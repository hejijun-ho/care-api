import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  findOrderByReference,
  requireUserId,
  type OrderShipmentRow,
} from "../_shared_haiglobals/orders.ts";
import {
  fetchShipmentsByOrderId,
  findShipmentByReference,
  assertShipmentVendorAccess,
} from "../_shared_haiglobals/orders_shipments.ts";
import {
  generateCheckMacValue,
  getEcpayLogisticsDatabaseConfig,
  normalizeEcpayLanguage,
  sanitizeText,
} from "../_shared/ecpay_logistics.ts";

type ShipmentPrintTarget = {
  action: string;
  fields: Record<string, string>;
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function text(value: unknown, maxLength = 200): string {
  return sanitizeText(value, maxLength);
}

function upper(value: unknown, maxLength = 40): string {
  return text(value, maxLength).toUpperCase();
}

function intText(value: unknown, fallback: number): string {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return String(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}

function resolveLogisticsBaseUrl(): string {
  const source = [
    process.env["ECPAY_LOGISTICS_CREATE_URL"],
    process.env["ECPAY_LOGISTICS_MAP_URL"],
    process.env["ENVIRONMENT"],
  ]
    .map((item) => String(item ?? "").toLowerCase())
    .join(" ");

  return source.includes("stage") || source.includes("staging")
    ? "https://logistics-stage.ecpay.com.tw"
    : "https://logistics.ecpay.com.tw";
}

function resolvePrintAction(logisticsSubType: string): string {
  const baseUrl = resolveLogisticsBaseUrl();
  const envName = `ECPAY_LOGISTICS_PRINT_${logisticsSubType}_URL`;
  const override = text(process.env[envName], 300);
  if (override) return override;

  const paths: Record<string, string> = {
    UNIMARTC2C: "/Express/PrintUniMartC2COrderInfo",
    FAMIC2C: "/Express/PrintFAMIC2COrderInfo",
    HILIFEC2C: "/Express/PrintHILIFEC2COrderInfo",
    OKMARTC2C: "/Express/PrintOKMARTC2COrderInfo",
    TCAT: "/helper/printTradeDocument",
    ECAN: "/helper/printTradeDocument",
    POST: "/helper/printTradeDocument",
  };

  const path = paths[logisticsSubType];
  if (!path) {
    throw new Error(
      `Unsupported ECPay logistics_sub_type for printing: ${logisticsSubType || "<empty>"}`,
    );
  }
  return `${baseUrl}${path}`;
}

function payloadValue(payload: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!payload) return "";
  for (const key of keys) {
    const value = text(payload[key], 120);
    if (value) return value;
  }
  return "";
}

function splitUnimartTrackingNo(value: string): { cvsPaymentNo: string; cvsValidationNo: string } {
  const normalized = value.replace(/\s+/g, "").trim();
  if (normalized.length > 4) {
    return {
      cvsPaymentNo: normalized.slice(0, -4),
      cvsValidationNo: normalized.slice(-4),
    };
  }
  return { cvsPaymentNo: normalized, cvsValidationNo: "" };
}

function resolveCvsPaymentNo(shipment: OrderShipmentRow, body: Record<string, unknown>): string {
  const payload = shipment.logistics_callback_payload;
  return (
    text(body.cvsPaymentNo ?? body.cvs_payment_no, 80) ||
    payloadValue(payload, ["CVSPaymentNo", "cvsPaymentNo", "cvs_payment_no"]) ||
    text(shipment.tracking_no, 80)
  );
}

function resolveCvsValidationNo(shipment: OrderShipmentRow, body: Record<string, unknown>): string {
  const payload = shipment.logistics_callback_payload;
  const explicit =
    text(body.cvsValidationNo ?? body.cvs_validation_no, 20) ||
    payloadValue(payload, ["CVSValidationNo", "cvsValidationNo", "cvs_validation_no"]);
  if (explicit) return explicit;

  return splitUnimartTrackingNo(text(shipment.tracking_no, 80)).cvsValidationNo;
}

async function resolveShipment(
  admin: ReturnType<typeof createDatabaseClient>,
  body: Record<string, unknown>,
): Promise<OrderShipmentRow> {
  const shipmentRef = text(body.shipmentId ?? body.shipment_id, 80);
  if (shipmentRef) {
    return await findShipmentByReference(admin, shipmentRef);
  }

  const orderRef = text(body.orderId ?? body.orderNumber ?? body.order_id ?? body.order_number, 80);
  const vendorId = text(body.vendorId ?? body.vendor_id, 80);
  if (!orderRef) throw new Error("orderId or shipmentId is required");
  if (!vendorId) throw new Error("vendorId is required");

  const order = await findOrderByReference(admin, orderRef);
  const shipments = await fetchShipmentsByOrderId(admin, order.id, vendorId);
  if (shipments.length === 0) {
    throw new Error("Shipment not found for this order and vendor");
  }
  if (shipments.length > 1) {
    throw new Error("Order must resolve to exactly one shipment");
  }
  return shipments[0];
}

async function buildShipmentPrintTarget(
  shipment: OrderShipmentRow,
  body: Record<string, unknown>,
): Promise<ShipmentPrintTarget> {
  const logisticsSubType = upper(shipment.logistics_sub_type);
  const allPayLogisticsId = text(shipment.provider_logistics_id, 40);
  if (!allPayLogisticsId) {
    throw new Error("provider_logistics_id is required before printing ECPay shipment label");
  }

  const config = getEcpayLogisticsDatabaseConfig(logisticsSubType);
  const platformId = text(
    body.platformId ??
      body.platform_id ??
      process.env["ECPAY_LOGISTICS_PLATFORM_ID"] ??
      process.env["ECPAY_PLATFORM_ID"],
    10,
  );

  const ecpayLanguage = normalizeEcpayLanguage(body.language ?? body.Language);

  const fields: Record<string, string> = {
    MerchantID: config.merchantId,
    AllPayLogisticsID: allPayLogisticsId,
    PlatformID: platformId,
  };

  if (ecpayLanguage) {
    fields.Language = ecpayLanguage;
  }

  if (["UNIMARTC2C", "FAMIC2C", "HILIFEC2C", "OKMARTC2C"].includes(logisticsSubType)) {
    let cvsPaymentNo = resolveCvsPaymentNo(shipment, body);
    if (logisticsSubType === "UNIMARTC2C") {
      const split = splitUnimartTrackingNo(cvsPaymentNo);
      const cvsValidationNo = resolveCvsValidationNo(shipment, body) || split.cvsValidationNo;
      cvsPaymentNo = split.cvsPaymentNo || cvsPaymentNo;
      if (!cvsValidationNo) {
        throw new Error("CVSValidationNo is required for UNIMARTC2C label printing");
      }
      fields.CVSValidationNo = cvsValidationNo;
      fields.PrintMode = intText(body.printMode ?? body.print_mode, 1);
    }

    if (!cvsPaymentNo) {
      throw new Error("CVSPaymentNo is required for CVS label printing");
    }
    fields.CVSPaymentNo = cvsPaymentNo;
  } else {
    fields.PrintMode = intText(body.printMode ?? body.print_mode, 1);
  }

  fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

  return {
    action: resolvePrintAction(logisticsSubType),
    fields,
  };
}

const handleRequest = async (req: Request): Promise<Response> => {
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
    const shipment = await resolveShipment(admin, body);
    const vendorId = text(body.vendorId ?? body.vendor_id ?? shipment.vendor_id, 80);
    if (!vendorId) throw new Error("vendorId is required");
    if (text(shipment.vendor_id, 80) !== vendorId) {
      throw new Error("Vendor shipment access required");
    }
    await assertShipmentVendorAccess(admin, vendorId, userId);

    if (upper(shipment.shipping_provider) !== "ECPAY") {
      throw new Error("Only ECPay shipments can print ECPay shipment labels");
    }

    const target = await buildShipmentPrintTarget(shipment, body);
    return json({
      ok: true,
      provider: "ecpay",
      shipmentId: shipment.id ?? null,
      orderId: shipment.order_id,
      vendorId,
      logisticsSubType: upper(shipment.logistics_sub_type),
      method: "POST",
      enctype: "application/x-www-form-urlencoded",
      action: target.action,
      fields: target.fields,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
