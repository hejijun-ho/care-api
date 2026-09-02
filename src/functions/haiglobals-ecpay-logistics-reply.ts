import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import {
  generateCheckMacValue,
  getEcpayLogisticsConfig,
  parseFormOrJsonBody,
  trimTrailingSlash,
} from "../_shared/ecpay_logistics.ts";
import { optionalEnv } from "../_shared/env.ts";

type LogisticsSelectionPayload = {
  MerchantTradeNo?: string;
  LogisticsSubType?: string;
  CVSStoreID?: string;
  CVSStoreName?: string;
  CVSAddress?: string;
  CVSTelephone?: string;
  CVSOutSide?: string;
  ExtraData?: string;
  CheckMacValue?: string;
  [key: string]: unknown;
};

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildRedirectHtml(url: string): string {
  const escapedUrl = JSON.stringify(url);
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>門市已選擇</title>
    <script>location.replace(${escapedUrl});</script>
  </head>
  <body>
    <p>門市已選擇，正在返回結帳頁...</p>
    <p><a href="${url.replace(/"/g, "&quot;")}">返回結帳頁</a></p>
  </body>
</html>`;
}

function queryValue(value: unknown): string {
  return encodeURIComponent(String(value ?? "").trim());
}

function clientBackUrlFromExtraData(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    const params = new URLSearchParams(text);
    const raw = String(params.get("clientBackUrl") ?? "").trim();
    if (!raw) {
      return "";
    }
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.toString();
  } catch (_) {
    return "";
  }
}

function appendStoreParams(baseUrl: string, params: string): string {
  const url = new URL(baseUrl);
  if (url.hash) {
    const [hashPath, hashQuery = ""] = url.hash.split("?");
    url.hash = `${hashPath}?${hashQuery ? `${hashQuery}&` : ""}${params}`;
    return url.toString();
  }
  url.search = url.search ? `${url.search}&${params}` : `?${params}`;
  return url.toString();
}

function buildStoreSelectedUrl(payload: LogisticsSelectionPayload): string {
  const siteUrl = trimTrailingSlash(optionalEnv("SITE_URL") || optionalEnv("SUPABASE_PUBLIC_URL"));
  const params = [
    "logistics=selected",
    `logisticsSubType=${queryValue(payload.LogisticsSubType)}`,
    `cvsStoreId=${queryValue(payload.CVSStoreID)}`,
    `cvsStoreName=${queryValue(payload.CVSStoreName)}`,
    `cvsStoreAddress=${queryValue(payload.CVSAddress)}`,
  ].join("&");
  const clientBackUrl = clientBackUrlFromExtraData(payload.ExtraData);
  if (clientBackUrl) {
    return appendStoreParams(clientBackUrl, params);
  }
  return `${siteUrl}/#/checkout?${params}`;
}

const handleRequest = async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const environment = (optionalEnv("ENVIRONMENT") || "production").toLowerCase();
  const rawBody = await req.clone().text();
  try {
    const payload = parseFormOrJsonBody(
      rawBody,
      req.headers.get("content-type") ?? "",
    ) as LogisticsSelectionPayload;
    const config = getEcpayLogisticsConfig(payload.LogisticsSubType);

    const incoming = String(payload.CheckMacValue ?? "").trim();
    if (incoming) {
      const expected = await generateCheckMacValue(payload, config.hashKey, config.hashIv);
      if (incoming.toUpperCase() !== expected) {
        return new Response("CheckMacValue Error", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    } else if (environment === "production") {
      return new Response("Missing CheckMacValue", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return htmlResponse(buildRedirectHtml(buildStoreSelectedUrl(payload)));
  } catch (error) {
    console.error("ecpay-logistics-reply error", error, { rawBody });
    return htmlResponse(
      "<!doctype html><html><body><p>門市資料儲存失敗，請返回商店重新選擇。</p></body></html>",
      500,
    );
  }
};

export default handleRequest;
