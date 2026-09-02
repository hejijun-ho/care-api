import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { findOrderByMerchantTradeNo, updateOrder } from "../_shared_haiglobals/orders.ts";
import {
  notifyVendorsOrderCreated,
  notifyVendorsOrderStatusChanged,
} from "../_shared_haiglobals/push_notifications.ts";
import { getEcpayInvoiceConfig, issueEcpayInvoiceForOrder } from "../_shared/ecpay_invoice.ts";
import {
  generateCheckMacValue,
  parseEcpayDate,
  parseFormOrJsonRequest,
} from "../_shared/ecpay_payment.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";
type EcpayCallbackPayload = {
  MerchantID?: string;
  MerchantTradeNo?: string;
  RtnCode?: string | number;
  RtnMsg?: string;
  TradeNo?: string;
  TradeAmt?: string | number;
  PaymentDate?: string;
  PaymentType?: string;
  PaymentTypeChargeFee?: string | number;
  TradeDate?: string;
  SimulatePaid?: string | number;
  CheckMacValue?: string;
  BankCode?: string;
  ATMAccBank?: string;
  vAccount?: string;
  VAccount?: string;
  PaymentNo?: string;
  PaymentURL?: string;
  BarcodeURL?: string;
  Barcode1?: string;
  Barcode2?: string;
  Barcode3?: string;
  ExpireDate?: string;
  PaymentInfoExpireDate?: string;
  ExpireTime?: string;
  CustomField1?: string;
  CustomField2?: string;
  CustomField3?: string;
  CustomField4?: string;
  [key: string]: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function getHashSecrets() {
  return {
    hashKey: requireEnv("ECPAY_HASH_KEY"),
    hashIv: requireEnv("ECPAY_HASH_IV"),
  };
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function computeCheckMacValue(params: Record<string, unknown>): Promise<string> {
  const { hashKey, hashIv } = getHashSecrets();
  return await generateCheckMacValue(params, hashKey, hashIv);
}

function normalizeToRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseEcpayDeadline(payload: EcpayCallbackPayload): string | null {
  const exact = parseEcpayDate(payload.PaymentInfoExpireDate ?? payload.ExpireTime);
  if (exact) return exact;

  const dateOnly = String(payload.ExpireDate ?? "").trim();
  const match = dateOnly.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m}-${d}T23:59:59+08:00`;
}

function isPaymentSuccess(payload: EcpayCallbackPayload): boolean {
  return String(payload.RtnCode ?? "") === "1";
}

function isSimulated(payload: EcpayCallbackPayload): boolean {
  return String(payload.SimulatePaid ?? "0") === "1";
}

function isPaymentInfoCallback(payload: EcpayCallbackPayload): boolean {
  return Boolean(
    firstText([
      payload.BankCode,
      payload.ATMAccBank,
      payload.vAccount,
      payload.VAccount,
      payload.PaymentNo,
      payload.PaymentURL,
      payload.BarcodeURL,
      payload.Barcode1,
      payload.Barcode2,
      payload.Barcode3,
      payload.ExpireDate,
      payload.PaymentInfoExpireDate,
      payload.ExpireTime,
    ]),
  );
}

function isExpiredCallback(payload: EcpayCallbackPayload): boolean {
  const message = String(payload.RtnMsg ?? "")
    .trim()
    .toLowerCase();
  return message.includes("expired") || message.includes("逾期") || message.includes("過期");
}

function isCancelledCallback(payload: EcpayCallbackPayload): boolean {
  const message = String(payload.RtnMsg ?? "")
    .trim()
    .toLowerCase();
  return message.includes("cancel") || message.includes("取消");
}

function normalizePaymentMethod(raw: unknown): string | null {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text.includes("applepay") || text.includes("apple_pay")) return "apple_pay";
  if (text.includes("credit")) return "credit_card";
  if (text.includes("barcode")) return "cvs_barcode";
  if (text.includes("cvs")) return "cvs_code";
  if (text.includes("webatm") || text.includes("atm")) return "atm";
  if (text.includes("cod")) return "cod";
  return null;
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

async function updateOrderFromCallback(payload: EcpayCallbackPayload) {
  const admin = createDatabaseClient();
  const merchantTradeNo = String(payload.MerchantTradeNo ?? "").trim();
  if (!merchantTradeNo) {
    throw new Error("Missing MerchantTradeNo");
  }

  const existing = await findOrderByMerchantTradeNo(admin, merchantTradeNo);
  const success = isPaymentSuccess(payload);
  const simulated = isSimulated(payload);
  const paidAtIso = parseEcpayDate(payload.PaymentDate);

  const updatePayload: Record<string, unknown> = {
    provider_order_id: merchantTradeNo,
    provider_transaction_id: String(payload.TradeNo ?? "") || null,
    provider_status_code: toInt(payload.RtnCode),
    provider_status_message: String(payload.RtnMsg ?? "") || null,
    payment_method: normalizePaymentMethod(payload.PaymentType) ?? existing.payment_method ?? null,
    bank_code: String(payload.BankCode ?? payload.ATMAccBank ?? "") || null,
    virtual_account: String(payload.vAccount ?? payload.VAccount ?? "") || null,
    payment_reference_no:
      firstText([
        payload.PaymentNo,
        [payload.Barcode1, payload.Barcode2, payload.Barcode3].filter(Boolean).join("|"),
      ]) || null,
    payment_url: String(payload.PaymentURL ?? payload.BarcodeURL ?? "") || null,
    payment_deadline: parseEcpayDeadline(payload),
    payment_callback_payload: payload,
    last_payment_callback_at: new Date().toISOString(),
    payment_provider: "ecpay",
  };

  if (success && !simulated) {
    updatePayload.payment_status = "paid";
    if (paidAtIso) updatePayload.paid_at = paidAtIso;
  } else if (simulated) {
    updatePayload.provider_status_message = `[SIMULATED] ${String(payload.RtnMsg ?? "")}`.trim();
  } else if (isPaymentInfoCallback(payload)) {
    updatePayload.payment_status = "pending";
  } else if (isExpiredCallback(payload)) {
    updatePayload.payment_status = "expired";
  } else if (isCancelledCallback(payload)) {
    updatePayload.payment_status = "cancelled";
    updatePayload.cancelled_at = new Date().toISOString();
  } else {
    updatePayload.payment_status = "failed";
  }

  await updateOrder(admin, existing.id, updatePayload);

  // 推播給廠商：只在 payment_status 真的改變時送，避免綠界重送 callback 造成重複通知。
  const previousPaymentStatus = String(existing.payment_status ?? "")
    .trim()
    .toLowerCase();
  const nextPaymentStatus = String(updatePayload.payment_status ?? "")
    .trim()
    .toLowerCase();

  if (nextPaymentStatus && nextPaymentStatus !== previousPaymentStatus) {
    if (nextPaymentStatus === "paid") {
      await notifyVendorsOrderCreated(admin, existing.id);
    } else {
      await notifyVendorsOrderStatusChanged(admin, {
        orderId: existing.id,
        status: nextPaymentStatus,
        statusType: "payment",
      });
    }
  }

  let invoice: Record<string, unknown> | null = null;
  if (success && !simulated) {
    try {
      invoice = (await issueEcpayInvoiceForOrder(
        admin,
        getEcpayInvoiceConfig(),
        existing.id,
      )) as Record<string, unknown>;
    } catch (error) {
      console.error("[haiglobals-ecpay-return][auto-invoice]", {
        orderId: existing.id,
        merchantTradeNo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    orderId: existing.id,
    merchantTradeNo,
    success,
    simulated,
    invoice,
  };
}

const handleRequest = async (req: Request) => {
  console.log("Received ECPay callback", {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
  });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const rawBody = await req.clone().text();

  const environment = (optionalEnv("ENVIRONMENT") || "production").toLowerCase();
  try {
    const record = await parseFormOrJsonRequest(req);
    const payload = normalizeToRecord(record) as EcpayCallbackPayload;

    const incomingCheckMacValue = String(payload.CheckMacValue ?? "").trim();
    if (incomingCheckMacValue) {
      const expected = await computeCheckMacValue(payload as Record<string, unknown>);
      if (expected !== incomingCheckMacValue.toUpperCase()) {
        console.error("ECPay CheckMacValue mismatch", {
          merchantTradeNo: payload.MerchantTradeNo,
          incoming: incomingCheckMacValue,
          expected,
          callbackKeys: Object.keys(payload).sort(),
          emptyKeys: Object.entries(payload)
            .filter(([, value]) => value === "")
            .map(([key]) => key)
            .sort(),
          rawBody,
        });
        return new Response("CheckMacValue Error", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    } else if (environment === "production") {
      return new Response("ECPay callback without CheckMacValue", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const result = await updateOrderFromCallback(payload);
    console.log("ECPay callback processed", result);

    return new Response("1|OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("ecpay-return error", error, { rawBody });
    return new Response("error", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};

export default handleRequest;
