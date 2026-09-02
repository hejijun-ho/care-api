import {
  patchRows,
  restRequest,
  selectOne,
  selectRows,
  type AdminClient,
} from "./vendor_subscriptions.ts";
import { fetchVendorSubscriptionById } from "./vendor_subscription_payments.ts";
import {
  selectOne as selectVendorSubscriptionOne,
  type VendorSubscriptionPlanRow,
} from "./vendor_subscriptions.ts";
import {
  getEcpayInvoiceConfig,
  issueEcpayB2CInvoice,
  type EcpayInvoiceItem,
  type EcpayIssueInvoiceData,
} from "../_shared/ecpay_invoice.ts";
import { parseEcpayDate, sanitizeEcpayItemName } from "../_shared/ecpay_common.ts";

type VendorOwnerRow = {
  id: string;
  user_id?: string | null;
  contact_email?: string | null;
  company_name?: string | null;
  business_registration_no?: string | null;
  contact_name?: string | null;
  contact_address?: string | null;
};

type InvoiceCustomer = {
  email: string;
  name: string;
  identifier: string;
  addr: string;
};

type UserEmailRow = {
  id: string;
  email?: string | null;
};

type VendorSubscriptionPaymentRow = {
  id: string;
  subscription_order_id: string;
  vendor_id: string;
  payment_sequence?: number | string | null;
  amount: number | string;
  currency?: string | null;
  status?: string | null;
  provider_trade_no?: string | null;
  provider_callback_key?: string | null;
  paid_at?: string | null;
  processed_at?: string | null;
};

export type VendorSubscriptionOrderForInvoice = {
  id: string;
  vendor_id: string;
  subscription_id?: string | null;
  order_number: string;
  amount: number | string;
  currency?: string | null;
  payment_status?: string | null;
  provider_order_id?: string | null;
  provider_trade_no?: string | null;
  period_amount?: number | string | null;
};

export type IssueVendorSubscriptionInvoiceInput = {
  subscriptionOrderId: string;
  paymentSequence?: number | null;
};

export type IssueVendorSubscriptionInvoiceResult = {
  skipped: boolean;
  invoiceId?: string;
  subscriptionOrderId: string;
  vendorId: string;
  status: "pending" | "issued" | "failed" | "skipped";
  invoiceNo?: string;
  relateNumber?: string;
  rtnCode?: number | null;
  rtnMsg?: string | null;
};

function normalizePositiveInt(value: unknown, label: string): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeString(value: unknown, maxLength = 0): string {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function normalizeSequence(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildInvoiceRelateNumber(
  order: VendorSubscriptionOrderForInvoice,
  paymentSequence: number | null,
): string {
  const base = `VSI${String(order.provider_order_id || order.order_number || order.id).replace(/[^a-zA-Z0-9]/g, "")}`;
  const seq = paymentSequence && paymentSequence > 1 ? `S${paymentSequence}` : "";
  return `${base}${seq}`.slice(0, 50);
}

async function patchById(
  admin: AdminClient,
  table: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await patchRows(
    admin,
    table,
    { id: `eq.${id}` },
    {
      ...payload,
      updated_at: new Date().toISOString(),
    },
  );
}

async function insertOne<T>(
  admin: AdminClient,
  table: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const rows = await restRequest<T[]>(admin, table, "", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  const row = rows[0];
  if (!row) throw new Error(`Failed to insert ${table}`);
  return row;
}

export async function fetchVendorSubscriptionOrderForInvoice(
  admin: AdminClient,
  subscriptionOrderId: string,
): Promise<VendorSubscriptionOrderForInvoice | null> {
  return await selectOne<VendorSubscriptionOrderForInvoice>(admin, "vendor_subscription_orders", {
    select:
      "id,vendor_id,subscription_id,order_number,amount,currency,payment_status,provider_order_id,provider_trade_no,period_amount",
    id: `eq.${subscriptionOrderId}`,
  });
}

// vendors.country_code defaults to TW; treat a missing value as TW so existing
// rows without an explicit country still issue Taiwan e-invoices.
function normalizeCountryCode(value: unknown): string {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  return code || "TW";
}

async function fetchVendorCountryCode(admin: AdminClient, vendorId: string): Promise<string> {
  const vendor = await selectOne<{ country_code?: string | null }>(admin, "vendors", {
    select: "country_code",
    id: `eq.${vendorId}`,
  });
  return normalizeCountryCode(vendor?.country_code);
}

// A 統一編號 is exactly 8 digits. A vendor's business_registration_no may hold a
// longer 商業登記號 instead, which is not a valid ECPay CustomerIdentifier, so
// only treat an 8-digit value as a tax id.
function resolveTaxId(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 8 ? digits : "";
}

// A printed invoice (Print=1) requires both CustomerName and CustomerAddr, or
// ECPay rejects it with 1200021 (name) / 1200023 (address). Derive the buyer
// name from the vendor: a company invoice uses the company name plus its 統編;
// otherwise fall back to the contact person's name. The address is always
// carried because Print=1 needs it regardless of whether it is a B2B triplet.
export function resolveInvoiceCustomer(
  vendor: VendorOwnerRow | null,
  email: string,
): InvoiceCustomer {
  const companyName = normalizeString(vendor?.company_name, 60);
  const contactName = normalizeString(vendor?.contact_name, 60);
  const addr = normalizeString(vendor?.contact_address, 100);

  if (companyName) {
    return {
      email,
      name: companyName,
      identifier: resolveTaxId(vendor?.business_registration_no),
      addr,
    };
  }

  return { email, name: contactName, identifier: "", addr };
}

async function resolveVendorInvoiceCustomer(
  admin: AdminClient,
  vendorId: string | null | undefined,
): Promise<InvoiceCustomer> {
  const normalizedVendorId = String(vendorId ?? "").trim();
  if (!normalizedVendorId) throw new Error("Order vendor_id is required to issue invoice");

  const vendor = await selectOne<VendorOwnerRow>(admin, "vendors", {
    select:
      "id,user_id,contact_email,company_name,business_registration_no,contact_name,contact_address",
    id: `eq.${normalizedVendorId}`,
  });

  const userId = normalizeString(vendor?.user_id, 80);
  const user = userId
    ? await selectOne<UserEmailRow>(admin, "users", {
        select: "id,email",
        id: `eq.${userId}`,
      })
    : null;

  const email = normalizeString(user?.email, 80) || normalizeString(vendor?.contact_email, 80);
  if (!email) {
    throw new Error(
      `Cannot issue invoice because users.email and vendors.contact_email were not found for vendor_id ${normalizedVendorId}`,
    );
  }

  const customer = resolveInvoiceCustomer(vendor, email);
  if (!customer.name) {
    throw new Error(
      `Cannot issue invoice because vendors.company_name and vendors.contact_name are both empty for vendor_id ${normalizedVendorId}`,
    );
  }
  // A printed invoice (Print=1) needs a buyer address, or ECPay rejects it with
  // 1200023.
  if (!customer.addr) {
    throw new Error(
      `Cannot issue invoice because vendors.contact_address is empty for vendor_id ${normalizedVendorId}`,
    );
  }
  return customer;
}

async function fetchPlanByCode(
  admin: AdminClient,
  planCode: string,
): Promise<VendorSubscriptionPlanRow | null> {
  return await selectVendorSubscriptionOne<VendorSubscriptionPlanRow>(
    admin,
    "vendor_subscription_plans",
    {
      select: "*",
      code: `eq.${planCode}`,
    },
  );
}

async function findPaidPayment(
  admin: AdminClient,
  orderId: string,
  paymentSequence: number | null,
): Promise<VendorSubscriptionPaymentRow | null> {
  const params: Record<string, string | number | boolean> = {
    select: "*",
    subscription_order_id: `eq.${orderId}`,
    status: "eq.paid",
    order: "payment_sequence.desc,created_at.desc",
  };
  if (paymentSequence !== null) {
    params.payment_sequence = `eq.${paymentSequence}`;
  }
  const rows = await selectRows<VendorSubscriptionPaymentRow>(
    admin,
    "vendor_subscription_payments",
    params,
  );
  return rows[0] ?? null;
}

async function findExistingInvoice(
  admin: AdminClient,
  orderId: string,
  paymentSequence: number | null,
): Promise<Record<string, unknown> | null> {
  const rows = await restRequest<Record<string, unknown>[]>(
    admin,
    "vendor_subscription_invoices",
    `subscription_order_id=eq.${encodeURIComponent(orderId)}&select=*&order=created_at.desc`,
  );
  const sequence = paymentSequence ?? 0;
  return rows.find((row) => Number(row.payment_sequence ?? 0) === sequence) ?? null;
}

export async function issueVendorSubscriptionInvoice(
  admin: AdminClient,
  input: IssueVendorSubscriptionInvoiceInput,
): Promise<IssueVendorSubscriptionInvoiceResult> {
  const order = await fetchVendorSubscriptionOrderForInvoice(admin, input.subscriptionOrderId);
  if (!order?.id) {
    throw new Error("Vendor subscription order not found");
  }
  if (String(order.payment_status ?? "").toLowerCase() !== "paid") {
    throw new Error("Only paid vendor subscription orders can issue invoices");
  }

  // ECPay e-invoices are Taiwan-only. Vendors operating outside Taiwan do not get
  // an auto-issued invoice; skip rather than throw so the paid callback still
  // succeeds.
  const vendorCountry = await fetchVendorCountryCode(admin, order.vendor_id);
  if (vendorCountry !== "TW") {
    return {
      skipped: true,
      subscriptionOrderId: order.id,
      vendorId: order.vendor_id,
      status: "skipped",
      rtnCode: null,
      rtnMsg: `Vendor country is ${vendorCountry}; ECPay e-invoice is only issued for TW vendors`,
    };
  }

  const requestedSequence = normalizeSequence(input.paymentSequence);
  const payment = await findPaidPayment(admin, order.id, requestedSequence);
  if (requestedSequence !== null && !payment) {
    throw new Error(`Paid vendor subscription payment not found for sequence ${requestedSequence}`);
  }

  const paymentSequence = normalizeSequence(payment?.payment_sequence) ?? requestedSequence;
  const existing = await findExistingInvoice(admin, order.id, paymentSequence);
  if (existing && String(existing.status ?? "").toLowerCase() === "issued") {
    return {
      skipped: true,
      invoiceId: String(existing.id ?? "") || undefined,
      subscriptionOrderId: order.id,
      vendorId: order.vendor_id,
      status: "issued",
      invoiceNo: String(existing.invoice_no ?? "") || undefined,
      relateNumber: String(existing.relate_number ?? "") || undefined,
      rtnCode: 1,
      rtnMsg: "Invoice already issued",
    };
  }
  if (existing && ["voided", "void_failed"].includes(String(existing.status ?? "").toLowerCase())) {
    throw new Error(
      "Existing vendor subscription invoice is voided and cannot be reissued with the same relate number",
    );
  }

  const invoiceConfig = getEcpayInvoiceConfig();
  const customer = await resolveVendorInvoiceCustomer(admin, order.vendor_id);
  const customerEmail = customer.email;
  const subscription = order.subscription_id
    ? await fetchVendorSubscriptionById(admin, order.subscription_id)
    : null;
  const plan = subscription?.plan_code
    ? await fetchPlanByCode(admin, subscription.plan_code)
    : null;
  const salesAmount = normalizePositiveInt(
    payment?.amount ?? order.period_amount ?? order.amount,
    "invoice salesAmount",
  );
  const itemName = sanitizeEcpayItemName(plan?.name, 500) || "廠商訂閱服務";

  const invoiceItem: EcpayInvoiceItem = {
    ItemSeq: 1,
    ItemName: itemName,
    ItemCount: 1,
    ItemWord: "式",
    ItemPrice: salesAmount,
    ItemAmount: salesAmount,
  };

  const invoiceData: EcpayIssueInvoiceData = {
    MerchantID: invoiceConfig.merchantId,
    RelateNumber: buildInvoiceRelateNumber(order, paymentSequence),
    CustomerEmail: customerEmail,
    CustomerPhone: "",
    CustomerIdentifier: customer.identifier,
    CustomerName: customer.name,
    CustomerAddr: customer.addr,
    Print: "1",
    Donation: "0",
    LoveCode: "",
    CarrierType: "",
    CarrierNum: "",
    TaxType: "1",
    SalesAmount: salesAmount,
    InvoiceRemark: "Vendor subscription invoice",
    Items: [invoiceItem],
    InvType: "07",
    vat: "1",
  };

  const basePayload = {
    vendor_id: order.vendor_id,
    subscription_order_id: order.id,
    provider: "ecpay",
    provider_order_id: order.provider_order_id,
    provider_trade_no: payment?.provider_trade_no ?? order.provider_trade_no ?? null,
    payment_sequence: paymentSequence,
    relate_number: invoiceData.RelateNumber,
    sales_amount: salesAmount,
    tax_type: invoiceData.TaxType,
    inv_type: invoiceData.InvType,
    vat: invoiceData.vat,
    status: "pending",
    customer_email: customerEmail,
    request_payload: invoiceData,
  };

  const invoiceId = existing?.id
    ? String(existing.id)
    : (await insertOne<{ id: string }>(admin, "vendor_subscription_invoices", basePayload)).id;
  if (existing?.id) {
    await patchById(admin, "vendor_subscription_invoices", invoiceId, {
      ...basePayload,
      response_payload: null,
      provider_rtn_code: null,
      provider_rtn_message: null,
      failed_at: null,
    });
  }

  try {
    const result = await issueEcpayB2CInvoice(invoiceConfig, invoiceData);
    const rtnCode = Number.parseInt(String(result.data.RtnCode ?? ""), 10);
    const rtnMsg = String(result.data.RtnMsg ?? "").trim();
    const issued = rtnCode === 1;

    await patchById(admin, "vendor_subscription_invoices", invoiceId, {
      status: issued ? "issued" : "failed",
      invoice_no: String(result.data.InvoiceNo ?? "").trim() || null,
      invoice_date: parseEcpayDate(result.data.InvoiceDate),
      random_number: String(result.data.RandomNumber ?? "").trim() || null,
      provider_rtn_code: Number.isFinite(rtnCode) ? rtnCode : null,
      provider_rtn_message: rtnMsg || null,
      response_payload: { envelope: result.envelope, data: result.data },
      issued_at: issued ? new Date().toISOString() : null,
      failed_at: issued ? null : new Date().toISOString(),
    });

    if (!issued) {
      throw new Error(`ECPay invoice issue failed: ${rtnCode || "unknown"} ${rtnMsg}`);
    }

    return {
      skipped: false,
      invoiceId,
      subscriptionOrderId: order.id,
      vendorId: order.vendor_id,
      status: "issued",
      invoiceNo: String(result.data.InvoiceNo ?? "").trim() || undefined,
      relateNumber: invoiceData.RelateNumber,
      rtnCode: Number.isFinite(rtnCode) ? rtnCode : null,
      rtnMsg: rtnMsg || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchById(admin, "vendor_subscription_invoices", invoiceId, {
      status: "failed",
      provider_rtn_message: message,
      failed_at: new Date().toISOString(),
    });
    throw error;
  }
}
