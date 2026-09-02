import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { createCheckoutOrder, fetchUserEmail } from "../_shared_haiglobals/orders_checkout.ts";
import { assertOrderShipmentsSupportCod } from "../_shared_haiglobals/orders_shipments.ts";
import {
  fetchOrderForUser,
  fetchOrderItems,
  fetchOrderInvoiceByOrderId,
  merchantTradeNoExists,
  requireUserId,
  updateOrder,
  updateOrderInvoice,
} from "../_shared_haiglobals/orders.ts";
import {
  buildTaipeiDate,
  generateCheckMacValue,
  getEcpayPaymentConfig,
  randomDigits,
  normalizeEcpayLanguage,
  sanitizeEcpayItemName,
  resolveCallbackBaseUrl,
  trimTrailingSlash,
  type EcpayPaymentConfig,
} from "../_shared/ecpay_payment.ts";
type PaymentType = "all" | "credit" | "apple_pay" | "webatm" | "atm" | "cvs" | "barcode" | "cod";

type CheckoutShippingSelectionDraft = {
  vendorId?: string;
  shippingMethodId?: string;
  deliveryMethod?: string;
  logisticsSubType?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  recipientCountryCode?: string;
  recipientZipcode?: string;
  pickupStoreName?: string;
  pickupStoreCode?: string;
  pickupStoreAddress?: string;
};

type CheckoutOrderDraft = {
  paymentProvider?: string;
  paymentMethod?: string;
  deliveryMethod?: string;
  logisticsSubType?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  recipientCountryCode?: string;
  recipientZipcode?: string;
  pickupStoreName?: string;
  pickupStoreCode?: string;
  pickupStoreAddress?: string;
  invoiceType?: string;
  invoiceCarrierType?: string;
  invoiceCarrierNo?: string;
  invoiceCompanyTitle?: string;
  invoiceTaxId?: string;
  items?: Array<{
    productId?: string;
    product_id?: string;
    skuId?: string;
    sku_id?: string;
    quantity?: number;
  }>;
  shippingSelections?: CheckoutShippingSelectionDraft[];
};

function normalizeBaseUrl(value: string): string {
  return trimTrailingSlash(value.trim());
}

function mapPaymentType(input: unknown): PaymentType {
  const value = String(input ?? "")
    .trim()
    .toLowerCase();
  switch (value) {
    case "credit":
    case "credit_card":
      return "credit";
    case "applepay":
    case "apple_pay":
      return "apple_pay";
    case "webatm":
    case "web_atm":
      return "webatm";
    case "atm":
      return "atm";
    case "cvs":
    case "convenience":
    case "convenience_store_code":
    case "cvs_code":
      return "cvs";
    case "barcode":
    case "bar_code":
    case "convenience_store_barcode":
    case "cvs_barcode":
      return "barcode";
    case "cod":
    case "cash":
    case "cash_on_delivery":
      return "cod";
    case "all":
    case "":
      return "all";
    default:
      throw new Error(`Unsupported payment type: ${value || "<empty>"}`);
  }
}

function toChoosePayment(paymentType: PaymentType): string {
  switch (paymentType) {
    case "credit":
      return "Credit";
    case "apple_pay":
      return "ApplePay";
    case "webatm":
      return "WebATM";
    case "atm":
      return "ATM";
    case "cvs":
      return "CVS";
    case "barcode":
      return "BARCODE";
    case "cod":
      return "ALL";
    case "all":
      return "ALL";
  }
}

// Keep MerchantTradeNo within 19 chars: OSE + 12-digit time + 4 random digits.
const MERCHANT_TRADE_NO_PREFIX = "OSE";
const MERCHANT_TRADE_NO_MAX_LENGTH = 19;
const MERCHANT_TRADE_TIMESTAMP_DIGITS = 12;
const MERCHANT_TRADE_RANDOM_DIGITS =
  MERCHANT_TRADE_NO_MAX_LENGTH - MERCHANT_TRADE_NO_PREFIX.length - MERCHANT_TRADE_TIMESTAMP_DIGITS;
const MERCHANT_TRADE_NO_MAX_ATTEMPTS = 12;
const ECPAY_RETURN_FUNCTION_NAME = "haiglobals-ecpay-return";

function sanitizeAlnum(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

function normalizeMerchantTradeNo(value: unknown): string {
  const normalized = sanitizeAlnum(String(value ?? "")).toUpperCase();
  if (!/^OSE\d{1,16}$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function buildMerchantTradeNoCandidate(now = Date.now()): string {
  const timestamp = now
    .toString()
    .slice(-MERCHANT_TRADE_TIMESTAMP_DIGITS)
    .padStart(MERCHANT_TRADE_TIMESTAMP_DIGITS, "0");
  return `${MERCHANT_TRADE_NO_PREFIX}${timestamp}${randomDigits(MERCHANT_TRADE_RANDOM_DIGITS)}`;
}

async function buildMerchantTradeNo(
  admin: ReturnType<typeof createDatabaseClient>,
  order: {
    id?: string | null;
    order_number?: string | null;
    provider_order_id?: string | null;
  },
): Promise<string> {
  const orderId = String(order.id ?? "").trim() || undefined;
  const reusable = !String(order.provider_order_id ?? "").trim()
    ? normalizeMerchantTradeNo(order.order_number)
    : "";
  if (reusable) {
    const exists = await merchantTradeNoExists(admin, reusable, orderId);
    if (!exists) {
      return reusable;
    }
  }

  for (let attempt = 0; attempt < MERCHANT_TRADE_NO_MAX_ATTEMPTS; attempt += 1) {
    const candidate = buildMerchantTradeNoCandidate(Date.now() + attempt);
    const exists = await merchantTradeNoExists(admin, candidate, orderId);
    if (!exists) {
      return candidate;
    }
  }

  throw new Error("Unable to allocate a unique MerchantTradeNo");
}

function buildItemName(
  items: Array<{ product_name?: string | null; quantity?: number | null }>,
): string {
  const names = items
    .map((item) => {
      const name = sanitizeEcpayItemName(item.product_name, 80);
      const quantity = Number(item.quantity ?? 0);
      if (!name) return "";
      return quantity > 1 ? `${name} x${quantity}` : name;
    })
    .filter(Boolean);

  const joined = names.join("#");
  if (!joined) {
    return "Osmile Order";
  }

  return joined.length <= 200 ? joined : joined.slice(0, 200);
}

function draftText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = String(record[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function toCheckoutShippingSelectionDraft(
  input: unknown,
  fallbackVendorId = "",
): CheckoutShippingSelectionDraft {
  if (typeof input === "string") {
    return {
      vendorId: fallbackVendorId.trim(),
      shippingMethodId: input.trim(),
    };
  }
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    vendorId: draftText(record, "vendorId", "vendor_id") || fallbackVendorId.trim(),
    shippingMethodId: draftText(record, "shippingMethodId", "shipping_method_id"),
    deliveryMethod: draftText(record, "deliveryMethod", "delivery_method"),
    logisticsSubType: draftText(record, "logisticsSubType", "logistics_sub_type"),
    recipientName: draftText(record, "recipientName", "recipient_name"),
    recipientPhone: draftText(record, "recipientPhone", "recipient_phone"),
    recipientAddress: draftText(record, "recipientAddress", "recipient_address"),
    recipientCountryCode: draftText(
      record,
      "recipientCountryCode",
      "recipient_country_code",
      "recipientCountry",
      "recipient_country",
    ).toUpperCase(),
    recipientZipcode: draftText(
      record,
      "recipientZipcode",
      "recipient_zipcode",
      "recipientZipCode",
      "recipient_zip_code",
    ),
    pickupStoreName: draftText(record, "pickupStoreName", "pickup_store_name"),
    pickupStoreCode: draftText(record, "pickupStoreCode", "pickup_store_code"),
    pickupStoreAddress: draftText(record, "pickupStoreAddress", "pickup_store_address"),
  };
}

function toCheckoutShippingSelectionsDraft(
  row: Record<string, unknown>,
): CheckoutShippingSelectionDraft[] {
  const raw =
    row.shippingSelections ??
    row.shipping_selections ??
    row.shipmentSelections ??
    row.shipment_selections ??
    row.vendorShippingSelections ??
    row.vendor_shipping_selections ??
    row.shippingByVendor ??
    row.shipping_by_vendor;
  if (raw === undefined || raw === null) return [];

  if (Array.isArray(raw)) {
    return raw.map((item) => toCheckoutShippingSelectionDraft(item));
  }

  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([vendorId, value]) =>
      toCheckoutShippingSelectionDraft(value, vendorId),
    );
  }

  throw new Error("shippingSelections must be an array or object");
}

function toCheckoutOrderDraft(input: unknown): CheckoutOrderDraft | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const row = input as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    paymentProvider: String(row.paymentProvider ?? row.payment_provider ?? "ecpay").trim(),
    paymentMethod: String(row.paymentMethod ?? row.payment_method ?? "").trim(),
    deliveryMethod: String(row.deliveryMethod ?? row.delivery_method ?? "").trim(),
    logisticsSubType: String(row.logisticsSubType ?? row.logistics_sub_type ?? "").trim(),
    recipientName: String(row.recipientName ?? row.recipient_name ?? "").trim(),
    recipientPhone: String(row.recipientPhone ?? row.recipient_phone ?? "").trim(),
    recipientAddress: String(row.recipientAddress ?? row.recipient_address ?? "").trim(),
    recipientCountryCode: String(
      row.recipientCountryCode ??
        row.recipient_country_code ??
        row.recipientCountry ??
        row.recipient_country ??
        "",
    )
      .trim()
      .toUpperCase(),
    recipientZipcode: String(
      row.recipientZipcode ??
        row.recipient_zipcode ??
        row.recipientZipCode ??
        row.recipient_zip_code ??
        "",
    ).trim(),
    pickupStoreName: String(row.pickupStoreName ?? row.pickup_store_name ?? "").trim(),
    pickupStoreCode: String(row.pickupStoreCode ?? row.pickup_store_code ?? "").trim(),
    pickupStoreAddress: String(row.pickupStoreAddress ?? row.pickup_store_address ?? "").trim(),
    invoiceType: String(row.invoiceType ?? row.invoice_type ?? "").trim(),
    invoiceCarrierType: String(row.invoiceCarrierType ?? row.invoice_carrier_type ?? "").trim(),
    invoiceCarrierNo: String(row.invoiceCarrierNo ?? row.invoice_carrier_no ?? "").trim(),
    invoiceCompanyTitle: String(row.invoiceCompanyTitle ?? row.invoice_company_title ?? "").trim(),
    invoiceTaxId: String(row.invoiceTaxId ?? row.invoice_tax_id ?? "").trim(),
    items: rawItems.map((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        product_id: String(record.productId ?? record.product_id ?? record.id ?? "").trim(),
        sku_id: String(record.skuId ?? record.sku_id ?? "").trim() || null,
        quantity: Number(record.quantity ?? 1),
      };
    }),
    shippingSelections: toCheckoutShippingSelectionsDraft(row),
  };
}

function buildClientBackUrl(appBaseUrl: string): string {
  return `${normalizeBaseUrl(appBaseUrl)}/#/orders`;
}

function resolveClientBackUrl(body: Record<string, unknown>, appBaseUrl: string): string {
  const raw = String(body.clientBackUrl ?? body.clientBackURL ?? body.client_back_url ?? "").trim();
  if (!raw) {
    return buildClientBackUrl(appBaseUrl);
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("clientBackUrl must be http(s)");
    }
    return url.toString();
  } catch (_) {
    throw new Error("clientBackUrl is invalid");
  }
}

function toNullableInt(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function assertEcpayOrderCompatible(
  order: {
    payment_provider?: string | null;
    order_number?: string | null;
    total_amount?: number | string | null;
  },
  tradeAmtValue = "",
): void {
  const paymentProvider = String(order.payment_provider ?? "")
    .trim()
    .toLowerCase();
  const orderRef = String(order.order_number ?? "")
    .trim()
    .toUpperCase();
  const inferredProvider =
    paymentProvider.length > 0 ? paymentProvider : orderRef.startsWith("OSE") ? "ecpay" : "";
  if (inferredProvider && inferredProvider !== "ecpay") {
    throw new Error(`Order payment_provider mismatch: ${inferredProvider}`);
  }

  const tradeAmt = toNullableInt(tradeAmtValue);
  if (tradeAmt === null) {
    return;
  }

  const orderAmount = Number(order.total_amount ?? 0);
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
    throw new Error("Order total_amount must be a positive integer");
  }

  if (tradeAmt !== orderAmount) {
    throw new Error("TradeAmt mismatch");
  }
}

const handleRequest = async (req) => {
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
    const config: EcpayPaymentConfig = getEcpayPaymentConfig();
    const userId = await requireUserId(req, config);
    const body = (await req.json()) as Record<string, unknown>;

    const admin = createDatabaseClient(config);
    const checkoutOrderDraft = toCheckoutOrderDraft(body.checkoutDraft ?? body.orderCreate);
    const requestedOrderId = String(body.orderId ?? "").trim();
    const order = requestedOrderId
      ? await fetchOrderForUser(admin, requestedOrderId, userId)
      : checkoutOrderDraft
        ? await createCheckoutOrder(admin, {
            userId,
            paymentProvider: checkoutOrderDraft.paymentProvider || "ecpay",
            paymentMethod: checkoutOrderDraft.paymentMethod ?? "",
            deliveryMethod: checkoutOrderDraft.deliveryMethod ?? "",
            logisticsSubType: checkoutOrderDraft.logisticsSubType ?? "",
            recipientName: checkoutOrderDraft.recipientName ?? "",
            recipientPhone: checkoutOrderDraft.recipientPhone ?? "",
            recipientAddress: checkoutOrderDraft.recipientAddress ?? "",
            recipientCountryCode: checkoutOrderDraft.recipientCountryCode ?? "",
            recipientZipcode: checkoutOrderDraft.recipientZipcode ?? "",
            pickupStoreName: checkoutOrderDraft.pickupStoreName ?? "",
            pickupStoreCode: checkoutOrderDraft.pickupStoreCode ?? "",
            pickupStoreAddress: checkoutOrderDraft.pickupStoreAddress ?? "",
            invoiceType: checkoutOrderDraft.invoiceType ?? "",
            invoiceCarrierType: checkoutOrderDraft.invoiceCarrierType ?? "",
            invoiceCarrierNo: checkoutOrderDraft.invoiceCarrierNo ?? "",
            invoiceCompanyTitle: checkoutOrderDraft.invoiceCompanyTitle ?? "",
            invoiceTaxId: checkoutOrderDraft.invoiceTaxId ?? "",
            items: (checkoutOrderDraft.items ?? []).map((item) => ({
              product_id: String(item.product_id ?? "").trim(),
              sku_id: String(item.sku_id ?? "").trim() || null,
              quantity: Number(item.quantity ?? 1),
            })),
            shippingSelections: checkoutOrderDraft.shippingSelections ?? [],
          })
        : null;

    if (!order) {
      throw new Error("orderId or checkoutDraft is required");
    }

    assertEcpayOrderCompatible(order);
    const userEmail = await fetchUserEmail(admin, userId);

    const ecpayLanguage = normalizeEcpayLanguage(body.language ?? body.Language);
    const paymentType = mapPaymentType(order.payment_method);
    const totalAmount = Number(order.total_amount ?? 0);
    if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
      throw new Error("Order total_amount must be a positive integer");
    }

    if (
      body.amount !== undefined &&
      Number.isFinite(Number(body.amount)) &&
      Number(body.amount) !== totalAmount
    ) {
      console.log("[Ecpay Checkout] Amount mismatch: %f, %f", body.amount, totalAmount);
      throw new Error("Amount mismatch");
    }

    if (order.payment_status === "paid") {
      throw new Error("This order is already paid");
    }
    if (order.payment_status === "cancelled" || order.payment_status === "refunded") {
      throw new Error(`Orders with payment_status=${order.payment_status} cannot start checkout`);
    }

    if (paymentType === "cod") {
      await assertOrderShipmentsSupportCod(admin, order.id);
      return new Response(
        JSON.stringify({
          provider: "ecpay",
          orderId: order.id,
          orderNumber: order.order_number ?? "",
          amount: totalAmount,
          paymentMethod: "cod",
          cod: true,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    const items = await fetchOrderItems(admin, order.id);
    const merchantTradeNo = await buildMerchantTradeNo(admin, order);
    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      PaymentType: "aio",
      TotalAmount: String(totalAmount),
      TradeDesc: "Osmile Order",
      ItemName: buildItemName(items),
      ReturnURL: `${callbackBaseUrl}/${ECPAY_RETURN_FUNCTION_NAME}`,
      ChoosePayment: config.choosePaymentOverride || toChoosePayment(paymentType),
      ClientBackURL: resolveClientBackUrl(body, config.appBaseUrl),
      NeedExtraPaidInfo: "Y",
      EncryptType: "1",
      CustomField1: order.id,
      CustomField2: String(order.payment_method ?? ""),
      CustomField4: config.appBaseUrl,
    };

    if (ecpayLanguage) {
      fields.Language = ecpayLanguage;
    }

    console.log("[Ecpay Checkout] Fields:", fields);

    if (paymentType === "atm" || paymentType === "cvs" || paymentType === "barcode") {
      fields.PaymentInfoURL = `${callbackBaseUrl}/${ECPAY_RETURN_FUNCTION_NAME}`;
    }

    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    await updateOrder(admin, order.id, {
      provider_order_id: merchantTradeNo,
      payment_provider: "ecpay",
      payment_status: "pending",
    });
    const existingInvoice = await fetchOrderInvoiceByOrderId(admin, order.id);
    if (existingInvoice) {
      await updateOrderInvoice(admin, order.id, {
        invoice_provider: "ecpay",
        invoice_status: "pending",
        invoice_error_message: null,
        ...(userEmail ? { invoice_email: userEmail } : {}),
      });
    }

    return new Response(
      JSON.stringify({
        provider: "ecpay",
        orderId: order.id,
        orderNumber: order.order_number ?? "",
        amount: totalAmount,
        action: config.checkoutUrl,
        fields,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  } catch (error) {
    console.error("[haiglobals-ecpay-checkout]", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }
};

export default handleRequest;
