// 手動「退回信用卡」：對某筆已付儲值(care_ecpay_orders)做綠界退刷(DoAction R)，
// 退回原卡並把錢包餘額扣掉。使用者負擔 NT$1 處理費（自退款額扣）。
//
// 服務相關退款(成交多退/取消/沒中/賠償)不走這裡——那些是錢包內部加回、零成本。
import { careRpc, type AdminClient } from "./db.ts";
import { updateOrder, type CareEcpayOrderRow } from "./subscription.ts";
import {
  generateCheckMacValue,
  getEcpayCreditActionConfig,
} from "../_shared/ecpay_payment.ts";

/** 綠界退刷每筆處理費，使用者負擔（自退款金額扣）。 */
export const REFUND_FEE_TWD = 1;

function parseEcpayForm(raw: string): Record<string, string> {
  return Object.fromEntries(
    new URLSearchParams(raw.replace(/^﻿/, "").trim()).entries(),
  );
}

/** 這筆儲值的面額（進錢包的金額）。 */
export function topupFace(order: CareEcpayOrderRow): number {
  const payload = (order.checkout_payload ?? {}) as Record<string, unknown>;
  const face = Number(payload.face_amount);
  return Number.isInteger(face) && face > 0 ? face : Number(order.amount ?? 0);
}

/** 這筆儲值還可退多少（面額 − 已退）。 */
export function refundableFace(order: CareEcpayOrderRow): number {
  return Math.max(topupFace(order) - Number(order.refunded_amount ?? 0), 0);
}

/**
 * 對某筆已付儲值退回原卡。[amount] = 要退的錢包金額（≤ 面額−已退，且 ≤ 錢包餘額）。
 *
 * 綠界信用卡有「關帳」界線（每日 20:00 自動關帳）：
 *   - 已關帳 → 用「退刷 R」，卡片實退 = amount − NT$1 手續費，可部分退。
 *   - 未關帳（已授權）→ R 會回 `error_amount_R`（可退金額=0）。此時只能用「放棄 N」
 *     整筆釋放授權（卡片回全額、免手續費），不能部分退。
 * 因此策略是「先試 R；若因未關帳失敗且此筆為整筆未動過，改用 N 整筆放棄」。
 * 一律先扣錢包（擋餘額不足），任何一步失敗就退回錢包保持一致。
 */
export async function refundTopupToCard(
  admin: AdminClient,
  input: { order: CareEcpayOrderRow; amount: number },
): Promise<{ refunded: number; cardAmount: number; action: "R" | "N" }> {
  const order = input.order;
  const amount = Math.trunc(input.amount);

  if (order.subject_type !== "topup" || order.payment_status !== "paid") {
    throw new Error("只有已付款的儲值才能退回原卡");
  }
  const tradeNo = String(order.provider_trade_no ?? "").trim();
  if (!tradeNo) throw new Error("找不到綠界交易號，無法退刷");
  if (amount <= REFUND_FEE_TWD) {
    throw new Error(`退款金額需大於處理費 ${REFUND_FEE_TWD} 元`);
  }
  const alreadyRefunded = Number(order.refunded_amount ?? 0);
  const remaining = refundableFace(order);
  if (amount > remaining) throw new Error(`這筆最多還能退 ${remaining} 元`);
  // 只有「整筆、未動過」才能在未關帳時用 N 整筆放棄（N 不能部分退）。
  const isFullUntouched = alreadyRefunded === 0 && amount === remaining;
  const authAmount = Math.max(Number(order.amount ?? 0), 0); // 授權金額（含當初手續費）

  // 先扣錢包（wallet_apply_for_user 會擋餘額不足）。
  await careRpc(admin, "wallet_apply_for_user", {
    p_user_id: order.user_id,
    p_amount: -amount,
    p_title: "退回信用卡",
    p_subtitle: `綠界訂單 ${order.merchant_trade_no}`,
    p_transaction_type: "refund_to_card",
  });
  const reverseWallet = (reason: string) =>
    careRpc(admin, "wallet_apply_for_user", {
      p_user_id: order.user_id,
      p_amount: amount,
      p_title: reason,
      p_subtitle: `綠界訂單 ${order.merchant_trade_no}`,
      p_transaction_type: "refund_reverse",
    });

  const config = getEcpayCreditActionConfig();
  const doAction = async (action: "R" | "N", totalAmount: number): Promise<void> => {
    const params: Record<string, string | number> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: order.merchant_trade_no,
      TradeNo: tradeNo,
      Action: action,
      TotalAmount: totalAmount,
      ...(config.platformId ? { PlatformID: config.platformId } : {}),
    };
    const checkMac = await generateCheckMacValue(params, config.hashKey, config.hashIv);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, CheckMacValue: checkMac })) {
      form.set(k, String(v));
    }
    const resp = await fetch(config.actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const raw = await resp.text();
    const parsed = parseEcpayForm(raw);
    if (!resp.ok || parsed.RtnCode !== "1") {
      throw new Error(parsed.RtnMsg || `ECPay ${action} failed (${resp.status}): ${raw.slice(0, 200)}`);
    }
  };

  let usedAction: "R" | "N" = "R";
  let cardRefunded = amount - REFUND_FEE_TWD; // R 路徑：手續費由使用者負擔
  try {
    await doAction("R", cardRefunded);
  } catch (rErr) {
    const msg = rErr instanceof Error ? rErr.message : String(rErr);
    // 未關帳（可退金額=0）→ 綠界回 error_amount_R。此時 R 無解，改走 N。
    const notCaptured = /error_amount_R|未關帳|尚未關帳|not\s*captured/i.test(msg);
    if (!notCaptured) {
      await reverseWallet("退款失敗退回錢包");
      throw rErr instanceof Error ? rErr : new Error(msg);
    }
    if (!isFullUntouched) {
      await reverseWallet("退款失敗退回錢包");
      throw new Error(
        "這筆今日尚未關帳（綠界每日 20:00 自動關帳），暫時只能全額退回原卡；部分退款請於關帳後再試。",
      );
    }
    try {
      // N 放棄整筆授權：TotalAmount = 授權金額（含手續費）；卡片回全額、免退刷手續費。
      await doAction("N", authAmount);
      usedAction = "N";
      cardRefunded = authAmount;
    } catch (nErr) {
      await reverseWallet("退款失敗退回錢包");
      throw nErr instanceof Error ? nErr : new Error(String(nErr));
    }
  }

  await updateOrder(admin, order.id, {
    refunded_amount: alreadyRefunded + amount,
  });
  return { refunded: amount, cardAmount: cardRefunded, action: usedAction };
}
