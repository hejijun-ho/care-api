import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

// 一般推播（訊息／待處理事項／公告）。與 send-call-push 完全獨立、互不影響通話：
//  - data.event = "notify"（通話是 "call_invite"/"call_cancel"，走 CallKit，不進這裡）
//  - 帶 notification block → 背景/終止由系統顯示；前景由 app 端 LocalNotifications 顯示
//  - data.route 決定點擊後導到 app 哪頁或哪個網址（見 app 的 NotificationRouter）
//
// 授權：
//  - 帶 service_role key（controller / 後端排程）→ 特權：可 broadcast / user_ids / to_user_id
//  - 一般登入者 → 只能對「已有聊天關係」的單一 to_user_id 發（供 app 訊息推播使用）

type JsonRecord = Record<string, unknown>;

type TokenRow = {
  id: string;
  fcm_token: string;
  user_id: string;
  platform?: string;
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

// sendEachForMulticast 單次上限 500 個 token。
const MULTICAST_CHUNK = 500;

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

async function authenticatedUserId(token: string): Promise<string> {
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
    // 用不同 app name，與 send-call-push 的 "care-call-push" 各自初始化、互不干擾。
    const appName = "care-notification";
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

/// 是否為既有聊天對象（一般登入者只能推播給已有聊天關係者，防濫發）。
async function hasChatRelation(actorId: string, targetId: string): Promise<boolean> {
  const query = new URLSearchParams({ select: "id", limit: "1" });
  query.set(
    "or",
    `(and(client_user_id.eq.${actorId},caregiver_user_id.eq.${targetId}),` +
      `and(caregiver_user_id.eq.${actorId},client_user_id.eq.${targetId}))`,
  );
  const rows = await publicRest<Array<{ id: string }>>("chat_threads", query);
  return rows.length > 0;
}

// 一般通知 Android 與 iOS 都送（iOS 的 FCM token 於 2026-09-01 起會註冊進來；
// notification block 由 FCM 轉 APNs alert 顯示）。只有「來電」在 iOS 走 VoIP 專軌。
async function activeTokensForUsers(userIds: string[]): Promise<TokenRow[]> {
  if (!userIds.length) return [];
  const query = new URLSearchParams({
    select: "id,fcm_token,user_id,platform",
    user_id: `in.(${userIds.join(",")})`,
    platform: "in.(android,ios)",
    is_active: "eq.true",
  });
  return publicRest<TokenRow[]>("user_fcm_tokens", query);
}

async function allActiveTokens(): Promise<TokenRow[]> {
  const query = new URLSearchParams({
    select: "id,fcm_token,user_id,platform",
    platform: "in.(android,ios)",
    is_active: "eq.true",
  });
  return publicRest<TokenRow[]>("user_fcm_tokens", query);
}

/// 「已刪除」帳號的 user_id（account_status.deleted_at 非空）。送出前排除之。
/// 縱深防禦：DB 觸發器已在關閉帳號時停用其 token，這裡再擋一層。
async function deletedUserIds(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userIds.length) return out;
  for (const group of chunk(userIds, 200)) {
    const rows = await publicRest<Array<{ user_id: string }>>(
      "account_status",
      new URLSearchParams({
        select: "user_id",
        deleted_at: "not.is.null",
        user_id: `in.(${group.join(",")})`,
      }),
    );
    for (const r of rows) out.add(r.user_id);
  }
  return out;
}

/// 廣播/多人推播去重：向 DB claim 一個 idempotency key（視窗內重複回 false → 不送）。
/// best-effort：查詢失敗一律放行，不因去重機制擋掉正常推播。
async function tryClaimIdem(key: string, windowSeconds = 60): Promise<boolean> {
  try {
    const res = await publicRest<unknown>(
      "rpc/try_claim_push_idem",
      new URLSearchParams(),
      {
        method: "POST",
        body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds }),
      },
    );
    if (typeof res === "boolean") return res;
    if (Array.isArray(res) && typeof res[0] === "boolean") return res[0];
    return true;
  } catch {
    return true;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const handleRequest = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const token = bearerToken(req);
    if (!token) return json({ error: "Missing bearer token" }, 401);
    // 特權：service_role key，或專用的 CRON 密鑰（給 pg_cron 排程推播用；最小權限，
    // 只能打這支端點、不能當 service_role 用）。
    const cronSecret = process.env.CRON_PUSH_SECRET?.trim() ?? "";
    const privileged =
      token === env("SUPABASE_SERVICE_ROLE_KEY") ||
      (cronSecret.length > 0 && token === cronSecret);

    const body = (await req.json()) as JsonRecord;
    const title = String(body.title ?? "").trim();
    const messageBody = String(body.body ?? "").trim();
    const route = String(body.route ?? "").trim();
    if (!title && !messageBody) {
      return json({ error: "title or body is required" }, 400);
    }

    const toUserId = String(body.to_user_id ?? "").trim();
    const userIds = Array.isArray(body.user_ids)
      ? body.user_ids.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const broadcast = body.broadcast === true;

    // ② 廣播/多人推播去重（防按兩下＝兩則真廣播）。只作用於特權「大量推送」；
    //    單人推播、聊天訊息、排程提醒(單人)都不受影響。
    if (privileged && (broadcast || userIds.length)) {
      const idemKey = createHash("sha256")
        .update(
          [
            broadcast ? "B" : "U",
            title,
            messageBody,
            route,
            broadcast ? "*" : userIds.slice().sort().join(","),
          ].join(""),
        )
        .digest("hex");
      const fresh = await tryClaimIdem(idemKey, 60);
      if (!fresh) {
        return json({ ok: true, attempted: 0, sent: 0, failed: 0, skipped: "duplicate" });
      }
    }

    // 決定收件對象與拉 token。
    let tokens: TokenRow[];
    if (privileged) {
      if (broadcast) {
        tokens = await allActiveTokens();
      } else {
        const targets = userIds.length ? userIds : toUserId ? [toUserId] : [];
        const valid = targets.filter(isUuid);
        if (!valid.length) {
          return json({ error: "broadcast, user_ids, or to_user_id required" }, 400);
        }
        tokens = await activeTokensForUsers(valid);
      }
    } else {
      // 一般登入者：只能對單一、已有聊天關係的對象發。
      if (broadcast || userIds.length) return json({ error: "Forbidden" }, 403);
      if (!isUuid(toUserId)) return json({ error: "to_user_id must be a UUID" }, 400);
      const actorId = await authenticatedUserId(token);
      if (actorId !== toUserId && !(await hasChatRelation(actorId, toUserId))) {
        return json({ error: "Forbidden" }, 403);
      }
      tokens = await activeTokensForUsers([toUserId]);
    }

    const uniqueTokens = Array.from(
      new Map(tokens.map((row) => [row.fcm_token, row])).values(),
    );

    // ③ 縱深防禦：即使有殘留 token，也不推給「已刪除」帳號。查狀態失敗則放行
    //    （DB 觸發器已在源頭停用已刪除帳號的 token，此處僅為第二層保險）。
    let deliverable = uniqueTokens;
    try {
      const owners = Array.from(
        new Set(uniqueTokens.map((t) => t.user_id).filter(Boolean)),
      );
      const deleted = await deletedUserIds(owners);
      if (deleted.size) {
        deliverable = uniqueTokens.filter((t) => !deleted.has(t.user_id));
      }
    } catch {
      // ignore：維持原清單。
    }

    if (!deliverable.length) {
      return json({ ok: true, attempted: 0, sent: 0, failed: 0, skipped: "no_tokens" });
    }

    const data: Record<string, string> = { event: "notify", route, title, body: messageBody };

    let sent = 0;
    let failed = 0;
    const deadIds: string[] = [];
    for (const group of chunk(deliverable, MULTICAST_CHUNK)) {
      const response = await (await messaging()).sendEachForMulticast({
        tokens: group.map((row) => row.fcm_token),
        notification: { title: title || "通知", body: messageBody },
        data,
        android: {
          priority: "high",
          ttl: 24 * 60 * 60 * 1000,
          notification: { channelId: "general", sound: "default" },
        },
        // iOS：android block 的 sound 不適用，提示音要在 aps 自帶；alert 由 FCM
        // 從 notification block 自動產生並與此 merge（2026-09-01 真機驗證：帶
        // aps.sound 不會影響顯示，通知在鎖屏/通知中心正常出現）。
        apns: {
          headers: { "apns-priority": "10" },
          payload: { aps: { sound: "default" } },
        },
      });
      sent += response.successCount;
      failed += response.failureCount;
      response.responses.forEach((result, index) => {
        if (result.success) return;
        // 失敗都要留下平台與錯誤碼，否則 iOS/Android 哪邊壞了無從查起。
        console.error("[send-notification] send failed", {
          platform: group[index].platform ?? "?",
          code: result.error?.code ?? "?",
          message: result.error?.message ?? "",
        });
        if (deadTokenCodes.has(result.error?.code ?? "")) {
          deadIds.push(group[index].id);
        }
      });
    }
    await disableDeadTokens(deadIds);

    console.log("[send-notification] completed", {
      mode: privileged ? (broadcast ? "broadcast" : "privileged") : "peer",
      attempted: deliverable.length,
      sent,
      failed,
      disabled: deadIds.length,
    });
    return json({
      ok: true,
      attempted: deliverable.length,
      sent,
      failed,
      disabled: deadIds.length,
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = /bearer token|session/i.test(message) ? 401 : 500;
    console.error("[send-notification] failed", { message });
    return json({ error: message }, status);
  }
};

export default handleRequest;
