import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  generateCheckMacValue,
  getEcpayLogisticsDatabaseConfig,
  parseEcpayDate,
  parseFormOrJsonBody,
  sanitizeText,
  toInt,
} from "../_shared/ecpay_logistics.ts";
import { optionalEnv } from "../_shared/env.ts";
import {
  findShipmentByReference,
  updateOrderShipment,
} from "../_shared_haiglobals/orders_shipments.ts";
import { notifyVendorsOrderStatusChanged } from "../_shared_haiglobals/push_notifications.ts";

type LogisticsNotifyPayload = {
  MerchantTradeNo?: string;
  AllPayLogisticsID?: string | number;
  LogisticsID?: string | number;
  BookingNote?: string;
  RtnCode?: string | number;
  RtnMsg?: string;
  LogisticsStatus?: string | number;
  LogisticsSubType?: string;
  UpdateStatusDate?: string;
  CheckMacValue?: string;
  [key: string]: unknown;
};

type LogisticsStatusInfo = {
  message: string;
  shippingStatus: string;
};

const unimartC2cStatusMap: Record<string, LogisticsStatusInfo> = {
  "300": { message: "訂單處理中(綠界已收到訂單資料)", shippingStatus: "created" },
  "2030": { message: "物流中心驗收成功", shippingStatus: "shipped" },
  "2041": { message: "物流中心理貨中", shippingStatus: "shipped" },
  "2042": { message: "包裹遺失，進入賠償程序", shippingStatus: "failed" },
  "2043": { message: "門市指定時間不配送，後續配送中", shippingStatus: "shipped" },
  "2048": { message: "包裝異常，請洽客服", shippingStatus: "failed" },
  "2051": { message: "賣家要求提早退貨", shippingStatus: "returned" },
  "2053": { message: "門市刷A給B，請洽客服", shippingStatus: "failed" },
  "2058": { message: "天候不佳，後續配送中", shippingStatus: "shipped" },
  "2061": { message: "包裹異常，請洽客服", shippingStatus: "failed" },
  "2062": { message: "包裹異常，請洽客服", shippingStatus: "failed" },
  "2066": { message: "包裹異常，請洽客服", shippingStatus: "failed" },
  "2067": { message: "買家已到店取貨", shippingStatus: "picked-up" },
  "2068": { message: "賣家已到門市寄件", shippingStatus: "shipped" },
  "2069": { message: "退貨便收件(商品退回指定C門市)", shippingStatus: "returned" },
  "2070": { message: "賣家已取退回包裹", shippingStatus: "returned" },
  "2072": { message: "包裹已退至原寄件門市", shippingStatus: "returned" },
  "2073": { message: "包裹配達取件門市", shippingStatus: "delivered" },
  "2074": { message: "買家未取包裹，將退回物流中心", shippingStatus: "returned" },
  "2075": { message: "賣家未取包裹，將退回物流中心", shippingStatus: "returned" },
  "2076": { message: "買家未取包裹，已退回物流中心", shippingStatus: "returned" },
  "2077": { message: "賣家未取包裹，待申請退回", shippingStatus: "returned" },
  "2078": { message: "買家未取包裹，已退回物流中心", shippingStatus: "returned" },
  "2079": { message: "買家未取貨退回物流中心-商品瑕疵(進物流中心)", shippingStatus: "returned" },
  "2080": { message: "買家未取貨退回物流中心-超材", shippingStatus: "returned" },
  "2081": { message: "買家未取貨退回物流中心-違禁品(退貨及罰款處理)", shippingStatus: "returned" },
  "2082": { message: "買家未取貨退回物流中心-訂單資料重複上傳", shippingStatus: "returned" },
  "2083": {
    message: "買家未取貨退回物流中心-已過門市進貨日（未於指定時間內寄至物流中心)",
    shippingStatus: "returned",
  },
  "2084": { message: "買家未取貨退回物流中心-第一段標籤規格錯誤", shippingStatus: "returned" },
  "2085": { message: "買家未取貨退回物流中心-第一段標籤無法判讀", shippingStatus: "returned" },
  "2086": { message: "買家未取貨退回物流中心-第一段標籤資料錯誤", shippingStatus: "returned" },
  "2087": { message: "買家未取貨退回物流中心-物流中心理貨中", shippingStatus: "returned" },
  "2088": { message: "買家未取貨退回物流中心-商品遺失", shippingStatus: "returned" },
  "2089": { message: "買家未取退回物流中心-門市指定不配送(六、日)", shippingStatus: "returned" },
  "2092": { message: "買家未取退回物流中心-門市關轉", shippingStatus: "returned" },
  "2093": { message: "買家未取退回物流中心-爆量", shippingStatus: "returned" },
  "2094": { message: "包裹異常，請洽客服", shippingStatus: "failed" },
  "2096": { message: "賣家未取包裹，待申請退回", shippingStatus: "returned" },
  "2097": { message: "賣家未取包裹，宅配退回中", shippingStatus: "returned" },
  "2098": { message: "包裹重新配達取件門市", shippingStatus: "delivered" },
  "2099": { message: "包裹重新配達寄件門市", shippingStatus: "returned" },
  "2101": { message: "門市關轉店", shippingStatus: "shipped" },
  "2102": { message: "門市舊店號更新", shippingStatus: "shipped" },
  "2103": { message: "無取件門市資料", shippingStatus: "failed" },
  "2104": { message: "門市關轉，請重選門市", shippingStatus: "failed" },
  "2105": { message: "已申請門市變更", shippingStatus: "shipped" },
  "2106": { message: "此訂單重複寄件，需申請退回", shippingStatus: "failed" },
  "7013": { message: "訂單超過驗收期限（賣家未出貨）", shippingStatus: "failed" },
  "7017": { message: "取件包裹異常，協尋中", shippingStatus: "failed" },
  "7018": { message: "包裹遺失，進入賠償程序", shippingStatus: "failed" },
  "7019": { message: "寄件包裹異常，協尋中", shippingStatus: "failed" },
  "7020": { message: "包裹遺失，進入賠償程序", shippingStatus: "failed" },
  "7038": { message: "門市驗收異常，請洽客服", shippingStatus: "failed" },
  "9999": { message: "訂單取消", shippingStatus: "cancelled" },
};

function getLogisticsStatusInfo(code: string): LogisticsStatusInfo {
  const known = unimartC2cStatusMap[code];
  if (known) return known;
  if (code === "1") {
    return { message: "物流訂單已建立", shippingStatus: "created" };
  }
  if (code.startsWith("2") || code.startsWith("3")) {
    return { message: "物流配送中", shippingStatus: "shipped" };
  }
  return { message: "未知物流狀態", shippingStatus: "pending" };
}

function appendLogisticsCallbackPayload(
  currentPayload: unknown,
  nextPayload: Record<string, unknown>,
): unknown[] {
  if (Array.isArray(currentPayload)) {
    return [...currentPayload, nextPayload];
  }

  if (currentPayload && typeof currentPayload === "object") {
    return [currentPayload, nextPayload];
  }

  return [nextPayload];
}

const handleRequest = async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }
  const environment = (optionalEnv("ENVIRONMENT") || "production").toLowerCase();
  const rawBody = await req.clone().text();
  try {
    const payload = parseFormOrJsonBody(
      rawBody,
      req.headers.get("content-type") ?? "",
    ) as LogisticsNotifyPayload;
    const config = getEcpayLogisticsDatabaseConfig(payload.LogisticsSubType);

    const incoming = String(payload.CheckMacValue ?? "").trim();
    if (incoming) {
      const expected = await generateCheckMacValue(payload, config.hashKey, config.hashIv);
      if (incoming.toUpperCase() !== expected) {
        return new Response("CheckMacValue Error", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    } else if (environment === "staging") {
      console.warn("ECPay callback without CheckMacValue", {
        merchantTradeNo: payload.MerchantTradeNo,
      });
    } else if (environment === "production") {
      return new Response("Missing CheckMacValue", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const reference = String(
      payload.MerchantTradeNo ?? payload.AllPayLogisticsID ?? payload.LogisticsID ?? "",
    ).trim();
    if (!reference) throw new Error("Missing logistics reference");

    const admin = createDatabaseClient(config);
    const shipment = await findShipmentByReference(admin, reference);
    if (!shipment.id) throw new Error("Shipment id is missing");
    const statusCode = String(payload.LogisticsStatus ?? payload.RtnCode ?? "").trim();
    const statusInfo = getLogisticsStatusInfo(statusCode);
    const nextStatus = statusInfo.shippingStatus;
    const statusAt = parseEcpayDate(payload.UpdateStatusDate) ?? new Date().toISOString();
    const enrichedPayload = {
      ...payload,
      ecpay_status_code: statusCode,
      ecpay_status_message: statusInfo.message,
      mapped_shipping_status: nextStatus,
    };
    const callbackPayloadHistory = appendLogisticsCallbackPayload(
      shipment.logistics_callback_payload,
      enrichedPayload,
    );

    const update: Record<string, unknown> = {
      provider_logistics_id:
        String(
          payload.AllPayLogisticsID ?? payload.LogisticsID ?? shipment.provider_logistics_id ?? "",
        ) || null,
      tracking_no: sanitizeText(payload.BookingNote ?? shipment.tracking_no, 40) || null,
      logistics_sub_type:
        sanitizeText(payload.LogisticsSubType ?? shipment.logistics_sub_type, 20) || null,
      shipping_status: nextStatus,
      logistics_callback_payload: callbackPayloadHistory,
      last_logistics_callback_at: new Date().toISOString(),
    };
    if (nextStatus === "shipped") update.shipped_at = shipment.shipped_at ?? statusAt;
    if (nextStatus === "delivered") update.delivered_at = statusAt;
    if (nextStatus === "picked-up") update.picked_up_at = statusAt;
    if (nextStatus === "returned") update.returned_at = statusAt;
    if (nextStatus === "failed") update.failed_at = statusAt;
    if (nextStatus === "cancelled") update.cancelled_at = statusAt;
    if (toInt(payload.GoodsAmount, 0) > 0) update.goods_amount = toInt(payload.GoodsAmount, 0);

    await updateOrderShipment(admin, String(shipment.id), update);

    // 綠界物流狀態回拋是外部事件，廠商不會知道，需要推播。
    // 狀態沒變（重送 callback）就不重複通知。
    const previousShippingStatus = String(shipment.shipping_status ?? "")
      .trim()
      .toLowerCase();
    if (nextStatus && nextStatus.toLowerCase() !== previousShippingStatus) {
      await notifyVendorsOrderStatusChanged(admin, {
        orderId: String(shipment.order_id ?? ""),
        status: nextStatus,
        statusType: "shipping",
        shipmentId: String(shipment.id),
        vendorIds: shipment.vendor_id ? [String(shipment.vendor_id)] : undefined,
      });
    }

    return new Response("1|OK", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("ecpay-logistics-notify error", error, { rawBody });
    return new Response("error", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};

export default handleRequest;
