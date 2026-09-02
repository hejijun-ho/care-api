import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";
import { requireEnv } from "../_shared/env.ts";

type Action = "create" | "consume" | "refresh" | "logout";

type RequestBody = {
  action?: Action;
  code?: string;
  refresh_token?: string;
};

type SessionRpcResult = {
  user_id: string;
  session_id: string;
  refresh_token: string;
  email?: string | null;
  phone?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

const RPC_SCHEMA = "auth_bridge";
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch (_) {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const action = body.action;
  if (!action) {
    return json({ success: false, error: "Missing action" }, 400);
  }

  const config = getSupabaseRuntimeConfig();

  try {
    switch (action) {
      case "create":
        return await createHandoff(req, config);

      case "consume":
        return await consumeHandoff(body, config);

      case "refresh":
        return await refreshSession(body, config);

      case "logout":
        return await logoutSession(body, config);

      default:
        return json({ success: false, error: "Unsupported action" }, 400);
    }
  } catch (error) {
    const message = errorMessage(error);
    console.error("[cross-app-session] request failed", { action, message });
    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;

async function createHandoff(
  req: Request,
  config: ReturnType<typeof getSupabaseRuntimeConfig>,
): Promise<Response> {
  const authorization = req.headers.get("Authorization")?.trim() ?? "";

  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return json({ success: false, error: "Missing authorization header" }, 401);
  }

  // Preserve the source app user's JWT. The database function uses auth.uid().
  const code = await callRpc<string>({
    supabaseUrl: config.supabaseUrl,
    apiKey: config.supabaseAnonKey,
    authorization,
    functionName: "create_cross_app_handoff",
    body: {},
  });

  return json({
    success: true,
    code,
    expires_in: 60,
  });
}

async function consumeHandoff(
  body: RequestBody,
  config: ReturnType<typeof getSupabaseRuntimeConfig>,
): Promise<Response> {
  const code = body.code?.trim() ?? "";

  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return json({ success: false, error: "Invalid or expired handoff" }, 400);
  }

  const session = await callRpc<SessionRpcResult>({
    supabaseUrl: config.supabaseUrl,
    apiKey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    functionName: "consume_cross_app_handoff",
    body: { p_code: code },
  });

  return sessionResponse(session, config.supabaseUrl);
}

async function refreshSession(
  body: RequestBody,
  config: ReturnType<typeof getSupabaseRuntimeConfig>,
): Promise<Response> {
  const refreshToken = body.refresh_token?.trim() ?? "";

  if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) {
    return json({ success: false, error: "Invalid refresh_token" }, 400);
  }

  const session = await callRpc<SessionRpcResult>({
    supabaseUrl: config.supabaseUrl,
    apiKey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    functionName: "refresh_cross_app_session",
    body: { p_refresh_token: refreshToken },
  });

  return sessionResponse(session, config.supabaseUrl);
}

async function logoutSession(
  body: RequestBody,
  config: ReturnType<typeof getSupabaseRuntimeConfig>,
): Promise<Response> {
  const refreshToken = body.refresh_token?.trim() ?? "";

  if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) {
    return json({ success: false, error: "Invalid refresh_token" }, 400);
  }

  const revoked = await callRpc<boolean>({
    supabaseUrl: config.supabaseUrl,
    apiKey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    functionName: "revoke_cross_app_session",
    body: { p_refresh_token: refreshToken },
  });

  return json({ success: true, revoked });
}

function sessionResponse(session: SessionRpcResult, supabaseUrl: string): Response {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + ACCESS_TOKEN_TTL_SECONDS;
  const jwtSecret = requireEnv("SUPABASE_JWT_SECRET");
  const normalizedSupabaseUrl = supabaseUrl.replace(/\/+$/, "");

  const accessToken = signHs256Jwt(
    {
      iss: `${normalizedSupabaseUrl}/auth/v1`,
      aud: "authenticated",
      sub: session.user_id,
      role: "authenticated",
      iat: nowSeconds,
      exp: expiresAt,
      aal: "aal1",
      session_id: session.session_id,
      email: session.email ?? undefined,
      phone: session.phone ?? undefined,
      app_metadata: session.app_metadata ?? {},
      user_metadata: session.user_metadata ?? {},
      is_anonymous: false,
      amr: [
        {
          method: "cross_app_handoff",
          timestamp: nowSeconds,
        },
      ],
    },
    jwtSecret,
  );

  return json({
    success: true,
    access_token: accessToken,
    refresh_token: session.refresh_token,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    expires_at: expiresAt,
    session_id: session.session_id,
    user: {
      id: session.user_id,
      email: session.email ?? null,
      phone: session.phone ?? null,
      app_metadata: session.app_metadata ?? {},
      user_metadata: session.user_metadata ?? {},
    },
  });
}

async function callRpc<T>(input: {
  supabaseUrl: string;
  apiKey: string;
  authorization: string;
  functionName: string;
  body: Record<string, unknown>;
}): Promise<T> {
  const normalizedSupabaseUrl = input.supabaseUrl.replace(/\/+$/, "");

  const response = await fetch(
    `${normalizedSupabaseUrl}/rest/v1/rpc/${encodeURIComponent(input.functionName)}`,
    {
      method: "POST",
      headers: {
        apikey: input.apiKey,
        Authorization: input.authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Profile": RPC_SCHEMA,
        "Accept-Profile": RPC_SCHEMA,
      },
      body: JSON.stringify(input.body),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(readPostgrestError(text) || `RPC failed (${response.status})`);
  }

  if (!text.trim()) {
    throw new Error("RPC returned an empty response");
  }

  try {
    return JSON.parse(text) as T;
  } catch (_) {
    throw new Error("RPC returned invalid JSON");
  }
}

function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const encodedHeader = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const encodedPayload = base64UrlJson(payload);
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", secret).update(unsignedToken).digest("base64url");

  return `${unsignedToken}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readPostgrestError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const message = payload.message ?? payload.details ?? payload.hint ?? payload.code;

    return typeof message === "string" ? message : "";
  } catch (_) {
    return trimmed;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
    },
  });
}
