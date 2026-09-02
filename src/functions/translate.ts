import { createHash } from "node:crypto";
import * as OpenCC from "opencc-js";

// 平台 + 聊聊的即時翻譯後端。可插拔三層:
//   ① Table-lookup（translation_cache 快取表）—— 命中即回，免費/即時/一致
//   ② OpenCC 繁↔簡 + LibreTranslate（自架，現階段的「類 google translate」）
//   ③ （未來）LLM / glossary —— LibreTranslate 沒 cover 的語言先回原文
// app 只呼叫這支、不持任何金鑰；LibreTranslate 只綁 docker 內網（carenet）。
//
// LibreTranslate 沒有繁中模型：繁中來源先 t2s、繁中目標先譯成簡中再 s2t。
// 支援聊聊的任意來源語言→任意目標語言（雙方各自用自己設定的語言）。

type JsonRecord = Record<string, unknown>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// LibreTranslate 目前載入的語言（/languages，來源與目標同一組）。其餘（緬甸/寮/他加祿…）回原文，待 LLM。
const LT_LANGS = new Set(["en", "id", "ja", "ko", "th", "vi", "zh-Hans"]);
const MAX_TEXTS = 200;
const MAX_TOTAL_CHARS = 20000;

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" }); // 繁（台）→ 簡
const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" }); // 簡 → 繁（台）

function env(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function libretranslateUrl(): string {
  return (process.env.LIBRETRANSLATE_URL?.trim() || "http://libretranslate:5000").replace(/\/+$/, "");
}
function supabaseUrl(): string {
  return (process.env.SUPABASE_PUBLIC_URL?.trim() || env("SUPABASE_URL")).replace(/\/+$/, "");
}
function careSchema(): string {
  return process.env.CARE_DB_SCHEMA?.trim() || "pro_care_matching";
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

function isTraditional(code: string): boolean {
  const c = code.trim().toLowerCase();
  return c === "" || c === "zh" || c === "zh-tw" || c === "zh-hant" || c === "zh-hk";
}
function isSimplified(code: string): boolean {
  const c = code.trim().toLowerCase();
  return c === "zh-hans" || c === "zh-cn";
}
// 該語言在 LibreTranslate 的代碼；不支援回 null（含繁/簡中一律用 zh-Hans）。
function ltCode(code: string): string | null {
  if (isTraditional(code) || isSimplified(code)) return "zh-Hans";
  return LT_LANGS.has(code) ? code : null;
}

async function careRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const schema = careSchema();
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceKey);
  headers.set("Authorization", `Bearer ${serviceKey}`);
  headers.set("Accept-Profile", schema);
  headers.set("Content-Profile", schema);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Supabase REST failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function libreTranslate(texts: string[], source: string, target: string): Promise<string[]> {
  const res = await fetch(`${libretranslateUrl()}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: texts, source, target, format: "text" }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `LibreTranslate failed (${res.status})`);
  }
  const data = (await res.json()) as { translatedText?: string | string[] };
  const out = data.translatedText;
  if (Array.isArray(out)) return out;
  return out != null ? [String(out)] : texts;
}

const handleRequest = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // 便宜的閘：要帶 app 的 anon apikey（擋開放濫用；翻譯內容本身不需個別使用者身分）。
  const apikey = (req.headers.get("apikey") ?? "").trim();
  if (!apikey || apikey !== env("SUPABASE_ANON_KEY")) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = (await req.json()) as JsonRecord;
    const to = String(body.to ?? "").trim();
    const from = String(body.from ?? "zh-TW").trim();
    const rawTexts: string[] = Array.isArray(body.texts)
      ? (body.texts as unknown[]).map((t) => String(t ?? ""))
      : body.q != null
        ? [String(body.q)]
        : [];

    if (!to) return json({ error: "to (target language) is required" }, 400);
    if (!rawTexts.length) return json({ translations: [], from, to, provider: "none" });
    if (rawTexts.length > MAX_TEXTS) return json({ error: `too many texts (max ${MAX_TEXTS})` }, 400);
    if (rawTexts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL_CHARS) {
      return json({ error: "payload too large" }, 400);
    }

    // from='auto' → 交給 LibreTranslate 自動偵測（聊聊：非中文對方訊息用；中文訊息前端會直接給 zh-TW）。
    const autoSrc = from.trim().toLowerCase() === 'auto';
    const srcLt = autoSrc ? 'auto' : ltCode(from);
    const tgtLt = ltCode(to);
    const tradTarget = isTraditional(to);
    const sameLang =
      (isTraditional(from) && isTraditional(to)) ||
      (isSimplified(from) && isSimplified(to)) ||
      (srcLt !== null && srcLt === tgtLt && !tradTarget && !isTraditional(from));

    // 來源或目標 LibreTranslate 不支援，或來源＝目標 → 原文回（待 LLM 補）。
    if (srcLt === null || tgtLt === null || sameLang) {
      return json({ translations: rawTexts, from, to, provider: "passthrough", untranslated: true });
    }

    // 去重＋只翻非空白。
    const uniques = Array.from(new Set(rawTexts.filter((t) => t.trim() !== "")));
    const hashByText = new Map(uniques.map((t) => [t, md5(t)]));
    const translated = new Map<string, string>();

    // ① 查快取（key = from/to 原樣，繁中結果也正確快取）。
    if (uniques.length) {
      const hashes = uniques.map((t) => hashByText.get(t)!);
      const q = new URLSearchParams({
        select: "source_hash,translated_text",
        source_lang: `eq.${from}`,
        target_lang: `eq.${to}`,
        source_hash: `in.(${hashes.join(",")})`,
      });
      const rows = await careRest<Array<{ source_hash: string; translated_text: string }>>(
        `translation_cache?${q}`,
      );
      const byHash = new Map(rows.map((r) => [r.source_hash, r.translated_text]));
      for (const t of uniques) {
        const cached = byHash.get(hashByText.get(t)!);
        if (cached != null) translated.set(t, cached);
      }
    }

    // ② 未命中 → 繁轉簡（若來源繁中）→ LibreTranslate → 繁化（若目標繁中）。
    const misses = uniques.filter((t) => !translated.has(t));
    if (misses.length) {
      const prepared = isTraditional(from) ? misses.map((t) => toSimplified(t)) : misses;
      const raw = await libreTranslate(prepared, srcLt, tgtLt);
      const finalOut = tradTarget ? raw.map((t) => toTraditional(t)) : raw;
      const cacheRows = misses.map((t, i) => {
        const out = (finalOut[i] ?? t).toString();
        translated.set(t, out);
        return {
          source_lang: from,
          target_lang: to,
          source_hash: hashByText.get(t)!,
          source_text: t,
          translated_text: out,
          provider: "libretranslate",
        };
      });
      try {
        await careRest<void>(
          "translation_cache?on_conflict=source_lang,target_lang,source_hash",
          {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(cacheRows),
          },
        );
      } catch (e) {
        console.error("[translate] cache write failed", { message: String(e) });
      }
    }

    const translations = rawTexts.map((t) => (t.trim() === "" ? t : translated.get(t) ?? t));
    return json({ translations, from, to, provider: "libretranslate" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[translate] failed", { message });
    return json({ error: message }, 500);
  }
};

export default handleRequest;
