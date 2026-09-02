// 管理端停扣：service_role 呼叫，用 user_id 取消該使用者的訂閱定期定額（不需使用者 JWT）。
// 用途：controller 關帳號（admin_close_account）前先呼叫這支叫綠界停扣，避免關帳號後還在扣。
//
// 金流安全原則（與 care-ecpay-subscription-cancel 一致）：**先叫綠界停扣、成功才改本地
// auto_renew**。綠界失敗就不動該軌的 user_settings，並在回應標記該軌失敗——絕不讓「本地
// 顯示已取消、綠界卻還在扣」發生。
//
// 授權：只接受帶著 service_role key 的呼叫（Authorization: Bearer <service_role_key>）。
// 請求 body：{ "user_id": "<uuid>", "role"?: "client" | "caregiver" }（不給 role 就兩軌都停）。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import { careSelectOne, careUpdate, createDatabaseClient } from "../_shared_care/db.ts";
import { normalizeRole, type CareEcpayOrderRow, type CareRole } from "../_shared_care/subscription.ts";
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

// 呼叫綠界停止定期定額委託。RtnCode 1 = 成功；90100149 = 委託本來就已停用（對取消而言
// 等同成功，可冪等重試）。其餘一律視為失敗並 throw。
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

// 停某一軌：找該使用者+角色最近一筆已付款訂閱委託 → 綠界停扣 → 成功才關本地 auto_renew。
// 綠界失敗會 throw（呼叫端據此標記該軌失敗、不改本地）。
async function cancelRole(
  admin: ReturnType<typeof createDatabaseClient>,
  userId: string,
  role: CareRole,
): Promise<Record<string, unknown>> {
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
    const raw = await cancelEcpayPeriodic(order.merchant_trade_no);
    ecpay = {
      skipped: false,
      merchantTradeNo: order.merchant_trade_no,
      rtnCode: raw.RtnCode ? Number(raw.RtnCode) : null,
      rtnMsg: raw.RtnMsg ?? null,
    };
  }

  const field =
    role === "caregiver" ? "seller_subscription_auto_renew" : "subscription_auto_renew";
  await careUpdate(admin, "user_settings", { user_id: `eq.${userId}` }, { [field]: false });
  return { role, cancelled: true, ecpay };
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const config: EcpayPaymentConfig = getEcpayPaymentConfig();

    // 只接受帶 service_role key 的呼叫（管理端後端對後端）。
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== config.supabaseServiceRoleKey) {
      return json({ ok: false, error: "service role required" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = String(body.user_id ?? "").trim();
    if (!userId) return json({ ok: false, error: "user_id required" }, 400);

    const admin = createDatabaseClient(config);
    const roles: CareRole[] = body.role
      ? [normalizeRole(body.role)]
      : ["client", "caregiver"];

    // 逐軌處理：一軌失敗不擋另一軌，各自回報；全部成功 ok 才 true。
    const results: Record<string, unknown>[] = [];
    let allOk = true;
    for (const role of roles) {
      try {
        results.push(await cancelRole(admin, userId, role));
      } catch (error) {
        allOk = false;
        results.push({
          role,
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return json({ ok: allOk, user_id: userId, results });
  } catch (error) {
    console.error("[care-ecpay-admin-subscription-cancel]", error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
