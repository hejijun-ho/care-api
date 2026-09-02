import {
  insertRows,
  onlyKnownColumns,
  patchRows,
  selectOne,
  subscriptionColumns,
  subscriptionOrderColumns,
  type AdminClient,
  type ApplyVendorSubscriptionPaymentInput,
  type VendorSubscriptionOrderRow,
  type VendorSubscriptionRow,
} from "./vendor_subscriptions.ts";

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function findVendorSubscriptionOrderByMerchantTradeNo(
  admin: AdminClient,
  merchantTradeNo: string,
): Promise<VendorSubscriptionOrderRow | null> {
  return await selectOne<VendorSubscriptionOrderRow>(admin, "vendor_subscription_orders", {
    select: "*",
    provider_order_id: `eq.${merchantTradeNo}`,
  });
}

export async function fetchVendorSubscriptionById(
  admin: AdminClient,
  subscriptionId: string,
): Promise<VendorSubscriptionRow | null> {
  return await selectOne<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
    select: "*",
    id: `eq.${subscriptionId}`,
  });
}

export async function updateVendorSubscriptionOrder(
  admin: AdminClient,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await patchRows(
    admin,
    "vendor_subscription_orders",
    { id: `eq.${orderId}` },
    onlyKnownColumns(
      { ...payload, updated_at: new Date().toISOString() },
      subscriptionOrderColumns,
    ),
  );
}

export async function cancelPendingVendorSubscriptionOrders(
  admin: AdminClient,
  subscriptionId: string,
): Promise<void> {
  await patchRows(
    admin,
    "vendor_subscription_orders",
    {
      subscription_id: `eq.${subscriptionId}`,
      payment_status: "eq.pending",
    },
    onlyKnownColumns(
      { payment_status: "cancelled", updated_at: new Date().toISOString() },
      subscriptionOrderColumns,
    ),
  );
}

export async function updateVendorSubscription(
  admin: AdminClient,
  subscriptionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await patchRows(
    admin,
    "vendor_subscriptions",
    { id: `eq.${subscriptionId}` },
    onlyKnownColumns({ ...payload, updated_at: new Date().toISOString() }, subscriptionColumns),
  );
}

export async function vendorSubscriptionPaymentExists(
  admin: AdminClient,
  callbackKey: string,
): Promise<boolean> {
  const existing = await selectOne<{ id: string }>(admin, "vendor_subscription_payments", {
    select: "id",
    provider_callback_key: `eq.${callbackKey}`,
  });
  return Boolean(existing?.id);
}

function addPeriod(start: Date, periodType: "D" | "M" | "Y", frequency: number): Date {
  const end = new Date(start.getTime());
  if (periodType === "D") {
    end.setUTCDate(end.getUTCDate() + frequency);
  } else if (periodType === "M") {
    end.setUTCMonth(end.getUTCMonth() + frequency);
  } else {
    end.setUTCFullYear(end.getUTCFullYear() + frequency);
  }
  return end;
}

export function computeEntitlementPeriod(
  startIso: string,
  order: VendorSubscriptionOrderRow,
): { startIso: string; endIso: string } {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    throw new Error("Invalid payment date");
  }

  const end = addPeriod(start, order.period_type, toPositiveInt(order.frequency, 1));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export async function createVendorSubscriptionPayment(
  admin: AdminClient,
  input: {
    order: VendorSubscriptionOrderRow;
    callbackKey: string;
    status: "paid" | "failed";
    amount: number;
    paymentSequence?: number | null;
    providerTradeNo?: string | null;
    providerGwsr?: string | null;
    providerAuthCode?: string | null;
    providerRtnCode?: number | null;
    providerRtnMessage?: string | null;
    paidAt?: string | null;
    processedAt?: string | null;
    rawPayload: Record<string, unknown>;
  },
): Promise<void> {
  await insertRows(admin, "vendor_subscription_payments", {
    subscription_order_id: input.order.id,
    vendor_id: input.order.vendor_id,
    payment_sequence: input.paymentSequence,
    amount: input.amount,
    currency: input.order.currency ?? "TWD",
    status: input.status,
    provider: "ecpay",
    provider_order_id: input.order.provider_order_id,
    provider_trade_no: input.providerTradeNo,
    provider_gwsr: input.providerGwsr,
    provider_auth_code: input.providerAuthCode,
    provider_rtn_code: input.providerRtnCode,
    provider_rtn_message: input.providerRtnMessage,
    provider_callback_key: input.callbackKey,
    paid_at: input.paidAt,
    processed_at: input.processedAt,
    raw_payload: input.rawPayload,
  });
}

function resolveEntitlementStartIso(paidAt: string): string {
  const paidAtDate = new Date(paidAt);
  if (Number.isNaN(paidAtDate.getTime())) {
    throw new Error("Invalid payment date");
  }
  return paidAtDate.toISOString();
}

export async function applyVendorSubscriptionPayment(
  admin: AdminClient,
  input: ApplyVendorSubscriptionPaymentInput,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const paidAt = input.paidAt || input.processedAt || nowIso;

  const orderUpdate: Record<string, unknown> = {
    provider_trade_no: input.providerTradeNo ?? input.order.provider_trade_no ?? null,
    provider_status_code: input.providerRtnCode ?? null,
    provider_status_message: input.providerRtnMessage ?? null,
    last_callback_payload: input.rawPayload,
  };

  if (String(input.order.payment_status ?? "").toLowerCase() === "cancelled") {
    await updateVendorSubscriptionOrder(admin, input.order.id, {
      ...orderUpdate,
      provider_status_message:
        input.providerRtnMessage ?? "Callback received after checkout was cancelled",
    });
    return;
  }

  if (input.isSimulated) {
    await updateVendorSubscriptionOrder(admin, input.order.id, {
      ...orderUpdate,
      provider_status_message: `[SIMULATED] ${input.providerRtnMessage ?? ""}`.trim(),
    });
    return;
  }

  if (!input.isSuccess) {
    await updateVendorSubscriptionOrder(admin, input.order.id, {
      ...orderUpdate,
      payment_status: "failed",
      failed_at: nowIso,
    });

    if (input.order.subscription_id) {
      await updateVendorSubscription(admin, input.order.subscription_id, {
        status: "pending",
      });
    }
    return;
  }

  await updateVendorSubscriptionOrder(admin, input.order.id, {
    ...orderUpdate,
    payment_status: "paid",
    paid_at: paidAt,
  });

  if (!input.order.subscription_id) {
    return;
  }

  const subscription = await fetchVendorSubscriptionById(admin, input.order.subscription_id);
  const entitlementStartIso = resolveEntitlementStartIso(paidAt);
  const period = computeEntitlementPeriod(entitlementStartIso, input.order);
  const execTimes = Number(input.order.exec_times);

  if (!Number.isFinite(execTimes) || execTimes < 2) {
    throw new Error("Order exec_times must be >= 2 for ECPay recurring subscriptions");
  }

  const currentPeriodEnd = period.endIso;

  await updateVendorSubscription(admin, input.order.subscription_id, {
    status: "active",
    started_at: subscription?.started_at ?? period.startIso,
    current_period_start: period.startIso,
    current_period_end: currentPeriodEnd,
  });
}
