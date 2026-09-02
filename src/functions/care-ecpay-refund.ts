// 手動退回信用卡：買家對自己某筆已付儲值發起綠界退刷，退回原卡、扣掉錢包餘額。
// 服務相關退款走錢包內部加回，不經這裡。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import {
  careSelectOne,
  createDatabaseClient,
  requireUserId,
} from "../_shared_care/db.ts";
import { refundTopupToCard } from "../_shared_care/refund.ts";
import { type CareEcpayOrderRow } from "../_shared_care/subscription.ts";
import { getEcpayPaymentConfig } from "../_shared/ecpay_payment.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const config = getEcpayPaymentConfig();
    const userId = await requireUserId(req, config);
    const body = (await req.json()) as Record<string, unknown>;

    const orderId = String(body.orderId ?? body.order_id ?? "").trim();
    const amount = Math.trunc(Number(body.amount ?? 0));
    if (!orderId || !(amount > 0)) {
      return json({ error: "orderId 與 amount 為必填" }, 400);
    }

    const admin = createDatabaseClient(config);
    const order = await careSelectOne<CareEcpayOrderRow>(admin, "care_ecpay_orders", {
      id: `eq.${orderId}`,
      select: "*",
    });
    if (!order) return json({ error: "找不到儲值訂單" }, 404);
    if (order.user_id !== userId) return json({ error: "無權操作這筆訂單" }, 403);

    const result = await refundTopupToCard(admin, { order, amount });
    return json({ ok: true, ...result });
  } catch (error) {
    console.error("[care-ecpay-refund]", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
