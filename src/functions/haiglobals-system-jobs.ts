import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { requireJobSecret } from "../_shared_haiglobals/job_auth.ts";
import {
  runSystemJobAction,
  systemJobDebugLog,
  systemJobDebugWarn,
  type SystemJobBody,
} from "../_shared_haiglobals/system_jobs.ts";

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 呼叫端是 cron worker，沒有使用者 token，只用 x-haiglobals-job-secret 驗證。
const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
  }

  let action = "";
  try {
    requireJobSecret(req);

    const body = (await req.json()) as SystemJobBody;
    action = String(body?.action ?? "").trim();

    const admin = createDatabaseClient();
    const data = await runSystemJobAction(admin, req, body);

    return jsonResponse({ ok: true, action, data });
  } catch (error) {
    const message = errorText(error);
    systemJobDebugWarn("request.failed", { action, error: message });
    return jsonResponse({ ok: false, error: message }, 400);
  }
};

systemJobDebugLog("function.loaded");

export default handleRequest;
