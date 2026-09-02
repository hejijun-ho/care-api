import {
  buildTaipeiDate,
  ecpayUrlEncode,
  getFunctionsBaseUrl,
  md5Upper,
  parseEcpayDate,
  parseFormOrJsonBody,
  randomDigits,
  normalizeEcpayLanguage,
  sanitizeEcpayItemName,
  sanitizeText,
  toInt,
  trimTrailingSlash,
} from "./ecpay_common.ts";
import { getSupabaseServiceConfig, optionalEnv, requireEnv } from "./env.ts";

export {
  buildTaipeiDate,
  parseEcpayDate,
  parseFormOrJsonBody,
  randomDigits,
  normalizeEcpayLanguage,
  sanitizeEcpayItemName,
  sanitizeText,
  toInt,
  trimTrailingSlash,
};

export type EcpayLogisticsConfig = {
  merchantId: string;
  hashKey: string;
  hashIv: string;
};

export type EcpayLogisticsMapConfig = EcpayLogisticsConfig & {
  supabasePublicUrl: string;
  logisticsMapUrl: string;
};

export type EcpayLogisticsDatabaseConfig = EcpayLogisticsConfig & {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export type EcpayLogisticsCreateConfig = EcpayLogisticsDatabaseConfig & {
  supabasePublicUrl: string;
  logisticsCreateUrl: string;
};

function isC2cLogisticsSubType(value: unknown): boolean {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .endsWith("C2C");
}

export function getEcpayLogisticsConfig(logisticsSubType?: unknown): EcpayLogisticsConfig {
  isC2cLogisticsSubType(logisticsSubType);
  return {
    merchantId: requireEnv("ECPAY_LOGISTICS_C2C_MERCHANT_ID"),
    hashKey: requireEnv("ECPAY_LOGISTICS_C2C_HASH_KEY"),
    hashIv: requireEnv("ECPAY_LOGISTICS_C2C_HASH_IV"),
  };
}

export function getEcpayLogisticsMapConfig(logisticsSubType?: unknown): EcpayLogisticsMapConfig {
  return {
    ...getEcpayLogisticsConfig(logisticsSubType),
    supabasePublicUrl: trimTrailingSlash(
      optionalEnv("FUNCTIONS_PUBLIC_URL") || requireEnv("SUPABASE_PUBLIC_URL"),
    ),
    logisticsMapUrl: requireEnv("ECPAY_LOGISTICS_MAP_URL"),
  };
}

export function getEcpayLogisticsDatabaseConfig(
  logisticsSubType?: unknown,
): EcpayLogisticsDatabaseConfig {
  return {
    ...getEcpayLogisticsConfig(logisticsSubType),
    ...getSupabaseServiceConfig(),
  };
}

export function getEcpayLogisticsCreateConfig(
  logisticsSubType?: unknown,
): EcpayLogisticsCreateConfig {
  return {
    ...getEcpayLogisticsDatabaseConfig(logisticsSubType),
    supabasePublicUrl: trimTrailingSlash(
      optionalEnv("FUNCTIONS_PUBLIC_URL") || requireEnv("SUPABASE_PUBLIC_URL"),
    ),
    logisticsCreateUrl: requireEnv("ECPAY_LOGISTICS_CREATE_URL"),
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
  const query = Object.entries(params)
    .filter(([key, value]) => key !== "CheckMacValue" && value !== undefined && value !== null)
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  return md5Upper(ecpayUrlEncode(`HashKey=${hashKey}&${query}&HashIV=${hashIv}`));
}
