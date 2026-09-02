import {
  buildTaipeiDate,
  ecpayUrlEncode,
  getFunctionsBaseUrl,
  parseEcpayDate,
  parseFormOrJsonRequest,
  randomDigits,
  normalizeEcpayLanguage,
  sanitizeEcpayItemName,
  sha256Upper,
  trimTrailingSlash,
} from "./ecpay_common.ts";
import {
  getSupabaseServiceConfig,
  optionalEnv,
  requireEnv,
  type SupabaseServiceConfig,
} from "./env.ts";

export {
  buildTaipeiDate,
  parseEcpayDate,
  parseFormOrJsonRequest,
  randomDigits,
  normalizeEcpayLanguage,
  sanitizeEcpayItemName,
  trimTrailingSlash,
};

export type EcpayPaymentConfig = SupabaseServiceConfig & {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  checkoutUrl: string;
  supabasePublicUrl: string;
  appBaseUrl: string;
  choosePaymentOverride: string;
};

export type EcpayPaymentCallbackConfig = SupabaseServiceConfig & {
  merchantId: string;
  hashKey: string;
  hashIv: string;
};

export type EcpayCreditActionConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  actionUrl: string;
  platformId?: string;
};

export type EcpayPeriodActionConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  actionUrl: string;
  platformId?: string;
};

export function getEcpayPaymentConfig(): EcpayPaymentConfig {
  return {
    merchantId: requireEnv("ECPAY_MERCHANT_ID"),
    hashKey: requireEnv("ECPAY_HASH_KEY"),
    hashIv: requireEnv("ECPAY_HASH_IV"),
    checkoutUrl: requireEnv("ECPAY_CHECKOUT_URL"),
    supabasePublicUrl: trimTrailingSlash(
      optionalEnv("FUNCTIONS_PUBLIC_URL") || requireEnv("SUPABASE_PUBLIC_URL"),
    ),
    appBaseUrl: trimTrailingSlash(requireEnv("SITE_URL")),
    choosePaymentOverride: optionalEnv("ECPAY_CHOOSE_PAYMENT"),
    ...getSupabaseServiceConfig(),
  };
}

export function getEcpayPaymentCallbackConfig(): EcpayPaymentCallbackConfig {
  return {
    merchantId: requireEnv("ECPAY_MERCHANT_ID"),
    hashKey: requireEnv("ECPAY_HASH_KEY"),
    hashIv: requireEnv("ECPAY_HASH_IV"),
    ...getSupabaseServiceConfig(),
  };
}

export function getEcpayCreditActionConfig(): EcpayCreditActionConfig {
  return {
    merchantId: requireEnv("ECPAY_MERCHANT_ID"),
    hashKey: requireEnv("ECPAY_HASH_KEY"),
    hashIv: requireEnv("ECPAY_HASH_IV"),
    actionUrl: requireEnv("ECPAY_CREDIT_ACTION_URL"),
    platformId: optionalEnv("ECPAY_PLATFORM_ID") || undefined,
  };
}

export function getEcpayPeriodActionConfig(): EcpayPeriodActionConfig {
  return {
    merchantId: requireEnv("ECPAY_MERCHANT_ID"),
    hashKey: requireEnv("ECPAY_HASH_KEY"),
    hashIv: requireEnv("ECPAY_HASH_IV"),
    actionUrl: requireEnv("ECPAY_CREDIT_PERIOD_ACTION_URL"),
    platformId: optionalEnv("ECPAY_PLATFORM_ID") || undefined,
  };
}

export function resolveCallbackBaseUrl(_req: Request, supabasePublicUrl: string): string {
  return getFunctionsBaseUrl(supabasePublicUrl);
}

export async function generateCheckMacValue(
  params: Record<string, unknown>,
  hashKey: string,
  hashIv: string,
): Promise<string> {
  const source = Object.entries(params)
    .filter(([key, value]) => key !== "CheckMacValue" && value !== undefined && value !== null)
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");

  return await sha256Upper(ecpayUrlEncode(`HashKey=${hashKey}&${source}&HashIV=${hashIv}`));
}

export async function isValidCheckMacValue(
  payload: Record<string, unknown>,
  hashKey: string,
  hashIv: string,
): Promise<boolean> {
  const received = String(payload.CheckMacValue ?? "")
    .trim()
    .toUpperCase();
  return Boolean(received) && received === (await generateCheckMacValue(payload, hashKey, hashIv));
}
