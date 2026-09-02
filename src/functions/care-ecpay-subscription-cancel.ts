// 取消 care 訂閱：呼叫綠界 CreditCardPeriodAction（Action=Cancel）停止定期定額扣款，
// 成功後才把 user_settings 的 (seller_)subscription_auto_renew 設 false（保留到期日、不再自動扣款）。
//
// 金流安全原則（萬無一失）：**先叫綠界停扣、綠界回成功才改本地狀態**。
// 綠界失敗就 throw、完全不動 user_settings —— 絕不讓「本地顯示已取消、綠界卻還在扣」的情況發生。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import {
  careSelectOne,
  careUpdate,
  createDatabaseClient,
  requireUserId,
} from "../_shared_care/db.ts";
import { normalizeRole, type CareEcpayOrderRow } from "../_shared_care/subscription.ts";
import {
  generateCheckMacValue,
  getEcpayPaymentConfig,
  getEcpayPeriodActionConfig,
  type EcpayPaymentConfig,
} from "../_shared/ecpay_payment.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseFormResponse(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

// 呼叫綠界停止定期定額委託。RtnCode 1 = 成功；90100149 = 委託本來就已停用
// （對「取消」而言等同成功，可冪等重試）。其餘一律視為失敗並 throw。
async function cancelEcpayPeriodic(merchantTradeNo: string): Promise<Record<string, string>> {
  const cfg = getEcpayPeriodActionConfig();
  const fields: Record<string, string> = {
    MerchantID: cfg.merchantId,
    MerchantTradeNo: merchantTradeNo,
    Action: "Cancel",
    TimeStamp: String(Math.floor(Date.now() / 1000)),
  };
  if (cfg.platformId) fields.PlatformID = cfg.platformId;
  fields.CheckMacValue = await generateCheckMacValue(fields, cfg.hashKey, cfg.hashIv);

  const res = await fetch(cfg.actionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `ECPay period action request failed (${res.status})`);
  }
  const raw = parseFormResponse(text);
  if (raw.CheckMacValue) {
    const expected = await generateCheckMacValue(raw, cfg.hashKey, cfg.hashIv);
    if (expected !== raw.CheckMacValue.toUpperCase()) {
      throw new Error("Invalid ECPay period action CheckMacValue");
    }
  }
  const rtnCode = raw.RtnCode ? Number(raw.RtnCode) : null;
  if (rtnCode !== 1 && rtnCode !== 90100149) {
    throw new Error(
      `ECPay recurring cancel failed: ${raw.RtnCode ?? "unknown"} ${raw.RtnMsg ?? ""}`.trim(),
    );
  }
  return raw;
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const config: EcpayPaymentConfig = getEcpayPaymentConfig();
    const userId = await requireUserId(req, config);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const role = normalizeRole(body.role);
    const admin = createDatabaseClient(config);

    // 該使用者 + 角色最近一筆「已付款」的訂閱定期定額（merchant_trade_no = 綠界委託識別碼）。
    const order = await careSelectOne<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
      user_id: `eq.${userId}`,
      role: `eq.${role}`,
      subject_type: "eq.subscription",
      payment_status: "eq.paid",
      order: "created_at.desc",
      select: "id,merchant_trade_no,payment_status",
    });

    let ecpay: Record<string, unknown> = {
      skipped: true,
      reason: "no paid subscription order to cancel",
    };
    if (order?.merchant_trade_no) {
      // 先叫綠界停扣；失敗會 throw，下面改本地狀態的程式碼就不會執行。
      const raw = await cancelEcpayPeriodic(order.merchant_trade_no);
      ecpay = {
        skipped: false,
        merchantTradeNo: order.merchant_trade_no,
        rtnCode: raw.RtnCode ? Number(raw.RtnCode) : null,
        rtnMsg: raw.RtnMsg ?? null,
      };
    }

    // 綠界已停扣（或本來就沒有委託）→ 關閉本地自動續訂旗標（保留到期日，用到當期結束）。
    const field =
      role === "caregiver" ? "seller_subscription_auto_renew" : "subscription_auto_renew";
    await careUpdate(admin, "user_settings", { user_id: `eq.${userId}` }, { [field]: false });

    return json({ ok: true, role, cancelled: true, ecpay });
  } catch (error) {
    console.error("[care-ecpay-subscription-cancel]", error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
