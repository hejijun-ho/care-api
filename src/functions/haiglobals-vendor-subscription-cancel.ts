// supabase/functions/haiglobals-vendor-subscription-cancel.ts
import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  assertVendorAccess,
  fetchActiveVendorSubscriptionPlan,
  type AdminClient,
  type VendorSubscriptionRow,
} from "../_shared_haiglobals/vendor_subscriptions.ts";
import { updateVendorSubscription } from "../_shared_haiglobals/vendor_subscription_payments.ts";
import {
  generateCheckMacValue,
  getEcpayPaymentCallbackConfig,
  getEcpayPeriodActionConfig,
} from "../_shared/ecpay_payment.ts";
type QueryValue = string | number | boolean;

type VendorSubscriptionOrderForCancel = {
  id: string;
  provider_order_id?: string | null;
  payment_status?: string | null;
};

type EcpayCancelResult = {
  skipped: boolean;
  reason?: string;
  merchantTradeNo?: string;
  rtnCode?: number | null;
  rtnMsg?: string | null;
  raw?: Record<string, string>;
};

type CancelResponse = {
  success: true;
  vendorId: string;
  planCode: string | null;
  subscriptionId: string;
  status: "cancelled";
  immediate: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  changedPeriod: boolean;
  alreadyCancelled: boolean;
  cancelledPendingCheckout: boolean;
  ecpayCancel: EcpayCancelResult;
};

const databaseSchema = "haiglobals";

function parseFormResponse(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function readBooleanFlag(value: unknown): boolean {
  return (
    value === true ||
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function encodeFilterValue(value: QueryValue): string {
  return encodeURIComponent(String(value));
}

function queryString(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeFilterValue(value)}`)
    .join("&");
}

async function restRequest<T>(
  admin: AdminClient,
  table: string,
  query: string,
  init: RequestInit = {},
): Promise<T> {
  const serviceRoleKey = admin.keys.supabaseServiceRoleKey;
  const url = `${admin.keys.supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Accept-Profile", databaseSchema);
  headers.set("Content-Profile", databaseSchema);
  headers.set("Content-Type", "application/json");

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase REST request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function selectRows<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T[]> {
  return await restRequest<T[]>(admin, table, queryString(params));
}

async function patchRows(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
  payload: Record<string, unknown>,
): Promise<void> {
  await restRequest<void>(admin, table, queryString(params), {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
  });
}

async function cancelPendingVendorSubscriptionOrders(
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
    {
      payment_status: "cancelled",
    },
  );
}

async function fetchLatestPaidSubscriptionOrder(
  admin: AdminClient,
  subscriptionId: string,
): Promise<VendorSubscriptionOrderForCancel | null> {
  const rows = await selectRows<VendorSubscriptionOrderForCancel>(
    admin,
    "vendor_subscription_orders",
    {
      select: "id,provider_order_id,payment_status",
      subscription_id: `eq.${subscriptionId}`,
      payment_status: "eq.paid",
      order: "paid_at.desc,created_at.desc",
      limit: 1,
    },
  );
  return rows[0] ?? null;
}

async function cancelEcpayRecurringSubscription(
  admin: AdminClient,
  subscription: VendorSubscriptionRow,
): Promise<EcpayCancelResult> {
  const order = await fetchLatestPaidSubscriptionOrder(admin, subscription.id);
  if (!order?.id) {
    return {
      skipped: true,
      reason: "subscription has no paid ECPay recurring checkout to cancel",
    };
  }

  if (subscription.status !== "active") {
    return {
      skipped: true,
      reason: `subscription status is ${subscription.status}, so no active ECPay recurring authorization is cancelled`,
    };
  }

  const merchantTradeNo = String(order.provider_order_id ?? "").trim();
  if (!merchantTradeNo) {
    throw new Error(
      "Cannot cancel ECPay recurring subscription because provider_order_id / MerchantTradeNo is missing",
    );
  }

  const config = getEcpayPeriodActionConfig();

  const fields: Record<string, string> = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    Action: "Cancel",
    TimeStamp: String(Math.floor(Date.now() / 1000)),
  };

  if (config.platformId) {
    fields.PlatformID = config.platformId;
  }

  fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

  const response = await fetch(config.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `ECPay period action request failed (${response.status})`);
  }

  const raw = parseFormResponse(text);
  const responseCheckMacValue = raw.CheckMacValue;
  if (responseCheckMacValue) {
    const expected = await generateCheckMacValue(raw, config.hashKey, config.hashIv);
    if (expected !== responseCheckMacValue.toUpperCase()) {
      throw new Error("Invalid ECPay period action CheckMacValue");
    }
  }

  const rtnCode = raw.RtnCode ? Number(raw.RtnCode) : null;
  const rtnMsg = raw.RtnMsg ?? null;

  // 1 = success. 90100149 commonly means the periodic order is already disabled/stopped;
  // for a cancel operation, that is idempotently acceptable because future charges are already stopped.
  if (rtnCode !== 1 && rtnCode !== 90100149) {
    throw new Error(
      `ECPay recurring cancel failed: ${raw.RtnCode ?? "unknown"} ${rtnMsg ?? ""}`.trim(),
    );
  }

  return {
    skipped: false,
    merchantTradeNo,
    rtnCode,
    rtnMsg,
    raw,
  };
}

async function findPendingSubscription(
  admin: AdminClient,
  vendorId: string,
  planCode: string,
): Promise<VendorSubscriptionRow | null> {
  const rows = await selectRows<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
    select: "*",
    vendor_id: `eq.${vendorId}`,
    plan_code: `eq.${planCode}`,
    status: "eq.pending",
    order: "created_at.desc",
    limit: 1,
  });

  return rows[0] ?? null;
}

async function findCurrentSubscription(
  admin: AdminClient,
  vendorId: string,
  planCode: string,
): Promise<VendorSubscriptionRow | null> {
  const nowIso = new Date().toISOString();
  const rows = await selectRows<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
    select: "*",
    vendor_id: `eq.${vendorId}`,
    plan_code: `eq.${planCode}`,
    status: "in.(active,cancelled)",
    current_period_start: `lte.${nowIso}`,
    current_period_end: `gt.${nowIso}`,
    order: "current_period_end.desc,created_at.desc",
    limit: 1,
  });

  return rows[0] ?? null;
}

function validDateFromIso(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Timestamps read back from Postgres and timestamps produced by toISOString()
// spell the same instant differently, so compare instants rather than strings.
function isSameInstant(left: unknown, right: unknown): boolean {
  const leftDate = validDateFromIso(left);
  const rightDate = validDateFromIso(right);
  if (!leftDate || !rightDate) return !leftDate && !rightDate;
  return leftDate.getTime() === rightDate.getTime();
}

function hasRemainingEntitlement(subscription: VendorSubscriptionRow, nowIso: string): boolean {
  const end = validDateFromIso(subscription.current_period_end);
  const now = validDateFromIso(nowIso);
  if (!end || !now) return false;
  return end.getTime() > now.getTime();
}

// An immediate cancel only ever shortens the entitlement. A period that already
// lapsed keeps its original end rather than being pushed forward to now, which
// would rewrite the period the vendor actually held.
function immediateCancellationEnd(subscription: VendorSubscriptionRow, nowIso: string): string {
  const end = validDateFromIso(subscription.current_period_end);
  const now = validDateFromIso(nowIso);
  if (!end || !now) return nowIso;
  return end.getTime() < now.getTime() ? end.toISOString() : nowIso;
}

function normalizeCancellationPeriod(
  startCandidate: unknown,
  endCandidate: unknown,
  cancelledAtIso: string,
): { startIso: string; endIso: string } {
  const cancelledAt = validDateFromIso(cancelledAtIso) ?? new Date();
  const start = validDateFromIso(startCandidate) ?? cancelledAt;
  const end = validDateFromIso(endCandidate);

  if (end && end.getTime() > start.getTime()) {
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  // No usable entitlement period: a pending checkout never established one, and
  // an immediate cancel can ask for an end at or before the start. Neither may
  // stay entitled, so the period ends at the cancellation instant rather than
  // reaching one second into the future. vendor_subscriptions has a DB
  // constraint requiring current_period_end > current_period_start while the
  // subscription is active/cancelled, so pull the start back when it would not
  // already sit before the end.
  if (start.getTime() < cancelledAt.getTime()) {
    return {
      startIso: start.toISOString(),
      endIso: cancelledAt.toISOString(),
    };
  }

  return {
    startIso: new Date(cancelledAt.getTime() - 1000).toISOString(),
    endIso: cancelledAt.toISOString(),
  };
}

async function findSubscriptionForCancel(
  admin: AdminClient,
  vendorId: string,
  subscriptionId?: string,
  planCode?: string,
): Promise<VendorSubscriptionRow | null> {
  if (subscriptionId) {
    const rows = await selectRows<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
      select: "*",
      id: `eq.${subscriptionId}`,
      vendor_id: `eq.${vendorId}`,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  const normalizedPlanCode = String(planCode ?? "").trim();
  if (!normalizedPlanCode) {
    throw new Error("planCode is required when subscriptionId is not provided");
  }

  const pending = await findPendingSubscription(admin, vendorId, normalizedPlanCode);
  if (pending) return pending;

  return await findCurrentSubscription(admin, vendorId, normalizedPlanCode);
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const config = getEcpayPaymentCallbackConfig();
    const { admin, userId } = await requireUserAndCreateDatabaseClient(req, config);
    const body = (await req.json()) as Record<string, unknown>;

    const vendorId = String(body.vendorId ?? body.vendor_id ?? "").trim();
    const subscriptionId = String(body.subscriptionId ?? body.subscription_id ?? "").trim();
    const planCode = String(
      body.planCode ?? body.plan_code ?? body.subscriptionKey ?? body.subscription_key ?? "",
    ).trim();
    // immediate=true expires the entitlement now; the default keeps it until the
    // current period ends. Either way ECPay stops charging the next period.
    const immediate = readBooleanFlag(body.immediate);

    if (!vendorId) throw new Error("vendorId is required");
    await assertVendorAccess(admin, vendorId, userId);
    const plan = planCode ? await fetchActiveVendorSubscriptionPlan(admin, planCode) : null;

    const subscription = await findSubscriptionForCancel(
      admin,
      vendorId,
      subscriptionId || undefined,
      plan?.code,
    );

    if (!subscription?.id) {
      throw new Error("No cancellable vendor subscription found for this vendor");
    }

    const alreadyCancelled = subscription.status === "cancelled";
    const wasPending = subscription.status === "pending";
    const cancelledAt = new Date().toISOString();
    const previousPeriodEnd = subscription.current_period_end ?? null;
    let ecpayCancel: EcpayCancelResult = {
      skipped: true,
      reason: alreadyCancelled ? "subscription is already cancelled locally" : "not evaluated yet",
    };

    let cancellationPeriodStart = subscription.current_period_start ?? null;
    let cancellationPeriodEnd = previousPeriodEnd;

    // A subscription cancelled at period end stays entitled until
    // current_period_end, so an immediate cancel still has work to do on it:
    // cut the remaining period short. Its ECPay authorization is already
    // cancelled, so only the local entitlement changes.
    const expiresRemainingPeriod =
      immediate && alreadyCancelled && hasRemainingEntitlement(subscription, cancelledAt);

    if (!alreadyCancelled || expiresRemainingPeriod) {
      if (!alreadyCancelled) {
        if (wasPending) {
          await cancelPendingVendorSubscriptionOrders(admin, subscription.id);
          ecpayCancel = {
            skipped: true,
            reason: "pending checkout has no established ECPay recurring authorization",
          };
        } else {
          ecpayCancel = await cancelEcpayRecurringSubscription(admin, subscription);
        }
      }

      const period = normalizeCancellationPeriod(
        subscription.current_period_start ?? subscription.started_at ?? cancelledAt,
        immediate
          ? immediateCancellationEnd(subscription, cancelledAt)
          : (subscription.current_period_end ?? subscription.ended_at),
        cancelledAt,
      );
      cancellationPeriodStart = period.startIso;
      cancellationPeriodEnd = period.endIso;
      await updateVendorSubscription(admin, subscription.id, {
        status: "cancelled",
        cancelled_at: subscription.cancelled_at ?? cancelledAt,
        ended_at: subscription.ended_at ?? cancelledAt,
        current_period_start: cancellationPeriodStart,
        current_period_end: cancellationPeriodEnd,
      });
    }

    const responseBody: CancelResponse = {
      success: true,
      vendorId,
      planCode: plan?.code ?? null,
      subscriptionId: subscription.id,
      status: "cancelled",
      immediate,
      currentPeriodStart: cancellationPeriodStart,
      currentPeriodEnd: cancellationPeriodEnd,
      changedPeriod: !isSameInstant(previousPeriodEnd, cancellationPeriodEnd),
      alreadyCancelled,
      cancelledPendingCheckout: wasPending,
      ecpayCancel,
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[haiglobals-vendor-subscription-cancel]", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }
};

export default handleRequest;
