import { optionalEnv } from "../_shared/env.ts";

const JOB_SECRET_HEADER = "x-haiglobals-job-secret";

// Constant-time compare: avoid leaking the secret through early-exit timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 沒設定 HAIGLOBALS_JOB_SECRET 時一律拒絕：避免忘記設定就等於整組系統排程 API 對外開放。
 * Never log the secret or any part of it.
 */
export function hasJobSecret(req: Request): boolean {
  const expected = optionalEnv("HAIGLOBALS_JOB_SECRET");
  if (!expected) return false;

  const actual = text(req.headers.get(JOB_SECRET_HEADER));
  return timingSafeEqual(actual, expected);
}

export function requireJobSecret(req: Request): void {
  if (!hasJobSecret(req)) {
    throw new Error("Invalid or missing job secret");
  }
}

export function isSystemAction(action: unknown): boolean {
  return typeof action === "string" && action.trim().toLowerCase().startsWith("system_");
}
