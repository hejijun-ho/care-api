import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import {
  buildTaipeiDate,
  generateCheckMacValue,
  getEcpayLogisticsMapConfig,
  randomDigits,
  normalizeEcpayLanguage,
  resolveCallbackBaseUrl,
} from "../_shared/ecpay_logistics.ts";

type LogisticsSubType = "UNIMARTC2C" | "FAMIC2C" | "HILIFEC2C" | "OKMARTC2C";

const supportedCvsSubTypes = new Set(["UNIMARTC2C", "FAMIC2C", "HILIFEC2C", "OKMARTC2C"]);
const ECPAY_LOGISTICS_REPLY_FUNCTION_NAME = "haiglobals-ecpay-logistics-reply";

function buildLogisticsTradeNo(): string {
  return `OSL${Date.now().toString().slice(-12)}${randomDigits(4)}`;
}

function normalizeCvsSubType(value: unknown): LogisticsSubType {
  const normalized = String(value ?? "FAMIC2C")
    .trim()
    .toUpperCase();
  if (!supportedCvsSubTypes.has(normalized)) {
    throw new Error(`Unsupported CVS logisticsSubType: ${normalized || "<empty>"}`);
  }
  return normalized as LogisticsSubType;
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function resolveClientBackUrl(body: Record<string, unknown>): string {
  const raw = String(body.clientBackUrl ?? body.clientBackURL ?? body.client_back_url ?? "").trim();
  if (!raw) {
    return "";
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

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const logisticsSubType = normalizeCvsSubType(body.logisticsSubType);
    const ecpayLanguage = normalizeEcpayLanguage(body.language ?? body.Language);
    const config = getEcpayLogisticsMapConfig(logisticsSubType);
    const callbackBaseUrl = resolveCallbackBaseUrl(req, config.supabasePublicUrl);
    const logisticsTradeNo = buildLogisticsTradeNo();
    const clientBackUrl = resolveClientBackUrl(body);
    const fields: Record<string, string> = {
      MerchantID: config.merchantId,
      MerchantTradeNo: logisticsTradeNo,
      MerchantTradeDate: buildTaipeiDate(),
      LogisticsType: "CVS",
      LogisticsSubType: logisticsSubType,
      IsCollection: body.isCollection ? "Y" : "N",
      ServerReplyURL: `${callbackBaseUrl}/${ECPAY_LOGISTICS_REPLY_FUNCTION_NAME}`,
      Device: "0",
    };
    if (ecpayLanguage) {
      fields.Language = ecpayLanguage;
    }
    if (clientBackUrl) {
      fields.ExtraData = new URLSearchParams({ clientBackUrl }).toString();
    }
    fields.CheckMacValue = await generateCheckMacValue(fields, config.hashKey, config.hashIv);

    return json({
      provider: "ecpay",
      action: config.logisticsMapUrl,
      fields,
      supportedLogisticsSubTypes: Array.from(supportedCvsSubTypes),
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

export default handleRequest;
