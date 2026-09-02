import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient, getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";
import { selectOne, type QueryValue } from "../_shared_haiglobals/orders.ts";
import { notifyVendorLotteryCancelled } from "../_shared_haiglobals/push_notifications.ts";

// 內部端點：僅供 haiglobals-workers 的 lottery-draw worker 呼叫。當抽獎開獎時間到、
// 符合資格人數為 0 時，worker 會把該場標記為 cancelled 並打這支端點，發推播通知賣家。
// 驗證方式：Authorization: Bearer <service_role_key>（只有後端持有）。

type LotteryRow = { id: string; vendor_id: string; title: string };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}

const handleRequest = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const config = getSupabaseRuntimeConfig();

  // 內部驗證：只接受帶 service_role key 的呼叫。
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== config.supabaseServiceRoleKey) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  let body: { lotteryId?: string; event?: string };
  try {
    body = (await req.json()) as { lotteryId?: string; event?: string };
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const lotteryId = String(body.lotteryId ?? "").trim();
  if (!UUID_RE.test(lotteryId)) {
    return json({ success: false, error: "Invalid lotteryId" }, 400);
  }

  try {
    const admin = createDatabaseClient(config);
    const lottery = await selectOne<LotteryRow>(admin, "lotteries", {
      select: "id,vendor_id,title",
      id: `eq.${lotteryId}`,
    } as Record<string, QueryValue>);

    if (!lottery?.vendor_id) {
      return json({ success: false, error: "找不到抽獎活動" }, 404);
    }

    await notifyVendorLotteryCancelled(admin, {
      vendorId: lottery.vendor_id,
      lotteryId,
      lotteryTitle: lottery.title,
      reason: String(body.event ?? "insufficient_participants"),
    });

    return json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[haiglobals-lottery-notify] failed", { lotteryId, message });
    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;
