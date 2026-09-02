import { optionalEnv } from "./env.ts";

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getFunctionsBaseUrl(supabasePublicUrl: string): string {
  const override = optionalEnv("FUNCTIONS_PUBLIC_URL") || optionalEnv("FUNCTIONS_BASE_URL");
  if (override) {
    return trimTrailingSlash(override);
  }
  return `${trimTrailingSlash(supabasePublicUrl)}/functions/v1`;
}

export function ecpayUrlEncode(value: string): string {
  let encoded = encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/~/g, "%7e")
    .replace(/'/g, "%27")
    .toLowerCase();

  const replacements: Record<string, string> = {
    "%2d": "-",
    "%5f": "_",
    "%2e": ".",
    "%21": "!",
    "%2a": "*",
    "%28": "(",
    "%29": ")",
  };

  for (const [from, to] of Object.entries(replacements)) {
    encoded = encoded.replaceAll(from, to);
  }
  return encoded;
}

export function normalizeEcpayLanguage(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();

  // 沒有傳語言時，維持綠界預設繁中
  if (!normalized) return undefined;

  // 綠界繁中是預設值，不要帶 Language
  if (normalized === "zh-tw") return undefined;

  // 綠界簡中
  if (normalized === "zh-cn") return "CHI";

  const languageCode = normalized.split("-")[0];
  switch (languageCode) {
    case "en":
      return "ENG";
    case "ja":
      return "JPN";
    case "ko":
      return "KOR";
    default:
      return "ENG";
  }
}

export function buildTaipeiDate(date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date).replaceAll("-", "/");
}

function formatDateToTaipeiIsoOffset(date: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+08:00`;
}

export function parseEcpayDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const normalized = text.replace(/\//g, "-");
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(normalized);
  if (match) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = match;
    const taipeiIso = `${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`;
    const parsed = new Date(taipeiIso);
    return Number.isNaN(parsed.getTime()) ? null : taipeiIso;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatDateToTaipeiIsoOffset(parsed);
}

export async function parseFormOrJsonRequest(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  const raw = await req.text();
  return stringifyRecord(parseFormOrJsonBody(raw, contentType));
}

export function parseFormOrJsonBody(raw: string, contentType = ""): Record<string, unknown> {
  if (!raw.trim()) return {};
  if (contentType.toLowerCase().includes("application/json") || raw.trim().startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

export function stringifyRecord(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, String(value ?? "")]),
  );
}

export function sanitizeText(value: unknown, maxLength = 200): string {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

const ECPAY_FORBIDDEN_ITEM_NAME_CHARS = new Set([
  "^",
  "\u0027",
  "\u0060",
  "!",
  "@",
  "#",
  "%",
  "&",
  "*",
  "+",
  "\u005C",
  "\u0022",
  "<",
  ">",
  "|",
  "\uFF5C",
  "_",
  "[",
  "]",
]);

export function sanitizeEcpayItemName(value: unknown, maxLength = 200): string {
  const sanitized = Array.from(sanitizeText(value, maxLength * 2))
    .filter((char) => !ECPAY_FORBIDDEN_ITEM_NAME_CHARS.has(char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length <= maxLength ? sanitized : sanitized.slice(0, maxLength);
}

export function toInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function randomDigits(length: number): string {
  let digits = "";
  while (digits.length < length) {
    const chunk = new Uint8Array(length - digits.length);
    crypto.getRandomValues(chunk);
    digits += Array.from(chunk, (value) => String(value % 10)).join("");
  }
  return digits;
}

export async function sha256Upper(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function add32(a: number, b: number): number {
  return (a + b) & 0xffffffff;
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function md5Cycle(state: number[], block: number[]): void {
  let [a, b, c, d] = state;
  const ff = (q: number, aa: number, bb: number, x: number, s: number, t: number) =>
    add32(rotateLeft(add32(add32(aa, q), add32(x, t)), s), bb);
  const cmn = ff;

  a = cmn((b & c) | (~b & d), a, b, block[0], 7, -680876936);
  d = cmn((a & b) | (~a & c), d, a, block[1], 12, -389564586);
  c = cmn((d & a) | (~d & b), c, d, block[2], 17, 606105819);
  b = cmn((c & d) | (~c & a), b, c, block[3], 22, -1044525330);
  a = cmn((b & c) | (~b & d), a, b, block[4], 7, -176418897);
  d = cmn((a & b) | (~a & c), d, a, block[5], 12, 1200080426);
  c = cmn((d & a) | (~d & b), c, d, block[6], 17, -1473231341);
  b = cmn((c & d) | (~c & a), b, c, block[7], 22, -45705983);
  a = cmn((b & c) | (~b & d), a, b, block[8], 7, 1770035416);
  d = cmn((a & b) | (~a & c), d, a, block[9], 12, -1958414417);
  c = cmn((d & a) | (~d & b), c, d, block[10], 17, -42063);
  b = cmn((c & d) | (~c & a), b, c, block[11], 22, -1990404162);
  a = cmn((b & c) | (~b & d), a, b, block[12], 7, 1804603682);
  d = cmn((a & b) | (~a & c), d, a, block[13], 12, -40341101);
  c = cmn((d & a) | (~d & b), c, d, block[14], 17, -1502002290);
  b = cmn((c & d) | (~c & a), b, c, block[15], 22, 1236535329);

  a = cmn((b & d) | (c & ~d), a, b, block[1], 5, -165796510);
  d = cmn((a & c) | (b & ~c), d, a, block[6], 9, -1069501632);
  c = cmn((d & b) | (a & ~b), c, d, block[11], 14, 643717713);
  b = cmn((c & a) | (d & ~a), b, c, block[0], 20, -373897302);
  a = cmn((b & d) | (c & ~d), a, b, block[5], 5, -701558691);
  d = cmn((a & c) | (b & ~c), d, a, block[10], 9, 38016083);
  c = cmn((d & b) | (a & ~b), c, d, block[15], 14, -660478335);
  b = cmn((c & a) | (d & ~a), b, c, block[4], 20, -405537848);
  a = cmn((b & d) | (c & ~d), a, b, block[9], 5, 568446438);
  d = cmn((a & c) | (b & ~c), d, a, block[14], 9, -1019803690);
  c = cmn((d & b) | (a & ~b), c, d, block[3], 14, -187363961);
  b = cmn((c & a) | (d & ~a), b, c, block[8], 20, 1163531501);
  a = cmn((b & d) | (c & ~d), a, b, block[13], 5, -1444681467);
  d = cmn((a & c) | (b & ~c), d, a, block[2], 9, -51403784);
  c = cmn((d & b) | (a & ~b), c, d, block[7], 14, 1735328473);
  b = cmn((c & a) | (d & ~a), b, c, block[12], 20, -1926607734);

  a = cmn(b ^ c ^ d, a, b, block[5], 4, -378558);
  d = cmn(a ^ b ^ c, d, a, block[8], 11, -2022574463);
  c = cmn(d ^ a ^ b, c, d, block[11], 16, 1839030562);
  b = cmn(c ^ d ^ a, b, c, block[14], 23, -35309556);
  a = cmn(b ^ c ^ d, a, b, block[1], 4, -1530992060);
  d = cmn(a ^ b ^ c, d, a, block[4], 11, 1272893353);
  c = cmn(d ^ a ^ b, c, d, block[7], 16, -155497632);
  b = cmn(c ^ d ^ a, b, c, block[10], 23, -1094730640);
  a = cmn(b ^ c ^ d, a, b, block[13], 4, 681279174);
  d = cmn(a ^ b ^ c, d, a, block[0], 11, -358537222);
  c = cmn(d ^ a ^ b, c, d, block[3], 16, -722521979);
  b = cmn(c ^ d ^ a, b, c, block[6], 23, 76029189);
  a = cmn(b ^ c ^ d, a, b, block[9], 4, -640364487);
  d = cmn(a ^ b ^ c, d, a, block[12], 11, -421815835);
  c = cmn(d ^ a ^ b, c, d, block[15], 16, 530742520);
  b = cmn(c ^ d ^ a, b, c, block[2], 23, -995338651);

  a = cmn(c ^ (b | ~d), a, b, block[0], 6, -198630844);
  d = cmn(b ^ (a | ~c), d, a, block[7], 10, 1126891415);
  c = cmn(a ^ (d | ~b), c, d, block[14], 15, -1416354905);
  b = cmn(d ^ (c | ~a), b, c, block[5], 21, -57434055);
  a = cmn(c ^ (b | ~d), a, b, block[12], 6, 1700485571);
  d = cmn(b ^ (a | ~c), d, a, block[3], 10, -1894986606);
  c = cmn(a ^ (d | ~b), c, d, block[10], 15, -1051523);
  b = cmn(d ^ (c | ~a), b, c, block[1], 21, -2054922799);
  a = cmn(c ^ (b | ~d), a, b, block[8], 6, 1873313359);
  d = cmn(b ^ (a | ~c), d, a, block[15], 10, -30611744);
  c = cmn(a ^ (d | ~b), c, d, block[6], 15, -1560198380);
  b = cmn(d ^ (c | ~a), b, c, block[13], 21, 1309151649);
  a = cmn(c ^ (b | ~d), a, b, block[4], 6, -145523070);
  d = cmn(b ^ (a | ~c), d, a, block[11], 10, -1120210379);
  c = cmn(a ^ (d | ~b), c, d, block[2], 15, 718787259);
  b = cmn(d ^ (c | ~a), b, c, block[9], 21, -343485551);

  state[0] = add32(state[0], a);
  state[1] = add32(state[1], b);
  state[2] = add32(state[2], c);
  state[3] = add32(state[3], d);
}

export function md5Upper(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  const state = [1732584193, -271733879, -1732584194, 271733878];
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const block = Array.from({ length: 16 }, (_, index) => view.getInt32(offset + index * 4, true));
    md5Cycle(state, block);
  }

  return state
    .flatMap((word) => [
      word & 0xff,
      (word >>> 8) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 24) & 0xff,
    ])
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
