// supabase/functions/haiglobals-vendor-subscription-checkout.ts
import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { createVendorSubscriptionCheckout } from "../_shared_haiglobals/vendor_subscription_checkout.ts";
import {
  assertVendorAccess,
  fetchActiveVendorSubscriptionPlan,
  getCurrentVendorSubscriptionId,
  requireUserId,
  type AdminClient,
  vendorSubscriptionTradeNoExists,
} from "../_shared_haiglobals/vendor_subscriptions.ts";
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
// VSE = Vendor Subscription Ecpay. 3 + 12 + 4 = 19 chars, within ECPay limit.
const MERCHANT_TRADE_NO_PREFIX = "VSE";
const MERCHANT_TRADE_NO_MAX_ATTEMPTS = 12;

function buildMerchantTradeNoCandidate(now = Date.now()): string {
  const timestamp = now.toString().slice(-12).padStart(12, "0");
  return `${MERCHANT_TRADE_NO_PREFIX}${timestamp}${randomDigits(4)}`;
}

async function buildMerchantTradeNo(admin: AdminClient): Promise<string> {
  for (let attempt = 0; attempt < MERCHANT_TRADE_NO_MAX_ATTEMPTS; attempt += 1) {
    const candidate = buildMerchantTradeNoCandidate(Date.now() + attempt);
    const exists = await vendorSubscriptionTradeNoExists(admin, candidate);
    if (!exists) return candidate;
  }
  throw new Error("Unable to allocate a unique vendor subscription MerchantTradeNo");
}

function toPositiveInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveClientBackUrl(body: Record<string, unknown>, appBaseUrl: string): string {
  const raw = String(body.clientBackUrl ?? body.clientBackURL ?? body.client_back_url ?? "").trim();

  const fallback = `${trimTrailingSlash(appBaseUrl)}/#/vendor/subscription`;
  if (!raw) return fallback;

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("clientBackUrl must be http(s)");
  }
  return url.toString();
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

  try {
    const config: EcpayPaymentConfig = getEcpayPaymentConfig();
    const userId = await requireUserId(req, config);
    const body = (await req.json()) as Record<string, unknown>;

    const ecpayLanguage = normalizeEcpayLanguage(body.language ?? body.Language);
    const vendorId = String(body.vendorId ?? body.vendor_id ?? "").trim();
    const planCode = String(body.planCode ?? body.plan_code ?? "").trim();

    if (!vendorId) throw new Error("vendorId is required");
    if (!planCode) throw new Error("planCode is required");

    const admin = createDatabaseClient(config);
    await assertVendorAccess(admin, vendorId, userId);

    const plan = await fetchActiveVendorSubscriptionPlan(admin, planCode);

    const currentSubscriptionId = await getCurrentVendorSubscriptionId(admin, vendorId, plan.code);
    if (currentSubscriptionId) {
      throw new Error(
        "This vendor already has an active subscription with overlapping features. Please wait until it expires before starting another checkout.",
      );
    }

    const merchantTradeNo = await buildMerchantTradeNo(admin);
    const { subscription, order } = await createVendorSubscriptionCheckout(admin, {
      vendorId,
      userId,
      plan,
      merchantTradeNo,
    });

    const checkoutPayload =
      order.checkout_payload && typeof order.checkout_payload === "object"
        ? (order.checkout_payload as Record<string, unknown>)
        : {};
    const amount = toPositiveInt(order.amount);
    if (amount <= 0) throw new Error("Plan amount must be positive");
    const periodAmount = toPositiveInt(order.period_amount ?? order.amount, amount);
    const sourceCurrency =
      String(checkoutPayload.source_currency ?? plan.currency ?? "TWD")
        .trim()
        .toUpperCase() || "TWD";
    const sourceAmount = Number(checkoutPayload.source_amount ?? plan.amount ?? amount);
    const exchangeRateFromTwd = Number(
      checkoutPayload.exchange_rate_from_twd ?? (sourceCurrency === "TWD" ? 1 : 0),
    );
    const exchangeRateCreatedAt =
      String(checkoutPayload.exchange_rate_created_at ?? "").trim() || null;

    const execTimes = toPositiveInt(order.exec_times, 0);
    if (execTimes < 2) {
      throw new Error("ECPay recurring ExecTimes must be >= 2");
    }

    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const returnUrl = `${callbackBaseUrl}/haiglobals-ecpay-vendor-subscription-return`;
    const itemName = sanitizeEcpayItemName(
      `${plan.name || "Vendor Subscription"} Subscription`,
      200,
    );

    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      PaymentType: "aio",
      TotalAmount: String(amount),
      TradeDesc: "Osmile Vendor Subscription",
      ItemName: itemName || "Vendor Subscription",
      ReturnURL: returnUrl,
      ChoosePayment: "Credit",
      ClientBackURL: resolveClientBackUrl(body, config.appBaseUrl),
      NeedExtraPaidInfo: "Y",
      EncryptType: "1",
      CustomField1: order.id,
      CustomField2: subscription.id,
      CustomField3: vendorId.slice(0, 50),
      CustomField4: "new",
    };

    if (ecpayLanguage) {
      fields.Language = ecpayLanguage;
    }

    fields.PeriodAmount = String(periodAmount);
    fields.PeriodType = plan.period_type;
    fields.Frequency = String(toPositiveInt(plan.frequency, 1));
    fields.ExecTimes = String(execTimes);
    fields.PeriodReturnURL = returnUrl;

    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    return new Response(
      JSON.stringify({
        provider: "ecpay",
        actionType: "new",
        vendorId,
        planCode: plan.code,
        subscriptionId: subscription.id,
        subscriptionOrderId: order.id,
        merchantTradeNo,
        amount,
        currency: "TWD",
        sourceCurrency,
        sourceAmount,
        exchangeRateFromTwd,
        exchangeRateCreatedAt,
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
    console.error("[haiglobals-vendor-subscription-checkout]", error);
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
