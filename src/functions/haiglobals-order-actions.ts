import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import { fetchOrderForUser, updateOrder } from "../_shared_haiglobals/orders.ts";
import {
  fetchShipmentByOrderAndShipmentId,
  updateOrderShipment,
} from "../_shared_haiglobals/orders_shipments.ts";
import { notifyVendorsOrderStatusChanged } from "../_shared_haiglobals/push_notifications.ts";
function text(value: unknown): string {
  return String(value ?? "").trim();
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const { admin, userId } = await requireUserAndCreateDatabaseClient(req);
    const body = (await req.json()) as Record<string, unknown>;
    const action = text(body.action);
    const orderId = text(body.orderId ?? body.order_id);
    if (!orderId) {
      throw new Error("orderId is required");
    }

    const order = await fetchOrderForUser(admin, orderId, userId);

    if (action === "confirm_received") {
      const shipmentId = text(body.shipmentId ?? body.shipment_id);
      if (!shipmentId) {
        throw new Error("shipmentId is required");
      }
      const shipment = await fetchShipmentByOrderAndShipmentId(admin, order.id, shipmentId);
      if (!shipment?.id) {
        throw new Error("Shipment not found");
      }
      const shippingStatus = String(shipment.shipping_status ?? "").toLowerCase();
      if (shippingStatus === "picked-up") {
        throw new Error("The orders has already been confirmed as received");
      }
      console.log("Confirming order as received", {
        orderId: order.id,
        shipmentId: shipment.id,
        shippingStatus,
      });
      if (shippingStatus !== "shipped" && shippingStatus !== "delivered") {
        throw new Error("The orders status is not eligible for confirmation as received");
      }
      const nextShippingStatus = "picked-up";
      await updateOrder(admin, order.id, {});
      await updateOrderShipment(admin, shipment.id, {
        shipping_status: nextShippingStatus,
        picked_up_at: new Date().toISOString(),
      });

      // 買家確認取貨會啟動退貨鑑賞期與月結，廠商需要知道。
      await notifyVendorsOrderStatusChanged(admin, {
        orderId: order.id,
        status: nextShippingStatus,
        statusType: "shipping",
        shipmentId: String(shipment.id),
        vendorIds: shipment.vendor_id ? [String(shipment.vendor_id)] : undefined,
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    throw new Error(`Unsupported action: ${action || "<empty>"}`);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
};

export default handleRequest;
