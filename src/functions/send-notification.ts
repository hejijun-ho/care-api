import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { translateTexts } from "./translate.ts";

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

// ── 依收訊者語言在地化 ──────────────────────────────────────────────────────
// 推播是「發訊端組文案、收訊端收」，所以收訊者的語言必須在**這裡**才查得到——
// 發訊的 DB 觸發器不知道對方看什麼語言。
//
// 推播內文的四段式約定（呼叫端負責拆，這裡負責翻與組裝）：
//   body_prefix     姓名等使用者資料 —— **一個字都不翻**
//   body_prefix_tr  前綴裡可以翻的部分（服務類型「居家陪伴」）—— App 各處都翻它，
//                   推播不翻就前後不一致
//   body            固定句子或含 %s/%d 的模板 —— 翻譯的對象
//   body_values     填進模板的動態值（金額）—— 翻完才填，所以快取鍵是靜態模板
// 整串送去機器翻譯等於把姓名送出去，而且每個姓名都是新的快取鍵、永遠不命中。
// `body_prefix` 或 `body_prefix_tr` **任一個 key 存在**＝呼叫端採用了這個約定，
// 也就是 body 可以翻；兩個都沒有就保守地原樣送出。

/// 取每位收訊者的語言（user_settings.language）；查不到或失敗一律當 zh-TW。
async function languagesForUsers(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!userIds.length) return out;
  try {
    for (const group of chunk(userIds, 200)) {
      const rows = await publicRest<Array<{ user_id: string; language: string | null }>>(
        "user_settings",
        new URLSearchParams({
          select: "user_id,language",
          user_id: `in.(${group.join(",")})`,
        }),
      );
      for (const r of rows) {
        const lang = (r.language ?? "").trim();
        if (lang) out.set(r.user_id, lang);
      }
    }
  } catch (e) {
    // 查不到語言就全部用中文送出，不因為在地化失敗而漏送推播。
    console.error("[send-notification] language lookup failed", { message: errorMessage(e) });
  }
  return out;
}

/// 把 title / body / 可翻前綴翻成 [lang]。任何失敗都回原文——推播寧可是中文，也不能不送。
async function localize(
  title: string,
  body: string,
  prefixTr: string,
  lang: string,
): Promise<{ title: string; body: string; prefixTr: string }> {
  if (!lang || lang === "zh-TW" || (!title && !body && !prefixTr)) return { title, body, prefixTr };
  try {
    const { translations } = await translateTexts([title, body, prefixTr], "zh-TW", lang);
    return {
      title: translations[0] ?? title,
      body: translations[1] ?? body,
      prefixTr: translations[2] ?? prefixTr,
    };
  } catch (e) {
    console.error("[send-notification] localize failed", { lang, message: errorMessage(e) });
    return { title, body, prefixTr };
  }
}

/// 把翻好的句子填上動態值。**值不進機器翻譯**：模板是靜態的，快取鍵才穩定
/// （與 app 端 `ref.tr(模板).replaceFirst('%d', 值)` 是同一套做法）。
/// ⚠ 依 token 在譯文中出現的**順序**填。單一 token 時沒有風險；多個 token 的模板
/// 若譯者調換了順序，值會跟著換位——校訂驗收有「多佔位符有序序列」檢查在擋。
export function fillValues(text: string, values: string[]): string {
  if (!values.length) return text;
  let i = 0;
  return text.replace(/%[ds]/g, (whole) => (i < values.length ? values[i++] : whole));
}

/// 組出最後的推播內文：姓名（不翻）・服務類型（已翻）＋ 空白 ＋ 填好值的句子（已翻）。
/// 空的段落一律略過，不會留下孤零零的「・」或多餘空白。
/// 匯出供測試（tests/notification_body_test.ts）；正式流程只由本檔內部呼叫。
export function composeBody(
  prefix: string,
  prefixTr: string,
  body: string,
  values: string[],
): string {
  const head = [prefix, prefixTr].filter((x) => x).join("・");
  return [head, fillValues(body, values)].filter((x) => x).join(" ");
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
    // 動態前綴（被照顧者姓名・服務類型…）：原樣接在譯文前面，**永不送去翻譯**。
    // 這個 **key 存在與否**＝呼叫端是否採用「前綴／句子分開」的約定，也就是 body 可不可以翻。
    // 值可以是空字串（例如服務類型剛好沒填），那仍代表 body 是乾淨的句子、可以翻。
    const bodySplit =
      Object.prototype.hasOwnProperty.call(body, "body_prefix") ||
      Object.prototype.hasOwnProperty.call(body, "body_prefix_tr");
    const bodyPrefix = String(body.body_prefix ?? "").trim();
    // 前綴裡**可以翻**的那一段（服務類型「居家陪伴」之類）。姓名放 body_prefix 永不翻，
    // 服務類型放這裡——App 各處都是 `ref.tr(serviceType)`，推播不翻就前後不一致。
    const bodyPrefixTr = String(body.body_prefix_tr ?? "").trim();
    // 句子裡的動態值（金額…）。模板留在 body、翻完才填，快取鍵才穩定。
    const bodyValues = Array.isArray(body.body_values)
      ? (body.body_values as unknown[]).map((v) => String(v ?? ""))
      : [];
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

    // 依收訊者語言分組：同一則推播，中文使用者收中文、印尼看護收印尼文。
    // 查不到語言的一律當 zh-TW（＝原文，不經翻譯）。
    const langByUser = await languagesForUsers(
      Array.from(new Set(deliverable.map((t) => t.user_id).filter(Boolean))),
    );
    const byLang = new Map<string, TokenRow[]>();
    for (const row of deliverable) {
      const lang = langByUser.get(row.user_id) || "zh-TW";
      const bucket = byLang.get(lang);
      if (bucket) bucket.push(row);
      else byLang.set(lang, [row]);
    }

    let sent = 0;
    let failed = 0;
    const deadIds: string[] = [];
    for (const [lang, rows] of byLang) {
      // ⚠ 安全預設：**沒有帶 body_prefix 就不翻 body**。
      // 現有呼叫端（DB 觸發器、app 聊天推播）傳來的 body 是已經把姓名／訊息內容組進去的
      // 完整字串，整串送去翻譯等於把使用者資料送出去。呼叫端要先把動態值拆到
      // body_prefix、把固定句子留在 body，才代表「這句可以翻」。
      // 標題不受此限——DB 那邊的 title 全是固定片語（「有買家出價」「服務已完成」…）。
      const localized = await localize(
        title,
        bodySplit ? messageBody : "",
        bodySplit ? bodyPrefixTr : "",
        lang,
      );
      const finalBody = bodySplit
        ? composeBody(bodyPrefix, localized.prefixTr, localized.body, bodyValues)
        : messageBody;
      const data: Record<string, string> = {
        event: "notify",
        route,
        title: localized.title,
        body: finalBody,
      };
      for (const group of chunk(rows, MULTICAST_CHUNK)) {
      const response = await (await messaging()).sendEachForMulticast({
        tokens: group.map((row) => row.fcm_token),
        notification: { title: localized.title || "通知", body: finalBody },
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
