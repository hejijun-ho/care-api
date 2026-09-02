import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { findOrderByReference, requireUserId } from "../_shared_haiglobals/orders.ts";
import {
  assertOrderCanProgressShipment,
  fetchShipmentsByOrderId,
  updateOrderShipment,
  assertShipmentVendorAccess,
} from "../_shared_haiglobals/orders_shipments.ts";
import { getEcpayLogisticsDatabaseConfig, sanitizeText } from "../_shared/ecpay_logistics.ts";

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function text(value: unknown, maxLength = 120): string {
  return sanitizeText(value, maxLength);
}

function isManualHomeShipment(shipment: {
  logistics_type?: unknown;
  shipping_provider?: unknown;
  logistics_sub_type?: unknown;
}): boolean {
  const logisticsType = text(shipment.logistics_type, 40).toUpperCase();
  const provider = text(shipment.shipping_provider, 40).toLowerCase();
  const logisticsSubType = text(shipment.logistics_sub_type, 40).toUpperCase();
  return logisticsType === "HOME" && (provider === "manual" || logisticsSubType === "MANUAL");
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const config = getEcpayLogisticsDatabaseConfig();
    const userId = await requireUserId(req, config);
    const admin = createDatabaseClient(config);
    const body = (await req.json()) as Record<string, unknown>;

    const orderRef = text(body.orderId ?? body.orderNumber);
    const vendorId = text(body.vendorId ?? body.vendor_id);
    if (!orderRef) throw new Error("orderId is required");
    if (!vendorId) throw new Error("vendorId is required");

    const order = await findOrderByReference(admin, orderRef);
    await assertShipmentVendorAccess(admin, vendorId, userId);
    assertOrderCanProgressShipment(order);

    const shipments = await fetchShipmentsByOrderId(admin, order.id, vendorId);
    if (shipments.length === 0) {
      throw new Error("Shipment not found for this order and vendor");
    }
    if (shipments.length > 1) {
      throw new Error("Order must resolve to exactly one shipment");
    }

    const shipment = shipments[0];
    if (!shipment.id) throw new Error("Shipment id is missing");
    if (text(shipment.vendor_id) !== vendorId) {
      throw new Error("Vendor shipment access required");
    }
    if (!isManualHomeShipment(shipment)) {
      throw new Error("Only HOME/MANUAL shipments can be manually created");
    }
    if (text(shipment.shipping_status, 40).toLowerCase() !== "pending") {
      throw new Error("Only pending shipments can be manually created");
    }

    const update: Record<string, unknown> = {
      shipping_status: "created",
    };

    await updateOrderShipment(admin, String(shipment.id), update);
    return json({ ok: true, shipment: { ...shipment, ...update } });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
