import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { optionalEnv } from "../_shared/env.ts";
import { queryString, restRequest, selectRows, type AdminClient } from "./orders.ts";

// FCM 推播傳輸層：只負責「把訊息送到某些 user 的裝置」，不認識訂單/退貨等商業語意。
// 商業語意（要通知誰、標題內容、要跳去哪個頁面）放在 push_notifications.ts。

export type PushPlatform = "web" | "android" | "ios";

export type PushRegistrationRow = {
  id: number;
  user_id: string;
  app_code: string;
  platform: PushPlatform | string;
  fcm_token: string;
  enabled: boolean;
};

export type PushMessage = {
  title: string;
  body: string;
  // FCM data payload 只允許 string value，因此這裡固定為 Record<string, string>。
  data: Record<string, string>;
  // Web 推播點擊後要開啟的網址；未帶時 web 端只能靠 data 自行導頁。
  link?: string | null;
};

export type PushSendResult = {
  attempted: number;
  sent: number;
  failed: number;
  disabled: number;
  skippedReason?: string;
};

type MessagingLike = {
  sendEachForMulticast: (message: Record<string, unknown>) => Promise<{
    successCount: number;
    failureCount: number;
    responses: Array<{ success: boolean; error?: { code?: string; message?: string } }>;
  }>;
};

// 這些 FCM 錯誤碼代表 token 已永久失效，直接把該筆 registration 停用，避免每次都重送。
const DEAD_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// sendEachForMulticast 單次上限 500 個 token。
const MULTICAST_BATCH_SIZE = 500;

let messagingPromise: Promise<MessagingLike | null> | null = null;

export function pushDebugLog(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[push][debug] ${event}`, JSON.stringify(payload));
}

export function pushDebugWarn(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(`[push][warn] ${event}`, JSON.stringify(payload));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** 推播總開關。PUSH_ENABLED=false 可在不動 credentials 的情況下整組關掉。 */
export function isPushEnabled(): boolean {
  const flag = optionalEnv("PUSH_ENABLED").toLowerCase();
  if (!flag) return true;
  return flag !== "false" && flag !== "0" && flag !== "off";
}

/**
 * 廠商後台的 app_code 白名單。只有這些 app_code 的 registration 會收到廠商通知。
 * 逗號分隔，預設 `haiglobals_vendor`。
 */
export function getVendorAppCodes(): string[] {
  const configured = optionalEnv("PUSH_VENDOR_APP_CODES");
  const codes = (configured || "haiglobals_vendor")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code);
  return Array.from(new Set(codes));
}

/** 廠商後台網址，用來組 web 推播點擊後要開的連結。未設定時不帶 link。 */
export function getVendorAdminUrl(): string {
  return optionalEnv("VENDOR_ADMIN_URL").replace(/\/+$/, "");
}

async function loadServiceAccount(credentialsPath: string): Promise<Record<string, string>> {
  const absolutePath = isAbsolute(credentialsPath)
    ? credentialsPath
    : resolve(process.cwd(), credentialsPath);

  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, string>;

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      `Firebase service account at ${absolutePath} is missing project_id / client_email / private_key`,
    );
  }

  return parsed;
}

/**
 * 延遲初始化 Firebase Admin。
 * - 用 dynamic import，讓沒用到推播的 API 不必在 server 啟動時載入 firebase-admin。
 * - 沒設定 GOOGLE_APPLICATION_CREDENTIALS 或初始化失敗時回傳 null（不丟例外），
 *   讓呼叫端可以安靜略過推播，不影響訂單/退貨主流程。
 */
async function getMessagingClient(): Promise<MessagingLike | null> {
  if (!messagingPromise) {
    messagingPromise = (async () => {
      const credentialsPath = optionalEnv("GOOGLE_APPLICATION_CREDENTIALS");
      if (!credentialsPath) {
        pushDebugWarn("firebase.notConfigured", {
          reason: "GOOGLE_APPLICATION_CREDENTIALS is not set",
        });
        return null;
      }

      try {
        const serviceAccount = await loadServiceAccount(credentialsPath);
        const { cert, getApps, initializeApp } = await import("firebase-admin/app");
        const { getMessaging } = await import("firebase-admin/messaging");

        const appName = "haiglobals-push";
        const existing = getApps().find((app) => app.name === appName);
        const app =
          existing ??
          initializeApp(
            {
              credential: cert({
                projectId: serviceAccount.project_id,
                clientEmail: serviceAccount.client_email,
                privateKey: serviceAccount.private_key,
              }),
            },
            appName,
          );

        pushDebugLog("firebase.initialized", {
          project_id: serviceAccount.project_id,
          client_email: serviceAccount.client_email,
        });

        return getMessaging(app) as unknown as MessagingLike;
      } catch (error) {
        pushDebugWarn("firebase.initFailed", {
          credentialsPath,
          error: errorText(error),
        });
        return null;
      }
    })();
  }

  return await messagingPromise;
}

/** 取出這些 user 在這些 app 上、還啟用中的推播註冊。 */
export async function fetchPushRegistrations(
  admin: AdminClient,
  userIds: string[],
  appCodes: string[],
): Promise<PushRegistrationRow[]> {
  const uniqueUserIds = Array.from(new Set(userIds.map(text).filter((id) => id)));
  const uniqueAppCodes = Array.from(new Set(appCodes.map(text).filter((code) => code)));

  if (!uniqueUserIds.length || !uniqueAppCodes.length) return [];

  return await selectRows<PushRegistrationRow>(admin, "push_registrations", {
    select: "id,user_id,app_code,platform,fcm_token,enabled",
    user_id: `in.(${uniqueUserIds.join(",")})`,
    app_code: `in.(${uniqueAppCodes.map((code) => `"${code}"`).join(",")})`,
    enabled: "is.true",
  });
}

/** 把已失效的 registration 標成 enabled=false（用 id 更新，避免 token 進 query string）。 */
async function disableRegistrations(admin: AdminClient, ids: number[]): Promise<number> {
  const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id))));
  if (!uniqueIds.length) return 0;

  try {
    await restRequest<void>(
      admin,
      "push_registrations",
      queryString({ id: `in.(${uniqueIds.join(",")})` }),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
      },
    );
    return uniqueIds.length;
  } catch (error) {
    pushDebugWarn("registration.disableFailed", {
      ids: uniqueIds,
      error: errorText(error),
    });
    return 0;
  }
}

function buildMulticastMessage(tokens: string[], message: PushMessage): Record<string, unknown> {
  const link = text(message.link);

  return {
    tokens,
    notification: {
      title: message.title,
      body: message.body,
    },
    data: message.data,
    android: {
      priority: "high",
      notification: {
        // Flutter 前景/背景點擊事件都靠這個 action 觸發。
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title: message.title, body: message.body },
          sound: "default",
          category: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
    },
    webpush: {
      notification: {
        title: message.title,
        body: message.body,
      },
      ...(link ? { fcmOptions: { link } } : {}),
    },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/**
 * 送推播給指定 user 的所有裝置。
 * 這個函式**永遠不會丟例外**：推播失敗只記 log，不能影響訂單/退貨主流程。
 */
export async function sendPushToUsers(
  admin: AdminClient,
  input: {
    userIds: string[];
    appCodes: string[];
    message: PushMessage;
  },
): Promise<PushSendResult> {
  const empty: PushSendResult = { attempted: 0, sent: 0, failed: 0, disabled: 0 };

  if (!isPushEnabled()) {
    return { ...empty, skippedReason: "push_disabled" };
  }

  try {
    const registrations = await fetchPushRegistrations(admin, input.userIds, input.appCodes);
    if (!registrations.length) {
      return { ...empty, skippedReason: "no_registrations" };
    }

    const messaging = await getMessagingClient();
    if (!messaging) {
      return { ...empty, skippedReason: "firebase_not_configured" };
    }

    // 同一個 token 可能被多筆 registration 共用（換帳號登入），送一次就好。
    const byToken = new Map<string, PushRegistrationRow>();
    for (const registration of registrations) {
      const token = text(registration.fcm_token);
      if (token && !byToken.has(token)) byToken.set(token, registration);
    }

    const tokens = Array.from(byToken.keys());
    const deadRegistrationIds: number[] = [];
    let sent = 0;
    let failed = 0;

    for (const batch of chunk(tokens, MULTICAST_BATCH_SIZE)) {
      const response = await messaging.sendEachForMulticast(
        buildMulticastMessage(batch, input.message),
      );

      sent += response.successCount;
      failed += response.failureCount;

      response.responses.forEach((result, index) => {
        if (result.success) return;

        const code = text(result.error?.code);
        const token = batch[index];
        const registration = token ? byToken.get(token) : undefined;

        if (DEAD_TOKEN_ERROR_CODES.has(code) && registration?.id) {
          deadRegistrationIds.push(registration.id);
        }

        pushDebugWarn("send.tokenFailed", {
          registration_id: registration?.id ?? null,
          user_id: registration?.user_id ?? null,
          platform: registration?.platform ?? null,
          code: code || null,
          message: text(result.error?.message) || null,
        });
      });
    }

    const disabled = await disableRegistrations(admin, deadRegistrationIds);

    pushDebugLog("send.done", {
      type: input.message.data.type ?? null,
      user_ids: Array.from(new Set(input.userIds)),
      attempted: tokens.length,
      sent,
      failed,
      disabled,
    });

    return { attempted: tokens.length, sent, failed, disabled };
  } catch (error) {
    pushDebugWarn("send.failed", {
      type: input.message.data?.type ?? null,
      error: errorText(error),
    });
    return { ...empty, skippedReason: "error" };
  }
}
