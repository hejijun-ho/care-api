// 停 care 訂閱的綠界定期定額（使用者取消、管理端關帳號、兌換優惠碼時停續扣共用）。
//
// 金流安全原則：**先叫綠界停扣、綠界回成功才改本地 auto_renew**。
// 綠界失敗就 throw、不動 user_settings——絕不讓「本地顯示已取消、綠界卻還在扣」發生。
import { careSelectOne, careUpdate, type AdminClient } from "./db.ts";
import type { CareEcpayOrderRow, CareRole } from "./subscription.ts";
import { generateCheckMacValue, getEcpayPeriodActionConfig } from "../_shared/ecpay_payment.ts";

function parseFormResponse(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

// 呼叫綠界停止定期定額委託。RtnCode 1 = 成功；90100149 = 委託本來就已停用
// （對「取消」而言等同成功，可冪等重試）。其餘一律視為失敗並 throw。
export async function cancelEcpayPeriodic(
  merchantTradeNo: string,
): Promise<Record<string, string>> {
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
// 綠界失敗會 throw（呼叫端據此回報失敗、本地不變）。
export async function cancelSubscriptionRole(
  admin: AdminClient,
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

  const field = role === "caregiver" ? "seller_subscription_auto_renew" : "subscription_auto_renew";
  await careUpdate(admin, "user_settings", { user_id: `eq.${userId}` }, { [field]: false });
  return { role, cancelled: true, ecpay };
}
