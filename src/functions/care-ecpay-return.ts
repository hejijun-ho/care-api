// 綠界回調（家屬／看護訂閱）：驗章 → 冪等 → 記一筆 care_ecpay_payments → 成功就把
// 訂閱寫回 user_settings（啟用／續期＋記卡片）。首刷與每期定期定額扣款都走這裡。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import { createDatabaseClient } from "../_shared_care/db.ts";
import {
  applySubscriptionPayment,
  findOrderByMerchantTradeNo,
  paymentExists,
  recordPayment,
  updateOrder,
} from "../_shared_care/subscription.ts";
import {
  getEcpayPaymentCallbackConfig,
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
  const processDate = String(payload.ProcessDate ?? payload.PaymentDate ?? "").trim();
  const rtnCode = String(payload.RtnCode ?? "").trim();
  return [
    "ecpay",
    merchantTradeNo,
    tradeNo || gwsr || sequence || processDate || rtnCode || "callback",
  ].join(":");
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  let payload: Record<string, string> = {};

  try {
    const config = getEcpayPaymentCallbackConfig();
    const admin = createDatabaseClient(config);
    payload = await parseFormOrJsonRequest(req);

    const merchantTradeNo = String(payload.MerchantTradeNo ?? "").trim();
    const callbackKey = buildCallbackKey(payload);
    const isSimulated = String(payload.SimulatePaid ?? "") === "1";

    if (!(await isValidCheckMacValue(payload, config.hashKey, config.hashIv))) {
      return text("CheckMacValue invalid", 400);
    }
    if (String(payload.MerchantID ?? "").trim() !== config.merchantId) {
      return text("MerchantID mismatch", 400);
    }
    if (!merchantTradeNo) {
      return text("MerchantTradeNo required", 400);
    }

    const order = await findOrderByMerchantTradeNo(admin, merchantTradeNo);
    if (!order) return text("Order not found", 404);

    // 冪等：同一筆回調（同 callbackKey）只處理一次。
    if (await paymentExists(admin, callbackKey)) {
      return text("1|OK");
    }

    const rtnCode = toNullableInt(payload.RtnCode);
    const isSuccess = rtnCode === 1;
    const amount =
      toNullableInt(payload.Amount ?? payload.TradeAmt ?? payload.PeriodAmount) ??
      Number(order.amount ?? 0);
    const paymentSequence =
      toNullableInt(payload.TotalSuccessTimes) ?? (order.payment_status === "paid" ? null : 1);
    const paidAt = parseEcpayDate(payload.PaymentDate ?? payload.ProcessDate);
    const processedAt = parseEcpayDate(payload.ProcessDate);
    const providerTradeNo = String(payload.TradeNo ?? "").trim() || null;
    const providerGwsr = String(payload.Gwsr ?? payload.gwsr ?? "").trim() || null;
    const providerAuthCode = String(payload.AuthCode ?? payload.auth_code ?? "").trim() || null;
    const providerRtnMessage = String(payload.RtnMsg ?? "").trim() || null;
    const cardLast4 = String(payload.Card4No ?? "").trim() || null;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Callback amount is invalid");
    }

    await recordPayment(admin, {
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

    if (isSuccess && !isSimulated) {
      await applySubscriptionPayment(admin, {
        order,
        paidAt,
        providerTradeNo,
        cardLast4,
        cardBrand: null,
      });
    } else {
      await updateOrder(admin, order.id, {
        payment_status: isSimulated ? order.payment_status ?? "pending" : "failed",
        provider_trade_no: providerTradeNo ?? order.provider_trade_no ?? null,
        provider_status_code: rtnCode ?? null,
        provider_status_message: providerRtnMessage,
        failed_at: isSuccess ? null : new Date().toISOString(),
        last_callback_payload: payload,
      });
    }

    return text("1|OK");
  } catch (error) {
    console.error("[care-ecpay-return]", error);
    try {
      const config = getEcpayPaymentCallbackConfig();
      const admin = createDatabaseClient(config);
      if (payload.MerchantTradeNo) {
        const order = await findOrderByMerchantTradeNo(admin, payload.MerchantTradeNo);
        if (order) {
          await updateOrder(admin, order.id, {
            provider_status_message: error instanceof Error ? error.message : String(error),
            last_callback_payload: payload,
          });
        }
      }
    } catch (_) {
      // don't mask the original error
    }
    return text(error instanceof Error ? error.message : String(error), 400);
  }
};

export default handleRequest;
