import { createPrivateKey, createSign } from "node:crypto";
import { connect as http2Connect } from "node:http2";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

type JsonRecord = Record<string, unknown>;

type CallRow = {
  id: string;
  caller_user_id: string;
  callee_user_id: string;
  caller_role: "client" | "caregiver";
  media: "audio" | "video";
  status: string;
};

type TokenRow = {
  id: string;
  fcm_token: string;
};

type VoipTokenRow = {
  id: string;
  voip_token: string;
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

// care-api 跑在宿主機 PM2；SUPABASE_URL 可能是只在 Docker network 可解析的
// `http://kong:8000`，因此宿主機對 Auth/PostgREST 優先走公開 staging URL。
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
  // care 資料在專屬 schema（2026-08-05 由 public 搬到 pro_care_matching）；PostgREST 需
  // 指定該 schema，否則會查到不存在的 public.* 而失敗。可用 CARE_DB_SCHEMA 覆蓋。
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

async function disableDeadVoipTokens(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const query = new URLSearchParams({ id: `in.(${ids.join(",")})` });
  await publicRest<void>("user_voip_tokens", query, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
  });
}

// ── APNs VoIP（iOS 背景/鎖屏/終止來電：PushKit → CallKit）────────────────────
//
// iOS 沒有可靠的 FCM data message 背景通道（會被節流、終止時不喚醒），來電只能走
// APNs 的 voip push type。app 端由 AppDelegate 的 PKPushRegistryDelegate 接住並
// 立刻彈 CallKit。payload 與 FCM data（shape A）完全相同，讓兩平台共用同一套
// 接聽/取消契約（CallKit id = callId = call_sessions.id）。
//
// 需要的環境變數（缺任一 → 靜默略過 iOS 通道，不影響 Android）：
//   APNS_KEY_P8（.p8 內容）或 CARE_APNS_KEY_FILE（.p8 路徑）
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//   APNS_ENV：production 走 api.push.apple.com，其餘走 sandbox。

type ApnsConfig = {
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
};

async function apnsConfig(): Promise<ApnsConfig | null> {
  const keyId = process.env.APNS_KEY_ID?.trim() ?? "";
  const teamId = process.env.APNS_TEAM_ID?.trim() ?? "";
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() ?? "";
  const inline = process.env.APNS_KEY_P8?.trim() ?? "";
  const keyFile = process.env.CARE_APNS_KEY_FILE?.trim() ?? "";
  if (!keyId || !teamId || !bundleId || (!inline && !keyFile)) return null;

  const key = inline
    ? inline
    : await readFile(isAbsolute(keyFile) ? keyFile : resolve(process.cwd(), keyFile), "utf8");
  const host =
    (process.env.APNS_ENV?.trim() ?? "") === "production"
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";
  return { key, keyId, teamId, bundleId, host };
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// APNs 要求 provider token 介於 20 分鐘～1 小時新；快取 45 分鐘內重用。
let apnsJwtCache: { jwt: string; issuedAt: number } | undefined;

function apnsJwt(config: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && now - apnsJwtCache.issuedAt < 45 * 60) return apnsJwtCache.jwt;

  const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = b64url(Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })));
  const unsigned = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(unsigned)
    .sign({ key: createPrivateKey(config.key), dsaEncoding: "ieee-p1363" });
  const jwt = `${unsigned}.${b64url(signature)}`;
  apnsJwtCache = { jwt, issuedAt: now };
  return jwt;
}

type ApnsResult = { ok: boolean; status: number; reason: string };

// Node 的 fetch（undici）不支援 APNs 必須的 HTTP/2，故用 node:http2 直連。
function sendApnsVoip(
  config: ApnsConfig,
  voipToken: string,
  payload: JsonRecord,
): Promise<ApnsResult> {
  return new Promise((resolvePromise) => {
    const session = http2Connect(`https://${config.host}`);
    const finish = (result: ApnsResult) => {
      session.close();
      resolvePromise(result);
    };
    session.on("error", (error) =>
      finish({ ok: false, status: 0, reason: errorMessage(error) }),
    );
    // APNs 連不上時不能讓整個 handler 卡住（app 端 15s 就放棄了）。
    session.setTimeout(10_000, () => finish({ ok: false, status: 0, reason: "timeout" }));

    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${voipToken}`,
      authorization: `bearer ${apnsJwt(config)}`,
      "apns-topic": `${config.bundleId}.voip`,
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": `${Math.floor(Date.now() / 1000) + 60}`,
      "content-type": "application/json",
    });
    request.setEncoding("utf8");

    let status = 0;
    let body = "";
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      let reason = "";
      try {
        reason = String((JSON.parse(body) as JsonRecord).reason ?? "");
      } catch {
        /* 2xx 無 body */
      }
      finish({ ok: status >= 200 && status < 300, status, reason });
    });
    request.on("error", (error) =>
      finish({ ok: false, status: 0, reason: errorMessage(error) }),
    );
    request.end(JSON.stringify(payload));
  });
}

const handleRequest = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const userId = await authenticatedUserId(req);
    const body = (await req.json()) as JsonRecord;
    const callId = String(body.call_id ?? "").trim();
    if (!isUuid(callId)) return json({ error: "call_id must be a UUID" }, 400);

    const callQuery = new URLSearchParams({
      select: "id,caller_user_id,callee_user_id,caller_role,media,status",
      id: `eq.${callId}`,
      limit: "1",
    });
    const [call] = await publicRest<CallRow[]>("call_sessions", callQuery);
    if (!call) return json({ error: "Call not found" }, 404);
    if (call.caller_user_id !== userId) return json({ error: "Forbidden" }, 403);
    if (call.status !== "ringing") return json({ ok: true, skipped: "not_ringing" });

    const [profile, tokens, voipTokens] = await Promise.all([
      publicRest<Array<{ display_name?: string | null }>>(
        "user_profiles",
        new URLSearchParams({
          select: "display_name",
          id: `eq.${call.caller_user_id}`,
          limit: "1",
        }),
      ),
      publicRest<TokenRow[]>(
        "user_fcm_tokens",
        new URLSearchParams({
          select: "id,fcm_token",
          user_id: `eq.${call.callee_user_id}`,
          platform: "eq.android",
          is_active: "eq.true",
        }),
      ),
      publicRest<VoipTokenRow[]>(
        "user_voip_tokens",
        new URLSearchParams({
          select: "id,voip_token",
          user_id: `eq.${call.callee_user_id}`,
          is_active: "eq.true",
        }),
      ),
    ]);

    // 兩平台共用的來電 payload（shape A）。iOS AppDelegate 與 Android receiver
    // 都以 callId 作為 CallKit 的 call id，取消時才收得掉同一通。
    const invite = {
      event: "call_invite",
      type: "video_call",
      callId: call.id,
      callerId: call.caller_user_id,
      callerName: profile[0]?.display_name?.trim() || "來電",
      callerRole: call.caller_role,
      media: call.media,
    };

    const uniqueTokens = Array.from(
      new Map(tokens.map((row) => [row.fcm_token, row])).values(),
    );
    const uniqueVoip = Array.from(
      new Map(voipTokens.map((row) => [row.voip_token, row])).values(),
    );
    if (!uniqueTokens.length && !uniqueVoip.length) {
      return json({ ok: true, attempted: 0, sent: 0, failed: 0, skipped: "no_tokens" });
    }

    // Android：FCM data message（原生 receiver 全螢幕來電）。行為與 iOS 支援前完全相同。
    let fcmSent = 0;
    let fcmFailed = 0;
    let fcmDisabled = 0;
    if (uniqueTokens.length) {
      const response = await (await messaging()).sendEachForMulticast({
        tokens: uniqueTokens.map((row) => row.fcm_token),
        data: invite,
        android: { priority: "high", ttl: 60_000 },
      });
      fcmSent = response.successCount;
      fcmFailed = response.failureCount;

      const deadIds: string[] = [];
      response.responses.forEach((result, index) => {
        if (!result.success && deadTokenCodes.has(result.error?.code ?? "")) {
          deadIds.push(uniqueTokens[index].id);
        }
      });
      await disableDeadTokens(deadIds);
      fcmDisabled = deadIds.length;
    }

    // iOS：APNs VoIP。未設定 APNs 金鑰時靜默略過（Android 部署不受影響）。
    let voipSent = 0;
    let voipFailed = 0;
    let voipDisabled = 0;
    const apns = uniqueVoip.length ? await apnsConfig() : null;
    if (uniqueVoip.length && !apns) {
      console.warn("[send-call-push] APNs not configured; skipped iOS voip tokens", {
        call_id: call.id,
        voip_tokens: uniqueVoip.length,
      });
    }
    if (apns) {
      const deadVoipIds: string[] = [];
      for (const row of uniqueVoip) {
        const result = await sendApnsVoip(apns, row.voip_token, invite);
        if (result.ok) {
          voipSent++;
        } else {
          voipFailed++;
          console.error("[send-call-push] voip send failed", {
            call_id: call.id,
            status: result.status,
            reason: result.reason,
          });
          // 410 Unregistered / BadDeviceToken → 停用，之後不再嘗試。
          if (result.status === 410 || result.reason === "BadDeviceToken") {
            deadVoipIds.push(row.id);
          }
        }
      }
      await disableDeadVoipTokens(deadVoipIds);
      voipDisabled = deadVoipIds.length;
    }

    console.log("[send-call-push] completed", {
      call_id: call.id,
      attempted: uniqueTokens.length,
      sent: fcmSent,
      failed: fcmFailed,
      disabled: fcmDisabled,
      voip_attempted: uniqueVoip.length,
      voip_sent: voipSent,
      voip_failed: voipFailed,
      voip_disabled: voipDisabled,
    });
    return json({
      ok: true,
      attempted: uniqueTokens.length,
      sent: fcmSent,
      failed: fcmFailed,
      disabled: fcmDisabled,
      voip_attempted: uniqueVoip.length,
      voip_sent: voipSent,
      voip_failed: voipFailed,
      voip_disabled: voipDisabled,
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = /bearer token|session/i.test(message) ? 401 : 500;
    console.error("[send-call-push] failed", { message });
    return json({ error: message }, status);
  }
};

export default handleRequest;
