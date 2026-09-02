import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient } from "../_shared_haiglobals/database.ts";
import { selectOne } from "../_shared_haiglobals/orders.ts";
import { optionalEnv } from "../_shared/env.ts";

/**
 * 商品分享頁（Open Graph）。
 *
 * 為什麼需要這支：Facebook / LINE / X 等平台的預覽爬蟲不會執行 JavaScript，
 * 只讀初始 HTML 的 <meta property="og:..."> 標籤。買家前台是 Flutter SPA，
 * 每個網址的 og 標籤都一樣，所以不能直接分享 App 網址。分享連結要指向這支
 * 伺服器端渲染的頁面：爬蟲讀到商品專屬 og 標籤顯示大圖＋標題，真人瀏覽器則
 * 被導回 App 的商品深連結。
 *
 * URL：GET /functions/v1/haiglobals-share-product?id=<products.id>
 */

type ShareProductRow = {
  id: string;
  name?: string | null;
  image_url?: string | null;
  description?: unknown;
  is_active?: boolean | string | null;
};

const PUBLIC_OBJECT_MARKER = "/storage/v1/object/public/";
const RENDER_IMAGE_MARKER = "/storage/v1/render/image/public/";

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 把 Supabase Storage 公開物件 URL 改寫成正方形縮圖（imgproxy render 端口）。
 * 尺寸可用環境變數 SHARE_OG_IMAGE_SIZE 覆蓋，預設 1200。非公開物件 URL 原樣回傳。
 */
function ogImageUrl(imageUrl: string): string {
  const trimmed = String(imageUrl ?? "").trim();
  if (!trimmed || !trimmed.includes(PUBLIC_OBJECT_MARKER)) return trimmed;

  const size = Number(optionalEnv("SHARE_OG_IMAGE_SIZE") || "1200") || 1200;
  // cover：填滿正方形不留黑邊（分享預覽較好看，會裁掉超出的邊）；
  // contain：保留完整商品但可能有留白/黑邊。可用環境變數切換，預設 cover。
  const resize = optionalEnv("SHARE_OG_IMAGE_RESIZE") === "contain" ? "contain" : "cover";
  const rendered = trimmed.replace(PUBLIC_OBJECT_MARKER, RENDER_IMAGE_MARKER);
  const separator = rendered.includes("?") ? "&" : "?";
  // 正方形：width = height。爬蟲不會帶 Accept: image/webp，
  // 因此 imgproxy 回傳 PNG/JPEG，符合 og:image。
  return `${rendered}${separator}width=${size}&height=${size}&resize=${resize}&quality=80`;
}

/**
 * 商品介紹是 Flutter Quill Delta（jsonb）。抽出純文字給 og:description。
 * 支援 Delta ops array、{ ops: [...] } 或純字串。
 */
function plainTextFromDescription(value: unknown, max = 160): string {
  let text = "";
  try {
    let parsed: unknown = value;
    if (typeof value === "string") {
      const s = value.trim();
      if (s.startsWith("{") || s.startsWith("[")) parsed = JSON.parse(s);
      else text = s;
    }
    if (!text) {
      const ops = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { ops?: unknown }).ops)
          ? (parsed as { ops: unknown[] }).ops
          : null;
      if (ops) {
        text = ops
          .map((op) =>
            op && typeof op === "object" && typeof (op as { insert?: unknown }).insert === "string"
              ? (op as { insert: string }).insert
              : "",
          )
          .join("");
      }
    }
  } catch {
    // 解析失敗就回空字串，讓 og:description 省略即可。
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      // 爬蟲與 CDN 可短暫快取；商品文案/圖片更新後最多延遲 5 分鐘。
      "Cache-Control": "public, max-age=300",
    },
  });
}

/** 沒有商品資料（或缺 id）時，只把真人導回 App，不輸出 og。 */
function renderRedirectOnly(appLink: string): string {
  const safeLink = htmlEscape(appLink);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${safeLink}">
<title>Haiglobals</title>
</head>
<body><script>location.replace(${JSON.stringify(appLink)});</script>
<a href="${safeLink}">前往 Haiglobals</a></body>
</html>`;
}

function renderShareHtml(params: {
  title: string;
  description: string;
  image: string;
  shareUrl: string;
  appLink: string;
  siteName: string;
}): string {
  const { title, description, image, shareUrl, appLink, siteName } = params;
  const tags: string[] = [
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${htmlEscape(siteName)}">`,
    `<meta property="og:title" content="${htmlEscape(title)}">`,
    `<meta property="og:url" content="${htmlEscape(shareUrl)}">`,
  ];
  if (description) {
    tags.push(`<meta property="og:description" content="${htmlEscape(description)}">`);
  }
  if (image) {
    tags.push(`<meta property="og:image" content="${htmlEscape(image)}">`);
    // Twitter/X 優先讀這組；用 summary_large_image 才會出大圖。
    tags.push(`<meta name="twitter:card" content="summary_large_image">`);
    tags.push(`<meta name="twitter:image" content="${htmlEscape(image)}">`);
  } else {
    tags.push(`<meta name="twitter:card" content="summary">`);
  }
  tags.push(`<meta name="twitter:title" content="${htmlEscape(title)}">`);
  if (description) {
    tags.push(`<meta name="twitter:description" content="${htmlEscape(description)}">`);
  }

  const safeLink = htmlEscape(appLink);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
${tags.join("\n")}
<meta http-equiv="refresh" content="0; url=${safeLink}">
</head>
<body>
<script>location.replace(${JSON.stringify(appLink)});</script>
<p><a href="${safeLink}">${htmlEscape(title)}</a></p>
</body>
</html>`;
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const productId = (url.searchParams.get("id") ?? "").trim();

  const siteBase = (optionalEnv("SITE_URL") || "").replace(/\/+$/, "");
  // 買家前台使用 hash 路由：<site>/#/product/<id>
  const appLink =
    productId && siteBase
      ? `${siteBase}/#/product/${encodeURIComponent(productId)}`
      : siteBase || "/";

  if (!productId) {
    return htmlResponse(renderRedirectOnly(appLink), 400);
  }

  let product: ShareProductRow | null = null;
  try {
    const admin = createDatabaseClient();
    product = await selectOne<ShareProductRow>(admin, "products", {
      select: "id,name,image_url,description,is_active",
      id: `eq.${productId}`,
    });
  } catch {
    product = null;
  }

  // 只放行公開商品；其他情況只把真人導回 App，不輸出商品 og。
  if (!product || product.is_active !== true) {
    return htmlResponse(renderRedirectOnly(appLink), 404);
  }

  // og:url 用品牌短連結（若有設定），否則用本 function 的實際網址。
  // 這是分享預覽顯示與被爬取的正規網址。
  const linkBase = optionalEnv("SHARE_LINK_BASE_URL").replace(/\/+$/, "");
  const shareUrl = linkBase
    ? `${linkBase}/${encodeURIComponent(productId)}`
    : `${url.origin}${url.pathname}?id=${encodeURIComponent(productId)}`;
  const title = String(product.name ?? "").trim() || "Haiglobals";
  const description = plainTextFromDescription(product.description);
  const image = ogImageUrl(String(product.image_url ?? ""));
  const siteName = optionalEnv("SHARE_OG_SITE_NAME") || "Haiglobals";

  return htmlResponse(renderShareHtml({ title, description, image, shareUrl, appLink, siteName }));
};

export default handleRequest;
