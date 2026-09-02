import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import { requireAdminUser } from "../_shared_haiglobals/admin.ts";
import { issueVendorSubscriptionInvoice } from "../_shared_haiglobals/vendor_subscription_invoices.ts";

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function optionalPositiveInt(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("paymentSequence must be a positive integer");
  }
  return parsed;
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
    const subscriptionOrderId = String(
      body.subscriptionOrderId ?? body.subscription_order_id ?? body.orderId ?? body.order_id ?? "",
    ).trim();
    if (!subscriptionOrderId) throw new Error("subscriptionOrderId is required");
    await requireAdminUser(admin, userId);

    const result = await issueVendorSubscriptionInvoice(admin, {
      subscriptionOrderId,
      paymentSequence: optionalPositiveInt(body.paymentSequence ?? body.payment_sequence),
    });

    return json({
      ok: true,
      provider: "ecpay",
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
