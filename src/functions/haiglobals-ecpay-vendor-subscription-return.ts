// supabase/functions/haiglobals-ecpay-vendor-subscription-return.ts
import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  applyVendorSubscriptionPayment,
  createVendorSubscriptionPayment,
  findVendorSubscriptionOrderByMerchantTradeNo,
  updateVendorSubscriptionOrder,
  vendorSubscriptionPaymentExists,
} from "../_shared_haiglobals/vendor_subscription_payments.ts";
import { issueVendorSubscriptionInvoice } from "../_shared_haiglobals/vendor_subscription_invoices.ts";
import { type AdminClient } from "../_shared_haiglobals/vendor_subscriptions.ts";
import {
  generateCheckMacValue,
  getEcpayCreditActionConfig,
  getEcpayPaymentCallbackConfig,
  getEcpayPeriodActionConfig,
  isValidCheckMacValue,
  parseEcpayDate,
  parseFormOrJsonRequest,
} from "../_shared/ecpay_payment.ts";
function toNullableInt(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCallbackKey(payload: Record<string, string>): string {
  const merchantTradeNo = String(payload.MerchantTradeNo ?? "").trim();
  const tradeNo = String(payload.TradeNo ?? "").trim();
  const gwsr = String(payload.Gwsr ?? payload.gwsr ?? "").trim();
  const sequence = String(payload.TotalSuccessTimes ?? "").trim();
  const processDate = String(
    payload.ProcessDate ?? payload.process_date ?? payload.PaymentDate ?? "",
  ).trim();
  const rtnCode = String(payload.RtnCode ?? "").trim();

  return [
    "ecpay",
    merchantTradeNo,
    tradeNo || gwsr || sequence || processDate || rtnCode || "callback",
  ].join(":");
}

function successText(): Response {
  return new Response("1|OK", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function parseGatewayResponse(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  const normalized = trimmed.replace(/<br\s*\/?>/gi, "&").replace(/&amp;/g, "&");

  return Object.fromEntries(new URLSearchParams(normalized).entries());
}

async function postSignedEcpayForm(
  url: string,
  params: Record<string, string | number>,
  hashKey: string,
  hashIv: string,
): Promise<Record<string, string>> {
  const checkMacValue = await generateCheckMacValue(params, hashKey, hashIv);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, CheckMacValue: checkMacValue })) {
    form.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const rawBody = await response.text();
  const parsed = parseGatewayResponse(rawBody);

  if (!response.ok) {
    throw new Error(rawBody || `ECPay request failed (${response.status})`);
  }

  return parsed;
}

async function cancelSupersededRecurringAuthorization(
  merchantTradeNo: string,
): Promise<Record<string, string>> {
  const config = getEcpayPeriodActionConfig();
  const params: Record<string, string | number> = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    Action: "Cancel",
    TimeStamp: Math.floor(Date.now() / 1000),
  };

  if (config.platformId) {
    params.PlatformID = config.platformId;
  }

  const parsed = await postSignedEcpayForm(config.actionUrl, params, config.hashKey, config.hashIv);
  const rtnCode = parsed.RtnCode ? Number(parsed.RtnCode) : null;
  if (rtnCode !== 1 && rtnCode !== 90100149) {
    throw new Error(
      `ECPay period cancel failed: ${parsed.RtnCode ?? "unknown"} ${parsed.RtnMsg ?? ""}`.trim(),
    );
  }

  return parsed;
}

async function refundSupersededCreditPayment(
  merchantTradeNo: string,
  providerTradeNo: string,
  amount: number,
): Promise<Record<string, string>> {
  const config = getEcpayCreditActionConfig();
  const params: Record<string, string | number> = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    TradeNo: providerTradeNo,
    Action: "R",
    TotalAmount: amount,
  };

  if (config.platformId) {
    params.PlatformID = config.platformId;
  }

  const parsed = await postSignedEcpayForm(config.actionUrl, params, config.hashKey, config.hashIv);
  const rtnCode = parsed.RtnCode ? Number(parsed.RtnCode) : null;
  if (rtnCode !== 1) {
    throw new Error(
      `ECPay credit refund failed: ${parsed.RtnCode ?? "unknown"} ${parsed.RtnMsg ?? ""}`.trim(),
    );
  }

  return parsed;
}

async function autoRefundCancelledSubscriptionOrder(
  admin: AdminClient,
  input: {
    orderId: string;
    merchantTradeNo: string;
    providerTradeNo: string;
    amount: number;
    providerRtnCode?: number | null;
    providerRtnMessage?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!input.providerTradeNo) {
    throw new Error("Missing provider trade number for superseded checkout refund");
  }

  await updateVendorSubscriptionOrder(admin, input.orderId, {
    provider_trade_no: input.providerTradeNo,
    provider_status_code: input.providerRtnCode ?? null,
    provider_status_message: "Superseded checkout payment received; auto-refund pending",
    last_callback_payload: input.payload,
  });

  const periodCancel = await cancelSupersededRecurringAuthorization(input.merchantTradeNo);
  const refund = await refundSupersededCreditPayment(
    input.merchantTradeNo,
    input.providerTradeNo,
    input.amount,
  );

  await updateVendorSubscriptionOrder(admin, input.orderId, {
    payment_status: "refunded",
    provider_trade_no: input.providerTradeNo,
    provider_status_code: input.providerRtnCode ?? null,
    provider_status_message: `Auto-refunded superseded checkout: ${refund.RtnMsg ?? "Refund success"}`,
    last_callback_payload: {
      ...input.payload,
      superseded_auto_refund: {
        periodCancel,
        refund,
      },
    },
  });
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let payload: Record<string, string> = {};
  let callbackKey = "";

  try {
    const config = getEcpayPaymentCallbackConfig();
    const admin = createDatabaseClient(config);
    payload = await parseFormOrJsonRequest(req);

    const merchantTradeNo = String(payload.MerchantTradeNo ?? "").trim();
    callbackKey = buildCallbackKey(payload);
    const isSimulated = String(payload.SimulatePaid ?? "") === "1";
    const validCheckMac = await isValidCheckMacValue(payload, config.hashKey, config.hashIv);

    if (!validCheckMac) {
      return new Response("CheckMacValue invalid", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (String(payload.MerchantID ?? "").trim() !== config.merchantId) {
      return new Response("MerchantID mismatch", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (!merchantTradeNo) {
      return new Response("MerchantTradeNo required", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const order = await findVendorSubscriptionOrderByMerchantTradeNo(admin, merchantTradeNo);
    if (!order) {
      return new Response("Order not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const duplicate = await vendorSubscriptionPaymentExists(admin, callbackKey);
    if (duplicate) {
      if (
        String(order.payment_status ?? "").toLowerCase() === "cancelled" &&
        String(order.provider_trade_no ?? "").trim()
      ) {
        await autoRefundCancelledSubscriptionOrder(admin, {
          orderId: order.id,
          merchantTradeNo,
          providerTradeNo: String(order.provider_trade_no ?? "").trim(),
          amount: Number(order.amount ?? 0),
          payload: order.last_callback_payload ?? payload,
        });
      }
      return successText();
    }

    const rtnCode = toNullableInt(payload.RtnCode);
    const amount =
      toNullableInt(payload.Amount ?? payload.TradeAmt ?? payload.PeriodAmount) ??
      Number(order.amount ?? 0);
    const paymentSequence =
      toNullableInt(payload.TotalSuccessTimes) ?? (order.payment_status === "paid" ? null : 1);
    const isSuccess = rtnCode === 1;
    const paidAt = parseEcpayDate(
      payload.PaymentDate ?? payload.ProcessDate ?? payload.process_date,
    );
    const processedAt = parseEcpayDate(payload.ProcessDate ?? payload.process_date);
    const providerTradeNo = String(payload.TradeNo ?? "").trim() || null;
    const providerGwsr = String(payload.Gwsr ?? payload.gwsr ?? "").trim() || null;
    const providerAuthCode = String(payload.AuthCode ?? payload.auth_code ?? "").trim() || null;
    const providerRtnMessage = String(payload.RtnMsg ?? "").trim() || null;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Callback amount is invalid");
    }

    await createVendorSubscriptionPayment(admin, {
      order,
      callbackKey,
      status: isSuccess && !isSimulated ? "paid" : "failed",
      amount,
      paymentSequence,
      providerTradeNo,
      providerGwsr,
      providerAuthCode,
      providerRtnCode: rtnCode,
      providerRtnMessage,
      paidAt,
      processedAt,
      rawPayload: payload,
    });

    if (
      isSuccess &&
      !isSimulated &&
      String(order.payment_status ?? "").toLowerCase() === "cancelled"
    ) {
      try {
        await autoRefundCancelledSubscriptionOrder(admin, {
          orderId: order.id,
          merchantTradeNo,
          providerTradeNo: providerTradeNo ?? "",
          amount,
          providerRtnCode: rtnCode,
          providerRtnMessage,
          payload,
        });
      } catch (error) {
        await updateVendorSubscriptionOrder(admin, order.id, {
          provider_trade_no: providerTradeNo ?? order.provider_trade_no ?? null,
          provider_status_code: rtnCode ?? null,
          provider_status_message: `Auto-refund failed for superseded checkout: ${error instanceof Error ? error.message : String(error)}`,
          last_callback_payload: payload,
        });
        throw error;
      }
      return successText();
    }

    await applyVendorSubscriptionPayment(admin, {
      order,
      providerTradeNo,
      providerRtnCode: rtnCode,
      providerRtnMessage,
      amount,
      paymentSequence,
      paidAt,
      processedAt,
      rawPayload: payload,
      isSuccess,
      isSimulated,
    });

    if (isSuccess && !isSimulated) {
      try {
        await issueVendorSubscriptionInvoice(admin, {
          subscriptionOrderId: order.id,
          paymentSequence,
        });
      } catch (error) {
        console.error("[haiglobals-ecpay-vendor-subscription-return][auto-invoice]", {
          subscriptionOrderId: order.id,
          merchantTradeNo,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return successText();
  } catch (error) {
    console.error("[haiglobals-ecpay-vendor-subscription-return]", error);

    try {
      const config = getEcpayPaymentCallbackConfig();
      const admin = createDatabaseClient(config);
      if (payload.MerchantTradeNo) {
        const order = await findVendorSubscriptionOrderByMerchantTradeNo(
          admin,
          payload.MerchantTradeNo,
        );
        if (order) {
          await updateVendorSubscriptionOrder(admin, order.id, {
            provider_status_message: error instanceof Error ? error.message : String(error),
            last_callback_payload: payload,
          });
        }
      }
    } catch (_) {
      // Avoid masking original callback error.
    }

    return new Response(error instanceof Error ? error.message : String(error), {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};

export default handleRequest;
