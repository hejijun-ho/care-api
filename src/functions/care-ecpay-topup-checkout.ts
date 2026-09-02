// 買家錢包儲值 → 綠界信用卡一次付清（互動結帳）。付款成功由 care-ecpay-topup-return
// 把金額加進 public.wallets.token_balance（真錢預付帳戶）。成交時就從這個餘額扣。
import { corsHeaders, handleCors } from "../_shared_care/cors.ts";
import { createDatabaseClient, requireUserId } from "../_shared_care/db.ts";
import { buildMerchantTradeNo, normalizeRole } from "../_shared_care/subscription.ts";
import {
  computeTopupCharge,
  createTopupOrder,
  normalizeTopupAmount,
} from "../_shared_care/topup.ts";
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
  const fallback = `${trimTrailingSlash(appBaseUrl)}/#/wallet`;
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
    const amount = normalizeTopupAmount(body.amount ?? body.topupAmount);

    // 手續費外加：使用者選面額，綠界實收 = 面額 + 手續費；錢包只入面額。
    const { face, fee, charge } = computeTopupCharge(amount);

    const admin = createDatabaseClient(config);
    const merchantTradeNo = await buildMerchantTradeNo(admin, "CTU");
    const order = await createTopupOrder(admin, {
      userId,
      role,
      face,
      fee,
      charge,
      merchantTradeNo,
    });

    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const returnUrl = `${callbackBaseUrl}/care-ecpay-topup-return`;
    const itemName =
      sanitizeEcpayItemName(`照護錢包儲值 NT$${face}（含金流手續費 NT$${fee}）`, 200) ||
      "Care Wallet Top-up";

    // 信用卡一次付清（無 Period* 欄位）：買家當下互動刷卡；TotalAmount = 面額 + 手續費。
    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      PaymentType: "aio",
      TotalAmount: String(charge),
      TradeDesc: "Osmile Care Wallet Topup",
      ItemName: itemName,
      ReturnURL: returnUrl,
      ChoosePayment: "Credit",
      ClientBackURL: resolveClientBackUrl(body, config.appBaseUrl),
      NeedExtraPaidInfo: "Y",
      EncryptType: "1",
      CustomField1: order.id,
      CustomField2: role,
      CustomField3: "topup",
    };

    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    return json({
      provider: "ecpay",
      role,
      amount: face, // 進錢包的面額
      fee, // 外加手續費
      charge, // 綠界實收
      currency: "TWD",
      merchantTradeNo,
      orderId: order.id,
      action: config.checkoutUrl,
      fields,
    });
  } catch (error) {
    console.error("[care-ecpay-topup-checkout]", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
