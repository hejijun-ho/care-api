import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient, getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";
import { queryString, restRequest } from "../_shared_haiglobals/orders.ts";

// 登出時停用這台裝置的推播註冊，與 haiglobals-register-push 成對使用。
//
// 為什麼需要這支：註冊 upsert 只在「有下一個人登入」時才會覆蓋 user_id，
// 但最常見的情況是登出後沒人再登入，那列會一直維持 enabled=true，
// 訂單/退貨通知就會繼續推到這台已登出的裝置。

type SupabaseUser = {
  id: string;
};

type UnregisterPushPayload = {
  fcm_token: string;
  app_code?: string | null;
};

type PushRegistrationRow = {
  id: number;
  app_code: string;
  platform: string;
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

  let payload: UnregisterPushPayload;
  try {
    payload = await parseUnregisterPushPayload(req);
  } catch (error) {
    return json({ success: false, error: errorMessage(error) }, 400);
  }

  let supabaseUrl: string;
  let anonKey: string;
  try {
    const config = getSupabaseRuntimeConfig();
    supabaseUrl = config.supabaseUrl;
    anonKey = config.supabaseAnonKey;
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
    console.log("[unregister-push] before disable", {
      user_id: user.id,
      app_code: payload.app_code ?? null,
    });

    const disabled = await disablePushRegistration({
      userId: user.id,
      payload,
    });

    console.log("[unregister-push] after disable", {
      user_id: user.id,
      app_code: payload.app_code ?? null,
      disabled_count: disabled.length,
      registration_ids: disabled.map((row) => row.id),
    });

    // 找不到對應註冊也回 200：登出流程不該因為推播沒清成功而失敗，
    // 而且「本來就沒有」跟「已經停用」對呼叫端來說結果一樣。
    return json(
      {
        success: true,
        disabled: disabled.length,
        registrations: disabled.map((row) => ({
          id: row.id,
          app_code: row.app_code,
          platform: row.platform,
        })),
      },
      200,
    );
  } catch (error) {
    const message = errorMessage(error);

    console.error("[unregister-push] disable failed", {
      user_id: user.id,
      app_code: payload.app_code ?? null,
      message,
    });

    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseUnregisterPushPayload(req: Request): Promise<UnregisterPushPayload> {
  let body: unknown;

  try {
    body = await req.json();
  } catch (_) {
    throw new Error("Request body must be valid JSON");
  }

  if (!isRecord(body)) {
    throw new Error("Request body must be a JSON object");
  }

  return {
    fcm_token: requiredString(body.fcm_token, "fcm_token", 4096),
    app_code: optionalString(body.app_code, "app_code", 100),
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

async function disablePushRegistration(input: {
  userId: string;
  payload: UnregisterPushPayload;
}): Promise<PushRegistrationRow[]> {
  const admin = createDatabaseClient();

  // 一律用 user_id 收斂範圍：只有 token 的持有者本人能停用自己的註冊，
  // 避免任何人拿到 token 字串就能關掉別人的推播。
  // 若該裝置已被別的帳號重新註冊（user_id 已被覆蓋），這裡就查不到，
  // 也正是我們要的行為：不要動到現在使用者的註冊。
  const params: Record<string, string> = {
    user_id: `eq.${input.userId}`,
    fcm_token: `eq.${input.payload.fcm_token}`,
    select: "id,app_code,platform",
  };

  if (input.payload.app_code) {
    params.app_code = `eq.${input.payload.app_code}`;
  }

  return await restRequest<PushRegistrationRow[]>(
    admin,
    "push_registrations",
    queryString(params),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    },
  );
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
