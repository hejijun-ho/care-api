import { parseEcpayDate } from "../_shared/ecpay_common.ts";
export type OrderRow = {
  id: string;
  user_id: string;
  order_number?: string | null;
  items_subtotal?: number | string | null;
  shipping_fee?: number | string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  total_amount?: number | string | null;
  currency?: string | null;
  payment_status?: string | null;
  provider_order_id?: string | null;
  provider_transaction_id?: string | null;
  provider_status_code?: number | string | null;
  provider_status_message?: string | null;
  bank_code?: string | null;
  virtual_account?: string | null;
  payment_reference_no?: string | null;
  payment_url?: string | null;
  paid_at?: string | null;
  payment_deadline?: string | null;
  payment_callback_payload?: Record<string, unknown> | null;
  last_payment_callback_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type OrderInvoiceRow = {
  id?: string | null;
  order_id: string;
  invoice_provider?: string | null;
  invoice_status?: string | null;
  invoice_type?: string | null;
  invoice_number?: string | null;
  invoice_random_number?: string | null;
  invoice_reference_no?: string | null;
  invoice_carrier_type?: string | null;
  invoice_carrier_no?: string | null;
  invoice_company_title?: string | null;
  invoice_tax_id?: string | null;
  invoice_love_code?: string | null;
  invoice_email?: string | null;
  invoice_issued_at?: string | null;
  invoice_requested_at?: string | null;
  invoice_sent_at?: string | null;
  invoice_received_at?: string | null;
  invoice_error_message?: string | null;
  invoice_payload?: Record<string, unknown> | null;
  invoice_voided_at?: string | null;
  invoice_void_reason?: string | null;
  invoice_void_result_code?: number | string | null;
  invoice_void_result_message?: string | null;
  invoice_void_request_payload?: Record<string, unknown> | null;
  invoice_void_response_payload?: Record<string, unknown> | null;
  invoice_void_raw_response?: string | null;
};

export type OrderShipmentRow = {
  id?: string | null;
  order_id: string;
  vendor_id?: string | number | null;
  shipping_method_id?: string | null;
  shipping_provider?: string | null;
  logistics_type?: string | null;
  logistics_sub_type?: string | null;
  shipping_status?: string | null;
  is_collection?: boolean | null;
  collection_amount?: number | string | null;
  temp_logistics_id?: string | null;
  provider_logistics_id?: string | null;
  tracking_no?: string | null;
  receiver_name?: string | null;
  receiver_phone?: string | null;
  receiver_email?: string | null;
  receiver_address?: string | null;
  receiver_country?: string | null;
  receiver_zip_code?: string | null;
  receiver_city?: string | null;
  receiver_district?: string | null;
  receiver_address_detail?: string | null;
  cvs_store_id?: string | null;
  cvs_store_name?: string | null;
  cvs_store_address?: string | null;
  cvs_store_type?: string | null;
  sender_name?: string | null;
  sender_phone?: string | null;
  sender_address?: string | null;
  shipping_fee?: number | string | null;
  goods_amount?: number | string | null;
  package_weight?: number | string | null;
  package_size?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
  returned_at?: string | null;
  failed_at?: string | null;
  cancelled_at?: string | null;
  logistics_callback_payload?: Record<string, unknown> | null;
  last_logistics_callback_at?: string | null;
};

export type OrderShipmentStatusRow = Pick<
  OrderShipmentRow,
  "id" | "order_id" | "vendor_id" | "shipping_status"
>;

export type OrderRefundStatus = "requesting" | "processing" | "success" | "failed";

export type OrderRefundRow = {
  id?: string | null;
  order_id: string;
  user_id?: string | null;
  refund_request_id: string;
  provider_order_id: string;
  provider_transaction_id: string;
  refund_amount: number | string;
  refund_reason?: string | null;
  status?: OrderRefundStatus | string | null;
  provider_result_code?: number | string | null;
  provider_result_message?: string | null;
  request_payload?: Record<string, unknown> | null;
  response_payload?: Record<string, unknown> | null;
  raw_response?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type CreateOrderRefundInput = {
  order_id: string;
  user_id?: string | null;
  refund_request_id: string;
  provider_order_id: string;
  provider_transaction_id: string;
  refund_amount: number;
  refund_reason?: string | null;
  status?: OrderRefundStatus;
  provider_result_code?: number | null;
  provider_result_message?: string | null;
  request_payload?: Record<string, unknown> | null;
  response_payload?: Record<string, unknown> | null;
  raw_response?: string | null;
};

export type UpdateOrderRefundInput = Partial<{
  status: OrderRefundStatus;
  provider_result_code: number | null;
  provider_result_message: string | null;
  request_payload: Record<string, unknown> | null;
  response_payload: Record<string, unknown> | null;
  raw_response: string | null;
}>;

export type AdminOrderRow = OrderRow;

export type AdminOrderItemRow = {
  order_id: string;
  vendor_id?: string | number | null;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
  sku_name?: string | null;
};

export type CheckoutOrderItemInput = {
  product_id: string;
  sku_id?: string | null;
  quantity: number;
};

export type CheckoutShippingSelectionInput = {
  vendorId?: string | null;
  vendor_id?: string | null;
  shippingMethodId?: string | null;
  shipping_method_id?: string | null;
  deliveryMethod?: string | null;
  delivery_method?: string | null;
  logisticsSubType?: string | null;
  logistics_sub_type?: string | null;
  recipientName?: string | null;
  recipient_name?: string | null;
  recipientPhone?: string | null;
  recipient_phone?: string | null;
  recipientAddress?: string | null;
  recipient_address?: string | null;
  recipientCountryCode?: string | null;
  recipient_country_code?: string | null;
  recipientZipcode?: string | null;
  recipient_zipcode?: string | null;
  recipientZipCode?: string | null;
  recipient_zip_code?: string | null;
  pickupStoreName?: string | null;
  pickup_store_name?: string | null;
  pickupStoreCode?: string | null;
  pickup_store_code?: string | null;
  pickupStoreAddress?: string | null;
  pickup_store_address?: string | null;
};

export type CheckoutOrderInput = {
  userId: string;
  paymentProvider: string;
  paymentMethod: string;
  deliveryMethod?: string;
  logisticsSubType?: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  recipientCountryCode?: string;
  recipientZipcode?: string;
  pickupStoreName?: string;
  pickupStoreCode?: string;
  pickupStoreAddress?: string;
  invoiceType: string;
  invoiceCarrierType?: string;
  invoiceCarrierNo?: string;
  invoiceCompanyTitle?: string;
  invoiceTaxId?: string;
  items: CheckoutOrderItemInput[];
  shippingSelections?: CheckoutShippingSelectionInput[];
};

export type SupabaseKeys = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export type AdminClient = {
  keys: SupabaseKeys;
};

export type QueryValue = string | number | boolean;

const databaseSchema = "haiglobals";

export type ProductRow = {
  id: string;
  name?: string | null;
  base_price?: number | string | null;
  price?: number | string | null;
  special_price?: number | string | null;
  is_active?: boolean | string | null;
  image_url?: string | null;
  vendor_id?: string | number | null;
  stock?: number | string | null;
  stock_owner_product_id?: string | null;
  currency?: string | null;
};

export type UserContactRow = {
  email?: string | null;
};

export const orderSelectFields =
  "id,user_id,order_number,payment_provider,payment_method,total_amount,payment_status,provider_order_id,provider_transaction_id";
export const adminOrderSelectFields =
  "id,user_id,order_number,items_subtotal,shipping_fee,total_amount,currency,payment_provider,payment_method,payment_status,provider_order_id,provider_transaction_id,provider_status_code,provider_status_message,bank_code,virtual_account,payment_reference_no,payment_url,paid_at,payment_deadline,last_payment_callback_at,cancelled_at,cancel_reason,created_at,updated_at";
export const invoiceOrderSelectFields =
  "id,user_id,order_number,payment_provider,payment_method,total_amount,shipping_fee,payment_status,provider_order_id,provider_transaction_id";

const orderTimestampColumnNames = new Set([
  "paid_at",
  "payment_deadline",
  "last_payment_callback_at",
  "cancelled_at",
  "created_at",
  "updated_at",
]);

const orderInvoiceTimestampColumnNames = new Set([
  "invoice_issued_at",
  "invoice_requested_at",
  "invoice_sent_at",
  "invoice_received_at",
  "invoice_voided_at",
  "updated_at",
  "created_at",
]);

function normalizeTimestampColumns(
  payload: Record<string, unknown>,
  timestampColumns: Set<string>,
): Record<string, unknown> {
  const normalized = { ...payload };
  for (const key of timestampColumns) {
    if (!(key in normalized)) continue;
    const value = normalized[key];
    if (typeof value !== "string") continue;
    const parsed = parseEcpayDate(value);
    if (parsed) normalized[key] = parsed;
  }
  return normalized;
}

const orderColumnNames = new Set([
  "id",
  "user_id",
  "order_number",
  "items_subtotal",
  "shipping_fee",
  "total_amount",
  "currency",
  "payment_provider",
  "payment_method",
  "payment_status",
  "provider_order_id",
  "provider_transaction_id",
  "provider_status_code",
  "provider_status_message",
  "bank_code",
  "virtual_account",
  "payment_reference_no",
  "payment_url",
  "paid_at",
  "payment_deadline",
  "payment_callback_payload",
  "last_payment_callback_at",
  "cancelled_at",
  "cancel_reason",
  "created_at",
  "updated_at",
]);

function encodeFilterValue(value: QueryValue): string {
  return encodeURIComponent(String(value));
}

export function queryString(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeFilterValue(value)}`)
    .join("&");
}

export async function restRequest<T>(
  admin: AdminClient,
  table: string,
  query: string,
  init: RequestInit = {},
): Promise<T> {
  const serviceRoleKey = normalizeServiceRoleKey(
    admin.keys.supabaseServiceRoleKey,
    admin.keys.supabaseAnonKey,
  );
  const url = `${normalizeSupabaseUrl(admin.keys.supabaseUrl)}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept-Profile", databaseSchema);
  headers.set("Content-Profile", databaseSchema);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase REST request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function extractMissingColumnName(errorText: string): string {
  const postgrestMatch = /could not find the '([^']+)' column/i.exec(errorText);
  if (postgrestMatch?.[1]) {
    return postgrestMatch[1].trim();
  }

  const postgresMatch = /column [a-z_]+\.([a-z_]+) does not exist/i.exec(errorText);
  return postgresMatch?.[1]?.trim() ?? "";
}

export async function selectRows<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T[]> {
  return await restRequest<T[]>(admin, table, queryString(params));
}

export async function insertRows<T>(
  admin: AdminClient,
  table: string,
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
): Promise<T[]> {
  return await restRequest<T[]>(admin, table, "", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
}

export async function selectOne<T>(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<T | null> {
  const rows = await selectRows<T>(admin, table, { ...params, limit: 1 });
  return rows[0] ?? null;
}

function normalizeSupabaseUrl(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("SUPABASE_URL is required");
  }
  return normalized;
}

function normalizeServiceRoleKey(serviceRoleKey: string, anonKey?: string): string {
  const normalized = String(serviceRoleKey ?? "").trim();
  if (!normalized) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for orders database operations");
  }
  if (anonKey && normalized === String(anonKey ?? "").trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be the anon key");
  }
  return normalized;
}

export function createAdminClient(keys: SupabaseKeys): AdminClient {
  return {
    keys: {
      supabaseUrl: normalizeSupabaseUrl(keys.supabaseUrl),
      supabaseAnonKey: String(keys.supabaseAnonKey ?? "").trim(),
      supabaseServiceRoleKey: normalizeServiceRoleKey(
        keys.supabaseServiceRoleKey,
        keys.supabaseAnonKey,
      ),
    },
  };
}

async function readAccessTokenFromRequestBody(req: Request): Promise<string> {
  try {
    const clone = req.clone();
    const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return "";
    }

    const body = await clone.json();
    if (!body || typeof body !== "object") {
      return "";
    }

    const record = body as Record<string, unknown>;
    return String(record.accessToken ?? record.access_token ?? record.token ?? "").trim();
  } catch (_) {
    return "";
  }
}

function readBearerToken(req: Request): string {
  const authorization = req.headers.get("Authorization") ?? "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

export async function requireUserId(req: Request, keys: SupabaseKeys): Promise<string> {
  const candidates = [readBearerToken(req), await readAccessTokenFromRequestBody(req)].filter(
    (token) => token,
  );

  if (candidates.length === 0) {
    throw new Error("Missing bearer token");
  }

  for (const token of candidates) {
    try {
      const response = await fetch(`${keys.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: keys.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const userId = String(payload.id ?? payload.sub ?? "").trim();
      if (userId) {
        return userId;
      }
    } catch (_) {
      // Try the next candidate. Hosted function gateway tokens are not app user tokens.
    }
  }

  throw new Error("User authentication failed");
}

export async function fetchOrderForUser(
  admin: AdminClient,
  orderId: string,
  userId: string,
): Promise<OrderRow> {
  const data = await selectOne<OrderRow>(admin, "orders", {
    select: orderSelectFields,
    id: `eq.${orderId}`,
    user_id: `eq.${userId}`,
  });

  if (!data) {
    throw new Error("Order not found");
  }
  return data;
}

export async function fetchOrderById(admin: AdminClient, orderId: string): Promise<OrderRow> {
  const data = await selectOne<OrderRow>(admin, "orders", {
    select: orderSelectFields,
    id: `eq.${orderId}`,
  });

  if (!data) {
    throw new Error("Order not found");
  }
  return data;
}

export async function fetchOrderItems(
  admin: AdminClient,
  orderId: string,
): Promise<Array<{ product_name?: string | null; quantity?: number | null }>> {
  return await selectRows(admin, "order_items", {
    select: "product_name,quantity",
    order_id: `eq.${orderId}`,
    order: "created_at.asc",
  });
}

export async function deleteRows(
  admin: AdminClient,
  table: string,
  params: Record<string, QueryValue>,
): Promise<void> {
  await restRequest<void>(admin, table, queryString(params), {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function fetchOrderVendorIds(admin: AdminClient, orderId: string): Promise<string[]> {
  const rows = await selectRows<{ vendor_id?: string | number | null }>(admin, "order_items", {
    select: "vendor_id",
    order_id: `eq.${orderId}`,
  });
  return Array.from(
    new Set(rows.map((row) => String(row.vendor_id ?? "").trim()).filter((vendorId) => vendorId)),
  );
}

export async function findOrderByMerchantTradeNo(
  admin: AdminClient,
  merchantTradeNo: string,
): Promise<OrderRow> {
  const data = await selectOne<OrderRow>(admin, "orders", {
    select: orderSelectFields,
    or: `(provider_order_id.eq.${merchantTradeNo},order_number.eq.${merchantTradeNo})`,
  });

  if (!data) {
    throw new Error("Order not found for MerchantTradeNo");
  }
  return data;
}

export async function merchantTradeNoExists(
  admin: AdminClient,
  merchantTradeNo: string,
  excludeOrderId?: string,
): Promise<boolean> {
  const normalized = merchantTradeNo.trim();
  if (!normalized) {
    return false;
  }

  const data = await selectOne<{ id: string }>(admin, "orders", {
    select: "id",
    or: `(provider_order_id.eq.${normalized},order_number.eq.${normalized})`,
    ...(excludeOrderId ? { id: `neq.${excludeOrderId}` } : {}),
  });

  return data !== null;
}

export async function findOrderByReference(
  admin: AdminClient,
  reference: string,
): Promise<OrderRow> {
  const normalized = reference.trim();
  if (!normalized) {
    throw new Error("Order reference is required");
  }

  const data = await selectOne<OrderRow>(admin, "orders", {
    select: orderSelectFields,
    or: `(id.eq.${normalized},order_number.eq.${normalized},provider_order_id.eq.${normalized})`,
  });

  if (!data) {
    throw new Error("Order not found");
  }
  return data;
}

export async function updateOrder(
  admin: AdminClient,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const merged = Object.fromEntries(
    Object.entries(
      normalizeTimestampColumns(
        {
          ...payload,
          updated_at: new Date().toISOString(),
        },
        orderTimestampColumnNames,
      ),
    ).filter(([key]) => orderColumnNames.has(key)),
  );

  const updatePayload: Record<string, unknown> = { ...merged };
  while (true) {
    try {
      await restRequest<void>(admin, "orders", queryString({ id: `eq.${orderId}` }), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(updatePayload),
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingColumn = extractMissingColumnName(message);
      if (!missingColumn || !(missingColumn in updatePayload)) {
        throw error;
      }
      delete updatePayload[missingColumn];
    }
  }
}

export function orderDebugLog(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[orders][debug] ${event}`, JSON.stringify(payload));
}

export function orderDebugWarn(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(`[orders][warn] ${event}`, JSON.stringify(payload));
}

export function safeKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

export async function fetchOrderInvoiceByOrderId(
  admin: AdminClient,
  orderId: string,
): Promise<OrderInvoiceRow | null> {
  return await selectOne<OrderInvoiceRow>(admin, "order_invoices", {
    select: "*",
    order_id: `eq.${orderId}`,
  });
}

export async function updateOrderInvoice(
  admin: AdminClient,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  orderDebugLog("updateOrderInvoice.start", {
    orderId,
    payloadKeys: Object.keys(payload),
  });

  const existing = await selectOne<{ id: string }>(admin, "order_invoices", {
    select: "id",
    order_id: `eq.${orderId}`,
  });

  orderDebugLog("updateOrderInvoice.existing", {
    orderId,
    existingInvoiceId: existing?.id ?? null,
  });

  const merged = normalizeTimestampColumns(
    {
      ...payload,
      order_id: orderId,
      updated_at: new Date().toISOString(),
    },
    orderInvoiceTimestampColumnNames,
  );

  if (existing?.id) {
    const updatePayload: Record<string, unknown> = { ...merged };
    while (true) {
      try {
        await restRequest<void>(admin, "order_invoices", queryString({ id: `eq.${existing.id}` }), {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(updatePayload),
        });
        orderDebugLog("updateOrderInvoice.patch.success", {
          orderId,
          invoiceId: existing.id,
          writtenKeys: Object.keys(updatePayload),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const missingColumn = extractMissingColumnName(message);
        if (!missingColumn || !(missingColumn in updatePayload)) {
          orderDebugWarn("updateOrderInvoice.patch.failed", {
            orderId,
            invoiceId: existing.id,
            payloadKeys: Object.keys(updatePayload),
            error: message,
          });
          throw error;
        }
        orderDebugWarn("updateOrderInvoice.patch.dropMissingColumn", {
          orderId,
          invoiceId: existing.id,
          missingColumn,
          originalError: message,
        });
        delete updatePayload[missingColumn];
      }
    }
  }

  const insertPayload: Record<string, unknown> = {
    invoice_provider: "ecpay",
    invoice_status: "pending",
    ...merged,
  };
  while (true) {
    try {
      await insertRows(admin, "order_invoices", insertPayload);
      orderDebugLog("updateOrderInvoice.insert.success", {
        orderId,
        writtenKeys: Object.keys(insertPayload),
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingColumn = extractMissingColumnName(message);
      if (!missingColumn || !(missingColumn in insertPayload)) {
        orderDebugWarn("updateOrderInvoice.insert.failed", {
          orderId,
          payloadKeys: Object.keys(insertPayload),
          error: message,
        });
        throw error;
      }
      orderDebugWarn("updateOrderInvoice.insert.dropMissingColumn", {
        orderId,
        missingColumn,
        originalError: message,
      });
      delete insertPayload[missingColumn];
    }
  }
}

export async function userCanManageOrderShipment(
  admin: AdminClient,
  userId: string,
  orderId: string,
  vendorId: string,
): Promise<boolean> {
  const normalizedVendorId = String(vendorId ?? "").trim();
  if (!normalizedVendorId) {
    return false;
  }

  const vendor = await selectOne<{ id?: string | number | null }>(admin, "vendors", {
    select: "id",
    id: `eq.${normalizedVendorId}`,
    user_id: `eq.${userId}`,
  });
  if (!vendor) {
    return false;
  }

  const item = await selectOne<{ order_id?: string | null }>(admin, "order_items", {
    select: "order_id",
    order_id: `eq.${orderId}`,
    vendor_id: `eq.${normalizedVendorId}`,
  });
  return item !== null;
}

export async function fetchAdminOrders(admin: AdminClient, limit = 200): Promise<AdminOrderRow[]> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 200;

  return await selectRows<AdminOrderRow>(admin, "orders", {
    select: adminOrderSelectFields,
    order: "created_at.desc",
    limit: safeLimit,
  });
}

export async function fetchOrderItemsByOrderIds(
  admin: AdminClient,
  orderIds: string[],
): Promise<AdminOrderItemRow[]> {
  const ids = orderIds.map((value) => value.trim()).filter((value) => value);
  if (ids.length === 0) {
    return [];
  }

  return await selectRows<AdminOrderItemRow>(admin, "order_items", {
    select: "order_id,vendor_id,product_id,product_name,sku_name,quantity,unit_price,line_total",
    order_id: `in.(${ids.join(",")})`,
    order: "created_at.asc",
  });
}
