import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";
import { requireUserId } from "../_shared_haiglobals/orders.ts";
import { isAdminUser } from "../_shared_haiglobals/admin.ts";

// 賣家/主後台「立即開獎」。驗證擁有該抽獎且已到開獎時間後，以 service role 呼叫原子
// draw_lottery()（其內 is_admin() 由 service_role 通過）。中獎通知不在這裡發，交由
// haiglobals-workers 的 lottery-draw worker 掃 notified_message_id IS NULL 後統一發送，
// 保證自動/手動兩條路的通知邏輯只有一份、且可在崩潰後補發。

type Config = ReturnType<typeof getSupabaseRuntimeConfig>;

type LotteryRow = { id: string; vendor_id: string; draw_at: string; status: string };
type WinnerRow = { winner_id: string };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const handleRequest = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  let body: { lotteryId?: string };
  try {
    body = (await req.json()) as { lotteryId?: string };
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const lotteryId = String(body.lotteryId ?? "").trim();
  if (!UUID_RE.test(lotteryId)) {
    return json({ success: false, error: "Invalid lotteryId" }, 400);
  }

  const config = getSupabaseRuntimeConfig();

  let userId: string;
  try {
    userId = await requireUserId(req, config);
  } catch {
    return json({ success: false, error: "請先登入" }, 401);
  }

  try {
    const lottery = await restGetOne<LotteryRow>(
      config,
      "lotteries",
      `id=eq.${encodeURIComponent(lotteryId)}&select=id,vendor_id,draw_at,status`,
    );
    if (!lottery) {
      return json({ success: false, error: "找不到抽獎活動" }, 404);
    }

    // 權限：主後台 admin，或該抽獎所屬賣家（vendors.user_id = 登入者）。
    const isAdmin = await isAdminUser({ keys: config }, userId);
    if (!isAdmin) {
      const owner = await restGetOne<{ id: string }>(
        config,
        "vendors",
        `id=eq.${encodeURIComponent(lottery.vendor_id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
      );
      if (!owner) {
        return json({ success: false, error: "你沒有權限開這個抽獎" }, 403);
      }
    }

    if (lottery.status !== "open") {
      return json({ success: false, error: `抽獎狀態不是可開獎（目前：${lottery.status}）` }, 409);
    }
    if (!isAdmin && new Date() < new Date(lottery.draw_at)) {
      return json({ success: false, error: "還沒到開獎時間" }, 409);
    }

    const winners = await callRpc<WinnerRow[]>(config, "draw_lottery", {
      p_lottery_id: lotteryId,
    });

    return json({
      success: true,
      winner_count: Array.isArray(winners) ? winners.length : 0,
      note: "已開獎，系統將自動發送中獎通知。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[haiglobals-lottery-draw] failed", { lotteryId, message });
    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;

async function restGetOne<T>(config: Config, table: string, query: string): Promise<T | null> {
  const response = await fetch(`${trimUrl(config.supabaseUrl)}/rest/v1/${table}?${query}&limit=1`, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Accept-Profile": "haiglobals",
      Accept: "application/json",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(readPostgrestError(text) || `select ${table} failed (${response.status})`);
  }

  const rows = text.trim() ? (JSON.parse(text) as T[]) : [];
  return rows.length > 0 ? rows[0] : null;
}

async function callRpc<T>(config: Config, fn: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `${trimUrl(config.supabaseUrl)}/rest/v1/rpc/${encodeURIComponent(fn)}`,
    {
      method: "POST",
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Profile": "haiglobals",
        "Content-Profile": "haiglobals",
      },
      body: JSON.stringify(args),
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(readPostgrestError(text) || `RPC ${fn} failed (${response.status})`);
  }
  return (text.trim() ? JSON.parse(text) : null) as T;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readPostgrestError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const message = payload.message ?? payload.details ?? payload.hint ?? payload.code;
    return typeof message === "string" ? message : "";
  } catch {
    return trimmed;
  }
}

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
