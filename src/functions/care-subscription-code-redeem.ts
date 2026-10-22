// 兌換 care 訂閱優惠碼（新版 app 走這支，取代直接呼叫 RPC redeem_subscription_code）。
//
// 2026-10-22：碼改成排隊（pro_care_matching migration 20261022120000_subscription_code_queue.sql）。
// 付費訂閱還會續扣時輸入碼，碼排在這期付費後面，**續扣要停掉**——不停的話綠界下一期照扣，
// applySubscriptionPayment 又把到期日往後推，等於重複付費、碼也被往後擠。停綠界只有 api 做得到。
//
// 順序：先兌換（DB 函式做完所有檢查並寫入）→ 成功後如果付費還在續扣，停綠界。
// 第二步失敗時兌換照樣成立，回 paidCancelFailed: true，app 提示「請到訂閱頁取消續訂」，不默默重複扣款。
//
// 請求 body：{ code, role }。錯誤回 { ok: false, error: '<DB 的錯誤代碼>' }（invalid_code、code_already_used、
// code_expired、code_role_mismatch、code_limit_reached、next_period_already_set、code_expires_earlier）。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import { careRpc, createDatabaseClient, requireUserId } from "../_shared_care/db.ts";
import { normalizeRole } from "../_shared_care/subscription.ts";
import { cancelSubscriptionRole } from "../_shared_care/subscription_cancel.ts";
import { getEcpayPaymentConfig, type EcpayPaymentConfig } from "../_shared/ecpay_payment.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

type RedeemResult = {
  ok: boolean;
  starts_at: string;
  active_until: string;
  queued: boolean;
  applies_to: string;
  renewing_paid: boolean;
};

// PostgREST 的錯誤是 JSON（{ code, message, ... }），DB raise 的代碼在 message
function dbErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // 不是 JSON：原文回去
  }
  return text;
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  let userId: string;
  let config: EcpayPaymentConfig;
  try {
    config = getEcpayPaymentConfig();
    userId = await requireUserId(req, config);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? "").trim();
  const role = normalizeRole(body.role);
  if (!code) return json({ ok: false, error: "invalid_code" }, 400);
  const admin = createDatabaseClient(config);

  let result: RedeemResult;
  try {
    result = await careRpc<RedeemResult>(admin, "_redeem_subscription_code", {
      p_code: code,
      p_role: role,
      p_user: userId,
    });
  } catch (error) {
    return json({ ok: false, error: dbErrorCode(error) }, 400);
  }

  let paidCancelled = false;
  let paidCancelFailed = false;
  if (result.renewing_paid) {
    try {
      await cancelSubscriptionRole(admin, userId, role);
      paidCancelled = true;
    } catch (error) {
      console.error("[care-subscription-code-redeem] stop renewal failed", error);
      paidCancelFailed = true;
    }
  }

  return json({
    ok: true,
    role,
    startsAt: result.starts_at,
    activeUntil: result.active_until,
    queued: result.queued,
    appliesTo: result.applies_to,
    paidCancelled,
    paidCancelFailed,
  });
};

export default handleRequest;
