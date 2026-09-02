// Care app database access. Same shape as _shared_haiglobals/orders.ts's
// AdminClient/restRequest, but bound to the care app's own schema. All care data
// was moved out of `public` into `pro_care_matching` for dev isolation; every REST
// call sets Accept-Profile/Content-Profile to CARE_SCHEMA. Override with CARE_DB_SCHEMA.
// Auth (requireUserId) is generic — verifies the app user's bearer token via
// Supabase /auth/v1/user. Filter convention matches haiglobals: callers pass the
// PostgREST operator in the value, e.g. { merchant_trade_no: "eq." + value }.
import { getSupabaseServiceConfig } from "../_shared/env.ts";

export type SupabaseKeys = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export type AdminClient = { keys: SupabaseKeys };

export type QueryValue = string | number | boolean;

const CARE_SCHEMA = (process.env.CARE_DB_SCHEMA ?? "pro_care_matching").trim() || "pro_care_matching";

function normalizeSupabaseUrl(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) throw new Error("SUPABASE_URL is required");
  return normalized;
}

function normalizeServiceRoleKey(serviceRoleKey: string, anonKey?: string): string {
  const normalized = String(serviceRoleKey ?? "").trim();
  if (!normalized) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (anonKey && normalized === String(anonKey ?? "").trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be the anon key");
  }
  return normalized;
}

export function getCareRuntimeConfig(): SupabaseKeys {
  return getSupabaseServiceConfig();
}

export function createDatabaseClient(keys: SupabaseKeys = getCareRuntimeConfig()): AdminClient {
  return {
    keys: {
      supabaseUrl: normalizeSupabaseUrl(keys.supabaseUrl),
      supabaseAnonKey: String(keys.supabaseAnonKey ?? "").trim(),
      supabaseServiceRoleKey: normalizeServiceRoleKey(keys.supabaseServiceRoleKey, keys.supabaseAnonKey),
    },
  };
}

function queryString(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export async function careRest<T>(
  admin: AdminClient,
  table: string,
  query: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${admin.keys.supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", admin.keys.supabaseServiceRoleKey);
  headers.set("Authorization", `Bearer ${admin.keys.supabaseServiceRoleKey}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept-Profile", CARE_SCHEMA);
  headers.set("Content-Profile", CARE_SCHEMA);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase REST request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function careSelect<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T[]> {
  return await careRest<T[]>(admin, table, queryString(params));
}

export async function careSelectOne<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T | null> {
  const rows = await careSelect<T>(admin, table, { ...params, limit: 1 });
  return rows[0] ?? null;
}

export async function careInsert<T>(
  admin: AdminClient,
  table: string,
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
): Promise<T[]> {
  return await careRest<T[]>(admin, table, "", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
}

export async function careUpdate<T>(
  admin: AdminClient,
  table: string,
  match: Record<string, QueryValue>,
  patch: Record<string, unknown>,
): Promise<T[]> {
  return await careRest<T[]>(admin, table, queryString(match), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
}

/** Call a Postgres RPC in the care schema (POST /rest/v1/rpc/<fn>). */
export async function careRpc<T>(
  admin: AdminClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  return await careRest<T>(admin, `rpc/${fn}`, "", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

function readBearer(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

async function readTokenFromBody(req: Request): Promise<string> {
  try {
    const clone = req.clone();
    const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) return "";
    const body = await clone.json();
    if (!body || typeof body !== "object") return "";
    const record = body as Record<string, unknown>;
    return String(record.accessToken ?? record.access_token ?? record.token ?? "").trim();
  } catch {
    return "";
  }
}

export async function requireUserId(req: Request, keys: SupabaseKeys): Promise<string> {
  const candidates = [readBearer(req), await readTokenFromBody(req)].filter((t) => t);
  if (candidates.length === 0) throw new Error("Missing bearer token");
  for (const token of candidates) {
    try {
      const response = await fetch(`${keys.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: keys.supabaseAnonKey, Authorization: `Bearer ${token}` },
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as Record<string, unknown>;
      const userId = String(payload.id ?? payload.sub ?? "").trim();
      if (userId) return userId;
    } catch {
      // try next candidate
    }
  }
  throw new Error("Invalid or expired token");
}
