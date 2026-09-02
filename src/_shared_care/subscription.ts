// Care subscription business logic. Gateway rows live in public.care_ecpay_orders
// / care_ecpay_payments; the *business* state (who is subscribed, until when, card
// on file) stays on public.user_settings — exactly the tables the app already uses.
import {
  careInsert,
  careSelectOne,
  careUpdate,
  type AdminClient,
} from "./db.ts";

export type CareRole = "client" | "caregiver";

export type CarePlan = {
  code: string; // 'monthly' | 'yearly' — matches the app's SubscriptionPlan.id
  name: string;
  amount: number; // TWD, per period
  periodType: "M" | "Y";
  frequency: number;
  execTimes: number; // 綠界定期定額執行次數上限（M≤99、Y≤9）
};

// 家屬與看護同價（訂閱費跟家屬相同）。
export const CARE_PLANS: Record<string, CarePlan> = {
  monthly: { code: "monthly", name: "照護月費", amount: 199, periodType: "M", frequency: 1, execTimes: 99 },
  yearly: { code: "yearly", name: "照護年費", amount: 1990, periodType: "Y", frequency: 1, execTimes: 9 },
};

export function resolveCarePlan(planCode: string): CarePlan {
  const plan = CARE_PLANS[String(planCode ?? "").trim()];
  if (!plan) throw new Error(`Unknown care plan: ${planCode}`);
  return plan;
}

export function normalizeRole(value: unknown): CareRole {
  return String(value ?? "").trim() === "caregiver" ? "caregiver" : "client";
}

export type CareEcpayOrderRow = {
  id: string;
  user_id: string;
  role: string;
  subject_type: string;
  subject_ref: string | null;
  merchant_trade_no: string;
  amount: number | string;
  currency: string | null;
  payment_status: string | null;
  provider_trade_no: string | null;
  period_type: string | null;
  frequency: number | null;
  exec_times: number | null;
  period_amount: number | null;
  checkout_payload: Record<string, unknown> | null;
  last_callback_payload: Record<string, unknown> | null;
  refunded_amount: number | null;
};

function randomDigits(len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) out += Math.floor(Math.random() * 10).toString();
  return out;
}

// prefix + ts(12) + rand(4) = 3 + 12 + 4 = 19, within ECPay's 20-char limit.
// CSE = Care Subscription Ecpay; CTU = Care Top-Up.
export async function buildMerchantTradeNo(admin: AdminClient, prefix = "CSE"): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ts = (Date.now() + attempt).toString().slice(-12).padStart(12, "0");
    const candidate = `${prefix}${ts}${randomDigits(4)}`;
    const existing = await careSelectOne<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
      merchant_trade_no: `eq.${candidate}`,
      select: "id",
    });
    if (!existing) return candidate;
  }
  throw new Error("Unable to allocate a unique care MerchantTradeNo");
}

export async function createSubscriptionOrder(
  admin: AdminClient,
  input: { userId: string; role: CareRole; plan: CarePlan; merchantTradeNo: string },
): Promise<CareEcpayOrderRow> {
  const rows = await careInsert<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
    user_id: input.userId,
    role: input.role,
    subject_type: "subscription",
    subject_ref: input.plan.code,
    merchant_trade_no: input.merchantTradeNo,
    amount: input.plan.amount,
    currency: "TWD",
    payment_provider: "ecpay",
    payment_method: "Credit",
    payment_status: "pending",
    period_type: input.plan.periodType,
    frequency: input.plan.frequency,
    exec_times: input.plan.execTimes,
    period_amount: input.plan.amount,
    checkout_payload: { plan_name: input.plan.name },
  });
  const order = rows[0];
  if (!order) throw new Error("Failed to create care subscription order");
  return order;
}

export async function findOrderByMerchantTradeNo(
  admin: AdminClient,
  merchantTradeNo: string,
): Promise<CareEcpayOrderRow | null> {
  return await careSelectOne<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
    merchant_trade_no: `eq.${merchantTradeNo}`,
    select: "*",
  });
}

export async function updateOrder(
  admin: AdminClient,
  orderId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await careUpdate(admin, "care_ecpay_orders", { id: `eq.${orderId}` }, patch);
}

export async function paymentExists(admin: AdminClient, callbackKey: string): Promise<boolean> {
  const row = await careSelectOne<{ id: string }>(admin, "care_ecpay_payments", {
    callback_key: `eq.${callbackKey}`,
    select: "id",
  });
  return Boolean(row);
}

export async function recordPayment(
  admin: AdminClient,
  input: {
    order: CareEcpayOrderRow;
    callbackKey: string;
    status: "paid" | "failed";
    amount: number;
    paymentSequence: number | null;
    providerTradeNo: string | null;
    providerGwsr: string | null;
    providerAuthCode: string | null;
    providerRtnCode: number | null;
    providerRtnMessage: string | null;
    paidAt: string | null;
    processedAt: string | null;
    rawPayload: Record<string, unknown>;
  },
): Promise<void> {
  await careInsert(admin, "care_ecpay_payments", {
    order_id: input.order.id,
    user_id: input.order.user_id,
    payment_sequence: input.paymentSequence,
    amount: input.amount,
    currency: "TWD",
    status: input.status,
    provider: "ecpay",
    provider_trade_no: input.providerTradeNo,
    provider_gwsr: input.providerGwsr,
    provider_auth_code: input.providerAuthCode,
    provider_rtn_code: input.providerRtnCode,
    provider_rtn_message: input.providerRtnMessage,
    callback_key: input.callbackKey,
    paid_at: input.paidAt,
    processed_at: input.processedAt,
    raw_payload: input.rawPayload,
  });
}

type UserSettingsRow = {
  user_id: string;
  subscription_expires_at: string | null;
  seller_subscription_expires_at: string | null;
};

function addPeriod(base: Date, periodType: string, count: number): Date {
  const d = new Date(base.getTime());
  if (periodType === "Y") d.setFullYear(d.getFullYear() + count);
  else if (periodType === "M") d.setMonth(d.getMonth() + count);
  else d.setDate(d.getDate() + count);
  return d;
}

/**
 * A successful (recurring) charge: extend the subscription on user_settings and
 * mark the card on file. Renewal extends from the current expiry if still active,
 * otherwise from now — same rule as the app's setSubscription.
 */
export async function applySubscriptionPayment(
  admin: AdminClient,
  input: {
    order: CareEcpayOrderRow;
    paidAt: string | null;
    providerTradeNo: string | null;
    cardLast4: string | null;
    cardBrand: string | null;
  },
): Promise<void> {
  const order = input.order;
  const role = normalizeRole(order.role);
  const plan = resolveCarePlan(String(order.subject_ref ?? ""));

  const settings = await careSelectOne<UserSettingsRow>(admin, "user_settings", {
    user_id: `eq.${order.user_id}`,
    select: "user_id,subscription_expires_at,seller_subscription_expires_at",
  });

  const now = input.paidAt ? new Date(input.paidAt) : new Date();
  const currentExpiryRaw =
    role === "caregiver" ? settings?.seller_subscription_expires_at : settings?.subscription_expires_at;
  const currentExpiry = currentExpiryRaw ? new Date(currentExpiryRaw) : null;
  const base = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const newExpiry = addPeriod(base, plan.periodType, plan.frequency).toISOString();

  const patch: Record<string, unknown> = {
    card_on_file: true,
    card_brand: input.cardBrand || "信用卡",
  };
  if (input.cardLast4) patch.card_last4 = input.cardLast4;

  if (role === "caregiver") {
    patch.seller_subscribed = true;
    patch.seller_subscription_plan = plan.code;
    patch.seller_subscription_expires_at = newExpiry;
    patch.seller_subscription_auto_renew = true;
  } else {
    patch.subscribed = true;
    patch.subscription_plan = plan.code;
    patch.subscription_expires_at = newExpiry;
    patch.subscription_auto_renew = true;
  }

  if (settings) {
    await careUpdate(admin, "user_settings", { user_id: `eq.${order.user_id}` }, patch);
  } else {
    await careInsert(admin, "user_settings", { user_id: order.user_id, ...patch });
  }

  await updateOrder(admin, order.id, {
    payment_status: "paid",
    provider_trade_no: input.providerTradeNo ?? order.provider_trade_no ?? null,
    paid_at: input.paidAt ?? new Date().toISOString(),
  });

  // 把訂閱費記進 cash_ledger，讓「款項中心」看得到、並標綠界訂單號。entry_type 非
  // buyer_ → 不會被 wallet_mirror 觸發扣錢包（訂閱是刷卡付的，不動錢包）。
  await careInsert(admin, "cash_ledger", {
    owner_user_id: order.user_id,
    entry_type: "subscription_fee",
    status: "paid",
    amount_twd: -Math.trunc(Number(order.amount ?? 0)),
    title: role === "caregiver" ? "看護端訂閱費" : "訂閱費",
    subtitle: `${plan.name}・綠界訂單 ${order.merchant_trade_no}`,
    provider: "ecpay",
    provider_ref: input.providerTradeNo ?? order.merchant_trade_no,
    group_key: `subscription:${order.id}`,
    metadata: {
      kind: "subscription",
      plan: plan.code,
      merchant_trade_no: order.merchant_trade_no,
    },
  });
}
