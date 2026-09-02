import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  buildTaipeiDate,
  generateCheckMacValue,
  getEcpayLogisticsCreateConfig,
  getEcpayLogisticsDatabaseConfig,
  parseFormOrJsonBody,
  randomDigits,
  sanitizeEcpayItemName,
  resolveCallbackBaseUrl,
  sanitizeText,
  toInt,
} from "../_shared/ecpay_logistics.ts";
import {
  fetchOrderItems,
  fetchOrderVendorIds,
  findOrderByReference,
  requireUserId,
} from "../_shared_haiglobals/orders.ts";
import {
  assertOrderCanProgressShipment,
  fetchShipmentByOrderId,
  updateOrderShipment,
  upsertOrderShipmentByOrderId,
  assertShipmentVendorAccess,
} from "../_shared_haiglobals/orders_shipments.ts";

const ECPAY_LOGISTICS_NOTIFY_FUNCTION_NAME = "haiglobals-ecpay-logistics-notify";

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function buildLogisticsTradeNo(): string {
  return `OSL${Date.now().toString().slice(-12)}${randomDigits(4)}`;
}

function normalizeLogisticsType(value: unknown): "CVS" {
  const text = String(value ?? "CVS")
    .trim()
    .toUpperCase();
  if (text === "CVS") return "CVS";
  throw new Error("Only CVS C2C logistics is supported");
}

function normalizeSubType(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .toUpperCase();
  const cvs = new Set(["UNIMARTC2C", "FAMIC2C", "HILIFEC2C", "OKMARTC2C"]);
  if (cvs.has(text)) return text;
  throw new Error(`Only CVS C2C logisticsSubType is supported: ${text || "<empty>"}`);
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = sanitizeText(value);
    if (text) return text;
  }
  return "";
}

function normalizeTaiwanMobileForEcpay(value: unknown, fieldName: string): string {
  let phone = sanitizeText(value, 30).replace(/[\s().-]/g, "");
  if (!phone) throw new Error(`${fieldName} is required`);
  if (phone.startsWith("+886")) {
    phone = phone.slice(4);
  } else if (phone.startsWith("886")) {
    phone = phone.slice(3);
  } else if (phone.startsWith("00886")) {
    phone = phone.slice(5);
  }
  if (/^9\d{8}$/.test(phone)) {
    phone = `0${phone}`;
  }
  if (!/^09\d{8}$/.test(phone)) {
    throw new Error(`${fieldName} must be a Taiwan mobile number, e.g. 0912345678`);
  }
  return phone;
}

function toTaiwanMobileE164(value: unknown, fieldName: string): string {
  const local = normalizeTaiwanMobileForEcpay(value, fieldName);
  return `+886${local.slice(1)}`;
}

function sanitizeGoodsName(value: unknown, maxLength = 50): string {
  return sanitizeEcpayItemName(value, maxLength);
}

function buildGoodsName(
  items: Array<{ product_name?: string | null; quantity?: number | null }>,
  fallback: unknown,
): string {
  const names = items
    .map((item) => {
      const name = sanitizeGoodsName(item.product_name, 40);
      const quantity = Number(item.quantity ?? 0);
      if (!name) return "";
      return quantity > 1 ? name + "x" + quantity : name;
    })
    .filter(Boolean);
  const joined = names.join(" ");
  return sanitizeGoodsName(joined, 50) || sanitizeGoodsName(fallback, 50) || "Osmile Order";
}

function extractEcpayError(result: Record<string, unknown>): string {
  const rtnCode = String(result.RtnCode ?? "").trim();
  const rtnMsg = String(result.RtnMsg ?? "").trim();
  if (rtnMsg) {
    return rtnCode ? `${rtnCode}|${rtnMsg}` : rtnMsg;
  }

  const firstKey = Object.keys(result)[0] ?? "";
  if (firstKey) {
    return firstKey;
  }

  return rtnCode ? `ECPay logistics RtnCode=${rtnCode}` : "ECPay logistics create failed";
}

function parseEcpayCreateResponse(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.startsWith("1|")) {
    return parseFormOrJsonBody(text.slice(2));
  }
  if (text.startsWith("0|")) {
    return { RtnCode: "0", RtnMsg: text.slice(2) };
  }
  return parseFormOrJsonBody(text);
}

function isEcpayCreateSuccess(raw: string, result: Record<string, unknown>): boolean {
  if (raw.trim().startsWith("1|")) return true;
  return String(result.RtnCode ?? "").trim() === "1";
}

function redactCheckMacValue(params: Record<string, string>): Record<string, string> {
  return {
    ...params,
    CheckMacValue: params.CheckMacValue ? "[redacted]" : "",
  };
}

function buildEcpayTrackingNo(result: Record<string, unknown>): string {
  const bookingNote = sanitizeText(result.BookingNote, 80);
  if (bookingNote) return bookingNote;

  const cvsPaymentNo = sanitizeText(result.CVSPaymentNo, 80);
  const cvsValidationNo = sanitizeText(result.CVSValidationNo, 20);
  if (cvsPaymentNo && cvsValidationNo) return `${cvsPaymentNo}${cvsValidationNo}`;
  if (cvsPaymentNo) return cvsPaymentNo;

  return sanitizeText(result.AllPayLogisticsID, 80);
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const baseConfig = getEcpayLogisticsDatabaseConfig();
    const userId = await requireUserId(req, baseConfig);
    const admin = createDatabaseClient(baseConfig);

    const body = (await req.json()) as Record<string, unknown>;
    const orderRef = String(body.orderId ?? body.orderNumber ?? body.providerOrderId ?? "").trim();
    const shipmentVendorId = String(body.vendorId ?? body.vendor_id ?? "").trim();
    if (!orderRef) throw new Error("orderId is required");
    if (!shipmentVendorId) throw new Error("vendorId is required");

    const order = await findOrderByReference(admin, orderRef);
    await assertShipmentVendorAccess(admin, shipmentVendorId, userId);
    assertOrderCanProgressShipment(order);

    const orderVendorIds = await fetchOrderVendorIds(admin, order.id);
    if (orderVendorIds.length === 0) {
      throw new Error("Order has no vendor shipments");
    }
    if (!orderVendorIds.includes(shipmentVendorId)) {
      throw new Error("Shipment vendor_id is not part of this order");
    }

    const existingShipment = await fetchShipmentByOrderId(admin, order.id, shipmentVendorId);
    if (!existingShipment?.id) {
      throw new Error("Shipment not found for this order and vendor");
    }
    const logisticsType = normalizeLogisticsType(existingShipment.logistics_type);
    const logisticsSubType = normalizeSubType(existingShipment.logistics_sub_type);
    const currentShippingStatus = String(existingShipment.shipping_status ?? "")
      .trim()
      .toLowerCase();
    if (currentShippingStatus !== "pending") {
      throw new Error("Only pending shipments can have ECPay logistics created");
    }
    const config = getEcpayLogisticsCreateConfig(logisticsSubType);
    const tradeNo = firstText([
      body.logisticsTradeNo,
      existingShipment?.temp_logistics_id,
      buildLogisticsTradeNo(),
    ]).slice(0, 20);

    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const goodsAmount = toInt(existingShipment.goods_amount ?? order.total_amount, 0);
    if (goodsAmount <= 0) throw new Error("goodsAmount must be a positive integer");
    const orderItems = await fetchOrderItems(admin, order.id);
    const goodsName = buildGoodsName(orderItems, order.order_number);

    const isCollection = Boolean(existingShipment.is_collection ?? false);
    const collectionAmount = isCollection
      ? toInt(existingShipment.collection_amount ?? goodsAmount, goodsAmount)
      : 0;
    const senderName = firstText([body.senderName, body.sender_name, existingShipment.sender_name]);
    if (!senderName) throw new Error("senderName is required");
    const senderPhone = firstText([
      body.senderPhone,
      body.sender_phone,
      existingShipment.sender_phone,
    ]);
    const senderPhoneForEcpay = normalizeTaiwanMobileForEcpay(senderPhone, "senderPhone");
    const receiverName = firstText([existingShipment.receiver_name]);
    if (!receiverName) throw new Error("receiver_name is required on order_shipments");
    const receiverPhone = firstText([existingShipment.receiver_phone]);
    const receiverPhoneForEcpay = normalizeTaiwanMobileForEcpay(receiverPhone, "receiver_phone");
    const receiverStoreId = firstText([existingShipment.cvs_store_id]);
    if (!receiverStoreId) throw new Error("cvs_store_id is required on order_shipments");

    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      LogisticsType: logisticsType,
      LogisticsSubType: logisticsSubType,
      GoodsAmount: String(goodsAmount),
      CollectionAmount: String(collectionAmount),
      IsCollection: isCollection ? "Y" : "N",
      GoodsName: goodsName,
      SenderName: sanitizeText(senderName, 10),
      SenderPhone: "",
      SenderCellPhone: senderPhoneForEcpay,
      ReceiverName: sanitizeText(receiverName, 10),
      ReceiverPhone: "",
      ReceiverCellPhone: receiverPhoneForEcpay,
      ReceiverEmail: sanitizeText(existingShipment.receiver_email, 80),
      ServerReplyURL: `${callbackBaseUrl}/${ECPAY_LOGISTICS_NOTIFY_FUNCTION_NAME}`,
      ClientReplyURL: "",
      Remark: sanitizeText(body.remark, 60),
      PlatformID: sanitizeText(body.platformId, 10),
      ReceiverStoreID: receiverStoreId,
    };

    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    await updateOrderShipment(admin, existingShipment.id, {
      shipping_provider: "ecpay",
      logistics_type: logisticsType,
      logistics_sub_type: logisticsSubType,
      shipping_status: "pending",
      is_collection: isCollection,
      collection_amount: collectionAmount || null,
      temp_logistics_id: tradeNo,
      receiver_name: fields.ReceiverName || null,
      receiver_phone: toTaiwanMobileE164(receiverPhone, "receiver_phone"),
      receiver_email: fields.ReceiverEmail || null,
      cvs_store_id: fields.ReceiverStoreID || null,
      cvs_store_name: existingShipment.cvs_store_name || null,
      cvs_store_address: existingShipment.cvs_store_address || null,
      cvs_store_type: existingShipment.cvs_store_type || logisticsSubType,
      sender_name: fields.SenderName || null,
      sender_phone: toTaiwanMobileE164(senderPhone, "senderPhone"),
      goods_amount: goodsAmount,
    });

    console.log("[ECPay create shipment] request", {
      requestUrl: config.logisticsCreateUrl,
      orderId: order.id,
      orderNumber: order.order_number ?? "",
      shipmentId: existingShipment.id,
      vendorId: shipmentVendorId,
      fields: redactCheckMacValue(fields),
    });

    const response = await fetch(config.logisticsCreateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    const responseText = await response.text();
    console.log("[ECPay create shipment] response", {
      responseUrl: response.url,
      orderId: order.id,
      shipmentId: existingShipment.id,
      status: response.status,
      body: responseText,
    });
    if (!response.ok) {
      throw new Error(responseText || `ECPay logistics create failed (${response.status})`);
    }
    const result = parseEcpayCreateResponse(responseText);
    if (!isEcpayCreateSuccess(responseText, result)) {
      throw new Error(extractEcpayError(result));
    }

    const shipment = await upsertOrderShipmentByOrderId(admin, order.id, {
      vendor_id: shipmentVendorId,
      shipping_provider: "ecpay",
      logistics_type: logisticsType,
      logistics_sub_type: logisticsSubType,
      shipping_status: "created",
      is_collection: isCollection,
      collection_amount: toInt(fields.CollectionAmount, 0) || null,
      temp_logistics_id: tradeNo,
      provider_logistics_id: String(result.AllPayLogisticsID ?? result.LogisticsID ?? "") || null,
      tracking_no: buildEcpayTrackingNo(result) || null,
      receiver_name: fields.ReceiverName || null,
      receiver_phone: toTaiwanMobileE164(receiverPhone, "receiver_phone"),
      receiver_email: fields.ReceiverEmail || null,
      receiver_address: existingShipment.receiver_address || null,
      cvs_store_id: fields.ReceiverStoreID || null,
      cvs_store_name: existingShipment.cvs_store_name || null,
      cvs_store_address: existingShipment.cvs_store_address || null,
      cvs_store_type: existingShipment.cvs_store_type || logisticsSubType,
      sender_name: fields.SenderName || null,
      sender_phone: toTaiwanMobileE164(senderPhone, "senderPhone"),
      sender_address: existingShipment.sender_address || null,
      goods_amount: goodsAmount,
    });

    return json({ ok: true, shipment, ecpay: result });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
