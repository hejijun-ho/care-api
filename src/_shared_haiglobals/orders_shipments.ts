import {
  fetchOrderVendorIds,
  insertRows,
  orderDebugLog,
  queryString,
  restRequest,
  selectOne,
  selectRows,
  type AdminClient,
  type OrderRow,
  type OrderShipmentRow,
  type OrderShipmentStatusRow,
  type QueryValue,
} from "./orders.ts";

type PlatformShippingMethodCollectionRow = {
  id?: string | null;
  provider?: string | null;
  logistics_type?: string | null;
  logistics_sub_type?: string | null;
  is_collection_supported?: boolean | string | null;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function isCollectionSupported(value: unknown): boolean {
  return value === true || text(value).toLowerCase() === "true";
}

function normalizePaymentMethod(value: unknown): string {
  return text(value).toLowerCase();
}

function normalizePaymentStatus(value: unknown): string {
  return text(value).toLowerCase();
}

type VendorAccessRow = {
  id?: string | null;
  user_id?: string | null;
  root_vendor_id?: string | null;
};

async function fetchVendorAccessRow(
  admin: AdminClient,
  vendorId: string,
): Promise<VendorAccessRow | null> {
  return await selectOne<VendorAccessRow>(admin, "vendors", {
    select: "id,user_id,root_vendor_id",
    id: `eq.${vendorId}`,
  });
}

export async function assertShipmentVendorAccess(
  admin: AdminClient,
  vendorId: string,
  userId: string,
): Promise<void> {
  const normalizedVendorId = text(vendorId);
  if (!normalizedVendorId) {
    throw new Error("vendorId is required");
  }

  const vendor = await fetchVendorAccessRow(admin, normalizedVendorId);
  if (text(vendor?.user_id) === userId) return;

  const rootVendorId = text(vendor?.root_vendor_id);
  if (rootVendorId && rootVendorId !== normalizedVendorId) {
    const rootVendor = await fetchVendorAccessRow(admin, rootVendorId);
    if (text(rootVendor?.user_id) === userId) return;
  }

  throw new Error("Vendor not found or current user cannot manage this shipment vendor");
}

function isCodPaymentMethod(value: unknown): boolean {
  const method = normalizePaymentMethod(value);
  return method === "cod" || method === "cash_on_delivery";
}

export function assertOrderCanProgressShipment(order: OrderRow): void {
  const paymentStatus = normalizePaymentStatus(order.payment_status);
  if (
    paymentStatus === "paid" ||
    (paymentStatus === "pending" && isCodPaymentMethod(order.payment_method))
  ) {
    return;
  }

  throw new Error(
    "Only paid or COD orders can have shipments created. Current payment_status: " +
      (paymentStatus || "<empty>") +
      ", payment_method: " +
      (text(order.payment_method) || "<empty>"),
  );
}

function describeShipmentMethod(
  method: PlatformShippingMethodCollectionRow | null,
  shipment: OrderShipmentRow,
): string {
  const provider = text(method?.provider) || text(shipment.shipping_provider) || "ecpay";
  const logisticsType =
    text(method?.logistics_type) || text(shipment.logistics_type) || "<unknown>";
  const logisticsSubType =
    text(method?.logistics_sub_type) || text(shipment.logistics_sub_type) || "<unknown>";
  return `${provider}/${logisticsType}/${logisticsSubType}`;
}

async function fetchShipmentShippingMethod(
  admin: AdminClient,
  shipment: OrderShipmentRow,
): Promise<PlatformShippingMethodCollectionRow | null> {
  const shippingMethodId = text(shipment.shipping_method_id);
  if (shippingMethodId) {
    return await selectOne<PlatformShippingMethodCollectionRow>(
      admin,
      "platform_shipping_methods",
      {
        select: "id,provider,logistics_type,logistics_sub_type,is_collection_supported",
        id: `eq.${shippingMethodId}`,
      },
    );
  }

  const provider = text(shipment.shipping_provider) || "ecpay";
  const logisticsType = text(shipment.logistics_type);
  const logisticsSubType = text(shipment.logistics_sub_type);
  if (!logisticsType || !logisticsSubType) {
    return null;
  }

  return await selectOne<PlatformShippingMethodCollectionRow>(admin, "platform_shipping_methods", {
    select: "id,provider,logistics_type,logistics_sub_type,is_collection_supported",
    provider: `eq.${provider}`,
    logistics_type: `eq.${logisticsType}`,
    logistics_sub_type: `eq.${logisticsSubType}`,
  });
}

export async function assertOrderShipmentsSupportCod(
  admin: AdminClient,
  orderId: string,
): Promise<void> {
  const shipments = await fetchShipmentsByOrderId(admin, orderId);
  if (shipments.length === 0) {
    throw new Error("Shipment not found");
  }

  for (const shipment of shipments) {
    const method = await fetchShipmentShippingMethod(admin, shipment);
    if (!isCollectionSupported(method?.is_collection_supported)) {
      throw new Error(
        `Shipping method does not support COD collection: ${describeShipmentMethod(method, shipment)}`,
      );
    }
  }
}

async function requireShipmentVendorId(
  admin: AdminClient,
  orderId: string,
  requestedVendorId: unknown,
): Promise<string> {
  const vendorId = String(requestedVendorId ?? "").trim();
  if (!vendorId) {
    throw new Error("vendor_id is required for shipment");
  }

  const vendorIds = await fetchOrderVendorIds(admin, orderId);
  if (vendorIds.length > 0 && !vendorIds.includes(vendorId)) {
    throw new Error("Shipment vendor_id is not part of this order");
  }

  return vendorId;
}

export async function updateOrderShipment(
  admin: AdminClient,
  shipmentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await restRequest<void>(admin, "order_shipments", queryString({ id: `eq.${shipmentId}` }), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      ...payload,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function cancelOrderShipmentsByOrderId(
  admin: AdminClient,
  orderId: string,
  cancelledAt: string,
): Promise<OrderShipmentRow[]> {
  orderDebugLog("cancelOrderShipmentsByOrderId.start", {
    orderId,
    cancelledAt,
  });

  const rows = await restRequest<OrderShipmentRow[]>(
    admin,
    "order_shipments",
    queryString({
      order_id: `eq.${orderId}`,
      select: "id,order_id,vendor_id,shipping_status,cancelled_at",
    }),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        shipping_status: "cancelled",
        cancelled_at: cancelledAt,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  orderDebugLog("cancelOrderShipmentsByOrderId.success", {
    orderId,
    cancelledAt,
    updatedCount: rows.length,
    shipmentIds: rows.map((row) => row.id ?? null),
  });

  return rows;
}

export async function upsertOrderShipmentByOrderId(
  admin: AdminClient,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<OrderShipmentRow> {
  const vendorId = await requireShipmentVendorId(admin, orderId, payload.vendor_id);
  const shipmentQuery: Record<string, QueryValue> = {
    select: "*",
    order_id: `eq.${orderId}`,
    vendor_id: `eq.${vendorId}`,
  };

  const existing = await selectOne<OrderShipmentRow>(admin, "order_shipments", {
    ...shipmentQuery,
  });
  const merged = {
    shipping_provider: "ecpay",
    shipping_status: "pending",
    ...payload,
    vendor_id: vendorId,
    order_id: orderId,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    await updateOrderShipment(admin, existing.id, merged);
    return { ...existing, ...merged };
  }

  const rows = await insertRows<OrderShipmentRow>(admin, "order_shipments", {
    ...merged,
    created_at: new Date().toISOString(),
  });
  return rows[0] ?? ({ ...merged } as OrderShipmentRow);
}

export async function fetchShipmentByOrderId(
  admin: AdminClient,
  orderId: string,
  vendorId?: string | number | null,
): Promise<OrderShipmentRow | null> {
  const params: Record<string, QueryValue> = {
    select: "*",
    order_id: `eq.${orderId}`,
  };
  const normalizedVendorId = String(vendorId ?? "").trim();
  if (normalizedVendorId) {
    params.vendor_id = `eq.${normalizedVendorId}`;
  }
  return await selectOne<OrderShipmentRow>(admin, "order_shipments", params);
}

export async function fetchShipmentByOrderAndShipmentId(
  admin: AdminClient,
  orderId: string,
  shipmentId: string,
): Promise<OrderShipmentRow | null> {
  return await selectOne<OrderShipmentRow>(admin, "order_shipments", {
    select: "*",
    order_id: "eq." + orderId,
    id: "eq." + shipmentId,
  });
}

export async function fetchShipmentsByOrderId(
  admin: AdminClient,
  orderId: string,
  vendorId?: string | number | null,
): Promise<OrderShipmentRow[]> {
  const params: Record<string, QueryValue> = {
    select: "*",
    order_id: `eq.${orderId}`,
  };
  const normalizedVendorId = String(vendorId ?? "").trim();
  if (normalizedVendorId) {
    params.vendor_id = `eq.${normalizedVendorId}`;
  }
  return await selectRows<OrderShipmentRow>(admin, "order_shipments", params);
}

export async function fetchOrderShipmentStatusesByOrderId(
  admin: AdminClient,
  orderId: string,
): Promise<OrderShipmentStatusRow[]> {
  return await selectRows<OrderShipmentStatusRow>(admin, "order_shipments", {
    select: "id,order_id,vendor_id,shipping_status",
    order_id: `eq.${orderId}`,
  });
}

export async function findShipmentByReference(
  admin: AdminClient,
  reference: string,
): Promise<OrderShipmentRow> {
  const normalized = reference.trim();
  if (!normalized) {
    throw new Error("Shipment reference is required");
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized,
  );
  const orFilters = [
    ...(isUuid ? [`id.eq.${normalized}`, `order_id.eq.${normalized}`] : []),
    `temp_logistics_id.eq.${normalized}`,
    `provider_logistics_id.eq.${normalized}`,
    `tracking_no.eq.${normalized}`,
  ].join(",");
  const data = await selectOne<OrderShipmentRow>(admin, "order_shipments", {
    select: "*",
    or: `(${orFilters})`,
  });
  if (!data) {
    throw new Error("Shipment not found");
  }
  return data;
}
