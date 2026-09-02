import {
  selectOne,
  selectRows,
  type AdminClient,
  type OrderRow,
  type QueryValue,
} from "./orders.ts";
import type { OrderReturnRow } from "./order_returns.ts";
import {
  getVendorAdminUrl,
  getVendorAppCodes,
  pushDebugLog,
  pushDebugWarn,
  sendPushToUsers,
  type PushSendResult,
} from "./push.ts";

// 廠商後台推播的商業語意層：決定「通知誰、標題內容、點擊後跳哪個頁面」。
// 實際送出交給 push.ts；本檔所有 export 都保證不丟例外，推播失敗不影響主流程。

/** data.type：前端用來分辨這是哪一種通知。 */
export type VendorPushType =
  | "order_created"
  | "order_status_changed"
  | "order_return_created"
  | "order_return_shipped"
  | "order_return_cancelled"
  | "lottery_cancelled";

/** data.target：前端用來分辨要導向訂單頁、退貨頁還是抽獎（在商品頁內）。 */
export type VendorPushTarget = "order" | "order_return" | "lottery";

/** data.status_type：狀態變更的來源欄位。 */
export type VendorOrderStatusType = "payment" | "shipping";

const ORDER_ROUTE = "/orders";
const RETURN_ROUTE = "/returns";
const LOTTERY_ROUTE = "/products"; // 抽獎活動在廠商後台的商品頁內管理

type VendorOwnerRow = {
  id?: string | null;
  user_id?: string | null;
  root_vendor_id?: string | null;
};

type OrderItemVendorRow = {
  vendor_id?: string | null;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(text).filter((value) => value)));
}

/** 把 undefined/null 欄位濾掉，因為 FCM data 只接受 string value。 */
function compactData(data: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

/**
 * vendor_id -> 要收通知的 user_id。
 *
 * 規則：優先用 vendor 自己的 `user_id`；若該 vendor 沒有綁帳號（例如國家市場分支），
 * 則往上退到 `root_vendor_id` 的 `user_id`，與 orders_shipments 的存取判斷一致。
 */
export async function resolveVendorNotifyUserIds(
  admin: AdminClient,
  vendorIds: string[],
): Promise<string[]> {
  const ids = unique(vendorIds);
  if (!ids.length) return [];

  const vendors = await selectRows<VendorOwnerRow>(admin, "vendors", {
    select: "id,user_id,root_vendor_id",
    id: `in.(${ids.join(",")})`,
  });

  const userIds: string[] = [];
  const rootLookups: string[] = [];

  for (const vendor of vendors) {
    const userId = text(vendor.user_id);
    if (userId) {
      userIds.push(userId);
      continue;
    }

    const rootVendorId = text(vendor.root_vendor_id);
    if (rootVendorId && rootVendorId !== text(vendor.id)) {
      rootLookups.push(rootVendorId);
    }
  }

  const pendingRoots = unique(rootLookups).filter((rootId) => !ids.includes(rootId));
  if (pendingRoots.length) {
    const rootVendors = await selectRows<VendorOwnerRow>(admin, "vendors", {
      select: "id,user_id",
      id: `in.(${pendingRoots.join(",")})`,
    });
    for (const rootVendor of rootVendors) {
      const userId = text(rootVendor.user_id);
      if (userId) userIds.push(userId);
    }
  }

  return unique(userIds);
}

async function fetchOrderVendorIdsForNotify(
  admin: AdminClient,
  orderId: string,
): Promise<string[]> {
  const rows = await selectRows<OrderItemVendorRow>(admin, "order_items", {
    select: "vendor_id",
    order_id: `eq.${orderId}`,
  });
  return unique(rows.map((row) => row.vendor_id));
}

async function fetchOrderForNotify(
  admin: AdminClient,
  orderId: string,
): Promise<Pick<OrderRow, "id" | "order_number" | "total_amount" | "currency"> | null> {
  return await selectOne(admin, "orders", {
    select: "id,order_number,total_amount,currency",
    id: `eq.${orderId}`,
  } as Record<string, QueryValue>);
}

/** 廠商後台的深層連結路徑；前端也可以只讀 data 裡的 id 自行組頁面。 */
function buildRoute(target: VendorPushTarget, resourceId: string): string {
  if (target === "lottery") return LOTTERY_ROUTE; // 抽獎在商品頁內，導向商品頁
  const base = target === "order_return" ? RETURN_ROUTE : ORDER_ROUTE;
  return resourceId ? `${base}/${resourceId}` : base;
}

/** Web 推播點擊後開啟的網址。Flutter web 走 hash routing，所以是 `<base>/#<route>`。 */
function buildWebLink(route: string): string | null {
  const baseUrl = getVendorAdminUrl();
  if (!baseUrl) return null;
  return `${baseUrl}/#${route}`;
}

function orderLabel(orderNumber: string | null | undefined, orderId: string): string {
  const normalized = text(orderNumber);
  return normalized || orderId.slice(0, 8);
}

/** 訂單付款狀態顯示字串（推播內文用）。 */
function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待付款",
    paid: "已付款",
    failed: "付款失敗",
    expired: "付款逾期",
    cancelled: "已取消",
    refunded: "已退款",
  };
  return labels[status] ?? status;
}

/** 出貨狀態顯示字串（推播內文用）。 */
function shippingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待建立物流單",
    created: "物流單已建立",
    shipped: "已出貨",
    delivered: "已送達",
    "picked-up": "買家已取貨",
    returned: "已退回",
    failed: "物流異常",
    cancelled: "物流已取消",
  };
  return labels[status] ?? status;
}

async function notifyVendors(
  admin: AdminClient,
  input: {
    vendorIds: string[];
    type: VendorPushType;
    target: VendorPushTarget;
    resourceId: string;
    title: string;
    body: string;
    extraData?: Record<string, string | null | undefined>;
  },
): Promise<PushSendResult> {
  const skipped: PushSendResult = { attempted: 0, sent: 0, failed: 0, disabled: 0 };

  const userIds = await resolveVendorNotifyUserIds(admin, input.vendorIds);
  if (!userIds.length) {
    pushDebugWarn("vendor.noNotifyUser", {
      type: input.type,
      vendor_ids: unique(input.vendorIds),
    });
    return { ...skipped, skippedReason: "no_vendor_user" };
  }

  const route = buildRoute(input.target, input.resourceId);

  return await sendPushToUsers(admin, {
    userIds,
    appCodes: getVendorAppCodes(),
    message: {
      title: input.title,
      body: input.body,
      link: buildWebLink(route),
      data: compactData({
        type: input.type,
        target: input.target,
        route,
        audience: "vendor",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
        sent_at: new Date().toISOString(),
        ...input.extraData,
      }),
    },
  });
}

/**
 * 新訂單成立（付款完成）→ 通知該訂單所有 vendor 的所屬 user。
 * 只在訂單第一次進入 paid 時呼叫，避免 ECPay 重送 callback 時重複通知。
 */
export async function notifyVendorsOrderCreated(
  admin: AdminClient,
  orderId: string,
): Promise<void> {
  try {
    const normalizedOrderId = text(orderId);
    if (!normalizedOrderId) return;

    const [order, vendorIds] = await Promise.all([
      fetchOrderForNotify(admin, normalizedOrderId),
      fetchOrderVendorIdsForNotify(admin, normalizedOrderId),
    ]);

    if (!vendorIds.length) return;

    const label = orderLabel(order?.order_number, normalizedOrderId);

    await notifyVendors(admin, {
      vendorIds,
      type: "order_created",
      target: "order",
      resourceId: normalizedOrderId,
      title: "您有一筆新訂單",
      body: `訂單 ${label} 已完成付款，請盡快處理出貨。`,
      extraData: {
        order_id: normalizedOrderId,
        order_number: text(order?.order_number) || null,
        status: "paid",
        status_type: "payment",
      },
    });
  } catch (error) {
    pushDebugWarn("notifyVendorsOrderCreated.failed", {
      order_id: text(orderId),
      error: errorText(error),
    });
  }
}

/**
 * 訂單狀態改變 → 通知該訂單（或該 shipment）所屬 vendor 的 user。
 *
 * 只在「非廠商自己觸發」的變更呼叫（例如買家取消、綠界物流回拋、買家確認取貨）；
 * 廠商自己在後台按出貨造成的狀態變更不需要再推回去給他自己。
 */
export async function notifyVendorsOrderStatusChanged(
  admin: AdminClient,
  input: {
    orderId: string;
    status: string;
    statusType: VendorOrderStatusType;
    shipmentId?: string | null;
    vendorIds?: string[];
  },
): Promise<void> {
  try {
    const orderId = text(input.orderId);
    const status = text(input.status);
    if (!orderId || !status) return;

    const vendorIds = input.vendorIds?.length
      ? unique(input.vendorIds)
      : await fetchOrderVendorIdsForNotify(admin, orderId);

    if (!vendorIds.length) return;

    const order = await fetchOrderForNotify(admin, orderId);
    const label = orderLabel(order?.order_number, orderId);
    const statusLabel =
      input.statusType === "shipping" ? shippingStatusLabel(status) : paymentStatusLabel(status);

    await notifyVendors(admin, {
      vendorIds,
      type: "order_status_changed",
      target: "order",
      resourceId: orderId,
      title: "訂單狀態已更新",
      body: `訂單 ${label} 狀態變更為「${statusLabel}」。`,
      extraData: {
        order_id: orderId,
        order_number: text(order?.order_number) || null,
        shipment_id: text(input.shipmentId) || null,
        status,
        status_type: input.statusType,
      },
    });
  } catch (error) {
    pushDebugWarn("notifyVendorsOrderStatusChanged.failed", {
      order_id: text(input.orderId),
      status: text(input.status),
      error: errorText(error),
    });
  }
}

const RETURN_EVENT_COPY: Record<
  "created" | "shipped" | "cancelled",
  { type: VendorPushType; title: string; body: (label: string) => string }
> = {
  created: {
    type: "order_return_created",
    title: "買家申請退貨",
    body: (label) => `訂單 ${label} 有新的退貨申請，請於期限內處理。`,
  },
  shipped: {
    type: "order_return_shipped",
    title: "買家已寄回退貨商品",
    body: (label) => `訂單 ${label} 的退貨商品已寄出，收到後請確認收貨。`,
  },
  cancelled: {
    type: "order_return_cancelled",
    title: "買家取消退貨",
    body: (label) => `訂單 ${label} 的退貨申請已由買家取消。`,
  },
};

/**
 * 買家端退貨事件 → 通知該退貨單所屬 vendor 的 user。
 * `create` 是需求指定的必要通知；`ship` / `cancel` 一併通知，因為都需要廠商後續處理。
 */
export async function notifyVendorsOrderReturnEvent(
  admin: AdminClient,
  input: {
    orderReturn: OrderReturnRow;
    event: "created" | "shipped" | "cancelled";
  },
): Promise<void> {
  try {
    const orderReturn = input.orderReturn;
    const returnId = text(orderReturn?.id);
    const vendorId = text(orderReturn?.vendor_id);
    const orderId = text(orderReturn?.order_id);

    if (!returnId || !vendorId) return;

    const order = orderId ? await fetchOrderForNotify(admin, orderId) : null;
    const label = orderLabel(order?.order_number, orderId || returnId);
    const copy = RETURN_EVENT_COPY[input.event];

    await notifyVendors(admin, {
      vendorIds: [vendorId],
      type: copy.type,
      target: "order_return",
      resourceId: returnId,
      title: copy.title,
      body: copy.body(label),
      extraData: {
        return_id: returnId,
        order_id: orderId || null,
        order_number: text(order?.order_number) || null,
        order_item_id: text(orderReturn?.order_item_id) || null,
        shipment_id: text(orderReturn?.shipment_id) || null,
        vendor_id: vendorId,
        status: text(orderReturn?.status) || null,
        status_type: "return",
      },
    });

    pushDebugLog("orderReturn.notified", {
      return_id: returnId,
      event: input.event,
      vendor_id: vendorId,
    });
  } catch (error) {
    pushDebugWarn("notifyVendorsOrderReturnEvent.failed", {
      return_id: text(input.orderReturn?.id),
      event: input.event,
      error: errorText(error),
    });
  }
}

/**
 * 抽獎因參加人數不足被系統自動取消 → 通知該抽獎所屬 vendor 的 user。
 * 由 haiglobals-workers 的 lottery-draw worker 在開獎時間到、符合資格人數為 0 時觸發
 * （透過內部端點 haiglobals-lottery-notify 呼叫）。點擊導向廠商後台商品頁。
 */
export async function notifyVendorLotteryCancelled(
  admin: AdminClient,
  input: {
    vendorId: string;
    lotteryId: string;
    lotteryTitle?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  try {
    const vendorId = text(input.vendorId);
    const lotteryId = text(input.lotteryId);
    if (!vendorId || !lotteryId) return;

    const title = text(input.lotteryTitle) || "抽獎活動";

    await notifyVendors(admin, {
      vendorIds: [vendorId],
      type: "lottery_cancelled",
      target: "lottery",
      resourceId: lotteryId,
      title: "抽獎已自動取消",
      body: `「${title}」因開獎時間到、參加人數不足，已自動取消。`,
      extraData: {
        lottery_id: lotteryId,
        reason: text(input.reason) || "insufficient_participants",
        status: "cancelled",
        status_type: "lottery",
      },
    });

    pushDebugLog("lottery.cancelledNotified", {
      lottery_id: lotteryId,
      vendor_id: vendorId,
    });
  } catch (error) {
    pushDebugWarn("notifyVendorLotteryCancelled.failed", {
      lottery_id: text(input.lotteryId),
      error: errorText(error),
    });
  }
}
