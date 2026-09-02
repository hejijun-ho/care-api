// supabase/functions/_shared/ecpay_invoice.ts
// ECPay B2C e-invoice JSON AES helper.

import {
  fetchOrderInvoiceByOrderId,
  invoiceOrderSelectFields,
  orderDebugLog,
  orderDebugWarn,
  safeKeys,
  selectOne,
  selectRows,
  updateOrderInvoice,
  type AdminClient,
  type OrderInvoiceRow,
  type OrderRow,
  type OrderShipmentRow,
} from "../_shared_haiglobals/orders.ts";
import { fetchShipmentByOrderId } from "../_shared_haiglobals/orders_shipments.ts";
import { parseEcpayDate, sanitizeEcpayItemName } from "./ecpay_common.ts";

export type EcpayInvoiceConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  issueUrl: string;
  platformId?: string;
};

export type EcpayInvoiceItem = {
  ItemSeq: number;
  ItemName: string;
  ItemCount: number;
  ItemWord: string;
  ItemPrice: number;
  ItemAmount: number;
  ItemTaxType?: string;
  ItemRemark?: string;
};

export type EcpayIssueInvoiceData = {
  MerchantID: string;
  RelateNumber: string;
  CustomerID?: string;
  CustomerIdentifier?: string;
  CustomerName?: string;
  CustomerAddr?: string;
  CustomerPhone?: string;
  CustomerEmail?: string;
  Print: string;
  Donation: string;
  LoveCode?: string;
  CarrierType?: string;
  CarrierNum?: string;
  TaxType: string;
  SalesAmount: number;
  InvoiceRemark?: string;
  Items: EcpayInvoiceItem[];
  InvType: string;
  vat: string;
  [key: string]: unknown;
};

export type EcpayIssueInvoiceResult = {
  envelope: Record<string, unknown>;
  data: Record<string, unknown>;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function assertAesKeyMaterial(hashKey: string, hashIv: string): void {
  if (new TextEncoder().encode(hashKey).length !== 16) {
    throw new Error("ECPay invoice HashKey must be 16 bytes for AES-128-CBC");
  }
  if (new TextEncoder().encode(hashIv).length !== 16) {
    throw new Error("ECPay invoice HashIV must be 16 bytes for AES-128-CBC");
  }
}

function urlEncodeDataJson(data: Record<string, unknown>): string {
  // ECPay invoice API requires JSON string -> URL encode -> AES encrypt.
  // encodeURIComponent uses uppercase hex for escaped bytes, which ECPay accepts.
  return encodeURIComponent(JSON.stringify(data));
}

async function importAesKey(hashKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hashKey),
    { name: "AES-CBC" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptInvoiceData(
  data: Record<string, unknown>,
  hashKey: string,
  hashIv: string,
): Promise<string> {
  assertAesKeyMaterial(hashKey, hashIv);
  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  const encoded = urlEncodeDataJson(data);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode(encoded) as BufferSource,
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

export async function decryptInvoiceData(
  encryptedBase64: string,
  hashKey: string,
  hashIv: string,
): Promise<Record<string, unknown>> {
  assertAesKeyMaterial(hashKey, hashIv);
  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    key,
    base64ToBytes(encryptedBase64) as BufferSource,
  );
  const encodedJson = new TextDecoder().decode(new Uint8Array(decrypted));
  return JSON.parse(decodeURIComponent(encodedJson)) as Record<string, unknown>;
}

export function resolveInvoiceIssueUrl(): string {
  const issueUrl = process.env["ECPAY_INVOICE_ISSUE_URL"]?.trim() ?? "";

  if (!issueUrl) {
    throw new Error("Missing ECPAY_INVOICE_ISSUE_URL");
  }

  return issueUrl;
}

export function getEcpayInvoiceConfig(): EcpayInvoiceConfig {
  const merchantId = process.env["ECPAY_INVOICE_MERCHANT_ID"]?.trim() ?? "";
  const hashKey = process.env["ECPAY_INVOICE_HASH_KEY"]?.trim() ?? "";
  const hashIv = process.env["ECPAY_INVOICE_HASH_IV"]?.trim() ?? "";
  const issueUrl = resolveInvoiceIssueUrl();
  const platformId = process.env["ECPAY_INVOICE_PLATFORM_ID"]?.trim() ?? "";

  if (!merchantId) throw new Error("Missing ECPAY_INVOICE_MERCHANT_ID");
  if (!hashKey) throw new Error("Missing ECPAY_INVOICE_HASH_KEY");
  if (!hashIv) throw new Error("Missing ECPAY_INVOICE_HASH_IV");

  return {
    merchantId,
    hashKey,
    hashIv,
    issueUrl,
    platformId,
  };
}

export async function issueEcpayB2CInvoice(
  config: EcpayInvoiceConfig,
  data: EcpayIssueInvoiceData,
): Promise<EcpayIssueInvoiceResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const encryptedData = await encryptInvoiceData(data, config.hashKey, config.hashIv);

  const requestBody: Record<string, unknown> = {
    MerchantID: config.merchantId,
    RqHeader: { Timestamp: timestamp },
    Data: encryptedData,
  };

  if (config.platformId) requestBody.PlatformID = config.platformId;

  const response = await fetch(config.issueUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const envelope = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`ECPay invoice HTTP ${response.status}: ${JSON.stringify(envelope)}`);
  }

  const encryptedResponseData = String(envelope.Data ?? "").trim();
  const decryptedData = encryptedResponseData
    ? await decryptInvoiceData(encryptedResponseData, config.hashKey, config.hashIv)
    : {};

  return { envelope, data: decryptedData };
}

type InvoiceOrderRow = OrderRow & {
  shipping_fee?: number | string | null;
  invoice?: OrderInvoiceRow | null;
  shipment?: OrderShipmentRow | null;
};

type InvoiceOrderItemRow = {
  id?: string | null;
  order_id?: string | null;
  vendor_id?: string | number | null;
  product_name?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
  sku_name?: string | null;
};

type InvoiceVendorRow = {
  id?: string | number | null;
  vendor_role?: string | null;
};

type AppUiConfigRow = {
  config_value?: Record<string, unknown> | null;
};

type InvoiceScope = {
  skipped: boolean;
  reason?: string;
  salesAmount: number;
  shippingFee: number;
  orderItems: InvoiceOrderItemRow[];
  invoiceableVendorIds: string[];
};

type EcpayInvoiceDataItem = {
  ItemSeq: number;
  ItemName: string;
  ItemCount: number;
  ItemWord: string;
  ItemPrice: number;
  ItemTaxType: string;
  ItemAmount: number;
  ItemRemark: string;
};

type EcpayInvoiceIssueResponseData = {
  RtnCode?: number | string;
  RtnMsg?: string;
  InvoiceNo?: string;
  InvoiceDate?: string;
  RandomNumber?: string;
};

export type EcpayInvoiceIssueConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  issueUrl: string;
  platformId?: string;
};

export type EcpayInvoiceIssueResult = {
  skipped: boolean;
  orderId: string;
  invoiceNo?: string;
  invoiceDate?: string;
  randomNumber?: string;
  referenceNo?: string;
  rtnCode?: number | string;
  rtnMsg?: string;
};

async function fetchInvoiceOrder(admin: AdminClient, orderId: string): Promise<InvoiceOrderRow> {
  const order = await selectOne<InvoiceOrderRow>(admin, "orders", {
    select: invoiceOrderSelectFields,
    id: `eq.${orderId}`,
  });

  if (!order) {
    throw new Error("Order not found");
  }

  const invoice = await selectOne<OrderInvoiceRow>(admin, "order_invoices", {
    select: "*",
    order_id: `eq.${orderId}`,
  });
  const shipment = await fetchShipmentByOrderId(admin, orderId);
  return { ...order, invoice, shipment };
}

async function fetchInvoiceOrderItems(
  admin: AdminClient,
  orderId: string,
): Promise<InvoiceOrderItemRow[]> {
  return await selectRows<InvoiceOrderItemRow>(admin, "order_items", {
    select: "id,order_id,vendor_id,product_name,sku_name,quantity,unit_price,line_total",
    order_id: `eq.${orderId}`,
    order: "created_at.asc",
  });
}

async function fetchInvoiceOrderShipments(
  admin: AdminClient,
  orderId: string,
): Promise<OrderShipmentRow[]> {
  return await selectRows<OrderShipmentRow>(admin, "order_shipments", {
    select:
      "id,order_id,vendor_id,receiver_country,shipping_fee,receiver_name,receiver_phone,receiver_email,receiver_address,cvs_store_address",
    order_id: `eq.${orderId}`,
    order: "created_at.asc",
  });
}

async function fetchInvoiceVendorsById(
  admin: AdminClient,
  vendorIds: string[],
): Promise<Map<string, InvoiceVendorRow>> {
  const ids = Array.from(new Set(vendorIds.map(normalizeVendorId).filter((id) => id)));
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await selectRows<InvoiceVendorRow>(admin, "vendors", {
    select: "id,vendor_role",
    id: `in.(${ids.join(",")})`,
  });

  return new Map(
    rows
      .map((vendor): [string, InvoiceVendorRow] => [normalizeVendorId(vendor.id), vendor])
      .filter(([vendorId]) => vendorId),
  );
}

async function fetchOsmileStoreVendorIds(admin: AdminClient): Promise<Set<string>> {
  const config = await selectOne<AppUiConfigRow>(admin, "app_ui_configs", {
    select: "config_value",
    config_key: "eq.osmile_store",
  });

  return extractOsmileStoreVendorIds(config?.config_value);
}

function coerceInt(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : fallback;
  }
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function coerceQuantity(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeVendorId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeCountryCode(value: unknown): string {
  // receiver_country is stored as ISO alpha-2 country code, e.g. TW.
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function extractOsmileStoreVendorIds(value: unknown): Set<string> {
  const vendorIds = new Set<string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return vendorIds;
  }

  for (const rawValue of Object.values(value as Record<string, unknown>)) {
    const vendorId = normalizeVendorId(rawValue);
    if (vendorId) vendorIds.add(vendorId);
  }
  return vendorIds;
}

function invoiceItemAmount(item: InvoiceOrderItemRow): number {
  const lineTotal = coerceInt(item.line_total);
  if (lineTotal > 0) return lineTotal;
  return Math.round(coerceInt(item.unit_price) * coerceQuantity(item.quantity));
}

function isInvoiceableVendor(
  vendorId: string,
  vendor: InvoiceVendorRow | undefined,
  osmileStoreVendorIds: Set<string>,
): boolean {
  const role = String(vendor?.vendor_role ?? "")
    .trim()
    .toLowerCase();
  if (role === "osmile_agent") return true;
  return role === "vendor" && osmileStoreVendorIds.has(vendorId);
}

async function resolveInvoiceScope(
  admin: AdminClient,
  orderItems: InvoiceOrderItemRow[],
  shipments: OrderShipmentRow[],
): Promise<InvoiceScope> {
  // Invoice country scope only uses order_shipments.receiver_country.
  // Current rule: TW issues invoice; any non-TW country is overseas and skipped.
  const receiverCountries = shipments
    .map((shipment) => normalizeCountryCode(shipment.receiver_country))
    .filter((country) => country);

  if (receiverCountries.length === 0) {
    return {
      skipped: true,
      reason: "Missing order_shipments.receiver_country",
      salesAmount: 0,
      shippingFee: 0,
      orderItems: [],
      invoiceableVendorIds: [],
    };
  }

  const overseasCountry = receiverCountries.find((country) => country !== "TW");
  if (overseasCountry) {
    return {
      skipped: true,
      reason: `Overseas order receiver_country=${overseasCountry}`,
      salesAmount: 0,
      shippingFee: 0,
      orderItems: [],
      invoiceableVendorIds: [],
    };
  }

  const candidateVendorIds = Array.from(
    new Set(
      [
        ...orderItems.map((item) => normalizeVendorId(item.vendor_id)),
        ...shipments.map((shipment) => normalizeVendorId(shipment.vendor_id)),
      ].filter((vendorId) => vendorId),
    ),
  );

  const [vendorMap, osmileStoreVendorIds] = await Promise.all([
    fetchInvoiceVendorsById(admin, candidateVendorIds),
    fetchOsmileStoreVendorIds(admin),
  ]);

  const invoiceableVendorIds = new Set<string>();
  for (const vendorId of candidateVendorIds) {
    if (isInvoiceableVendor(vendorId, vendorMap.get(vendorId), osmileStoreVendorIds)) {
      invoiceableVendorIds.add(vendorId);
    }
  }

  const invoiceableOrderItems = orderItems.filter((item) =>
    invoiceableVendorIds.has(normalizeVendorId(item.vendor_id)),
  );
  const itemAmount = invoiceableOrderItems.reduce((sum, item) => sum + invoiceItemAmount(item), 0);
  const shippingFee = shipments
    .filter((shipment) => invoiceableVendorIds.has(normalizeVendorId(shipment.vendor_id)))
    .reduce((sum, shipment) => sum + coerceInt(shipment.shipping_fee), 0);
  const salesAmount = itemAmount + shippingFee;

  if (invoiceableOrderItems.length === 0 && shippingFee <= 0) {
    return {
      skipped: true,
      reason: "No invoiceable Osmile vendor items in this order",
      salesAmount: 0,
      shippingFee: 0,
      orderItems: [],
      invoiceableVendorIds: Array.from(invoiceableVendorIds),
    };
  }
  if (salesAmount <= 0) {
    return {
      skipped: true,
      reason: "Invoiceable Osmile amount is not positive",
      salesAmount: 0,
      shippingFee: 0,
      orderItems: invoiceableOrderItems,
      invoiceableVendorIds: Array.from(invoiceableVendorIds),
    };
  }

  return {
    skipped: false,
    salesAmount,
    shippingFee,
    orderItems: invoiceableOrderItems,
    invoiceableVendorIds: Array.from(invoiceableVendorIds),
  };
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function sanitizeInvoiceText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function sanitizeDigits(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, maxLength);
}

function normalizeInvoiceCarrierNo(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeInvoiceReference(value: unknown): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase()
    .slice(0, 50);
}

function buildInvoiceReferenceNo(order: InvoiceOrderRow): string {
  const existing = normalizeInvoiceReference(order.invoice?.invoice_reference_no);
  if (existing) {
    return existing;
  }

  const source = normalizeInvoiceReference(
    order.provider_order_id || order.order_number || order.id,
  );
  const withPrefix = source.startsWith("INV") ? source : `INV${source}`;
  return withPrefix.slice(0, 50);
}

function buildFallbackInvoiceName(
  order: InvoiceOrderRow,
  orderItems: InvoiceOrderItemRow[],
): string {
  const names = orderItems
    .map((item) => sanitizeEcpayItemName(firstText([item.product_name, item.sku_name]), 40))
    .filter((name) => name);
  if (names.length === 1) {
    return names[0];
  }
  if (names.length > 1) {
    const joined = names.slice(0, 3).join("+");
    return sanitizeInvoiceText(`${joined}${names.length > 3 ? `等${names.length}項` : ""}`, 80);
  }
  return sanitizeEcpayItemName(`Osmile Order ${order.order_number ?? order.id}`, 80);
}

function buildInvoiceItems(
  order: InvoiceOrderRow,
  orderItems: InvoiceOrderItemRow[],
): EcpayInvoiceDataItem[] {
  const salesAmount = coerceInt(order.total_amount);
  if (salesAmount <= 0) {
    throw new Error("Invoice SalesAmount must be a positive integer");
  }

  const sourceItems = orderItems;
  const candidates = sourceItems
    .map((item, index): EcpayInvoiceDataItem | null => {
      const name = sanitizeEcpayItemName(firstText([item.product_name, item.sku_name]), 80);
      const count = coerceQuantity(item.quantity);
      const lineTotal = coerceInt(item.line_total);
      const unitPrice = coerceInt(item.unit_price);
      const amount = lineTotal > 0 ? lineTotal : Math.round(unitPrice * count);
      if (!name || amount <= 0 || (unitPrice <= 0 && lineTotal <= 0)) {
        return null;
      }
      return {
        ItemSeq: index + 1,
        ItemName: name,
        ItemCount: count,
        ItemWord: "件",
        ItemPrice: unitPrice > 0 ? unitPrice : amount,
        ItemTaxType: "1",
        ItemAmount: amount,
        ItemRemark: "",
      };
    })
    .filter((item): item is EcpayInvoiceDataItem => item !== null);

  const shippingFee = coerceInt(order.shipping_fee);
  const shipmentFee = coerceInt(order.shipment?.shipping_fee);
  const invoiceShippingAmount = shippingFee || shipmentFee;
  if (invoiceShippingAmount > 0) {
    candidates.push({
      ItemSeq: candidates.length + 1,
      ItemName: "運費",
      ItemCount: 1,
      ItemWord: "筆",
      ItemPrice: invoiceShippingAmount,
      ItemTaxType: "1",
      ItemAmount: invoiceShippingAmount,
      ItemRemark: "",
    });
  }

  const candidateTotal = candidates.reduce((sum, item) => sum + item.ItemAmount, 0);
  if (candidates.length > 0 && candidateTotal === salesAmount) {
    return candidates.map((item, index) => ({ ...item, ItemSeq: index + 1 }));
  }

  // 折扣、優惠券、歷史資料缺 unit_price 時，明細加總容易與 total_amount 不一致。
  // 綠界要求 SalesAmount 與 Items 金額一致；因此改用一筆彙總項目保證可開立。
  return [
    {
      ItemSeq: 1,
      ItemName: buildFallbackInvoiceName(order, sourceItems),
      ItemCount: 1,
      ItemWord: "筆",
      ItemPrice: salesAmount,
      ItemTaxType: "1",
      ItemAmount: salesAmount,
      ItemRemark: "",
    },
  ];
}

function buildEcpayInvoiceData(
  order: InvoiceOrderRow,
  orderItems: InvoiceOrderItemRow[],
): Record<string, unknown> {
  const salesAmount = coerceInt(order.total_amount);
  if (salesAmount <= 0) {
    throw new Error("Invoice SalesAmount must be a positive integer");
  }

  const invoice = order.invoice ?? { order_id: order.id };
  const invoiceType = String(invoice.invoice_type ?? "personal")
    .trim()
    .toLowerCase();
  const carrierType = String(invoice.invoice_carrier_type ?? "")
    .trim()
    .toLowerCase();
  const isCompany =
    invoiceType === "company" || sanitizeDigits(invoice.invoice_tax_id, 8).length === 8;
  const taxId = isCompany ? sanitizeDigits(invoice.invoice_tax_id, 8) : "";
  const carrierNo = normalizeInvoiceCarrierNo(invoice.invoice_carrier_no);
  const loveCode = sanitizeDigits(invoice.invoice_love_code, 7);
  const isDonation = invoiceType === "donation" || loveCode.length > 0;
  const wantsMobileCarrier =
    carrierType === "mobile" || carrierType === "3" || invoiceType === "carrier";

  const customerName = sanitizeInvoiceText(
    firstText([invoice.invoice_company_title, order.shipment?.receiver_name]),
    60,
  );
  const customerAddr = sanitizeInvoiceText(
    firstText([order.shipment?.receiver_address, order.shipment?.cvs_store_address]),
    100,
  );
  const customerPhone = sanitizeDigits(firstText([order.shipment?.receiver_phone]), 20);
  const customerEmail = sanitizeInvoiceText(
    firstText([invoice.invoice_email, order.shipment?.receiver_email]),
    80,
  );

  let ecpayCarrierType = ""; // 個人電子發票預設存綠界載具。
  let ecpayCarrierNum = "";
  let print = "0";
  if (wantsMobileCarrier) {
    ecpayCarrierType = "3";
    ecpayCarrierNum = carrierNo;
    print = "0";
    if (!/^\/[0-9A-Z+\-.]{7}$/.test(ecpayCarrierNum)) {
      throw new Error("Invalid mobile barcode carrier number");
    }
  } else if (isCompany) {
    ecpayCarrierType = "";
    ecpayCarrierNum = "";
    print = "1";
    if (!taxId) {
      throw new Error("CustomerIdentifier is required for company invoice");
    }
    if (!customerName) {
      throw new Error("CustomerName is required for company invoice");
    }
    if (!customerAddr) {
      throw new Error("CustomerAddr is required for company invoice");
    }
  }
  if (isDonation && !loveCode) {
    throw new Error("LoveCode is required for donation invoice");
  }
  if (isDonation) {
    ecpayCarrierType = "";
    ecpayCarrierNum = "";
    print = "0";
  }
  const shouldSuppressEmail = wantsMobileCarrier || isCompany;
  const customerEmailForInvoice = shouldSuppressEmail ? "" : customerEmail;
  if (!customerPhone && !customerEmailForInvoice) {
    throw new Error("CustomerPhone or CustomerEmail is required to issue ECPay invoice");
  }

  return {
    MerchantID: "", // 送出前會用 config.merchantId 覆蓋。
    RelateNumber: buildInvoiceReferenceNo(order),
    CustomerID: normalizeInvoiceReference(order.user_id).slice(0, 20),
    CustomerIdentifier: taxId,
    CustomerName: customerName,
    CustomerAddr: customerAddr,
    CustomerPhone: customerPhone,
    CustomerEmail: customerEmailForInvoice,
    ClearanceMark: "1",
    Print: print,
    Donation: isDonation ? "1" : "0",
    LoveCode: isDonation ? loveCode : "",
    CarrierType: ecpayCarrierType,
    CarrierNum: ecpayCarrierNum,
    TaxType: "1",
    SpecialTaxType: 0,
    SalesAmount: salesAmount,
    InvoiceRemark: sanitizeInvoiceText(order.order_number ?? order.id, 100),
    InvType: "07",
    vat: "1",
    Items: buildInvoiceItems(order, orderItems),
  };
}

async function encryptEcpayInvoiceData(
  payload: Record<string, unknown>,
  hashKey: string,
  hashIv: string,
): Promise<string> {
  return await encryptInvoiceData(payload, hashKey, hashIv);
}

async function decryptEcpayInvoiceData(
  encryptedData: string,
  hashKey: string,
  hashIv: string,
): Promise<EcpayInvoiceIssueResponseData & EcpayInvoiceInvalidResponseData> {
  return (await decryptInvoiceData(
    encryptedData,
    hashKey,
    hashIv,
  )) as EcpayInvoiceIssueResponseData & EcpayInvoiceInvalidResponseData;
}

async function postEcpayInvoiceIssue(
  config: EcpayInvoiceIssueConfig,
  data: Record<string, unknown>,
): Promise<EcpayInvoiceIssueResponseData> {
  const merchantId = config.merchantId.trim();
  const issueUrl = config.issueUrl.trim();
  if (!merchantId) {
    throw new Error("Missing ECPay invoice merchantId");
  }
  if (!issueUrl) {
    throw new Error("Missing ECPay invoice issueUrl");
  }

  const payload = { ...data, MerchantID: merchantId };
  const encryptedData = await encryptEcpayInvoiceData(payload, config.hashKey, config.hashIv);
  const body = {
    PlatformID: config.platformId?.trim() ?? "",
    MerchantID: merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: encryptedData,
  };

  const response = await fetch(issueUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `ECPay invoice issue failed (${response.status})`);
  }

  const envelope = JSON.parse(responseText) as Record<string, unknown>;
  const transCode = String(envelope.TransCode ?? "").trim();
  const transMsg = String(envelope.TransMsg ?? "").trim();
  if (transCode && transCode !== "1") {
    throw new Error(transMsg || `ECPay invoice TransCode=${transCode}`);
  }

  const responseData = await decryptEcpayInvoiceData(
    String(envelope.Data ?? ""),
    config.hashKey,
    config.hashIv,
  );
  return {
    RtnCode: responseData.RtnCode,
    RtnMsg: responseData.RtnMsg || transMsg,
    InvoiceNo: responseData.InvoiceNo,
    InvoiceDate: responseData.InvoiceDate,
    RandomNumber: responseData.RandomNumber,
  };
}

export async function issueEcpayInvoiceForOrder(
  admin: AdminClient,
  config: EcpayInvoiceIssueConfig,
  orderId: string,
): Promise<EcpayInvoiceIssueResult> {
  const order = await fetchInvoiceOrder(admin, orderId);
  if (!order.invoice) {
    return {
      skipped: true,
      orderId,
      rtnCode: 1,
      rtnMsg: "Invoice not requested",
    };
  }

  const existingInvoiceNo = firstText([order.invoice.invoice_number]);
  if (String(order.invoice.invoice_status ?? "").toLowerCase() === "issued") {
    return {
      skipped: true,
      orderId,
      invoiceNo: existingInvoiceNo || undefined,
      invoiceDate: order.invoice.invoice_issued_at ?? undefined,
      randomNumber: order.invoice.invoice_random_number ?? undefined,
      referenceNo: order.invoice.invoice_reference_no ?? undefined,
      rtnCode: 1,
      rtnMsg: "Invoice already issued",
    };
  }

  const paymentStatus = String(order.payment_status ?? "")
    .trim()
    .toLowerCase();
  if (paymentStatus !== "paid") {
    throw new Error("Only paid orders can issue ECPay invoices");
  }

  const orderItems = await fetchInvoiceOrderItems(admin, order.id);
  const shipments = await fetchInvoiceOrderShipments(admin, order.id);
  const invoiceScope = await resolveInvoiceScope(admin, orderItems, shipments);
  if (invoiceScope.skipped) {
    orderDebugLog("issueEcpayInvoiceForOrder.skipped", {
      orderId,
      reason: invoiceScope.reason,
      invoiceableVendorIds: invoiceScope.invoiceableVendorIds,
    });
    return {
      skipped: true,
      orderId,
      rtnCode: 1,
      rtnMsg: invoiceScope.reason ?? "Invoice skipped",
    };
  }

  const referenceNo = buildInvoiceReferenceNo(order);
  const requestedAt = new Date().toISOString();
  await updateOrderInvoice(admin, order.id, {
    invoice_provider: "ecpay",
    invoice_status: "pending",
    invoice_reference_no: referenceNo,
    invoice_requested_at: requestedAt,
    invoice_error_message: null,
  });

  try {
    const invoiceData = buildEcpayInvoiceData(
      {
        ...order,
        total_amount: invoiceScope.salesAmount,
        shipping_fee: invoiceScope.shippingFee,
        shipment: order.shipment ? { ...order.shipment, shipping_fee: null } : order.shipment,
        invoice: {
          ...(order.invoice ?? { order_id: order.id }),
          invoice_reference_no: referenceNo,
        },
      },
      invoiceScope.orderItems,
    );
    const sentAt = new Date().toISOString();
    await updateOrderInvoice(admin, order.id, {
      invoice_sent_at: sentAt,
      invoice_error_message: null,
    });

    const result = await postEcpayInvoiceIssue(config, invoiceData);
    const receivedAt = new Date().toISOString();
    const rtnCode = String(result.RtnCode ?? "").trim();
    const rtnMsg = String(result.RtnMsg ?? "").trim();
    if (rtnCode !== "1") {
      await updateOrderInvoice(admin, order.id, {
        invoice_status: "failed",
        invoice_received_at: receivedAt,
        invoice_error_message: rtnMsg || `ECPay invoice RtnCode=${rtnCode || "<empty>"}`,
      });
      throw new Error(rtnMsg || `ECPay invoice RtnCode=${rtnCode || "<empty>"}`);
    }

    const invoiceNo = String(result.InvoiceNo ?? "").trim();
    const invoiceIssuedAt = parseEcpayDate(result.InvoiceDate) ?? receivedAt;
    const randomNumber = String(result.RandomNumber ?? "").trim();
    await updateOrderInvoice(admin, order.id, {
      invoice_provider: "ecpay",
      invoice_status: "issued",
      invoice_number: invoiceNo || null,
      invoice_issued_at: invoiceIssuedAt,
      invoice_random_number: randomNumber || null,
      invoice_reference_no: referenceNo,
      invoice_received_at: receivedAt,
      invoice_error_message: null,
      invoice_payload: result as Record<string, unknown>,
    });

    return {
      skipped: false,
      orderId,
      invoiceNo,
      invoiceDate: invoiceIssuedAt,
      randomNumber,
      referenceNo,
      rtnCode: result.RtnCode,
      rtnMsg: result.RtnMsg,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateOrderInvoice(admin, order.id, {
      invoice_status: "failed",
      invoice_received_at: new Date().toISOString(),
      invoice_error_message: message,
    });
    throw error;
  }
}

type EcpayInvoiceInvalidResponseData = {
  RtnCode?: number | string;
  RtnMsg?: string;
  InvoiceNo?: string;
};

type EcpayInvoiceInvalidPostResult = {
  requestPayload: Record<string, unknown>;
  requestEnvelope: Record<string, unknown>;
  responseEnvelope: Record<string, unknown>;
  responseData: EcpayInvoiceInvalidResponseData;
  rawResponse: string;
};

export type EcpayInvoiceInvalidConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  invalidUrl: string;
  platformId?: string;
};

export type EcpayInvoiceInvalidResult = {
  skipped: boolean;
  status: "skipped" | "success" | "failed";
  orderId: string;
  invoiceNo?: string;
  invoiceDate?: string;
  rtnCode?: number | string;
  rtnMsg?: string;
  reason?: string;
  error?: string;
};

function invoiceDateForEcpay(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const direct = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct) || /^\d{4}\/\d{2}\/\d{2}$/.test(direct)) {
    return direct;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

async function postEcpayInvoiceInvalid(
  config: EcpayInvoiceInvalidConfig,
  data: Record<string, unknown>,
): Promise<EcpayInvoiceInvalidPostResult> {
  const merchantId = config.merchantId.trim();
  const invalidUrl = config.invalidUrl.trim();
  if (!merchantId) {
    throw new Error("Missing ECPay invoice merchantId");
  }
  if (!invalidUrl) {
    throw new Error("Missing ECPay invoice invalidUrl");
  }

  const requestPayload = { ...data, MerchantID: merchantId };
  const encryptedData = await encryptEcpayInvoiceData(
    requestPayload,
    config.hashKey,
    config.hashIv,
  );
  const requestEnvelope = {
    PlatformID: config.platformId?.trim() ?? "",
    MerchantID: merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: encryptedData,
  };

  const response = await fetch(invalidUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestEnvelope),
  });
  const rawResponse = await response.text();
  if (!response.ok) {
    throw new Error(rawResponse || `ECPay invoice invalid failed (${response.status})`);
  }

  const responseEnvelope = JSON.parse(rawResponse) as Record<string, unknown>;
  const transCode = String(responseEnvelope.TransCode ?? "").trim();
  const transMsg = String(responseEnvelope.TransMsg ?? "").trim();
  if (transCode && transCode !== "1") {
    throw new Error(transMsg || `ECPay invoice invalid TransCode=${transCode}`);
  }

  const decryptedData = await decryptEcpayInvoiceData(
    String(responseEnvelope.Data ?? ""),
    config.hashKey,
    config.hashIv,
  );

  return {
    requestPayload,
    requestEnvelope: { ...requestEnvelope, Data: "<encrypted>" },
    responseEnvelope: { ...responseEnvelope, Data: responseEnvelope.Data ? "<encrypted>" : "" },
    responseData: {
      RtnCode: decryptedData.RtnCode,
      RtnMsg: decryptedData.RtnMsg,
      InvoiceNo: decryptedData.InvoiceNo,
    },
    rawResponse,
  };
}

export async function voidEcpayInvoiceForOrder(
  admin: AdminClient,
  config: EcpayInvoiceInvalidConfig,
  orderId: string,
  reason?: string | null,
): Promise<EcpayInvoiceInvalidResult> {
  orderDebugLog("voidEcpayInvoiceForOrder.start", {
    orderId,
    reason: reason ?? null,
    merchantId: config.merchantId ? `${config.merchantId.slice(0, 4)}***` : "<empty>",
    hasHashKey: Boolean(config.hashKey),
    hasHashIv: Boolean(config.hashIv),
    invalidUrl: config.invalidUrl || "<empty>",
    hasPlatformId: Boolean(config.platformId),
  });

  const invoice = await fetchOrderInvoiceByOrderId(admin, orderId);
  orderDebugLog("voidEcpayInvoiceForOrder.invoiceFetched", {
    orderId,
    found: Boolean(invoice),
    invoiceId: invoice?.id ?? null,
    invoiceStatus: invoice?.invoice_status ?? null,
    invoiceNumber: invoice?.invoice_number ?? null,
    invoiceIssuedAt: invoice?.invoice_issued_at ?? null,
    invoiceReceivedAt: invoice?.invoice_received_at ?? null,
    invoicePayloadKeys: safeKeys(invoice?.invoice_payload),
  });

  if (!invoice) {
    orderDebugWarn("voidEcpayInvoiceForOrder.skipped", {
      orderId,
      reason: "no_invoice_record",
    });
    return {
      skipped: true,
      status: "skipped",
      orderId,
      reason: "no_invoice_record",
    };
  }

  const invoiceStatus = String(invoice.invoice_status ?? "")
    .trim()
    .toLowerCase();
  const invoicePayload = invoice.invoice_payload as Record<string, unknown> | null | undefined;
  const invoiceNo = firstText([
    invoice.invoice_number,
    invoicePayload?.InvoiceNo,
    invoicePayload?.invoiceNo,
  ]);

  if (["voided", "invalid", "invalidated"].includes(invoiceStatus)) {
    orderDebugLog("voidEcpayInvoiceForOrder.alreadyVoided", {
      orderId,
      invoiceNo: invoiceNo || null,
      invoiceStatus,
    });
    return {
      skipped: true,
      status: "skipped",
      orderId,
      invoiceNo: invoiceNo || undefined,
      invoiceDate: invoice.invoice_issued_at ?? undefined,
      rtnCode: 1,
      rtnMsg: "Invoice already voided",
      reason: "already_voided",
    };
  }

  if (!invoiceNo) {
    orderDebugWarn("voidEcpayInvoiceForOrder.skipped", {
      orderId,
      invoiceId: invoice.id ?? null,
      reason: "invoice_not_issued",
      invoiceStatus,
      invoicePayloadKeys: safeKeys(invoice.invoice_payload),
    });
    return {
      skipped: true,
      status: "skipped",
      orderId,
      reason: "invoice_not_issued",
    };
  }

  const invoiceDateSource = firstText([
    invoice.invoice_issued_at,
    invoicePayload?.InvoiceDate,
    invoicePayload?.invoiceDate,
    invoice.invoice_received_at,
    invoice.invoice_sent_at,
    invoice.invoice_requested_at,
  ]);
  const invoiceDate = invoiceDateForEcpay(invoiceDateSource);
  const voidReason = sanitizeInvoiceText(reason || "訂單取消", 20) || "訂單取消";

  orderDebugLog("voidEcpayInvoiceForOrder.precheck", {
    orderId,
    invoiceId: invoice.id ?? null,
    invoiceNo,
    invoiceDateSource,
    invoiceDate,
    voidReason,
    invoiceStatus,
  });

  if (!invoiceDate) {
    const message =
      "Issued invoice is missing invoice_issued_at / InvoiceDate; cannot void invoice";
    await updateOrderInvoice(admin, orderId, {
      invoice_status: "void_failed",
      invoice_void_reason: voidReason,
      invoice_error_message: message,
    });
    orderDebugWarn("voidEcpayInvoiceForOrder.failed", {
      orderId,
      invoiceNo,
      reason: "missing_invoice_date",
      message,
    });
    return {
      skipped: false,
      status: "failed",
      orderId,
      invoiceNo,
      reason: "missing_invoice_date",
      error: message,
    };
  }

  await updateOrderInvoice(admin, orderId, {
    invoice_status: "voided",
    invoice_void_reason: voidReason,
    invoice_error_message: null,
  });

  const invalidData = {
    MerchantID: config.merchantId,
    InvoiceNo: invoiceNo,
    InvoiceDate: invoiceDate,
    Reason: voidReason,
  };

  orderDebugLog("voidEcpayInvoiceForOrder.callEcpay", {
    orderId,
    invalidUrl: config.invalidUrl,
    invalidData,
    hasPlatformId: Boolean(config.platformId),
  });

  try {
    const postResult = await postEcpayInvoiceInvalid(config, invalidData);
    const rtnCode = String(postResult.responseData.RtnCode ?? "").trim();
    const rtnMsg = String(postResult.responseData.RtnMsg ?? "").trim();
    const responseInvoiceNo = String(postResult.responseData.InvoiceNo ?? "").trim();

    orderDebugLog("voidEcpayInvoiceForOrder.ecpayResult", {
      orderId,
      rtnCode,
      rtnMsg,
      responseInvoiceNo,
      responseEnvelopeKeys: Object.keys(postResult.responseEnvelope),
      responseData: postResult.responseData,
    });

    if (rtnCode !== "1") {
      const message = rtnMsg || `ECPay invoice invalid RtnCode=${rtnCode || "<empty>"}`;
      await updateOrderInvoice(admin, orderId, {
        invoice_status: "void_failed",
        invoice_void_result_code: rtnCode || null,
        invoice_void_result_message: message,
        invoice_void_request_payload: {
          ...postResult.requestEnvelope,
          DataPayload: invalidData,
        },
        invoice_void_response_payload: {
          envelope: postResult.responseEnvelope,
          data: postResult.responseData,
        },
        invoice_void_raw_response: postResult.rawResponse,
        invoice_error_message: message,
      });
      orderDebugWarn("voidEcpayInvoiceForOrder.ecpayFailed", {
        orderId,
        invoiceNo,
        rtnCode,
        message,
      });
      return {
        skipped: false,
        status: "failed",
        orderId,
        invoiceNo,
        invoiceDate,
        rtnCode: rtnCode || undefined,
        rtnMsg: message,
        reason: voidReason,
        error: message,
      };
    }

    const voidedAt = new Date().toISOString();
    const voidUpdatePayload = {
      invoice_provider: "ecpay",
      invoice_status: "voided",
      invoice_voided_at: voidedAt,
      invoice_void_reason: voidReason,
      invoice_void_result_code: rtnCode,
      invoice_void_result_message: rtnMsg || "作廢發票成功",
      invoice_void_request_payload: {
        ...postResult.requestEnvelope,
        DataPayload: invalidData,
      },
      invoice_void_response_payload: {
        envelope: postResult.responseEnvelope,
        data: postResult.responseData,
      },
      invoice_void_raw_response: postResult.rawResponse,
      invoice_error_message: null,
    };

    await updateOrderInvoice(admin, orderId, voidUpdatePayload);

    orderDebugLog("voidEcpayInvoiceForOrder.success", {
      orderId,
      invoiceNo: responseInvoiceNo || invoiceNo,
      invoiceDate,
      voidedAt,
      writtenKeys: Object.keys(voidUpdatePayload),
    });

    return {
      skipped: false,
      status: "success",
      orderId,
      invoiceNo: responseInvoiceNo || invoiceNo,
      invoiceDate,
      rtnCode,
      rtnMsg: rtnMsg || "作廢發票成功",
      reason: voidReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateOrderInvoice(admin, orderId, {
      invoice_status: "void_failed",
      invoice_void_reason: voidReason,
      invoice_void_request_payload: invalidData,
      invoice_error_message: message,
    });
    orderDebugWarn("voidEcpayInvoiceForOrder.exception", {
      orderId,
      invoiceNo,
      invoiceDate,
      error: message,
    });
    return {
      skipped: false,
      status: "failed",
      orderId,
      invoiceNo,
      invoiceDate,
      reason: voidReason,
      error: message,
    };
  }
}
