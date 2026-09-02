import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  selectOne,
  selectRows,
  type AdminClient,
  type OrderInvoiceRow,
  type OrderRow,
} from "../_shared_haiglobals/orders.ts";
import { assertVendorAccess } from "../_shared_haiglobals/vendor_subscriptions.ts";
import { decryptInvoiceData, encryptInvoiceData } from "../_shared/ecpay_invoice.ts";
import { normalizeEcpayLanguage } from "../_shared/ecpay_common.ts";

type EcpayInvoicePrintConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  printUrl: string;
  platformId: string;
};

type EcpayInvoicePrintResponseData = {
  RtnCode?: number | string;
  RtnMsg?: string;
  InvoiceHtml?: string;
};

type InvoiceTarget = "order" | "vendor_subscription";

type VendorSubscriptionInvoiceRow = {
  id?: string | null;
  vendor_id?: string | null;
  subscription_order_id?: string | null;
  provider?: string | null;
  status?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  issued_at?: string | null;
  payment_sequence?: number | string | null;
  response_payload?: Record<string, unknown> | null;
};

type PrintableInvoice = {
  target: InvoiceTarget;
  sourceTable: "order_invoices" | "vendor_subscription_invoices";
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string;
  orderId?: string;
  subscriptionOrderId?: string;
  vendorId?: string;
  paymentSequence?: number | string | null;
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function intValue(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveInvoiceBaseUrl(): string {
  const source = [
    process.env["ECPAY_INVOICE_ISSUE_URL"],
    process.env["ECPAY_INVOICE_INVALID_URL"],
    process.env["ENVIRONMENT"],
  ]
    .map((item) => String(item ?? "").toLowerCase())
    .join(" ");

  return source.includes("stage") || source.includes("staging")
    ? "https://einvoice-stage.ecpay.com.tw"
    : "https://einvoice.ecpay.com.tw";
}

function getEcpayInvoicePrintConfig(): EcpayInvoicePrintConfig {
  const merchantId = text(process.env["ECPAY_INVOICE_MERCHANT_ID"]);
  const hashKey = text(process.env["ECPAY_INVOICE_HASH_KEY"]);
  const hashIv = text(process.env["ECPAY_INVOICE_HASH_IV"]);
  const printUrl =
    text(process.env["ECPAY_INVOICE_PRINT_URL"]) ||
    `${resolveInvoiceBaseUrl()}/B2CInvoice/InvoicePrint`;
  const platformId = text(process.env["ECPAY_INVOICE_PLATFORM_ID"]);

  if (!merchantId) throw new Error("Missing ECPAY_INVOICE_MERCHANT_ID");
  if (!hashKey) throw new Error("Missing ECPAY_INVOICE_HASH_KEY");
  if (!hashIv) throw new Error("Missing ECPAY_INVOICE_HASH_IV");

  return { merchantId, hashKey, hashIv, printUrl, platformId };
}

function invoiceDateForEcpay(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";

  const direct = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct) || /^\d{4}\/\d{2}\/\d{2}$/.test(direct)) {
    return direct;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function resolveInvoiceTarget(body: Record<string, unknown>): InvoiceTarget {
  const raw = text(body.invoiceTarget ?? body.invoice_target ?? body.target ?? body.type)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!raw) {
    return hasVendorInvoiceIdentifier(body) ? "vendor_subscription" : "order";
  }

  if (["order", "buyer", "customer", "order_invoice", "buyer_order"].includes(raw)) {
    return "order";
  }

  if (
    [
      "vendor",
      "vendor_subscription",
      "vendor_subscription_invoice",
      "subscription",
      "subscription_invoice",
    ].includes(raw)
  ) {
    return "vendor_subscription";
  }

  throw new Error("invoiceTarget must be order or vendor_subscription");
}

function hasVendorInvoiceIdentifier(body: Record<string, unknown>): boolean {
  return Boolean(
    text(body.vendorInvoiceId ?? body.vendor_invoice_id) ||
    text(body.subscriptionOrderId ?? body.subscription_order_id) ||
    text(body.vendorSubscriptionOrderId ?? body.vendor_subscription_order_id),
  );
}

async function requestInvoicePrintUrl(
  config: EcpayInvoicePrintConfig,
  data: Record<string, unknown>,
): Promise<EcpayInvoicePrintResponseData> {
  const payload = { ...data, MerchantID: config.merchantId };
  const envelope: Record<string, unknown> = {
    MerchantID: config.merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: await encryptInvoiceData(payload, config.hashKey, config.hashIv),
  };
  if (config.platformId) envelope.PlatformID = config.platformId;

  const response = await fetch(config.printUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const rawResponse = await response.text();
  if (!response.ok) {
    throw new Error(rawResponse || `ECPay invoice print failed (${response.status})`);
  }

  const responseEnvelope = JSON.parse(rawResponse) as Record<string, unknown>;
  const transCode = text(responseEnvelope.TransCode);
  const transMsg = text(responseEnvelope.TransMsg);
  if (transCode && transCode !== "1") {
    throw new Error(transMsg || `ECPay invoice print TransCode=${transCode}`);
  }

  const encryptedData = text(responseEnvelope.Data);
  if (!encryptedData) {
    throw new Error("ECPay invoice print response missing Data");
  }

  return (await decryptInvoiceData(
    encryptedData,
    config.hashKey,
    config.hashIv,
  )) as EcpayInvoicePrintResponseData;
}

async function fetchOrderForUserByReference(
  admin: AdminClient,
  orderRef: string,
  userId: string,
): Promise<OrderRow> {
  const order = await selectOne<OrderRow>(admin, "orders", {
    select:
      "id,user_id,order_number,payment_provider,payment_method,total_amount,payment_status,provider_order_id,provider_transaction_id",
    user_id: `eq.${userId}`,
    or: `(id.eq.${orderRef},order_number.eq.${orderRef},provider_order_id.eq.${orderRef})`,
  });

  if (!order?.id) {
    throw new Error("Order not found");
  }
  return order;
}

async function getBuyerOrderInvoice(
  admin: AdminClient,
  body: Record<string, unknown>,
  userId: string,
): Promise<PrintableInvoice> {
  const orderInvoiceId = text(
    body.orderInvoiceId ?? body.order_invoice_id ?? body.invoiceId ?? body.invoice_id,
  );
  const orderRef = text(
    body.orderId ??
      body.order_id ??
      body.orderNumber ??
      body.order_number ??
      body.providerOrderId ??
      body.provider_order_id,
  );

  let invoice: OrderInvoiceRow | null = null;
  let order: OrderRow | null = null;

  if (orderInvoiceId) {
    invoice = await selectOne<OrderInvoiceRow>(admin, "order_invoices", {
      select:
        "id,order_id,invoice_provider,invoice_status,invoice_number,invoice_random_number,invoice_reference_no,invoice_issued_at,invoice_payload",
      id: `eq.${orderInvoiceId}`,
    });
    if (!invoice?.order_id) throw new Error("Invoice not found");
    order = await fetchOrderForUserByReference(admin, invoice.order_id, userId);
  } else {
    if (!orderRef) throw new Error("orderId is required");
    order = await fetchOrderForUserByReference(admin, orderRef, userId);
    invoice = await selectOne<OrderInvoiceRow>(admin, "order_invoices", {
      select:
        "id,order_id,invoice_provider,invoice_status,invoice_number,invoice_random_number,invoice_reference_no,invoice_issued_at,invoice_payload",
      order_id: `eq.${order.id}`,
      order: "created_at.desc",
    });
  }

  if (!invoice) throw new Error("Invoice not found");
  if (text(invoice.invoice_provider).toLowerCase() !== "ecpay") {
    throw new Error("Only ECPay invoices can be opened through ECPay");
  }
  if (text(invoice.invoice_status).toLowerCase() !== "issued") {
    throw new Error("Only issued invoices can be opened through ECPay");
  }

  const invoiceNo = text(invoice.invoice_number);
  const invoiceDate = invoiceDateForEcpay(invoice.invoice_issued_at);
  if (!invoiceNo) throw new Error("invoice_number is required");
  if (!invoiceDate) throw new Error("invoice_issued_at is required");

  return {
    target: "order",
    sourceTable: "order_invoices",
    invoiceId: text(invoice.id),
    orderId: order.id,
    invoiceNo,
    invoiceDate,
  };
}

async function getVendorSubscriptionInvoice(
  admin: AdminClient,
  body: Record<string, unknown>,
  userId: string,
): Promise<PrintableInvoice> {
  const vendorInvoiceId = text(
    body.vendorInvoiceId ?? body.vendor_invoice_id ?? body.invoiceId ?? body.invoice_id,
  );
  const subscriptionOrderId = text(
    body.subscriptionOrderId ??
      body.subscription_order_id ??
      body.vendorSubscriptionOrderId ??
      body.vendor_subscription_order_id ??
      body.orderId ??
      body.order_id,
  );
  const requestedVendorId = text(body.vendorId ?? body.vendor_id);
  const paymentSequence = text(body.paymentSequence ?? body.payment_sequence);

  let invoice: VendorSubscriptionInvoiceRow | null = null;

  if (vendorInvoiceId) {
    invoice = await selectOne<VendorSubscriptionInvoiceRow>(admin, "vendor_subscription_invoices", {
      select:
        "id,vendor_id,subscription_order_id,provider,status,invoice_no,invoice_date,issued_at,payment_sequence,response_payload",
      id: `eq.${vendorInvoiceId}`,
    });
  } else {
    if (!subscriptionOrderId) {
      throw new Error("subscriptionOrderId is required for vendor_subscription invoice print");
    }

    const params: Record<string, string | number | boolean> = {
      select:
        "id,vendor_id,subscription_order_id,provider,status,invoice_no,invoice_date,issued_at,payment_sequence,response_payload",
      subscription_order_id: `eq.${subscriptionOrderId}`,
      order: "created_at.desc",
    };
    if (requestedVendorId) params.vendor_id = `eq.${requestedVendorId}`;
    if (paymentSequence) params.payment_sequence = `eq.${paymentSequence}`;

    const rows = await selectRows<VendorSubscriptionInvoiceRow>(
      admin,
      "vendor_subscription_invoices",
      {
        ...params,
        limit: 1,
      },
    );
    invoice = rows[0] ?? null;
  }

  if (!invoice) throw new Error("Vendor subscription invoice not found");

  const invoiceVendorId = text(invoice.vendor_id);
  const vendorId = requestedVendorId || invoiceVendorId;
  if (!vendorId) throw new Error("vendorId is required");
  if (invoiceVendorId && invoiceVendorId !== vendorId) {
    throw new Error("Vendor invoice does not belong to this vendor");
  }
  await assertVendorAccess(admin, vendorId, userId);

  if (text(invoice.provider).toLowerCase() !== "ecpay") {
    throw new Error("Only ECPay invoices can be opened through ECPay");
  }
  if (text(invoice.status).toLowerCase() !== "issued") {
    throw new Error("Only issued invoices can be opened through ECPay");
  }

  const invoiceNo = text(invoice.invoice_no);
  const invoiceDate = invoiceDateForEcpay(invoice.invoice_date ?? invoice.issued_at);
  if (!invoiceNo) throw new Error("invoice_no is required");
  if (!invoiceDate) throw new Error("invoice_date is required");

  return {
    target: "vendor_subscription",
    sourceTable: "vendor_subscription_invoices",
    invoiceId: text(invoice.id),
    vendorId,
    subscriptionOrderId: text(invoice.subscription_order_id) || subscriptionOrderId,
    paymentSequence: invoice.payment_sequence ?? null,
    invoiceNo,
    invoiceDate,
  };
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const { admin, userId } = await requireUserAndCreateDatabaseClient(req);
    const body = (await req.json()) as Record<string, unknown>;
    const target = resolveInvoiceTarget(body);
    const invoice =
      target === "vendor_subscription"
        ? await getVendorSubscriptionInvoice(admin, body, userId)
        : await getBuyerOrderInvoice(admin, body, userId);

    const config = getEcpayInvoicePrintConfig();
    const ecpayLanguage = normalizeEcpayLanguage(body.language ?? body.Language);
    const printData: Record<string, unknown> = {
      InvoiceNo: invoice.invoiceNo,
      InvoiceDate: invoice.invoiceDate,
      PrintStyle: intValue(body.printStyle ?? body.print_style, 1),
      IsShowingDetail: intValue(body.isShowingDetail ?? body.is_showing_detail, 1),
    };
    if (ecpayLanguage) {
      printData.Language = ecpayLanguage;
    }
    const isReprint = text(body.isReprintInvoice ?? body.is_reprint_invoice).toUpperCase();
    if (isReprint === "Y" || body.isReprintInvoice === true || body.is_reprint_invoice === true) {
      printData.IsReprintInvoice = "Y";
    }

    const result = await requestInvoicePrintUrl(config, printData);
    const rtnCode = text(result.RtnCode);
    const rtnMsg = text(result.RtnMsg);
    if (rtnCode !== "1") {
      throw new Error(rtnMsg || `ECPay invoice print RtnCode=${rtnCode || "<empty>"}`);
    }

    const invoiceHtml = text(result.InvoiceHtml);
    if (!invoiceHtml) {
      throw new Error("ECPay invoice print response missing InvoiceHtml");
    }

    return json({
      ok: true,
      provider: "ecpay",
      invoiceTarget: invoice.target,
      invoiceSourceTable: invoice.sourceTable,
      invoiceId: invoice.invoiceId,
      orderId: invoice.orderId,
      subscriptionOrderId: invoice.subscriptionOrderId,
      vendorId: invoice.vendorId,
      paymentSequence: invoice.paymentSequence,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      invoiceHtml,
      url: invoiceHtml,
      expiresInSeconds: 3600,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
