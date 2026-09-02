import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import { requireAdminUser } from "../_shared_haiglobals/admin.ts";
import { getEcpayInvoiceConfig, issueEcpayInvoiceForOrder } from "../_shared/ecpay_invoice.ts";

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

const handleRequest = async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const { admin, userId } = await requireUserAndCreateDatabaseClient(req);
    const body = (await req.json()) as Record<string, unknown>;
    const orderId = String(body.orderId ?? body.order_id ?? "").trim();
    if (!orderId) throw new Error("orderId is required");
    await requireAdminUser(admin, userId);
    const result = await issueEcpayInvoiceForOrder(admin, getEcpayInvoiceConfig(), orderId);

    return json({
      ok: true,
      provider: "ecpay",
      orderId,
      ...result,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
};

export default handleRequest;
