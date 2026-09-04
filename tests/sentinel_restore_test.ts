/**
 * 哨符還原的離線單元測試：不連網、不依賴翻譯服務，純粹釘住 protect/restore 的行為。
 *
 * 由來是一次線上實測抓到的真 bug：「鼻胃管灌食」是兩個相鄰術語，舊版哨符相接後變成
 * `Xy2yXXy3yX`，中間有 `XX`；MT 把它併成一個 `X`，還原時 #2 吃掉共用的那個 X，
 * 只剩 `y3yX` 碎片直接漏到使用者眼前（實測 ja「経鼻胃管y3yX」、vi「dạ dày3yX」）。
 * 更糟的是舊版的「遺失偵測」用事後字串比對——`Xy2yXy3yX` 裡確實含子字串 `Xy3yX`，
 * 所以它判定「沒遺失」，連補救都不會觸發。
 *
 * 跑法（在 care-api 目錄）：npx tsx tests/sentinel_restore_test.ts
 */
import { protectTerms, restoreTerms } from "../src/functions/translate.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      實際: ${JSON.stringify(actual)}`);
    console.log(`      預期: ${JSON.stringify(expected)}`);
  }
}

const NG = { source_term: "鼻胃管", target_term: "NG tube" };
const FEED = { source_term: "灌食", target_term: "tube feeding" };
const PAT = { source_term: "拍背", target_term: "back percussion" };

// ── protectTerms ───────────────────────────────────────────────────────────
{
  const { prepared, map } = protectTerms("鼻胃管灌食後要坐著三十分鐘", [NG, FEED]);
  check("相鄰術語不會產生 XX（那會被 MT 併成一個 X）", /XX/.test(prepared), false);
  check("兩個術語都進了對照表", [...map.entries()], [[1, "NG tube"], [2, "tube feeding"]]);
}
{
  const { prepared, map } = protectTerms("今天天氣很好", [NG, FEED]);
  check("沒有術語就不動原文", prepared, "今天天氣很好");
  check("沒有術語時對照表是空的", map.size, 0);
}

// ── restoreTerms ───────────────────────────────────────────────────────────
const map2 = new Map<number, string>([[1, "NG tube"], [2, "tube feeding"]]);

check(
  "MT 把 XX 併成一個 X 時，兩個術語都還原得回來（舊版會留下 y2yX 碎片）",
  restoreTerms("Use Xy1yXy2yX daily", map2),
  "Use NG tube tube feeding daily",
);
check(
  "重疊字串不再騙過遺失偵測（舊版會誤判成沒遺失、不補救）",
  /（/.test(restoreTerms("Use Xy1yXy2yX daily", map2)),
  false,
);
check(
  "語序重排後仍依編號還原，不依位置",
  restoreTerms("Xy2yX before Xy1yX", map2),
  "tube feeding before NG tube",
);
check(
  "哨符被整個吃掉 → 術語補在句尾，不讓照顧指示消失",
  restoreTerms("Something else entirely", map2),
  "Something else entirely（NG tube、tube feeding）",
);
check(
  "缺一個 X 也還原得回來（MT 偶爾會吃掉頭或尾）",
  restoreTerms("take Xy1yX and y2yX now", map2),
  "take NG tube and tube feeding now",
);
check(
  "不是我們發出去的編號 → 原樣保留，不亂動",
  restoreTerms("Xy9yX", new Map([[1, "NG tube"]])),
  "Xy9yX（NG tube）",
);
check(
  "對照表是空的就原樣回傳（連空白都不動，快取才一致）",
  restoreTerms("  a   b  ", new Map()),
  "  a   b  ",
);
check(
  "留白造成的多餘空格與標點前空白會收乾淨",
  restoreTerms("請幫她 Xy3yX 。", new Map([[3, "拍背"]])),
  "請幫她 拍背。",
);
// ── 補分隔空白：只在「用空白斷詞的文字」才補 ─────────────────────────────
check(
  "韓文相鄰術語要補空白（韓文用空白斷詞，只看 ASCII 會漏掉）",
  restoreTerms("Xy1yXy2yX", new Map([[1, "비위관"], [2, "경관 영양"]])),
  "비위관 경관 영양",
);
check(
  "日文相鄰術語不補空白（中日文沒有詞間空白，硬塞反而不自然）",
  restoreTerms("Xy1yXy2yX", new Map([[1, "経鼻胃管"], [2, "経管栄養"]])),
  "経鼻胃管経管栄養",
);
check(
  "泰文相鄰術語不補空白",
  restoreTerms("Xy1yXy2yX", new Map([[1, "เคาะปอด"], [2, "ให้อาหารทางสาย"]])),
  "เคาะปอดให้อาหารทางสาย",
);
check(
  "越南文相鄰術語要補空白（變音符號不是 ASCII，但越南文用空白斷詞）",
  restoreTerms("Xy1yXy2yX", new Map([[1, "vỗ lưng"], [2, "ống thông dạ dày"]])),
  "vỗ lưng ống thông dạ dày",
);

check("大小寫不敏感", restoreTerms("xY1Yx", map2), "NG tube（tube feeding）");

// ── protect → 模擬 MT → restore 的來回 ─────────────────────────────────────
{
  const { prepared, map } = protectTerms("記得幫她拍背，還有鼻胃管灌食。", [NG, FEED, PAT]);
  // 模擬 MT：把中文換掉、順序打亂、把哨符旁的空白吃掉，但哨符本體留著。
  const mtOutput = prepared
    .replace("記得幫她", "Remember to help her with ")
    .replace("，還有", ", and ")
    .replace("。", ".")
    .replace(/ {2,}/g, " ");
  const out = restoreTerms(mtOutput, map);
  check("來回之後三個術語都在", [NG, FEED, PAT].every((t) => out.includes(t.target_term)), true);
  check("來回之後沒有哨符碎片外洩", /\bX?y\d+yX?\b/i.test(out), false);
}

console.log(`\n失敗數: ${failures}`);
if (failures > 0) process.exitCode = 1;
