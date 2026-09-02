import {
  findPendingVendorSubscription,
  getCurrentVendorSubscriptionId,
  insertRows,
  onlyKnownColumns,
  patchRows,
  subscriptionColumns,
  subscriptionOrderColumns,
  type AdminClient,
  type CreateVendorSubscriptionCheckoutInput,
  type VendorSubscriptionCheckoutRecord,
  type VendorSubscriptionOrderRow,
  type VendorSubscriptionPlanRow,
  type VendorSubscriptionRow,
} from "./vendor_subscriptions.ts";
import {
  convertAmountToTwd,
  fetchLatestExchangeRates,
  normalizeCurrencyCode,
} from "./currency_exchange.ts";

function buildOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-12).padStart(12, "0");
  const random = crypto.getRandomValues(new Uint8Array(3));
  const suffix = Array.from(random, (value) => String(value % 10)).join("");
  return `VS${timestamp}${suffix}`;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value ?? 0);
  const rounded = Math.round(parsed);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : fallback;
}

function resolvePlanExecTimes(plan: VendorSubscriptionPlanRow): number {
  const execTimes = toPositiveInt(plan.exec_times, 0);

  if (execTimes < 2) {
    throw new Error("Plan exec_times must be >= 2 for ECPay recurring subscriptions");
  }

  return execTimes;
}

async function supersedePendingSubscription(
  admin: AdminClient,
  subscription: VendorSubscriptionRow,
  nextMerchantTradeNo: string,
): Promise<void> {
  if (!subscription.id) return;

  const cancelledAt = new Date().toISOString();
  // The superseded checkout never established an entitlement period and must not
  // hold one now, so the period ends at the cancellation instant. Anchoring the
  // minimal window at its end (rather than starting it at "now" and reaching one
  // second into the future) keeps current_period_end > current_period_start for
  // the DB constraint while reading as already expired, so the overlap check
  // below does not match the subscription this call just superseded.
  const currentPeriodStart = new Date(new Date(cancelledAt).getTime() - 1000).toISOString();
  const message = `Superseded by vendor subscription checkout ${nextMerchantTradeNo}`;

  await patchRows(
    admin,
    "vendor_subscription_orders",
    {
      subscription_id: `eq.${subscription.id}`,
      payment_status: "eq.pending",
    },
    onlyKnownColumns(
      {
        payment_status: "cancelled",
        provider_status_message: message,
        updated_at: cancelledAt,
      },
      subscriptionOrderColumns,
    ),
  );

  await patchRows(
    admin,
    "vendor_subscriptions",
    { id: `eq.${subscription.id}` },
    onlyKnownColumns(
      {
        status: "cancelled",
        cancelled_at: cancelledAt,
        ended_at: cancelledAt,
        current_period_start: currentPeriodStart,
        current_period_end: cancelledAt,
        updated_at: cancelledAt,
      },
      subscriptionColumns,
    ),
  );
}

export async function createVendorSubscriptionCheckout(
  admin: AdminClient,
  input: CreateVendorSubscriptionCheckoutInput,
): Promise<VendorSubscriptionCheckoutRecord> {
  const nowIso = new Date().toISOString();
  const frequency = toPositiveInt(input.plan.frequency, 1);
  const periodType = input.plan.period_type;
  const sourceCurrency = normalizeCurrencyCode(input.plan.currency);
  const execTimes = resolvePlanExecTimes(input.plan);

  const exchangeRates = await fetchLatestExchangeRates(admin, [sourceCurrency], {
    exchangeRatesTable: process.env["EXCHANGE_RATES_TABLE"] || "exchange_rates",
    exchangeRateSource: process.env["EXCHANGE_RATE_SOURCE"] || "openexchangerates",
    exchangeRateBaseCurrency: process.env["EXCHANGE_RATE_BASE_CURRENCY"] || "TWD",
  });
  const pricing = convertAmountToTwd(
    input.plan.amount,
    sourceCurrency,
    exchangeRates,
    "Plan amount",
  );
  const planAmount = toPositiveInt(pricing.twdAmount, 0);

  if (planAmount <= 0) {
    throw new Error("Plan amount must be a positive integer");
  }

  const existingPending = await findPendingVendorSubscription(
    admin,
    input.vendorId,
    input.plan.code,
  );
  if (existingPending?.id) {
    await supersedePendingSubscription(admin, existingPending, input.merchantTradeNo);
  }

  const currentSubscriptionId = await getCurrentVendorSubscriptionId(
    admin,
    input.vendorId,
    input.plan.code,
  );
  if (currentSubscriptionId) {
    throw new Error(
      `This vendor already has an active subscription with overlapping features. Please wait until it expires before starting another checkout.`,
    );
  }

  const subscriptionRows = await insertRows<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
    vendor_id: input.vendorId,
    plan_code: input.plan.code,
    contract_id: input.plan.contract_id ?? null,
    status: "pending",
    period_type: periodType,
    frequency,
    exec_times: execTimes,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const subscription = subscriptionRows[0];
  if (!subscription?.id) {
    throw new Error("Failed to create vendor subscription");
  }

  const orderRows = await insertRows<VendorSubscriptionOrderRow>(
    admin,
    "vendor_subscription_orders",
    {
      vendor_id: input.vendorId,
      subscription_id: subscription.id,
      order_number: buildOrderNumber(),
      amount: planAmount,
      currency: "TWD",
      payment_provider: "ecpay",
      payment_method: "credit_card",
      payment_status: "pending",
      provider_order_id: input.merchantTradeNo,
      period_type: periodType,
      frequency,
      exec_times: execTimes,
      period_amount: planAmount,
      checkout_payload: {
        kind: "new",
        user_id: input.userId,
        plan_code: input.plan.code,
        plan_contract_id: input.plan.contract_id ?? null,
        plan_exec_times: execTimes,
        source_currency: pricing.sourceCurrency,
        source_amount: pricing.sourceAmount,
        exchange_rate_from_twd: pricing.exchangeRateFromTwd,
        exchange_rate_created_at: pricing.exchangeRateCreatedAt,
        twd_amount: pricing.twdAmount,
      },
      created_at: nowIso,
      updated_at: nowIso,
    },
  );

  const order = orderRows[0];
  if (!order?.id) {
    throw new Error("Failed to create vendor subscription order");
  }

  return { subscription, order };
}
