import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";

type DetectSource = "cloudflare" | "alias" | "fallback";

const DEFAULT_COUNTRY_CODE = "TW";

/**
 * 這裡放「前台支援的正式 country code」。
 * 這份清單要跟你的前台 country config 保持一致。
 */
const SUPPORTED_COUNTRY_CODES = new Set<string>([
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
]);

/**
 * Cloudflare / ISO 可能回來，但你的支援清單沒有獨立顯示的 code。
 * 這些要 map 到你保留的主要國家。
 */
const COUNTRY_ALIAS_MAP: Record<string, string> = {
  AX: "FI", // Åland Islands -> Finland
  BV: "NO", // Bouvet Island -> Norway
  CC: "AU", // Cocos Islands -> Australia
  CX: "AU", // Christmas Island -> Australia
  HM: "AU", // Heard Island and McDonald Islands -> Australia
  NF: "AU", // Norfolk Island -> Australia
  SJ: "NO", // Svalbard and Jan Mayen -> Norway
  TF: "FR", // French Southern Territories -> France
  UM: "US", // U.S. Outlying Islands -> United States
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function normalizeCountryCode(value: unknown): string | null {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{2}$/.test(code)) return null;

  // Cloudflare 可能回 XX / T1 這種非一般國家碼；不當作可用國家。
  if (code === "XX" || code === "T1") return null;

  return code;
}

function resolveSupportedCountryCode(rawCountryCode: unknown): {
  countryCode: string;
  rawCountryCode: string | null;
  source: DetectSource;
  mappedFrom: string | null;
  fallbackUsed: boolean;
} {
  const normalized = normalizeCountryCode(rawCountryCode);

  if (!normalized) {
    return {
      countryCode: DEFAULT_COUNTRY_CODE,
      rawCountryCode: null,
      source: "fallback",
      mappedFrom: null,
      fallbackUsed: true,
    };
  }

  if (SUPPORTED_COUNTRY_CODES.has(normalized)) {
    return {
      countryCode: normalized,
      rawCountryCode: normalized,
      source: "cloudflare",
      mappedFrom: null,
      fallbackUsed: false,
    };
  }

  const mapped = COUNTRY_ALIAS_MAP[normalized];

  if (mapped && SUPPORTED_COUNTRY_CODES.has(mapped)) {
    return {
      countryCode: mapped,
      rawCountryCode: normalized,
      source: "alias",
      mappedFrom: normalized,
      fallbackUsed: false,
    };
  }

  return {
    countryCode: DEFAULT_COUNTRY_CODE,
    rawCountryCode: normalized,
    source: "fallback",
    mappedFrom: null,
    fallbackUsed: true,
  };
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "GET") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const cloudflareCountry = req.headers.get("cf-ipcountry");
    const resolved = resolveSupportedCountryCode(cloudflareCountry);

    return json({
      ok: true,
      countryCode: resolved.countryCode,
      rawCountryCode: resolved.rawCountryCode,
      source: resolved.source,
      mappedFrom: resolved.mappedFrom,
      fallbackUsed: resolved.fallbackUsed,
      canChange: true,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        countryCode: DEFAULT_COUNTRY_CODE,
        source: "fallback",
        fallbackUsed: true,
        canChange: true,
      },
      400,
    );
  }
};

export default handleRequest;
