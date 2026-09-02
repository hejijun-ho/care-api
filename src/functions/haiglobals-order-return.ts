import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import {
  createDatabaseClient,
  requireUserAndCreateDatabaseClient,
} from "../_shared_haiglobals/database.ts";
import { hasJobSecret, isSystemAction } from "../_shared_haiglobals/job_auth.ts";
import {
  orderReturnDebugLog,
  orderReturnDebugWarn,
  runOrderReturnAction,
  type OrderReturnBody,
} from "../_shared_haiglobals/order_returns.ts";

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `admin` returned by requireUserAndCreateDatabaseClient is the service-role DB client.
const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    // 先讀 body 才知道是不是排程用的 system_* action：cron worker 沒有使用者 token，
    // 不先分流的話既有的排程 action 永遠打不進來。
    // 必須讀 clone：requireUserId 之後還要再 clone 一次去拿 body 裡的 accessToken，
    // 直接 req.json() 會把 body 用掉，讓「token 放 body」的一般使用者全部認證失敗。
    const body = (await req.clone().json()) as OrderReturnBody;

    const isJobCall = isSystemAction(body?.action) && hasJobSecret(req);

    // system_* 沒帶正確 job secret 時不會走到這裡，會落到下面的使用者驗證而被擋掉；
    // runOrderReturnAction 內每個 system_* handler 仍會各自 requireJobSecret()，那層閘門保留不要拿掉。
    const { admin, userId } = isJobCall
      ? { admin: createDatabaseClient(), userId: "" }
      : await requireUserAndCreateDatabaseClient(req);

    const result = await runOrderReturnAction(admin, userId, req, body);
    return jsonResponse(result);
  } catch (error) {
    const message = errorText(error);
    orderReturnDebugWarn("request.failed", { error: message });
    return jsonResponse({ ok: false, error: message }, 400);
  }
};

orderReturnDebugLog("function.loaded");

export default handleRequest;
