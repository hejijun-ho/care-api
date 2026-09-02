import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";

type SupabaseUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
};

type PushPlatform = "web" | "android" | "ios";

type RegisterPushPayload = {
  fcm_token: string;
  platform: PushPlatform;
  app_code: string;
  device_id?: string | null;
  device_name?: string | null;
  app_version?: string | null;
};

type PushRegistrationRow = {
  id: number;
  user_id: string;
  app_code: string;
  platform: PushPlatform;
  fcm_token: string;
  device_id?: string | null;
  device_name?: string | null;
  app_version?: string | null;
  enabled: boolean;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) {
    return json({ success: false, error: "Missing authorization header" }, 401);
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({ success: false, error: "Missing bearer token" }, 401);
  }

  let payload: RegisterPushPayload;
  try {
    payload = await parseRegisterPushPayload(req);
  } catch (error) {
    return json({ success: false, error: errorMessage(error) }, 400);
  }

  let supabaseUrl: string;
  let anonKey: string;
  let serviceRoleKey: string;
  try {
    const config = getSupabaseRuntimeConfig();
    supabaseUrl = config.supabaseUrl;
    anonKey = config.supabaseAnonKey;
    serviceRoleKey = config.supabaseServiceRoleKey;
  } catch (error) {
    return json({ success: false, error: errorMessage(error) }, 500);
  }

  let user: SupabaseUser;
  try {
    user = await fetchAuthenticatedUser({ supabaseUrl, anonKey, token });
  } catch (_) {
    return json({ success: false, error: "Invalid or expired session" }, 401);
  }

  try {
    console.log("[register-push] before upsert", {
      user_id: user.id,
      app_code: payload.app_code,
      platform: payload.platform,
      device_id: payload.device_id ?? null,
    });

    const registration = await upsertPushRegistration({
      supabaseUrl,
      serviceRoleKey,
      userId: user.id,
      payload,
    });

    console.log("[register-push] after upsert", {
      registration_id: registration.id,
      user_id: user.id,
      app_code: registration.app_code,
      platform: registration.platform,
    });

    return json(
      {
        success: true,
        registration: {
          id: registration.id,
          user_id: registration.user_id,
          app_code: registration.app_code,
          platform: registration.platform,
          device_id: registration.device_id ?? null,
          device_name: registration.device_name ?? null,
          app_version: registration.app_version ?? null,
          enabled: registration.enabled,
          last_seen_at: registration.last_seen_at,
          created_at: registration.created_at,
          updated_at: registration.updated_at,
        },
      },
      200,
    );
  } catch (error) {
    const message = errorMessage(error);

    console.error("[register-push] upsert failed", {
      user_id: user.id,
      app_code: payload.app_code,
      platform: payload.platform,
      message,
    });

    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseRegisterPushPayload(req: Request): Promise<RegisterPushPayload> {
  let body: unknown;

  try {
    body = await req.json();
  } catch (_) {
    throw new Error("Request body must be valid JSON");
  }

  if (!isRecord(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const fcmToken = requiredString(body.fcm_token, "fcm_token", 4096);
  const appCode = requiredString(body.app_code, "app_code", 100);
  const platform = parsePlatform(body.platform);

  return {
    fcm_token: fcmToken,
    app_code: appCode,
    platform,
    device_id: optionalString(body.device_id, "device_id", 255),
    device_name: optionalString(body.device_name, "device_name", 255),
    app_version: optionalString(body.app_version, "app_version", 100),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  if (normalized.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters`);
  }

  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters`);
  }

  return normalized;
}

function parsePlatform(value: unknown): PushPlatform {
  if (value === "web" || value === "android" || value === "ios") {
    return value;
  }

  throw new Error("platform must be one of: web, android, ios");
}

async function fetchAuthenticatedUser(input: {
  supabaseUrl: string;
  anonKey: string;
  token: string;
}): Promise<SupabaseUser> {
  const response = await fetch(`${input.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: input.anonKey,
      Authorization: `Bearer ${input.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase user lookup failed (${response.status})`);
  }

  const user = (await response.json()) as SupabaseUser;

  if (!user.id) {
    throw new Error("Supabase user lookup did not return a user id");
  }

  return user;
}

async function upsertPushRegistration(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
  payload: RegisterPushPayload;
}): Promise<PushRegistrationRow> {
  const now = new Date().toISOString();

  const endpoint = new URL(`${input.supabaseUrl}/rest/v1/push_registrations`);

  endpoint.searchParams.set("on_conflict", "app_code,fcm_token");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: input.serviceRoleKey,
      Authorization: `Bearer ${input.serviceRoleKey}`,
      "Content-Type": "application/json",

      // 使用自訂 schema：haiglobals
      "Content-Profile": "haiglobals",
      "Accept-Profile": "haiglobals",

      // 若 (app_code, fcm_token) 已存在，就更新原資料。
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      user_id: input.userId,
      app_code: input.payload.app_code,
      platform: input.payload.platform,
      fcm_token: input.payload.fcm_token,
      device_id: input.payload.device_id ?? null,
      device_name: input.payload.device_name ?? null,
      app_version: input.payload.app_version ?? null,
      enabled: true,
      last_seen_at: now,
      updated_at: now,
    }),
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(text || `Supabase push registration upsert failed (${response.status})`);
  }

  const rows = (await response.json()) as PushRegistrationRow[];
  const registration = rows[0];

  if (!registration?.id) {
    throw new Error("Supabase upsert did not return a registration");
  }

  return registration;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
