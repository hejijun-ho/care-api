// Care wallet top-up (儲值) business logic. Real 綠界 money in → the buyer's
// real prepaid balance (public.wallets.token_balance). Gateway rows live in
// care_ecpay_orders / care_ecpay_payments; the balance move goes through the
// buyer-keyed wallet_apply_for_user RPC (service_role).
//
// 金流手續費「外加」由使用者吸收：使用者選「面額」(進錢包的金額)，綠界實收
// 面額 + 手續費；錢包只入面額。手續費一律用國內卡費率 2.45%（海外卡的差額由平台
// 吸收，屬少數）。
import { careInsert, careRpc, type AdminClient } from "./db.ts";
import { updateOrder, type CareEcpayOrderRow } from "./subscription.ts";

export const TOPUP_MIN = 100;
export const TOPUP_MAX = 100000;

/** 一律外加國內卡費率；海外卡(3.8%)的差 1.35% 由平台吸收（少數）。 */
export const TOPUP_FEE_RATE = 0.0245;

/** 面額 → {面額, 手續費(無條件進位), 綠界實收} 。 */
export function computeTopupCharge(faceAmount: number): {
  face: number;
  fee: number;
  charge: number;
} {
  const face = Math.trunc(faceAmount);
  const fee = Math.ceil(face * TOPUP_FEE_RATE);
  return { face, fee, charge: face + fee };
}

export function normalizeTopupAmount(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new Error("Top-up amount must be a number");
  if (n < TOPUP_MIN) throw new Error(`Top-up amount must be at least ${TOPUP_MIN}`);
  if (n > TOPUP_MAX) throw new Error(`Top-up amount must be at most ${TOPUP_MAX}`);
  return n;
}

/** care_ecpay_orders.amount = 綠界實收 (charge)；面額/手續費放 checkout_payload。 */
export async function createTopupOrder(
  admin: AdminClient,
  input: {
    userId: string;
    role: string;
    face: number;
    fee: number;
    charge: number;
    merchantTradeNo: string;
  },
): Promise<CareEcpayOrderRow> {
  const rows = await careInsert<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
    user_id: input.userId,
    role: input.role,
    subject_type: "topup",
    subject_ref: "wallet",
    merchant_trade_no: input.merchantTradeNo,
    amount: input.charge, // 綠界實收（面額 + 手續費）
    currency: "TWD",
    payment_provider: "ecpay",
    payment_method: "Credit",
    payment_status: "pending",
    checkout_payload: {
      kind: "wallet_topup",
      face_amount: input.face, // 進錢包的面額
      fee_twd: input.fee,
      charge_twd: input.charge,
      fee_rate: TOPUP_FEE_RATE,
    },
  });
  const order = rows[0];
  if (!order) throw new Error("Failed to create care top-up order");
  return order;
}

function topupFaceAmount(order: CareEcpayOrderRow): number {
  const payload = (order.checkout_payload ?? {}) as Record<string, unknown>;
  const face = Number(payload.face_amount);
  // 舊單（沒外加手續費）沒有 face_amount → 退回用 amount。
  return Number.isInteger(face) && face > 0 ? face : Number(order.amount ?? 0);
}

/**
 * A successful top-up: credit the buyer's real wallet with the FACE amount (the
 * fee the user paid on top is not wallet money), then mark the order paid.
 * Idempotency is enforced by the caller (paymentExists) before this runs.
 */
export async function applyTopupPayment(
  admin: AdminClient,
  input: {
    order: CareEcpayOrderRow;
    paidAt: string | null;
    providerTradeNo: string | null;
  },
): Promise<void> {
  const face = topupFaceAmount(input.order);
  if (!Number.isInteger(face) || face <= 0) {
    throw new Error("Top-up face amount is invalid");
  }
  // 每筆儲值款項標上綠界訂單編號（MerchantTradeNo，綠界後台對得到）＋綠界交易號，方便對帳。
  const ecpayRef = [input.order.merchant_trade_no, input.providerTradeNo]
    .filter((v) => v)
    .join(" · ");
  await careRpc(admin, "wallet_apply_for_user", {
    p_user_id: input.order.user_id,
    p_amount: face, // 錢包只入面額
    p_title: "綠界儲值",
    p_subtitle: `綠界訂單 ${ecpayRef}`,
    p_transaction_type: "topup",
  });
  await updateOrder(admin, input.order.id, {
    payment_status: "paid",
    provider_trade_no: input.providerTradeNo ?? input.order.provider_trade_no ?? null,
    paid_at: input.paidAt ?? new Date().toISOString(),
  });
}
