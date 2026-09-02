import { generateCheckMacValue } from "../_shared/ecpay_payment.ts";
import { optionalEnv } from "../_shared/env.ts";
import { isSystemAction, requireJobSecret } from "./job_auth.ts";
import {
  insertRows,
  queryString,
  restRequest,
  selectOne,
  selectRows,
  type AdminClient,
  type OrderRefundRow,
  type OrderRow,
} from "./orders.ts";
import { assertShipmentVendorAccess } from "./orders_shipments.ts";
import { createOrderRefundRecord, updateOrderRefundRecord } from "./orders_refunds.ts";
import { notifyVendorsOrderReturnEvent } from "./push_notifications.ts";

// Note: the `admin` function parameter is the service-role database client, not a platform-admin user/action.
export type OrderReturnBody = Record<string, unknown>;
export type OrderReturnPayload = Record<string, unknown>;

export type OrderReturnStatus =
  | "requested"
  | "approved"
  | "shipped"
  | "disputed"
  | "shipment_issue"
  | "refunded"
  | "cancelled"
  | "refund_failed";

// Public actions are limited to buyer/seller operations. Platform-admin actions are intentionally omitted.
export type OrderReturnAction =
  | "create"
  | "cancel"
  | "ship"
  | "vendor_approve"
  | "vendor_dispute"
  | "vendor_shipment_issue"
  | "vendor_confirm_received"
  | "system_mark_unanswered_disputed"
  | "system_auto_refund_shipped";

export type OrderReturnRow = {
  id: string;
  order_id: string;
  order_item_id: string;
  shipment_id: string;
  buyer_user_id: string;
  vendor_id: string;
  quantity: number | string;
  reason: string;
  status: OrderReturnStatus | string;
  currency?: string | null;
  refund_amount: number | string;
  buyer_received_at: string;
  approved_at?: string | null;
  return_carrier?: string | null;
  return_tracking_no?: string | null;
  buyer_shipped_at?: string | null;
  vendor_received_at?: string | null;
  dispute_reason?: string | null;
  disputed_at?: string | null;
  order_refund_id?: string | null;
  refunded_at?: string | null;
  refund_failed_at?: string | null;
  refund_failure_reason?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  quantity: number | string;
  unit_price?: number | string | null;
  line_total?: number | string | null;
  vendor_id: string;
  currency?: string | null;
  product_name?: string | null;
  sku_name?: string | null;
};

type OrderShipmentReturnRow = {
  id: string;
  order_id: string;
  vendor_id: string;
  shipping_status?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
};

type EcpayCreditActionConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  actionUrl: string;
  platformId: string;
};

const RETURN_WINDOW_DAYS = 7;
const DEFAULT_VENDOR_RESPONSE_DAYS = 7;
const DEFAULT_VENDOR_RECEIVE_CONFIRM_DAYS = 7;
const ACTIVE_QUANTITY_STATUSES: OrderReturnStatus[] = [
  "requested",
  "approved",
  "shipped",
  "disputed",
  "shipment_issue",
  "refund_failed",
  "refunded",
];

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function normalize(value: unknown): string {
  return text(value).toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveText(value: unknown, field: string): string {
  const parsed = text(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function optionalText(value: unknown): string {
  return text(value);
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

function toNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .replaceAll(",", "")
            .trim(),
        );

  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number`);
  }
  return parsed;
}

function addDays(dateIso: string, days: number): Date {
  const time = new Date(dateIso).getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid date: ${dateIso || "<empty>"}`);
  }
  return new Date(time + days * 24 * 60 * 60 * 1000);
}

function getPayload(body: OrderReturnBody): OrderReturnPayload {
  const payload = body.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as OrderReturnPayload;
  }
  return {};
}

function requireReturnId(body: OrderReturnBody): string {
  return positiveText(body.returnId ?? body.return_id, "returnId");
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

function isCreditPayment(order: OrderRow): boolean {
  const method = normalize(order.payment_method);
  return (
    method === "credit_card" ||
    method === "credit" ||
    method.includes("credit") ||
    method.includes("creditcard")
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
  for (const [key, value] of Object.entries({
    ...params,
    CheckMacValue: checkMacValue,
  })) {
    form.set(key, String(value));
  }

  orderReturnDebugLog("ecpayRefund.call", {
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

  orderReturnDebugLog("ecpayRefund.response", {
    httpStatus: response.status,
    parsed,
    rawBodyPreview: rawBody.slice(0, 500),
  });

  if (!response.ok) {
    throw new Error(`ECPay refund HTTP failed (${response.status}): ${rawBody}`);
  }

  return { httpStatus: response.status, rawBody, parsed };
}

function buildReturnRefundRequestId(returnId: string): string {
  return `RT${returnId.replaceAll("-", "").toUpperCase()}`.slice(0, 30);
}

export function orderReturnDebugLog(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[order_return][debug] ${event}`, JSON.stringify(payload));
}

export function orderReturnDebugWarn(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(`[order_return][warn] ${event}`, JSON.stringify(payload));
}

async function fetchRequired<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, string | number | boolean>,
  errorMessage: string,
): Promise<T> {
  const row = await selectOne<T>(admin, table, params);
  if (!row) throw new Error(errorMessage);
  return row;
}

async function fetchOrder(admin: AdminClient, orderId: string): Promise<OrderRow> {
  return await fetchRequired<OrderRow>(
    admin,
    "orders",
    {
      select: "*",
      id: `eq.${orderId}`,
    },
    "Order not found",
  );
}

async function fetchOrderItem(admin: AdminClient, orderItemId: string): Promise<OrderItemRow> {
  return await fetchRequired<OrderItemRow>(
    admin,
    "order_items",
    {
      select: "id,order_id,quantity,unit_price,line_total,vendor_id,currency,product_name,sku_name",
      id: `eq.${orderItemId}`,
    },
    "Order item not found",
  );
}

async function fetchShipment(
  admin: AdminClient,
  shipmentId: string,
): Promise<OrderShipmentReturnRow> {
  return await fetchRequired<OrderShipmentReturnRow>(
    admin,
    "order_shipments",
    {
      select: "id,order_id,vendor_id,shipping_status,delivered_at,picked_up_at",
      id: `eq.${shipmentId}`,
    },
    "Order shipment not found",
  );
}

export async function fetchOrderReturnById(
  admin: AdminClient,
  returnId: string,
): Promise<OrderReturnRow> {
  return await fetchRequired<OrderReturnRow>(
    admin,
    "order_returns",
    {
      select: "*",
      id: `eq.${returnId}`,
    },
    "Order return not found",
  );
}

async function fetchOrderRefundById(
  admin: AdminClient,
  refundId: string,
): Promise<OrderRefundRow | null> {
  return await selectOne<OrderRefundRow>(admin, "order_refunds", {
    select: "*",
    id: `eq.${refundId}`,
  });
}

async function fetchOrderRefundByRequestId(
  admin: AdminClient,
  refundRequestId: string,
): Promise<OrderRefundRow | null> {
  return await selectOne<OrderRefundRow>(admin, "order_refunds", {
    select: "*",
    refund_request_id: `eq.${refundRequestId}`,
  });
}

function assertBuyerOwnsReturn(orderReturn: OrderReturnRow, userId: string): void {
  if (text(orderReturn.buyer_user_id) !== userId) {
    throw new Error("Current user is not the buyer of this return");
  }
}

async function assertVendorOwnsReturn(
  admin: AdminClient,
  orderReturn: OrderReturnRow,
  userId: string,
): Promise<void> {
  await assertShipmentVendorAccess(admin, text(orderReturn.vendor_id), userId);
}

function assertStatus(currentStatus: unknown, allowed: OrderReturnStatus[], action: string): void {
  const status = normalize(currentStatus) as OrderReturnStatus;
  if (!allowed.includes(status)) {
    throw new Error(
      `Invalid return status for ${action}. Current status: ${status || "<empty>"}. Allowed: ${allowed.join(", ")}`,
    );
  }
}

function buyerReceivedAtFromShipment(shipment: OrderShipmentReturnRow): string {
  const status = normalize(shipment.shipping_status);
  if (status !== "delivered" && status !== "picked-up" && status !== "picked_up") {
    throw new Error("Only delivered or picked-up shipments can be returned");
  }

  const receivedAt = text(shipment.picked_up_at) || text(shipment.delivered_at);
  if (!receivedAt) {
    throw new Error("Shipment is completed but missing picked_up_at or delivered_at");
  }
  return receivedAt;
}

function assertWithinReturnWindow(buyerReceivedAt: string): void {
  const deadline = addDays(buyerReceivedAt, RETURN_WINDOW_DAYS);
  if (Date.now() > deadline.getTime()) {
    throw new Error(
      `Return window expired. Returns are allowed within ${RETURN_WINDOW_DAYS} days after receipt`,
    );
  }
}

async function getUsedReturnQuantity(admin: AdminClient, orderItemId: string): Promise<number> {
  const rows = await selectRows<{ quantity?: number | string | null }>(admin, "order_returns", {
    select: "quantity",
    order_item_id: `eq.${orderItemId}`,
    status: `in.(${ACTIVE_QUANTITY_STATUSES.join(",")})`,
  });

  return rows.reduce((sum, row) => sum + toNumber(row.quantity ?? 0, "order_returns.quantity"), 0);
}

function calculateRefundAmount(orderItem: OrderItemRow, returnQuantity: number): number {
  const originalQuantity = toPositiveInt(orderItem.quantity, "order item quantity");
  if (returnQuantity > originalQuantity) {
    throw new Error("Return quantity cannot exceed order item quantity");
  }

  const lineTotal =
    orderItem.line_total == null
      ? toNumber(orderItem.unit_price, "order item unit_price") * originalQuantity
      : toNumber(orderItem.line_total, "order item line_total");

  const amount = (lineTotal * returnQuantity) / originalQuantity;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Calculated refund amount must be positive");
  }

  // ECPay credit-card refund amount is integer NTD. Persist the same rounded value.
  return Math.round(amount);
}

async function patchOrderReturn(
  admin: AdminClient,
  returnId: string,
  payload: Record<string, unknown>,
): Promise<OrderReturnRow> {
  const rows = await restRequest<OrderReturnRow[]>(
    admin,
    "order_returns",
    queryString({ id: `eq.${returnId}` }),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        ...payload,
        updated_at: nowIso(),
      }),
    },
  );

  const updated = rows[0] ?? null;
  if (!updated?.id) {
    throw new Error("Failed to update order return");
  }
  return updated;
}

async function createOrderReturn(
  admin: AdminClient,
  userId: string,
  payload: OrderReturnPayload,
): Promise<OrderReturnRow> {
  const orderId = positiveText(payload.orderId ?? payload.order_id, "payload.orderId");
  const orderItemId = positiveText(
    payload.orderItemId ?? payload.order_item_id,
    "payload.orderItemId",
  );
  const shipmentId = positiveText(payload.shipmentId ?? payload.shipment_id, "payload.shipmentId");
  const quantity = toPositiveInt(payload.quantity, "payload.quantity");
  const reason = positiveText(payload.reason, "payload.reason");

  const [order, orderItem, shipment] = await Promise.all([
    fetchOrder(admin, orderId),
    fetchOrderItem(admin, orderItemId),
    fetchShipment(admin, shipmentId),
  ]);

  if (text(order.user_id) !== userId) {
    throw new Error("Current user is not the buyer of this order");
  }
  if (normalize(order.payment_status) !== "paid") {
    throw new Error("Only paid orders can be returned");
  }
  if (text(orderItem.order_id) !== orderId) {
    throw new Error("orderItemId does not belong to orderId");
  }
  if (text(shipment.order_id) !== orderId) {
    throw new Error("shipmentId does not belong to orderId");
  }
  if (text(shipment.vendor_id) !== text(orderItem.vendor_id)) {
    throw new Error("shipment vendor_id does not match order item vendor_id");
  }

  const buyerReceivedAt = buyerReceivedAtFromShipment(shipment);
  assertWithinReturnWindow(buyerReceivedAt);

  const usedQuantity = await getUsedReturnQuantity(admin, orderItemId);
  const originalQuantity = toPositiveInt(orderItem.quantity, "order item quantity");
  const refundableQuantity = originalQuantity - usedQuantity;
  if (quantity > refundableQuantity) {
    throw new Error(
      `Return quantity exceeds refundable quantity. Remaining refundable quantity: ${refundableQuantity}`,
    );
  }

  const now = nowIso();
  const rows = await insertRows<OrderReturnRow>(admin, "order_returns", {
    order_id: orderId,
    order_item_id: orderItemId,
    shipment_id: shipmentId,
    buyer_user_id: userId,
    vendor_id: text(orderItem.vendor_id),
    quantity,
    reason,
    status: "requested",
    currency: text(orderItem.currency) || text(order.currency) || "TWD",
    refund_amount: calculateRefundAmount(orderItem, quantity),
    buyer_received_at: buyerReceivedAt,
    created_at: now,
    updated_at: now,
  });

  const created = rows[0] ?? null;
  if (!created?.id) {
    throw new Error("Failed to create order return");
  }

  return created;
}

async function cancelReturn(
  admin: AdminClient,
  userId: string,
  returnId: string,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  assertBuyerOwnsReturn(orderReturn, userId);
  assertStatus(orderReturn.status, ["requested", "approved", "disputed"], "cancel");

  return await patchOrderReturn(admin, returnId, {
    status: "cancelled",
    cancelled_at: nowIso(),
  });
}

async function shipReturn(
  admin: AdminClient,
  userId: string,
  returnId: string,
  payload: OrderReturnPayload,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  assertBuyerOwnsReturn(orderReturn, userId);
  assertStatus(orderReturn.status, ["approved"], "ship");

  const trackingNo = positiveText(
    payload.returnTrackingNo ?? payload.return_tracking_no,
    "payload.returnTrackingNo",
  );
  const carrier = optionalText(payload.returnCarrier ?? payload.return_carrier);

  return await patchOrderReturn(admin, returnId, {
    status: "shipped",
    return_carrier: carrier || null,
    return_tracking_no: trackingNo,
    buyer_shipped_at: nowIso(),
  });
}

async function vendorApproveReturn(
  admin: AdminClient,
  userId: string,
  returnId: string,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  await assertVendorOwnsReturn(admin, orderReturn, userId);
  assertStatus(orderReturn.status, ["requested", "disputed"], "vendor_approve");

  return await patchOrderReturn(admin, returnId, {
    status: "approved",
    approved_at: nowIso(),
  });
}

async function vendorDisputeReturn(
  admin: AdminClient,
  userId: string,
  returnId: string,
  payload: OrderReturnPayload,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  await assertVendorOwnsReturn(admin, orderReturn, userId);
  assertStatus(orderReturn.status, ["requested"], "vendor_dispute");

  const reason = positiveText(
    payload.reason ?? payload.disputeReason ?? payload.dispute_reason,
    "payload.reason",
  );

  return await patchOrderReturn(admin, returnId, {
    status: "disputed",
    dispute_reason: reason,
    disputed_at: nowIso(),
  });
}

// shipment_issue means the buyer has already shipped the parcel; buyer cancellation is not allowed.
async function vendorShipmentIssueReturn(
  admin: AdminClient,
  userId: string,
  returnId: string,
  payload: OrderReturnPayload,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  await assertVendorOwnsReturn(admin, orderReturn, userId);
  assertStatus(orderReturn.status, ["shipped"], "vendor_shipment_issue");

  const reason = positiveText(
    payload.reason ?? payload.issueReason ?? payload.issue_reason,
    "payload.reason",
  );

  return await patchOrderReturn(admin, returnId, {
    status: "shipment_issue",
    dispute_reason: reason,
    disputed_at: nowIso(),
  });
}

function ecpayRefundAmountFromReturn(orderReturn: OrderReturnRow): number {
  const amount = Math.round(toNumber(orderReturn.refund_amount, "order_returns.refund_amount"));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("refund_amount must be a positive integer for ECPay refund");
  }
  return amount;
}

async function prepareRefundRecord(
  admin: AdminClient,
  order: OrderRow,
  orderReturn: OrderReturnRow,
  reason: string,
): Promise<{
  refundRecord: OrderRefundRow;
  ecpayParams: Record<string, string | number>;
}> {
  if (normalize(order.payment_provider) !== "ecpay") {
    throw new Error("Order return auto-refund only supports ECPay orders");
  }
  if (!isCreditPayment(order)) {
    throw new Error("Order return auto-refund only supports ECPay credit-card payments");
  }

  const providerOrderId = text(order.provider_order_id) || text(order.order_number);
  if (!providerOrderId) throw new Error("Missing provider_order_id for refund");

  const providerTransactionId = text(order.provider_transaction_id);
  if (!providerTransactionId) throw new Error("Missing provider_transaction_id for refund");

  const refundAmount = ecpayRefundAmountFromReturn(orderReturn);
  const refundRequestId = buildReturnRefundRequestId(orderReturn.id);
  const config = getEcpayCreditActionConfig();
  const ecpayParams: Record<string, string | number> = {
    MerchantID: config.merchantId,
    MerchantTradeNo: providerOrderId,
    TradeNo: providerTransactionId,
    Action: "R",
    TotalAmount: refundAmount,
    ...(config.platformId ? { PlatformID: config.platformId } : {}),
  };

  if (orderReturn.order_refund_id) {
    const existing = await fetchOrderRefundById(admin, text(orderReturn.order_refund_id));
    if (!existing?.id) {
      throw new Error("order_returns.order_refund_id exists but order_refunds row was not found");
    }

    const existingStatus = normalize(existing.status);
    if (existingStatus === "success") {
      return { refundRecord: existing, ecpayParams };
    }
    if (existingStatus === "requesting" || existingStatus === "processing") {
      throw new Error("This return already has a refund in progress");
    }
    if (existingStatus === "failed") {
      throw new Error("This return refund previously failed and requires external reconciliation");
    }
    throw new Error(`Unsupported existing refund status: ${existingStatus}`);
  }

  const duplicate = await fetchOrderRefundByRequestId(admin, refundRequestId);
  if (duplicate?.id) {
    await patchOrderReturn(admin, orderReturn.id, {
      order_refund_id: duplicate.id,
    });
    const duplicateStatus = normalize(duplicate.status);
    if (duplicateStatus === "success") {
      return { refundRecord: duplicate, ecpayParams };
    }
    if (duplicateStatus === "requesting" || duplicateStatus === "processing") {
      throw new Error("This return already has a refund in progress");
    }
    if (duplicateStatus === "failed") {
      throw new Error("This return refund previously failed and requires external reconciliation");
    }
    throw new Error(`Unsupported duplicate refund status: ${duplicateStatus}`);
  }

  const refundRecord = await createOrderRefundRecord(admin, {
    order_id: orderReturn.order_id,
    user_id: orderReturn.buyer_user_id,
    refund_request_id: refundRequestId,
    provider_order_id: providerOrderId,
    provider_transaction_id: providerTransactionId,
    refund_amount: refundAmount,
    refund_reason: reason,
    status: "requesting",
    request_payload: { ...ecpayParams, CheckMacValue: "<generated>" },
  });

  await patchOrderReturn(admin, orderReturn.id, {
    order_refund_id: refundRecord.id,
  });
  return { refundRecord, ecpayParams };
}

async function refundOrderReturn(
  admin: AdminClient,
  orderReturn: OrderReturnRow,
  options: {
    reason?: string | null;
    markVendorReceived?: boolean;
  } = {},
): Promise<OrderReturnRow> {
  const freshReturn = await fetchOrderReturnById(admin, orderReturn.id);
  assertStatus(freshReturn.status, ["shipped", "shipment_issue"], "refund");

  const order = await fetchOrder(admin, freshReturn.order_id);
  const reason = options.reason || `order return refund ${freshReturn.id}`;

  const { refundRecord, ecpayParams } = await prepareRefundRecord(
    admin,
    order,
    freshReturn,
    reason,
  );

  if (normalize(refundRecord.status) === "success") {
    return await patchOrderReturn(admin, freshReturn.id, {
      status: "refunded",
      refunded_at: freshReturn.refunded_at || nowIso(),
      refund_failed_at: null,
      refund_failure_reason: null,
    });
  }

  try {
    await updateOrderRefundRecord(admin, refundRecord.id!, {
      status: "processing",
    });

    if (options.markVendorReceived && !freshReturn.vendor_received_at) {
      await patchOrderReturn(admin, freshReturn.id, {
        vendor_received_at: nowIso(),
      });
    }

    const result = await postEcpayCreditAction(getEcpayCreditActionConfig(), ecpayParams);
    const rtnCode = text(result.parsed.RtnCode ?? result.parsed.rtnCode);
    const rtnMsg = text(result.parsed.RtnMsg ?? result.parsed.rtnMsg);

    if (rtnCode !== "1") {
      await updateOrderRefundRecord(admin, refundRecord.id!, {
        status: "failed",
        provider_result_code: rtnCode ? Number(rtnCode) : null,
        provider_result_message: rtnMsg || "ECPay refund failed",
        response_payload: result.parsed,
        raw_response: result.rawBody,
      });

      return await patchOrderReturn(admin, freshReturn.id, {
        status: "refund_failed",
        refund_failed_at: nowIso(),
        refund_failure_reason: rtnMsg || "ECPay refund failed",
      });
    }

    await updateOrderRefundRecord(admin, refundRecord.id!, {
      status: "success",
      provider_result_code: Number(rtnCode),
      provider_result_message: rtnMsg || "Refund success",
      response_payload: result.parsed,
      raw_response: result.rawBody,
    });

    return await patchOrderReturn(admin, freshReturn.id, {
      status: "refunded",
      refunded_at: nowIso(),
      refund_failed_at: null,
      refund_failure_reason: null,
      ...(options.markVendorReceived && !freshReturn.vendor_received_at
        ? { vendor_received_at: nowIso() }
        : {}),
    });
  } catch (error) {
    const message = errorText(error);
    orderReturnDebugWarn("refund.exception", {
      returnId: freshReturn.id,
      refundRecordId: refundRecord.id ?? null,
      error: message,
    });

    await updateOrderRefundRecord(admin, refundRecord.id!, {
      status: "failed",
      provider_result_message: message,
    }).catch((updateError) => {
      orderReturnDebugWarn("refund.markRefundFailedError", {
        returnId: freshReturn.id,
        refundRecordId: refundRecord.id ?? null,
        error: errorText(updateError),
      });
    });

    return await patchOrderReturn(admin, freshReturn.id, {
      status: "refund_failed",
      refund_failed_at: nowIso(),
      refund_failure_reason: message,
    });
  }
}

async function vendorConfirmReceived(
  admin: AdminClient,
  userId: string,
  returnId: string,
): Promise<OrderReturnRow> {
  const orderReturn = await fetchOrderReturnById(admin, returnId);
  await assertVendorOwnsReturn(admin, orderReturn, userId);
  assertStatus(orderReturn.status, ["shipped", "shipment_issue"], "vendor_confirm_received");

  if (!text(orderReturn.return_tracking_no)) {
    throw new Error("return_tracking_no is required before vendor can confirm receipt");
  }

  return await refundOrderReturn(admin, orderReturn, {
    reason: "vendor confirmed return received",
    markVendorReceived: true,
  });
}

// Internal scheduled jobs remain available; they are not platform-admin UI actions.
async function markUnansweredDisputed(
  admin: AdminClient,
  req: Request,
  payload: OrderReturnPayload,
): Promise<{ updated: number; returnIds: string[] }> {
  requireJobSecret(req);

  const days = toPositiveInt(payload.days ?? DEFAULT_VENDOR_RESPONSE_DAYS, "payload.days");
  const limit = Math.min(toPositiveInt(payload.limit ?? 100, "payload.limit"), 500);
  const reason = optionalText(payload.reason) || "賣家逾期未回應退貨申請";
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await selectRows<OrderReturnRow>(admin, "order_returns", {
    select: "*",
    status: "eq.requested",
    created_at: `lt.${threshold}`,
    order: "created_at.asc",
    limit,
  });

  const updatedIds: string[] = [];
  for (const row of rows) {
    const updated = await patchOrderReturn(admin, row.id, {
      status: "disputed",
      dispute_reason: reason,
      disputed_at: nowIso(),
    });
    updatedIds.push(updated.id);
  }

  return { updated: updatedIds.length, returnIds: updatedIds };
}

async function autoRefundShipped(
  admin: AdminClient,
  req: Request,
  payload: OrderReturnPayload,
): Promise<{
  processed: number;
  refunded: number;
  failed: number;
  returnIds: string[];
}> {
  requireJobSecret(req);

  const days = toPositiveInt(payload.days ?? DEFAULT_VENDOR_RECEIVE_CONFIRM_DAYS, "payload.days");
  const limit = Math.min(toPositiveInt(payload.limit ?? 50, "payload.limit"), 100);
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await selectRows<OrderReturnRow>(admin, "order_returns", {
    select: "*",
    status: "eq.shipped",
    buyer_shipped_at: `lt.${threshold}`,
    vendor_received_at: "is.null",
    order_refund_id: "is.null",
    order: "buyer_shipped_at.asc",
    limit,
  });

  let refunded = 0;
  let failed = 0;
  const returnIds: string[] = [];
  for (const row of rows) {
    const updated = await refundOrderReturn(admin, row, {
      reason: "seller did not confirm received return within deadline",
    });
    returnIds.push(updated.id);
    if (normalize(updated.status) === "refunded") refunded += 1;
    if (normalize(updated.status) === "refund_failed") failed += 1;
  }

  return { processed: rows.length, refunded, failed, returnIds };
}

export async function runOrderReturnAction(
  admin: AdminClient,
  userId: string,
  req: Request,
  body: OrderReturnBody,
): Promise<Record<string, unknown>> {
  const action = normalize(body.action) as OrderReturnAction;
  const payload = getPayload(body);

  orderReturnDebugLog("action.start", {
    action,
    userId,
    bodyKeys: Object.keys(body),
    payloadKeys: Object.keys(payload),
  });

  if (!action) throw new Error("action is required");

  // 與 runSystemJobAction 對齊：system_* 一律在分派前就擋一次，
  // 之後有人加新的 system_* action 卻忘了在 handler 內驗 secret 時才不會直接開天窗。
  if (isSystemAction(action)) requireJobSecret(req);

  let data: unknown;

  switch (action) {
    // 買家端三個 action 都要推播給賣家：賣家不在現場，不推就不會知道。
    // 賣家自己觸發的 vendor_* action 不推播，因為操作的人就是收通知的人。
    case "create":
      data = await createOrderReturn(admin, userId, payload);
      await notifyVendorsOrderReturnEvent(admin, {
        orderReturn: data as OrderReturnRow,
        event: "created",
      });
      break;

    case "cancel":
      data = await cancelReturn(admin, userId, requireReturnId(body));
      await notifyVendorsOrderReturnEvent(admin, {
        orderReturn: data as OrderReturnRow,
        event: "cancelled",
      });
      break;

    case "ship":
      data = await shipReturn(admin, userId, requireReturnId(body), payload);
      await notifyVendorsOrderReturnEvent(admin, {
        orderReturn: data as OrderReturnRow,
        event: "shipped",
      });
      break;

    case "vendor_approve":
      data = await vendorApproveReturn(admin, userId, requireReturnId(body));
      break;

    case "vendor_dispute":
      data = await vendorDisputeReturn(admin, userId, requireReturnId(body), payload);
      break;

    case "vendor_shipment_issue":
      data = await vendorShipmentIssueReturn(admin, userId, requireReturnId(body), payload);
      break;

    case "vendor_confirm_received":
      data = await vendorConfirmReceived(admin, userId, requireReturnId(body));
      break;

    case "system_mark_unanswered_disputed":
      data = await markUnansweredDisputed(admin, req, payload);
      break;

    case "system_auto_refund_shipped":
      data = await autoRefundShipped(admin, req, payload);
      break;

    default:
      throw new Error(`Unsupported order return action: ${action || "<empty>"}`);
  }

  orderReturnDebugLog("action.success", { action, userId });
  return { ok: true, action, data };
}
