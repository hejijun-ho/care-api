/**
 * 術語保護層的端到端驗證：本地保護 → 送 staging 的翻譯服務 → 本地還原，
 * 與「不保護」的結果並排比較。
 *
 * 這支測試不需要部署就能證明整條設計成立：它把 translate.ts 匯出的
 * protectTerms/restoreTerms 接上真實的機器翻譯，重現線上會發生的事。
 *
 * ⚠ 術語保護層**部署之後**，「未保護」那一欄其實也會被伺服器保護（兩欄會一模一樣）。
 *   要看沒有保護的對照組，請打一個還沒部署本層的環境。部署後這支測試的價值在於
 *   下面兩個斷言仍然成立：譯文不得是暴力行為、術語不得遺失。
 *
 * 動機：實測「記得幫她拍背」被翻成「打她耳光 / slap her back / ตบหลังเธอ」——
 * 一句排痰的照顧指令變成毆打被照顧者。這支測試就是釘住那件事不再發生。
 *
 * 跑法（在 care-api 目錄）：
 *   npx tsx tests/glossary_protection_test.ts
 * 需要環境變數（不寫進檔案）：
 *   CARE_FUNCTIONS_BASE_URL  例 https://carematching.haiglobals.com/functions/v1
 *   CARE_ANON_KEY            該環境的 anon key
 */
import { protectTerms, restoreTerms } from "../src/functions/translate.ts";

type GlossaryTerm = { source_term: string; target_term: string };

const BASE = (process.env.CARE_FUNCTIONS_BASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.CARE_ANON_KEY ?? "";
const LANGS = ["en", "id", "vi", "th", "ja", "ko"] as const;

// 這些句子都是真實照顧情境；「拍背」是已知會被翻成毆打的那一個。
const CASES = [
  "她昨天晚上一直咳嗽，記得幫她拍背。",
  "下午要抽痰，另外鼻胃管的位置也幫忙看一下。",
  "翻身之後記得幫她拍背，不要漏掉。",
];

// 對照用的最小術語表（正式流程從 DB 的 translation_glossary 讀）。
const GLOSSARY: Record<string, GlossaryTerm[]> = {
  en: [
    { source_term: "翻身拍背", target_term: "repositioning and back percussion" },
    { source_term: "鼻胃管", target_term: "NG tube feeding" },
    { source_term: "拍背", target_term: "back percussion" },
    { source_term: "抽痰", target_term: "sputum suctioning" },
    { source_term: "翻身", target_term: "repositioning" },
  ],
  id: [
    { source_term: "鼻胃管", target_term: "selang NGT" },
    { source_term: "拍背", target_term: "tepuk punggung" },
    { source_term: "抽痰", target_term: "sedot dahak" },
    { source_term: "翻身", target_term: "balik badan" },
  ],
  vi: [
    { source_term: "鼻胃管", target_term: "ống thông dạ dày" },
    { source_term: "拍背", target_term: "vỗ lưng" },
    { source_term: "抽痰", target_term: "hút đờm" },
    { source_term: "翻身", target_term: "trở mình" },
  ],
  th: [
    { source_term: "鼻胃管", target_term: "สายให้อาหารทางจมูก" },
    { source_term: "拍背", target_term: "เคาะปอด" },
    { source_term: "抽痰", target_term: "ดูดเสมหะ" },
    { source_term: "翻身", target_term: "พลิกตัว" },
  ],
  ja: [
    { source_term: "鼻胃管", target_term: "経鼻胃管" },
    { source_term: "拍背", target_term: "背部タッピング" },
    { source_term: "抽痰", target_term: "喀痰吸引" },
    { source_term: "翻身", target_term: "体位変換" },
  ],
  ko: [
    { source_term: "鼻胃管", target_term: "비위관" },
    { source_term: "拍背", target_term: "등 두드리기" },
    { source_term: "抽痰", target_term: "가래 흡인" },
    { source_term: "翻身", target_term: "체위 변경" },
  ],
};

// 譯文出現這些字＝把照顧指令翻成了暴力行為。看到就是測試失敗。
const VIOLENT = [
  /slap/i, /hit\s+her/i, /beat\s+her/i, /punch/i,
  /menampar/i, /pukul/i,
  /tát/i, /đánh/i,
  /ตบ/, /ตี/,
  /殴/, /叩く/, /引っぱたく/,
  /때리/, /뺨/,
];

async function translate(texts: string[], to: string): Promise<string[]> {
  const res = await fetch(`${BASE}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "User-Agent": "care-glossary-test/1.0",
    },
    body: JSON.stringify({ texts, to, from: "zh-TW" }),
  });
  if (!res.ok) throw new Error(`translate failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { translations?: string[] };
  return data.translations ?? [];
}

async function main() {
  if (!BASE || !KEY) {
    throw new Error("需要環境變數 CARE_FUNCTIONS_BASE_URL 與 CARE_ANON_KEY");
  }
  let failures = 0;

  for (const lang of LANGS) {
    const terms = [...GLOSSARY[lang]].sort((a, b) => b.source_term.length - a.source_term.length);
    // 加上亂數後綴繞開翻譯快取，確保量到的是這次 MT 的真實輸出。
    const nonce = ` （${Math.random().toString(36).slice(2, 8)}）`;
    const guarded = CASES.map((c) => protectTerms(c + nonce, terms));

    const plain = await translate(CASES.map((c) => c + nonce), lang);
    const rawGuarded = await translate(guarded.map((g) => g.prepared), lang);
    const restored = rawGuarded.map((t, i) => restoreTerms(t, guarded[i].map));

    console.log(`\n=== ${lang} ===`);
    for (let i = 0; i < CASES.length; i += 1) {
      const violentPlain = VIOLENT.some((re) => re.test(plain[i] ?? ""));
      const violentGuarded = VIOLENT.some((re) => re.test(restored[i] ?? ""));
      console.log(`原文  : ${CASES[i]}`);
      // 部署後這一欄不再是真的「未保護」——伺服器自己也會保護（見檔頭說明）。
      console.log(`直接送: ${plain[i]}${violentPlain ? "   ← 翻成暴力行為" : ""}`);
      console.log(`已保護: ${restored[i]}${violentGuarded ? "   ← 仍是暴力行為" : ""}`);
      if (violentGuarded) failures += 1;
      // 術語必須真的出現在譯文裡，否則保護等於沒做。
      for (const term of guarded[i].map.values()) {
        if (!(restored[i] ?? "").includes(term)) {
          console.log(`  !! 術語遺失: ${term}`);
          failures += 1;
        }
      }
    }
  }

  console.log(`\n失敗數: ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
