// supabase/functions/_shared_haiglobals/vendor_subscriptions.ts
// Vendor subscription data layer. It intentionally does not use buyer orders tables.

export type SupabaseKeys = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export type AdminClient = {
  keys: SupabaseKeys;
};

export type QueryValue = string | number | boolean;

export type VendorSubscriptionPlanRow = {
  code: string;
  name: string;
  description?: string | null;
  contract_id?: string | null;
  amount: number | string;
  currency?: string | null;
  period_type: "D" | "M" | "Y";
  frequency: number | string;
  exec_times?: number | string;
  is_active?: boolean | null;
};

export type VendorSubscriptionRow = {
  id: string;
  vendor_id: string;
  plan_code: string;
  contract_id?: string | null;
  status: "pending" | "active" | "cancelled";
  period_type: "D" | "M" | "Y";
  frequency: number | string;
  exec_times?: number | string;
  started_at?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancelled_at?: string | null;
  ended_at?: string | null;
};

export type VendorSubscriptionOrderRow = {
  id: string;
  vendor_id: string;
  subscription_id?: string | null;
  order_number: string;
  amount: number | string;
  currency?: string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  provider_order_id?: string | null;
  provider_trade_no?: string | null;
  provider_status_code?: number | null;
  provider_status_message?: string | null;
  period_type: "D" | "M" | "Y";
  frequency: number | string;
  exec_times?: number | string;
  period_amount: number | string;
  checkout_payload?: Record<string, unknown> | null;
  last_callback_payload?: Record<string, unknown> | null;
  paid_at?: string | null;
  failed_at?: string | null;
};

export type CreateVendorSubscriptionCheckoutInput = {
  vendorId: string;
  userId: string;
  plan: VendorSubscriptionPlanRow;
  merchantTradeNo: string;
};

export type VendorSubscriptionCheckoutRecord = {
  subscription: VendorSubscriptionRow;
  order: VendorSubscriptionOrderRow;
};

export type ApplyVendorSubscriptionPaymentInput = {
  order: VendorSubscriptionOrderRow;
  providerTradeNo?: string | null;
  providerRtnCode?: number | null;
  providerRtnMessage?: string | null;
  amount: number;
  paymentSequence?: number | null;
  paidAt?: string | null;
  processedAt?: string | null;
  rawPayload: Record<string, unknown>;
  isSuccess: boolean;
  isSimulated: boolean;
};

const databaseSchema = "haiglobals";

export const subscriptionOrderColumns = new Set([
  "id",
  "vendor_id",
  "subscription_id",
  "order_number",
  "amount",
  "currency",
  "payment_provider",
  "payment_method",
  "payment_status",
  "provider_order_id",
  "provider_trade_no",
  "provider_status_code",
  "provider_status_message",
  "period_type",
  "frequency",
  "exec_times",
  "period_amount",
  "checkout_payload",
  "last_callback_payload",
  "paid_at",
  "failed_at",
  "updated_at",
]);

export const subscriptionColumns = new Set([
  "id",
  "vendor_id",
  "plan_code",
  "contract_id",
  "status",
  "period_type",
  "frequency",
  "exec_times",
  "started_at",
  "current_period_start",
  "current_period_end",
  "cancelled_at",
  "ended_at",
  "updated_at",
]);

function normalizeSupabaseUrl(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("SUPABASE_URL is required");
  }
  return normalized;
}

function normalizeServiceRoleKey(serviceRoleKey: string, anonKey?: string): string {
  const normalized = String(serviceRoleKey ?? "").trim();
  if (!normalized) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }
  if (anonKey && normalized === String(anonKey ?? "").trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be the anon key");
  }
  return normalized;
}

export function createAdminClient(keys: SupabaseKeys): AdminClient {
  return {
    keys: {
      supabaseUrl: normalizeSupabaseUrl(keys.supabaseUrl),
      supabaseAnonKey: String(keys.supabaseAnonKey ?? "").trim(),
      supabaseServiceRoleKey: normalizeServiceRoleKey(
        keys.supabaseServiceRoleKey,
        keys.supabaseAnonKey,
      ),
    },
  };
}

function encodeFilterValue(value: QueryValue): string {
  return encodeURIComponent(String(value));
}

export function queryString(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeFilterValue(value)}`)
    .join("&");
}

export async function restRequest<T>(
  admin: AdminClient,
  table: string,
  query: string,
  init: RequestInit = {},
): Promise<T> {
  const serviceRoleKey = normalizeServiceRoleKey(
    admin.keys.supabaseServiceRoleKey,
    admin.keys.supabaseAnonKey,
  );
  const url = `${normalizeSupabaseUrl(admin.keys.supabaseUrl)}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept-Profile", databaseSchema);
  headers.set("Content-Profile", databaseSchema);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase REST request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function selectRows<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T[]> {
  return await restRequest<T[]>(admin, table, queryString(params));
}

export async function selectOne<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T | null> {
  const rows = await selectRows<T>(admin, table, { ...params, limit: 1 });
  return rows[0] ?? null;
}

export async function insertRows<T>(
  admin: AdminClient,
  table: string,
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
): Promise<T[]> {
  return await restRequest<T[]>(admin, table, "", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
}

export async function patchRows(
  admin: AdminClient,
  table: string,
  filter: Record<string, QueryValue>,
  payload: Record<string, unknown>,
): Promise<void> {
  await restRequest<void>(admin, table, queryString(filter), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
}

export function onlyKnownColumns(
  payload: Record<string, unknown>,
  columns: Set<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
}

async function readAccessTokenFromRequestBody(req: Request): Promise<string> {
  try {
    const clone = req.clone();
    const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return "";
    }

    const body = await clone.json();
    if (!body || typeof body !== "object") {
      return "";
    }

    const record = body as Record<string, unknown>;
    return String(record.accessToken ?? record.access_token ?? record.token ?? "").trim();
  } catch (_) {
    return "";
  }
}

function readBearerToken(req: Request): string {
  const authorization = req.headers.get("Authorization") ?? "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

export async function requireUserId(req: Request, keys: SupabaseKeys): Promise<string> {
  const candidates = [readBearerToken(req), await readAccessTokenFromRequestBody(req)].filter(
    (token) => token,
  );

  if (candidates.length === 0) {
    throw new Error("Missing bearer token");
  }

  for (const token of candidates) {
    try {
      const response = await fetch(`${keys.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: keys.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const userId = String(payload.id ?? payload.sub ?? "").trim();
      if (userId) {
        return userId;
      }
    } catch (_) {
      // Try next candidate.
    }
  }

  throw new Error("User authentication failed");
}

export async function assertVendorAccess(
  admin: AdminClient,
  vendorId: string,
  userId: string,
): Promise<void> {
  if (!vendorId.trim()) {
    throw new Error("vendorId is required");
  }

  if (process.env["VENDOR_SUBSCRIPTION_SKIP_VENDOR_CHECK"] === "true") {
    return;
  }

  const table = process.env["VENDOR_OWNERSHIP_TABLE"]?.trim() || "vendors";
  const idColumn = process.env["VENDOR_OWNERSHIP_ID_COLUMN"]?.trim() || "id";
  const userColumn = process.env["VENDOR_OWNERSHIP_USER_COLUMN"]?.trim() || "user_id";

  if (table === "vendors" && idColumn !== "id") {
    throw new Error("VENDOR_OWNERSHIP_ID_COLUMN must be id for vendors in the current schema");
  }

  const row = await selectOne<Record<string, unknown>>(admin, table, {
    select: idColumn,
    [idColumn]: `eq.${vendorId}`,
    [userColumn]: `eq.${userId}`,
  });

  if (!row) {
    throw new Error("Vendor not found or current user cannot manage this vendor");
  }
}

export async function fetchActiveVendorSubscriptionPlan(
  admin: AdminClient,
  planCode: string,
): Promise<VendorSubscriptionPlanRow> {
  const plan = await selectOne<VendorSubscriptionPlanRow>(admin, "vendor_subscription_plans", {
    select: "*",
    code: `eq.${planCode}`,
    is_active: "eq.true",
  });

  if (!plan) {
    throw new Error("Vendor subscription plan not found");
  }

  return plan;
}

export async function vendorSubscriptionTradeNoExists(
  admin: AdminClient,
  merchantTradeNo: string,
): Promise<boolean> {
  const existing = await selectOne<VendorSubscriptionOrderRow>(
    admin,
    "vendor_subscription_orders",
    {
      select: "id",
      provider_order_id: `eq.${merchantTradeNo}`,
    },
  );
  return Boolean(existing?.id);
}

export async function getCurrentVendorSubscriptionId(
  admin: AdminClient,
  vendorId: string,
  planCode: string,
): Promise<string | null> {
  const normalizedPlanCode = String(planCode ?? "").trim();
  if (!normalizedPlanCode) {
    throw new Error("planCode is required");
  }

  const featureLinks = await selectRows<{ feature_code?: string | null }>(
    admin,
    "vendor_subscription_plan_features",
    {
      select: "feature_code",
      plan_code: `eq.${normalizedPlanCode}`,
    },
  );
  const featureCodes = new Set(
    featureLinks.map((row) => String(row.feature_code ?? "").trim()).filter((code) => code),
  );
  if (featureCodes.size === 0) {
    throw new Error("Subscription plan has no features");
  }

  const nowIso = new Date().toISOString();
  const currentSubscriptions = await selectRows<Pick<VendorSubscriptionRow, "id" | "plan_code">>(
    admin,
    "vendor_subscriptions",
    {
      select: "id,plan_code",
      vendor_id: `eq.${vendorId}`,
      status: "in.(active,cancelled)",
      current_period_start: `lte.${nowIso}`,
      current_period_end: `gt.${nowIso}`,
      order: "current_period_end.desc,created_at.desc",
    },
  );

  for (const subscription of currentSubscriptions) {
    const subscriptionPlanCode = String(subscription.plan_code ?? "").trim();
    if (!subscriptionPlanCode) {
      continue;
    }

    const subscriptionFeatureLinks = await selectRows<{ feature_code?: string | null }>(
      admin,
      "vendor_subscription_plan_features",
      {
        select: "feature_code",
        plan_code: `eq.${subscriptionPlanCode}`,
      },
    );

    for (const link of subscriptionFeatureLinks) {
      const featureCode = String(link.feature_code ?? "").trim();
      if (featureCode && featureCodes.has(featureCode)) {
        return subscription.id || "current";
      }
    }
  }

  return null;
}

export async function findPendingVendorSubscription(
  admin: AdminClient,
  vendorId: string,
  planCode: string,
): Promise<VendorSubscriptionRow | null> {
  const normalizedPlanCode = String(planCode ?? "").trim();
  if (!normalizedPlanCode) {
    throw new Error("planCode is required");
  }

  return await selectOne<VendorSubscriptionRow>(admin, "vendor_subscriptions", {
    select: "*",
    vendor_id: `eq.${vendorId}`,
    plan_code: `eq.${normalizedPlanCode}`,
    status: "eq.pending",
    order: "created_at.desc",
  });
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
