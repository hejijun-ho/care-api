import { getEcpayInvoiceConfig, issueEcpayInvoiceForOrder } from "../_shared/ecpay_invoice.ts";
import { optionalEnv } from "../_shared/env.ts";
import { requireJobSecret } from "./job_auth.ts";
import {
  selectRows,
  updateOrder,
  type AdminClient,
  type OrderInvoiceRow,
  type OrderRow,
} from "./orders.ts";
import { cancelOrderShipmentsByOrderId, updateOrderShipment } from "./orders_shipments.ts";
import { notifyVendorsOrderStatusChanged } from "./push_notifications.ts";

export type SystemJobBody = Record<string, unknown>;
export type SystemJobPayload = Record<string, unknown>;

export type SystemJobAction =
  | "auto_confirm_received"
  | "expire_unpaid_orders"
  | "retry_failed_invoices"
  | "report_stuck_refunds";

type ShipmentCandidateRow = {
  id: string;
  order_id: string;
  vendor_id?: string | number | null;
  shipping_status?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
};

type SkipDetail = { shipmentId?: string; orderId: string; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// 訂單已進入這些狀態就不該再自動確認收貨：錢已經退掉或作廢了。
const INACTIVE_ORDER_STATUSES = ["cancelled", "refunded", "expired", "failed"];
// 退貨還在進行中的狀態集合。
const ACTIVE_RETURN_STATUSES = [
  "requested",
  "approved",
  "disputed",
  "shipped",
  "shipment_issue",
  "refund_failed",
];
// COD 在送達前本來就會一直是 pending，不能當成逾期未付款。
const COD_PAYMENT_METHODS = ["cod", "cash_on_delivery"];

export function systemJobDebugLog(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[system-jobs][debug] ${event}`, JSON.stringify(payload));
}

export function systemJobDebugWarn(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(`[system-jobs][warn] ${event}`, JSON.stringify(payload));
}

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

// graceMinutes 允許 0（立即到期），所以不能直接用 toPositiveInt。
function toNonNegativeInt(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(
          String(value ?? "")
            .replaceAll(",", "")
            .trim(),
          10,
        );

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function toLimit(value: unknown, field: string, fallback: number, hardMax: number): number {
  return Math.min(toPositiveInt(value ?? fallback, field), hardMax);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return normalize(value) === "true";
}

function getPayload(body: SystemJobBody): SystemJobPayload {
  const payload = body.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as SystemJobPayload;
  }
  return {};
}

function isoBefore(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value)));
}

/**
 * (a) auto_confirm_received
 * 買家沒按「確認收貨」，超過期限就代按：不代按的話鑑賞期與月結永遠不會開始。
 */
async function autoConfirmReceived(
  admin: AdminClient,
  payload: SystemJobPayload,
): Promise<Record<string, unknown>> {
  const defaultDays = optionalEnv("AUTO_CONFIRM_RECEIVED_DAYS") || 7;
  const days = toPositiveInt(payload.days ?? defaultDays, "payload.days");
  const limit = toLimit(payload.limit, "payload.limit", 100, 500);
  const dryRun = toBoolean(payload.dryRun);
  const threshold = isoBefore(days * DAY_MS);

  const shipments = await selectRows<ShipmentCandidateRow>(admin, "order_shipments", {
    select: "id,order_id,vendor_id,shipping_status,shipped_at,delivered_at,picked_up_at",
    picked_up_at: "is.null",
    or: `(and(shipping_status.eq.shipped,shipped_at.lt.${threshold}),and(shipping_status.eq.delivered,delivered_at.lt.${threshold}))`,
    order: "created_at.asc",
    limit,
  });

  systemJobDebugLog("autoConfirmReceived.candidates", {
    days,
    limit,
    dryRun,
    scanned: shipments.length,
  });

  const orderIds = unique(shipments.map((shipment) => text(shipment.order_id)));
  const shipmentIdList = unique(shipments.map((shipment) => text(shipment.id)));

  const orders = orderIds.length
    ? await selectRows<OrderRow>(admin, "orders", {
        select: "id,payment_status",
        id: `in.(${orderIds.join(",")})`,
      })
    : [];
  const orderStatusById = new Map(
    orders.map((order) => [text(order.id), normalize(order.payment_status)]),
  );

  // 確認收貨會開啟退貨鑑賞期並讓貨款可以撥付；退貨還在跑的時候代按會同時弄壞這兩件事。
  const activeReturns = shipmentIdList.length
    ? await selectRows<{ shipment_id: string }>(admin, "order_returns", {
        select: "shipment_id",
        shipment_id: `in.(${shipmentIdList.join(",")})`,
        status: `in.(${ACTIVE_RETURN_STATUSES.join(",")})`,
      })
    : [];
  const shipmentIdsWithActiveReturn = new Set(
    activeReturns.map((row) => text(row.shipment_id)).filter((value) => value),
  );

  const confirmedShipmentIds: string[] = [];
  const skippedDetails: SkipDetail[] = [];

  for (const shipment of shipments) {
    const shipmentId = text(shipment.id);
    const orderId = text(shipment.order_id);
    const status = normalize(shipment.shipping_status);

    if (INACTIVE_ORDER_STATUSES.includes(orderStatusById.get(orderId) ?? "")) {
      skippedDetails.push({ shipmentId, orderId, reason: "order_not_active" });
      continue;
    }

    if (shipmentIdsWithActiveReturn.has(shipmentId)) {
      skippedDetails.push({ shipmentId, orderId, reason: "active_return" });
      continue;
    }

    const drivingTimestamp =
      status === "shipped" ? text(shipment.shipped_at) : text(shipment.delivered_at);
    if (!drivingTimestamp) {
      skippedDetails.push({ shipmentId, orderId, reason: "missing_timestamp" });
      continue;
    }

    // Idempotency re-check: the query already filters picked_up_at, re-verify before writing.
    if (status === "picked-up" || text(shipment.picked_up_at)) {
      skippedDetails.push({ shipmentId, orderId, reason: "already_confirmed" });
      continue;
    }

    if (dryRun) {
      confirmedShipmentIds.push(shipmentId);
      continue;
    }

    await updateOrderShipment(admin, shipmentId, {
      shipping_status: "picked-up",
      picked_up_at: nowIso(),
    });
    confirmedShipmentIds.push(shipmentId);

    // 推播失敗不能回滾狀態：狀態已經改了，只記錄下來讓人追。
    try {
      await notifyVendorsOrderStatusChanged(admin, {
        orderId,
        status: "picked-up",
        statusType: "shipping",
        shipmentId,
        vendorIds: shipment.vendor_id ? [text(shipment.vendor_id)] : undefined,
      });
    } catch (error) {
      systemJobDebugWarn("autoConfirmReceived.notifyFailed", {
        shipmentId,
        orderId,
        error: errorText(error),
      });
      skippedDetails.push({ shipmentId, orderId, reason: "notify_failed" });
    }
  }

  return {
    scanned: shipments.length,
    confirmed: confirmedShipmentIds.length,
    skipped: skippedDetails.length,
    dryRun,
    shipmentIds: confirmedShipmentIds,
    skippedDetails,
  };
}

function resolveTerminalStatus(): "cancelled" | "expired" {
  const configured = normalize(optionalEnv("EXPIRE_UNPAID_ORDERS_STATUS")) || "cancelled";
  if (configured !== "cancelled" && configured !== "expired") {
    throw new Error(
      `EXPIRE_UNPAID_ORDERS_STATUS must be "cancelled" or "expired". Current: ${configured}`,
    );
  }
  return configured;
}

/**
 * (b) expire_unpaid_orders
 * 綠界只在付款成功時回拋，沒付款的訂單會永遠卡在 pending，庫存也一直被佔住。
 */
async function expireUnpaidOrders(
  admin: AdminClient,
  payload: SystemJobPayload,
): Promise<Record<string, unknown>> {
  const terminalStatus = resolveTerminalStatus();
  const graceMinutes = toNonNegativeInt(payload.graceMinutes ?? 0, "payload.graceMinutes");
  const limit = toLimit(payload.limit, "payload.limit", 100, 500);
  const dryRun = toBoolean(payload.dryRun);
  const threshold = isoBefore(graceMinutes * MINUTE_MS);

  const orders = await selectRows<OrderRow>(admin, "orders", {
    select: "id,payment_status,payment_method,payment_deadline",
    payment_status: "eq.pending",
    payment_deadline: `lt.${threshold}`,
    // COD 送達前一直是 pending，過期掉會取消真實有效的訂單。
    or: `(payment_method.is.null,payment_method.not.in.(${COD_PAYMENT_METHODS.join(",")}))`,
    order: "payment_deadline.asc",
    limit,
  });

  systemJobDebugLog("expireUnpaidOrders.candidates", {
    terminalStatus,
    graceMinutes,
    limit,
    dryRun,
    scanned: orders.length,
  });

  const orderIds = unique(orders.map((order) => text(order.id)));
  const shipments = orderIds.length
    ? await selectRows<ShipmentCandidateRow>(admin, "order_shipments", {
        select: "id,order_id,shipping_status",
        order_id: `in.(${orderIds.join(",")})`,
      })
    : [];

  // 同 haiglobals-order-cancel.ts 的 assertAllOrderShipmentsPending，但這裡不丟例外，只回報 skip。
  const orderIdsWithProgressedShipment = new Set(
    shipments
      .filter((shipment) => normalize(shipment.shipping_status) !== "pending")
      .map((shipment) => text(shipment.order_id)),
  );

  const expiredOrderIds: string[] = [];
  const skippedDetails: Array<{ orderId: string; reason: string }> = [];
  const errors: Array<{ orderId: string; error: string }> = [];

  for (const order of orders) {
    const orderId = text(order.id);

    // Re-check in code: the PostgREST `not.in.(...)` filter is case-sensitive, so a legacy row
    // with payment_method='COD' would slip through. 取消一筆還在配送中的貨到付款訂單是不可逆的。
    if (COD_PAYMENT_METHODS.includes(normalize(order.payment_method))) {
      skippedDetails.push({ orderId, reason: "cod_payment_method" });
      continue;
    }

    // 廠商已經開始出貨，要不要取消得由人決定。
    if (orderIdsWithProgressedShipment.has(orderId)) {
      skippedDetails.push({ orderId, reason: "shipment_in_progress" });
      continue;
    }

    if (dryRun) {
      expiredOrderIds.push(orderId);
      continue;
    }

    try {
      const cancelledAt = nowIso();
      if (terminalStatus === "cancelled") {
        // 'cancelled' 才會觸發 restore_stock_on_order_cancelled() 把庫存還回去，這是預設也是安全的選項。
        await updateOrder(admin, orderId, {
          payment_status: "cancelled",
          cancelled_at: cancelledAt,
          cancel_reason: "payment deadline exceeded (auto)",
        });
      } else {
        // WARNING: payment_status='expired' 不會觸發 restore_stock_on_order_cancelled()，
        // 庫存不會回補、會持續外漏，除非之後補上對應的 DB trigger。
        await updateOrder(admin, orderId, {
          payment_status: "expired",
          cancelled_at: cancelledAt,
          cancel_reason: "payment deadline exceeded (auto)",
        });
      }

      // 未付款訂單不會有已開立發票，所以不做作廢發票。
      await cancelOrderShipmentsByOrderId(admin, orderId, cancelledAt);

      await notifyVendorsOrderStatusChanged(admin, {
        orderId,
        status: terminalStatus,
        statusType: "payment",
      });

      expiredOrderIds.push(orderId);
    } catch (error) {
      const message = errorText(error);
      systemJobDebugWarn("expireUnpaidOrders.orderFailed", { orderId, error: message });
      errors.push({ orderId, error: message });
    }
  }

  return {
    scanned: orders.length,
    expired: expiredOrderIds.length,
    skipped: skippedDetails.length,
    failed: errors.length,
    dryRun,
    terminalStatus,
    orderIds: expiredOrderIds,
    skippedDetails,
    errors,
  };
}

/**
 * (c) retry_failed_invoices
 * 開立失敗、或送出後綠界沒回來的發票，靠排程重試，否則買家永遠拿不到發票。
 */
async function retryFailedInvoices(
  admin: AdminClient,
  payload: SystemJobPayload,
): Promise<Record<string, unknown>> {
  const limit = toLimit(payload.limit, "payload.limit", 50, 200);
  const maxAgeDays = toPositiveInt(payload.maxAgeDays ?? 7, "payload.maxAgeDays");
  const minAgeMinutes = toPositiveInt(payload.minAgeMinutes ?? 30, "payload.minAgeMinutes");
  const dryRun = toBoolean(payload.dryRun);

  const maxAgeThreshold = isoBefore(maxAgeDays * DAY_MS);
  const minAgeThreshold = isoBefore(minAgeMinutes * MINUTE_MS);

  const invoices = await selectRows<OrderInvoiceRow & { created_at?: string | null }>(
    admin,
    "order_invoices",
    {
      select: "*",
      // 太舊的失敗不再重試，避免每輪都在啃同一批爛資料。
      created_at: `gt.${maxAgeThreshold}`,
      or: `(invoice_status.eq.failed,and(invoice_status.eq.pending,invoice_requested_at.lt.${minAgeThreshold}))`,
      order: "created_at.asc",
      limit,
    },
  );

  systemJobDebugLog("retryFailedInvoices.candidates", {
    limit,
    maxAgeDays,
    minAgeMinutes,
    dryRun,
    scanned: invoices.length,
  });

  const orderIds = unique(invoices.map((invoice) => text(invoice.order_id)));
  const orders = orderIds.length
    ? await selectRows<OrderRow>(admin, "orders", {
        select: "id,payment_status",
        id: `in.(${orderIds.join(",")})`,
      })
    : [];
  const orderStatusById = new Map(
    orders.map((order) => [text(order.id), normalize(order.payment_status)]),
  );

  const results: Array<{
    orderId: string;
    invoiceStatus: string;
    ok: boolean;
    message: string;
  }> = [];
  let retried = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const invoice of invoices) {
    const orderId = text(invoice.order_id);
    const invoiceStatus = normalize(invoice.invoice_status);

    if (invoiceStatus === "issued") {
      skipped += 1;
      results.push({ orderId, invoiceStatus, ok: false, message: "already_issued" });
      continue;
    }

    if (orderStatusById.get(orderId) !== "paid") {
      skipped += 1;
      results.push({ orderId, invoiceStatus, ok: false, message: "order_not_paid" });
      continue;
    }

    if (dryRun) {
      retried += 1;
      results.push({ orderId, invoiceStatus, ok: true, message: "dry_run" });
      continue;
    }

    retried += 1;
    try {
      const result = await issueEcpayInvoiceForOrder(admin, getEcpayInvoiceConfig(), orderId);
      succeeded += 1;
      results.push({
        orderId,
        invoiceStatus,
        ok: true,
        message: text(result.rtnMsg) || (result.skipped ? "skipped" : "issued"),
      });
    } catch (error) {
      const message = errorText(error);
      failed += 1;
      systemJobDebugWarn("retryFailedInvoices.issueFailed", { orderId, error: message });
      results.push({ orderId, invoiceStatus, ok: false, message });
    }
  }

  return {
    scanned: invoices.length,
    retried,
    succeeded,
    failed,
    skipped,
    dryRun,
    results,
  };
}

/**
 * (d) report_stuck_refunds
 * READ ONLY: 這個 action 只做查詢，永遠不可以寫入資料庫（不得新增任何 insert/update/delete）。
 */
async function reportStuckRefunds(
  admin: AdminClient,
  payload: SystemJobPayload,
): Promise<Record<string, unknown>> {
  const stuckMinutes = toPositiveInt(payload.stuckMinutes ?? 60, "payload.stuckMinutes");
  const limit = toLimit(payload.limit, "payload.limit", 200, 500);
  const threshold = isoBefore(stuckMinutes * MINUTE_MS);
  const now = Date.now();

  const [refundRows, returnRows, invoiceRows] = await Promise.all([
    selectRows<{
      id: string;
      order_id: string;
      status?: string | null;
      refund_amount?: number | string | null;
      updated_at?: string | null;
    }>(admin, "order_refunds", {
      select: "id,order_id,status,refund_amount,updated_at",
      status: "in.(requesting,processing)",
      updated_at: `lt.${threshold}`,
      order: "updated_at.asc",
      limit,
    }),
    selectRows<{
      id: string;
      order_id: string;
      vendor_id?: string | null;
      refund_amount?: number | string | null;
      refund_failed_at?: string | null;
      refund_failure_reason?: string | null;
    }>(admin, "order_returns", {
      select: "id,order_id,vendor_id,refund_amount,refund_failed_at,refund_failure_reason",
      status: "eq.refund_failed",
      order: "refund_failed_at.asc",
      limit,
    }),
    selectRows<OrderInvoiceRow & { updated_at?: string | null }>(admin, "order_invoices", {
      select: "order_id,invoice_status,invoice_error_message,updated_at",
      invoice_status: "in.(failed,void_failed)",
      order: "updated_at.asc",
      limit,
    }),
  ]);

  const stuckRefunds = refundRows.map((row) => {
    const updatedAt = text(row.updated_at);
    const updatedMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
    return {
      id: text(row.id),
      orderId: text(row.order_id),
      status: normalize(row.status),
      refundAmount: row.refund_amount ?? null,
      updatedAt: updatedAt || null,
      ageMinutes: Number.isFinite(updatedMs) ? Math.floor((now - updatedMs) / MINUTE_MS) : null,
    };
  });

  const refundFailedReturns = returnRows.map((row) => ({
    id: text(row.id),
    orderId: text(row.order_id),
    vendorId: text(row.vendor_id) || null,
    refundAmount: row.refund_amount ?? null,
    refundFailedAt: text(row.refund_failed_at) || null,
    reason: text(row.refund_failure_reason) || null,
  }));

  const failedInvoices = invoiceRows.map((row) => ({
    orderId: text(row.order_id),
    invoiceStatus: normalize(row.invoice_status),
    errorMessage: text(row.invoice_error_message) || null,
    updatedAt: text(row.updated_at) || null,
  }));

  systemJobDebugLog("reportStuckRefunds.result", {
    stuckMinutes,
    limit,
    stuckRefunds: stuckRefunds.length,
    refundFailedReturns: refundFailedReturns.length,
    failedInvoices: failedInvoices.length,
  });

  return {
    counts: {
      stuckRefunds: stuckRefunds.length,
      refundFailedReturns: refundFailedReturns.length,
      failedInvoices: failedInvoices.length,
    },
    stuckRefunds,
    refundFailedReturns,
    failedInvoices,
  };
}

export async function runSystemJobAction(
  admin: AdminClient,
  req: Request,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 端點已經驗過一次，這裡再驗一次：這層閘門不要拿掉，避免之後有人從別的地方呼叫進來。
  requireJobSecret(req);

  const action = normalize(body.action) as SystemJobAction;
  const payload = getPayload(body);

  systemJobDebugLog("action.start", {
    action,
    bodyKeys: Object.keys(body),
    payloadKeys: Object.keys(payload),
  });

  if (!action) throw new Error("action is required");

  let data: Record<string, unknown>;

  switch (action) {
    case "auto_confirm_received":
      data = await autoConfirmReceived(admin, payload);
      break;

    case "expire_unpaid_orders":
      data = await expireUnpaidOrders(admin, payload);
      break;

    case "retry_failed_invoices":
      data = await retryFailedInvoices(admin, payload);
      break;

    case "report_stuck_refunds":
      data = await reportStuckRefunds(admin, payload);
      break;

    default:
      throw new Error(`Unsupported system job action: ${action || "<empty>"}`);
  }

  systemJobDebugLog("action.success", { action });
  return data;
}
