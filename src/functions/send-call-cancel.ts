import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

type JsonRecord = Record<string, unknown>;

type CallRow = {
  id: string;
  caller_user_id: string;
  callee_user_id: string;
};

type TokenRow = {
  id: string;
  fcm_token: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const deadTokenCodes = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

let messagingPromise: Promise<Messaging> | undefined;

function env(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function supabaseUrl(): string {
  return (process.env.SUPABASE_PUBLIC_URL?.trim() || env("SUPABASE_URL")).replace(/\/+$/, "");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function authenticatedUserId(req: Request): Promise<string> {
  const token = bearerToken(req);
  if (!token) throw new Error("Missing bearer token");

  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: env("SUPABASE_ANON_KEY"),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error("Invalid or expired session");

  const user = (await response.json()) as JsonRecord;
  const id = String(user.id ?? user.sub ?? "").trim();
  if (!id) throw new Error("Authenticated user id is missing");
  return id;
}

async function publicRest<T>(
  table: string,
  query: URLSearchParams,
  init: RequestInit = {},
): Promise<T> {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const schema = process.env.CARE_DB_SCHEMA?.trim() || "pro_care_matching";
  const url = `${supabaseUrl()}/rest/v1/${table}?${query}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceKey);
  headers.set("Authorization", `Bearer ${serviceKey}`);
  headers.set("Accept-Profile", schema);
  headers.set("Content-Profile", schema);
  headers.set("Content-Type", "application/json");

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Supabase REST request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function readServiceAccount(): Promise<Record<string, string>> {
  const inline = process.env.FCM_SERVICE_ACCOUNT?.trim();
  const raw = inline
    ? inline
    : await readFile(
        isAbsolute(env("CARE_FCM_SERVICE_ACCOUNT_FILE"))
          ? env("CARE_FCM_SERVICE_ACCOUNT_FILE")
          : resolve(process.cwd(), env("CARE_FCM_SERVICE_ACCOUNT_FILE")),
        "utf8",
      );
  const account = JSON.parse(raw) as Record<string, string>;
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error("Firebase service account is missing required fields");
  }
  return account;
}

async function messaging(): Promise<Messaging> {
  messagingPromise ??= (async () => {
    const account = await readServiceAccount();
    const appName = "care-call-push";
    let app: App | undefined = getApps().find((candidate) => candidate.name === appName);
    app ??= initializeApp(
      {
        credential: cert({
          projectId: account.project_id,
          clientEmail: account.client_email,
          privateKey: account.private_key,
        }),
      },
      appName,
    );
    return getMessaging(app);
  })();
  return await messagingPromise;
}

async function disableDeadTokens(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const query = new URLSearchParams({ id: `in.(${ids.join(",")})` });
  await publicRest<void>("user_fcm_tokens", query, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
  });
}

// 撥出方掛斷/取消 → 通知被叫方把還在響的 CallKit 來電畫面收掉。被叫方在響鈴時
// CallKit 蓋在最上層、Flutter 被暫停，realtime/輪詢收不到取消，只能靠這則推播。
// 不要求 call 仍是 ringing（呼叫時通常已被 end_call 改成 cancelled）。
const handleRequest = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const userId = await authenticatedUserId(req);
    const body = (await req.json()) as JsonRecord;
    const callId = String(body.call_id ?? "").trim();
    if (!isUuid(callId)) return json({ error: "call_id must be a UUID" }, 400);

    const callQuery = new URLSearchParams({
      select: "id,caller_user_id,callee_user_id",
      id: `eq.${callId}`,
      limit: "1",
    });
    const [call] = await publicRest<CallRow[]>("call_sessions", callQuery);
    if (!call) return json({ error: "Call not found" }, 404);
    // 只有這通的參與者能取消它的來電畫面（撥出方掛斷是主要情境）。
    if (call.caller_user_id !== userId && call.callee_user_id !== userId) {
      return json({ error: "Forbidden" }, 403);
    }

    // Android + iOS 都送：iOS 的來電雖走 APNs VoIP 顯示，但「取消」依 Apple 規定
    // 不能用 voip push（每則 voip push 都必須 report 新來電），只能走一般 FCM 的
    // content-available 背景訊息叫 Dart handler 收掉 CallKit；送不到時靠來電顯示
    // 端的 45 秒逾時保底。
    const tokens = await publicRest<TokenRow[]>(
      "user_fcm_tokens",
      new URLSearchParams({
        select: "id,fcm_token",
        user_id: `eq.${call.callee_user_id}`,
        platform: "in.(android,ios)",
        is_active: "eq.true",
      }),
    );

    const uniqueTokens = Array.from(
      new Map(tokens.map((row) => [row.fcm_token, row])).values(),
    );
    if (!uniqueTokens.length) {
      return json({ ok: true, attempted: 0, sent: 0, failed: 0, skipped: "no_tokens" });
    }

    const response = await (await messaging()).sendEachForMulticast({
      tokens: uniqueTokens.map((row) => row.fcm_token),
      data: {
        event: "call_cancel",
        callId: call.id,
      },
      android: { priority: "high", ttl: 60_000 },
      // iOS：data-only 訊息要能在背景喚醒 app，必須帶 content-available 背景推播
      //（apns-priority 依 Apple 規定背景推播只能用 5）。Android token 不受此段影響。
      apns: {
        headers: {
          "apns-push-type": "background",
          "apns-priority": "5",
          "apns-expiration": `${Math.floor(Date.now() / 1000) + 60}`,
        },
        payload: { aps: { contentAvailable: true } },
      },
    });

    const deadIds: string[] = [];
    response.responses.forEach((result, index) => {
      if (!result.success && deadTokenCodes.has(result.error?.code ?? "")) {
        deadIds.push(uniqueTokens[index].id);
      }
    });
    await disableDeadTokens(deadIds);

    console.log("[send-call-cancel] completed", {
      call_id: call.id,
      attempted: uniqueTokens.length,
      sent: response.successCount,
      failed: response.failureCount,
      disabled: deadIds.length,
    });
    return json({
      ok: true,
      attempted: uniqueTokens.length,
      sent: response.successCount,
      failed: response.failureCount,
      disabled: deadIds.length,
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = /bearer token|session/i.test(message) ? 401 : 500;
    console.error("[send-call-cancel] failed", { message });
    return json({ error: message }, status);
  }
};

export default handleRequest;
