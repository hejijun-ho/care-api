// Send a single test FCM push via the HTTP v1 API. Zero runtime dependencies —
// uses only Node built-ins (crypto + global fetch, Node 20+). Run with tsx.
//
// Why not the Firebase console? The console's "Send test message" button sends
// a notification but makes it awkward to attach the `data` payload we need to
// test tap->navigation (audience/target/route). This script sets `data` exactly
// like the real backend does (see haiglobals-docs/modules/28_push_notifications.md §6).
//
// Usage (GOOGLE_APPLICATION_CREDENTIALS is read from .env via --env-file):
//   npm run push:test -- "<FCM_TOKEN>" [route]
//
// Examples:
//   npm run push:test -- "fMEr9x..."                 # -> /orders/test-123
//   npm run push:test -- "fMEr9x..." /returns/abc-987 # a return
//   npm run push:test -- "fMEr9x..." --data-only      # diagnose duplicate notifications
//
// Get <FCM_TOKEN> from the DB after the app registered it:
//   select fcm_token from haiglobals.push_registrations
//   where app_code = 'haiglobals_vendor' order by last_seen_at desc limit 1;

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

// --data-only: send WITHOUT a `notification` payload. Use this to diagnose duplicate
// notifications on web: when `notification` is present the Firebase JS SDK service
// worker auto-displays it, so a `showNotification()` call inside onBackgroundMessage
// produces a SECOND one. Data-only means nothing is auto-displayed and every
// notification you see came from your own service worker code.
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fcmToken = positional[0];
const route = positional[1] || "/orders/test-123";
const dataOnly = flags.includes("--data-only");

if (!credPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS (in .env) to the service account JSON path.");
  process.exit(1);
}
if (!fcmToken) {
  console.error('Usage: npm run push:test -- "<FCM_TOKEN>" [route]');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(credPath, "utf8")) as ServiceAccount;

function base64url(input: string | Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// 1) Mint a signed JWT and exchange it for an OAuth2 access token.
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = base64url(
    createSign("RSA-SHA256").update(`${header}.${claim}`).sign(sa.private_key),
  );
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

// 2) Build the same data payload shape the real backend sends.
function buildData(): Record<string, string> {
  const id = route.split("/").filter(Boolean).pop() || "";
  const isReturn = route.startsWith("/returns/");
  return {
    audience: "vendor",
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    type: isReturn ? "order_return_created" : "order_created",
    target: isReturn ? "order_return" : "order",
    route,
    ...(isReturn ? { return_id: id } : { order_id: id }),
    sent_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const accessToken = await getAccessToken();
  const message = {
    message: {
      token: fcmToken,
      // Omitted entirely in --data-only mode so the SDK auto-display never kicks in.
      ...(dataOnly
        ? {}
        : {
            notification: {
              title: "測試推播",
              body: `這是一則測試通知（route=${route}）`,
            },
          }),
      data: buildData(),
      webpush: { headers: { Urgency: "high" } },
    },
  };

  console.log(
    dataOnly
      ? "Mode: data-only (no `notification` payload — nothing is auto-displayed)"
      : "Mode: notification + data (the SDK service worker auto-displays it)",
  );

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  const json = (await res.json()) as { name?: string };
  if (!res.ok) {
    console.error(`FCM send failed (${res.status}):`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`Sent to project ${sa.project_id}:`, json.name);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
