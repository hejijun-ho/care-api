// 家屬／看護訂閱 → 綠界定期定額（信用卡定期扣款）。第一次授權即成為 card-on-file，
// 之後每期由綠界自動扣款並回調 care-ecpay-return。對映既有 user_settings 訂閱狀態。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import { createDatabaseClient, requireUserId } from "../_shared_care/db.ts";
import { loadCarePricing } from "../_shared_care/pricing.ts";
import {
  buildMerchantTradeNo,
  createSubscriptionOrder,
  nextPeriodAlreadySet,
  normalizeRole,
  resolveCarePlan,
} from "../_shared_care/subscription.ts";
import {
  buildTaipeiDate,
  generateCheckMacValue,
  getEcpayPaymentConfig,
  resolveCallbackBaseUrl,
  sanitizeEcpayItemName,
  trimTrailingSlash,
  type EcpayPaymentConfig,
} from "../_shared/ecpay_payment.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function resolveClientBackUrl(body: Record<string, unknown>, appBaseUrl: string): string {
  const raw = String(body.clientBackUrl ?? body.clientBackURL ?? body.client_back_url ?? "").trim();
  const fallback = `${trimTrailingSlash(appBaseUrl)}/#/subscription`;
  if (!raw) return fallback;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("clientBackUrl must be http(s)");
  }
  return url.toString();
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const config: EcpayPaymentConfig = getEcpayPaymentConfig();
    const userId = await requireUserId(req, config);
    const body = (await req.json()) as Record<string, unknown>;

    const role = normalizeRole(body.role);
    const admin = createDatabaseClient(config);
    // 只能決定下一期：已經排了優惠碼（或已經預付）就不能再訂閱（同 haiglobals modules/54）
    if (await nextPeriodAlreadySet(admin, userId, role)) {
      return json({ error: "next_period_already_set" }, 400);
    }
    // 價格讀 care_service_config（App 顯示讀同一份）；只影響新訂閱，既有定期定額照原金額扣款。
    const plan = resolveCarePlan(String(body.planCode ?? body.plan_code ?? ""), await loadCarePricing(admin));
    const merchantTradeNo = await buildMerchantTradeNo(admin);
    const order = await createSubscriptionOrder(admin, { userId, role, plan, merchantTradeNo });

    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const returnUrl = `${callbackBaseUrl}/care-ecpay-return`;
    const roleLabel = role === "caregiver" ? "看護端" : "家屬端";
    const itemName =
      sanitizeEcpayItemName(`${plan.name}（${roleLabel}）`, 200) || "Care Subscription";

    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      PaymentType: "aio",
      TotalAmount: String(plan.amount),
      TradeDesc: "Osmile Care Subscription",
      ItemName: itemName,
      ReturnURL: returnUrl,
      ChoosePayment: "Credit",
      ClientBackURL: resolveClientBackUrl(body, config.appBaseUrl),
      NeedExtraPaidInfo: "Y",
      EncryptType: "1",
      CustomField1: order.id,
      CustomField2: role,
      CustomField3: plan.code,
      // 定期定額（信用卡）：每期自動扣款
      PeriodAmount: String(plan.amount),
      PeriodType: plan.periodType,
      Frequency: String(plan.frequency),
      ExecTimes: String(plan.execTimes),
      PeriodReturnURL: returnUrl,
    };

    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    return json({
      provider: "ecpay",
      role,
      planCode: plan.code,
      amount: plan.amount,
      currency: "TWD",
      merchantTradeNo,
      orderId: order.id,
      action: config.checkoutUrl,
      fields,
    });
  } catch (error) {
    console.error("[care-ecpay-subscription-checkout]", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
