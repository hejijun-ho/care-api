import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import { generateCheckMacValue } from "../_shared/ecpay_payment.ts";
import { optionalEnv } from "../_shared/env.ts";
import {
  voidEcpayInvoiceForOrder,
  type EcpayInvoiceInvalidConfig,
} from "../_shared/ecpay_invoice.ts";
import {
  fetchOrderForUser,
  updateOrder,
  type AdminClient,
  type OrderRow,
} from "../_shared_haiglobals/orders.ts";
import {
  cancelOrderShipmentsByOrderId,
  fetchOrderShipmentStatusesByOrderId,
} from "../_shared_haiglobals/orders_shipments.ts";
import {
  createOrderRefundRecord,
  fetchBlockingOrderRefundByOrderId,
  updateOrderRefundRecord,
} from "../_shared_haiglobals/orders_refunds.ts";
import { notifyVendorsOrderStatusChanged } from "../_shared_haiglobals/push_notifications.ts";
type CancelOrderBody = Record<string, unknown>;

type EcpayCreditActionConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  actionUrl: string;
  platformId: string;
};

type InvoiceVoidResult = Awaited<ReturnType<typeof voidEcpayInvoiceForOrder>>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizePaymentStatus(value: unknown): string {
  return text(value).toLowerCase();
}

function normalizeShipmentStatus(value: unknown): string {
  return text(value).toLowerCase();
}

function cancelDebugLog(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[haiglobals-order-cancel][debug] ${event}`, JSON.stringify(payload));
}

function cancelDebugWarn(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(`[haiglobals-order-cancel][warn] ${event}`, JSON.stringify(payload));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertAllOrderShipmentsPending(
  admin: AdminClient,
  orderId: string,
  options: { requireShipment?: boolean } = {},
): Promise<{ total: number }> {
  cancelDebugLog("shipmentGuard.start", { orderId });

  const shipments = await fetchOrderShipmentStatusesByOrderId(admin, orderId);

  cancelDebugLog("shipmentGuard.fetched", {
    orderId,
    total: shipments.length,
    shipments: shipments.map((shipment) => ({
      id: shipment.id ?? null,
      vendorId: shipment.vendor_id ?? null,
      shippingStatus: shipment.shipping_status ?? null,
    })),
  });

  if (!shipments.length) {
    if (options.requireShipment) {
      cancelDebugWarn("shipmentGuard.blocked", {
        orderId,
        reason: "no_order_shipments",
      });
      throw new Error("No order_shipments found for this order; cannot verify shipping_status");
    }

    cancelDebugLog("shipmentGuard.passed", {
      orderId,
      total: 0,
      reason: "no_order_shipments_allowed",
    });
    return { total: 0 };
  }

  const blockingShipment = shipments.find(
    (shipment) => normalizeShipmentStatus(shipment.shipping_status) !== "pending",
  );

  if (blockingShipment) {
    cancelDebugWarn("shipmentGuard.blocked", {
      orderId,
      reason: "shipment_not_pending",
      blockingShipmentId: blockingShipment.id ?? null,
      vendorId: blockingShipment.vendor_id ?? null,
      shippingStatus: blockingShipment.shipping_status ?? null,
    });
    throw new Error(
      `Only orders whose every order_shipments.shipping_status is pending can be cancelled or refunded. ` +
        `Blocking shipment id=${blockingShipment.id ?? "<empty>"}, ` +
        `vendor_id=${blockingShipment.vendor_id ?? "<empty>"}, ` +
        `shipping_status=${blockingShipment.shipping_status ?? "<empty>"}`,
    );
  }

  cancelDebugLog("shipmentGuard.passed", {
    orderId,
    total: shipments.length,
  });

  return { total: shipments.length };
}

function getEcpayCreditActionConfig(): EcpayCreditActionConfig {
  return {
    merchantId: optionalEnv("ECPAY_MERCHANT_ID"),
    hashKey: optionalEnv("ECPAY_HASH_KEY"),
    hashIv: optionalEnv("ECPAY_HASH_IV"),
    actionUrl: optionalEnv("ECPAY_CREDIT_ACTION_URL"),
    platformId: optionalEnv("ECPAY_PLATFORM_ID"),
  };
}

function getEcpayInvoiceInvalidConfig(): EcpayInvoiceInvalidConfig {
  return {
    merchantId: optionalEnv("ECPAY_INVOICE_MERCHANT_ID"),
    hashKey: optionalEnv("ECPAY_INVOICE_HASH_KEY"),
    hashIv: optionalEnv("ECPAY_INVOICE_HASH_IV"),
    invalidUrl: optionalEnv("ECPAY_INVOICE_INVALID_URL"),
    platformId: optionalEnv("ECPAY_INVOICE_PLATFORM_ID"),
  };
}

async function voidInvoiceForCancelledOrder(
  admin: AdminClient,
  orderId: string,
  reason: string | null,
): Promise<InvoiceVoidResult> {
  cancelDebugLog("invoiceVoid.start", {
    orderId,
    reason: reason || "訂單取消",
  });

  try {
    const result = await voidEcpayInvoiceForOrder(
      admin,
      getEcpayInvoiceInvalidConfig(),
      orderId,
      reason || "訂單取消",
    );

    cancelDebugLog("invoiceVoid.result", {
      orderId,
      status: result.status,
      skipped: result.skipped,
      reason: result.reason ?? null,
      invoiceNo: result.invoiceNo ?? null,
      rtnCode: result.rtnCode ?? null,
      rtnMsg: result.rtnMsg ?? null,
      error: result.error ?? null,
    });

    return result;
  } catch (error) {
    const message = errorText(error);
    cancelDebugWarn("invoiceVoid.unhandledError", {
      orderId,
      error: message,
    });
    return {
      skipped: false,
      status: "failed",
      orderId,
      reason: "invoice_void_unhandled_error",
      error: message,
    };
  }
}

function invoiceWarnings(invoice: InvoiceVoidResult): string[] {
  if (invoice.status !== "failed") {
    return [];
  }
  return [`Invoice void failed: ${invoice.error || invoice.rtnMsg || "unknown error"}`];
}

function toPositiveInt(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(
          String(value ?? "")
            .replaceAll(",", "")
            .trim(),
          10,
        );

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function isCreditPayment(order: OrderRow): boolean {
  const normalized = text(order.payment_method).toLowerCase();
  return (
    normalized === "credit_card" ||
    normalized === "credit" ||
    normalized.includes("credit") ||
    normalized.includes("creditcard")
  );
}

function parseGatewayResponse(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, text(value)]),
      );
    }
  }

  if (!trimmed.includes("=") && trimmed.includes("|")) {
    const [rtnCode, ...messageParts] = trimmed.split("|");
    return {
      RtnCode: text(rtnCode),
      RtnMsg: text(messageParts.join("|")),
    };
  }

  const normalized = trimmed.replace(/<br\s*\/?>/gi, "&").replace(/&amp;/g, "&");

  return Object.fromEntries(new URLSearchParams(normalized).entries());
}

async function postEcpayCreditAction(
  config: EcpayCreditActionConfig,
  params: Record<string, string | number>,
): Promise<{
  httpStatus: number;
  rawBody: string;
  parsed: Record<string, string>;
}> {
  const checkMacValue = await generateCheckMacValue(params, config.hashKey, config.hashIv);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, CheckMacValue: checkMacValue })) {
    form.set(key, String(value));
  }

  cancelDebugLog("ecpayRefund.call", {
    actionUrl: config.actionUrl,
    merchantId: config.merchantId ? `${config.merchantId.slice(0, 4)}***` : "<empty>",
    merchantTradeNo: params.MerchantTradeNo ?? null,
    tradeNo: params.TradeNo ?? null,
    action: params.Action ?? null,
    totalAmount: params.TotalAmount ?? null,
    hasPlatformId: Boolean(config.platformId),
  });

  const response = await fetch(config.actionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const rawBody = await response.text();
  const parsed = parseGatewayResponse(rawBody);

  cancelDebugLog("ecpayRefund.response", {
    httpStatus: response.status,
    parsed,
    rawBodyPreview: rawBody.slice(0, 500),
  });

  if (!response.ok) {
    throw new Error(`ECPay refund HTTP failed (${response.status}): ${rawBody}`);
  }

  return {
    httpStatus: response.status,
    rawBody,
    parsed,
  };
}

function buildRefundRequestId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `RF${stamp}${random}`.slice(0, 30);
}

async function cancelPendingOrder(
  admin: AdminClient,
  order: OrderRow,
  reason: string | null,
): Promise<Response> {
  const cancelledAt = new Date().toISOString();

  cancelDebugLog("cancelPendingOrder.start", {
    orderId: order.id,
    paymentStatus: order.payment_status ?? null,
    reason,
  });

  await updateOrder(admin, order.id, {
    payment_status: "cancelled",
    cancelled_at: cancelledAt,
    cancel_reason: reason,
  });

  cancelDebugLog("cancelPendingOrder.orderUpdated", {
    orderId: order.id,
    cancelledAt,
  });

  const cancelledShipments = await cancelOrderShipmentsByOrderId(admin, order.id, cancelledAt);

  cancelDebugLog("cancelPendingOrder.shipmentsUpdated", {
    orderId: order.id,
    updatedCount: cancelledShipments.length,
    shipmentIds: cancelledShipments.map((shipment) => shipment.id ?? null),
  });

  const invoice = await voidInvoiceForCancelledOrder(admin, order.id, reason);

  // 買家取消訂單，廠商後台需要知道這張單不用出貨了。
  await notifyVendorsOrderStatusChanged(admin, {
    orderId: order.id,
    status: "cancelled",
    statusType: "payment",
  });

  return jsonResponse({
    ok: true,
    orderId: order.id,
    paymentStatus: "cancelled",
    cancelledAt,
    cancelReason: reason,
    refund: null,
    invoice,
    warnings: invoiceWarnings(invoice),
    cancelledShipments: cancelledShipments.length,
  });
}

async function cancelPaidOrderWithRefund(
  admin: AdminClient,
  order: OrderRow,
  reason: string | null,
): Promise<Response> {
  cancelDebugLog("cancelPaidOrderWithRefund.start", {
    orderId: order.id,
    paymentProvider: order.payment_provider ?? null,
    paymentMethod: order.payment_method ?? null,
    paymentStatus: order.payment_status ?? null,
    reason,
  });

  if (text(order.payment_provider).toLowerCase() !== "ecpay") {
    throw new Error("Paid order cancellation with auto-refund only supports ECPay orders");
  }

  if (!isCreditPayment(order)) {
    throw new Error(
      "Paid order cancellation with auto-refund only supports ECPay credit-card payments",
    );
  }

  const existingRefund = await fetchBlockingOrderRefundByOrderId(admin, order.id);
  cancelDebugLog("cancelPaidOrderWithRefund.existingRefund", {
    orderId: order.id,
    found: Boolean(existingRefund?.id),
    refundId: existingRefund?.id ?? null,
    status: existingRefund?.status ?? null,
  });
  if (existingRefund?.id) {
    throw new Error(
      `This order already has a ${existingRefund.status ?? "existing"} refund record`,
    );
  }

  const providerOrderId = text(order.provider_order_id) || text(order.order_number);
  if (!providerOrderId) {
    throw new Error("Missing provider_order_id for refund");
  }

  const providerTransactionId = text(order.provider_transaction_id);
  if (!providerTransactionId) {
    throw new Error("Missing provider_transaction_id for refund");
  }

  const refundAmount = toPositiveInt(order.total_amount, "order total_amount");
  const refundReason = reason || "cancel paid order";
  const refundRequestId = buildRefundRequestId();
  const config = getEcpayCreditActionConfig();

  const ecpayParams: Record<string, string | number> = {
    MerchantID: config.merchantId,
    MerchantTradeNo: providerOrderId,
    TradeNo: providerTransactionId,
    Action: "R",
    TotalAmount: refundAmount,
    ...(config.platformId ? { PlatformID: config.platformId } : {}),
  };

  cancelDebugLog("cancelPaidOrderWithRefund.refundPrepared", {
    orderId: order.id,
    providerOrderId,
    providerTransactionId,
    refundAmount,
    refundRequestId,
    hasPlatformId: Boolean(config.platformId),
  });

  const refundRecord = await createOrderRefundRecord(admin, {
    order_id: order.id,
    user_id: order.user_id,
    refund_request_id: refundRequestId,
    provider_order_id: providerOrderId,
    provider_transaction_id: providerTransactionId,
    refund_amount: refundAmount,
    refund_reason: refundReason,
    status: "requesting",
    request_payload: {
      ...ecpayParams,
      CheckMacValue: "<generated>",
    },
  });

  let refundMarkedSuccess = false;

  try {
    cancelDebugLog("cancelPaidOrderWithRefund.refundRecordCreated", {
      orderId: order.id,
      refundRecordId: refundRecord.id ?? null,
      refundRequestId,
    });

    await updateOrderRefundRecord(admin, refundRecord.id!, { status: "processing" });

    cancelDebugLog("cancelPaidOrderWithRefund.refundProcessing", {
      orderId: order.id,
      refundRecordId: refundRecord.id ?? null,
    });

    const ecpayResult = await postEcpayCreditAction(config, ecpayParams);
    const rtnCode = text(ecpayResult.parsed.RtnCode ?? ecpayResult.parsed.rtnCode);
    const rtnMsg = text(ecpayResult.parsed.RtnMsg ?? ecpayResult.parsed.rtnMsg);

    cancelDebugLog("cancelPaidOrderWithRefund.ecpayParsed", {
      orderId: order.id,
      refundRecordId: refundRecord.id ?? null,
      rtnCode,
      rtnMsg,
    });

    if (rtnCode !== "1") {
      cancelDebugWarn("cancelPaidOrderWithRefund.ecpayFailed", {
        orderId: order.id,
        refundRecordId: refundRecord.id ?? null,
        rtnCode,
        rtnMsg,
      });
      await updateOrderRefundRecord(admin, refundRecord.id!, {
        status: "failed",
        provider_result_code: rtnCode ? Number(rtnCode) : null,
        provider_result_message: rtnMsg || "ECPay refund failed",
        response_payload: ecpayResult.parsed,
        raw_response: ecpayResult.rawBody,
      });
      throw new Error(rtnMsg || "ECPay refund failed");
    }

    const cancelledAt = new Date().toISOString();

    await updateOrder(admin, order.id, {
      payment_status: "refunded",
      cancelled_at: cancelledAt,
      cancel_reason: reason,
      provider_status_code: Number(rtnCode),
      provider_status_message: rtnMsg || "Refund success",
    });

    cancelDebugLog("cancelPaidOrderWithRefund.orderUpdated", {
      orderId: order.id,
      cancelledAt,
      paymentStatus: "refunded",
    });

    await updateOrderRefundRecord(admin, refundRecord.id!, {
      status: "success",
      provider_result_code: Number(rtnCode),
      provider_result_message: rtnMsg || "Refund success",
      response_payload: ecpayResult.parsed,
      raw_response: ecpayResult.rawBody,
    });
    refundMarkedSuccess = true;

    cancelDebugLog("cancelPaidOrderWithRefund.refundRecordSuccess", {
      orderId: order.id,
      refundRecordId: refundRecord.id ?? null,
      rtnCode,
      rtnMsg,
    });

    const cancelledShipments = await cancelOrderShipmentsByOrderId(admin, order.id, cancelledAt);

    cancelDebugLog("cancelPaidOrderWithRefund.shipmentsUpdated", {
      orderId: order.id,
      updatedCount: cancelledShipments.length,
      shipmentIds: cancelledShipments.map((shipment) => shipment.id ?? null),
    });

    const invoice = await voidInvoiceForCancelledOrder(admin, order.id, reason);

    // 已付款訂單取消並退款成功，廠商後台需要知道這張單已結束。
    await notifyVendorsOrderStatusChanged(admin, {
      orderId: order.id,
      status: "refunded",
      statusType: "payment",
    });

    return jsonResponse({
      ok: true,
      orderId: order.id,
      paymentStatus: "refunded",
      cancelledAt,
      cancelReason: reason,
      refund: {
        refundRecordId: refundRecord.id,
        refundRequestId,
        refundAmount,
        status: "success",
      },
      invoice,
      warnings: invoiceWarnings(invoice),
      cancelledShipments: cancelledShipments.length,
      ecpay: ecpayResult.parsed,
    });
  } catch (error) {
    const message = errorText(error);
    cancelDebugWarn("cancelPaidOrderWithRefund.exception", {
      orderId: order.id,
      refundRecordId: refundRecord.id ?? null,
      error: message,
    });
    if (!refundMarkedSuccess) {
      await updateOrderRefundRecord(admin, refundRecord.id!, {
        status: "failed",
        provider_result_message: message,
      }).catch((updateError) => {
        cancelDebugWarn("cancelPaidOrderWithRefund.markRefundFailedError", {
          orderId: order.id,
          refundRecordId: refundRecord.id ?? null,
          error: errorText(updateError),
        });
      });
    } else {
      cancelDebugWarn("cancelPaidOrderWithRefund.afterRefundSuccessError", {
        orderId: order.id,
        refundRecordId: refundRecord.id ?? null,
        note: "Refund was already marked success; not changing order_refunds.status back to failed.",
        error: message,
      });
    }
    throw error;
  }
}

const handleRequest = async (req) => {
  cancelDebugLog("request.received", {
    method: req.method,
    url: req.url,
  });

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
    const body = (await req.json()) as CancelOrderBody;

    cancelDebugLog("request.authenticated", {
      userId,
      bodyKeys: Object.keys(body),
    });

    const orderId = text(body.orderId ?? body.order_id);
    if (!orderId) {
      throw new Error("orderId is required");
    }

    const order = await fetchOrderForUser(admin, orderId, userId);
    const paymentStatus = normalizePaymentStatus(order.payment_status);
    const reason = text(body.reason ?? body.cancelReason ?? body.cancel_reason) || null;

    cancelDebugLog("order.fetched", {
      orderId: order.id,
      userId: order.user_id,
      paymentStatus,
      paymentProvider: order.payment_provider ?? null,
      paymentMethod: order.payment_method ?? null,
      providerOrderId: order.provider_order_id ?? null,
      hasProviderTransactionId: Boolean(order.provider_transaction_id),
      totalAmount: order.total_amount ?? null,
      reason,
    });

    if (paymentStatus === "cancelled") {
      cancelDebugWarn("order.blocked", {
        orderId: order.id,
        paymentStatus,
        reason: "already_cancelled",
      });
      return jsonResponse({
        ok: true,
        orderId: order.id,
        paymentStatus: "cancelled",
        alreadyCancelled: true,
        refund: null,
      });
    }

    if (paymentStatus === "refunded") {
      cancelDebugWarn("order.blocked", {
        orderId: order.id,
        paymentStatus,
        reason: "already_refunded",
      });
      return jsonResponse({
        ok: true,
        orderId: order.id,
        paymentStatus: "refunded",
        alreadyRefunded: true,
      });
    }

    const shipmentGuard = await assertAllOrderShipmentsPending(admin, order.id, {
      requireShipment: paymentStatus === "paid",
    });

    if (paymentStatus === "pending") {
      cancelDebugLog("order.branch", { orderId: order.id, branch: "pending_cancel" });
      const response = await cancelPendingOrder(admin, order, reason);
      const payload = (await response.json()) as Record<string, unknown>;
      return jsonResponse({ ...payload, checkedShipments: shipmentGuard.total });
    }

    if (paymentStatus === "paid") {
      cancelDebugLog("order.branch", { orderId: order.id, branch: "paid_refund_cancel" });
      const response = await cancelPaidOrderWithRefund(admin, order, reason);
      const payload = (await response.json()) as Record<string, unknown>;
      return jsonResponse({ ...payload, checkedShipments: shipmentGuard.total });
    }

    throw new Error(
      `Only pending or paid orders can be cancelled. Current payment_status: ${paymentStatus || "<empty>"}`,
    );
  } catch (error) {
    const message = errorText(error);
    cancelDebugWarn("request.failed", { error: message });
    return jsonResponse({ error: message }, 400);
  }
};

export default handleRequest;
