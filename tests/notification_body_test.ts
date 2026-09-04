/**
 * 推播內文組裝的離線單元測試（不連網、不發推播）。
 *
 * 推播沒辦法用「發一則到真人裝置」來驗，所以把組裝抽成純函式在這裡釘住。
 * 四段式約定：body_prefix（姓名，永不翻）／body_prefix_tr（服務類型，翻）／
 * body（句子或 %s 模板，翻）／body_values（金額，翻完才填）。
 *
 * 跑法（在 care-api 目錄）：npx tsx tests/notification_body_test.ts
 */
import { composeBody, fillValues } from "../src/functions/send-notification.ts";

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

// ── 正常組裝（韓文使用者收到的樣子）────────────────────────────────────────
check(
  "姓名不翻、服務類型已翻、句子已翻",
  composeBody("陳美玉", "재택 동반", "새 예약이 있습니다", []),
  "陳美玉・재택 동반 새 예약이 있습니다",
);
check(
  "沒有服務類型時不留下孤零零的「・」",
  composeBody("陳美玉", "", "새 예약이 있습니다", []),
  "陳美玉 새 예약이 있습니다",
);
check(
  "沒有姓名時也不留下前導的「・」（刊登過期推播就是這種）",
  composeBody("", "재택 동반", "게시가 중단되었습니다", []),
  "재택 동반 게시가 중단되었습니다",
);
check(
  "兩段前綴都空就只剩句子",
  composeBody("", "", "게시가 중단되었습니다", []),
  "게시가 중단되었습니다",
);

// ── 模板填值（金額不進機器翻譯）──────────────────────────────────────────────
check(
  "金額填進已翻好的模板，NT$ 留在模板裡",
  composeBody("", "", "보증금 미납금 NT$%s가 있습니다.", ["1200"]),
  "보증금 미납금 NT$1200가 있습니다.",
);
check(
  "沒有值就原樣保留佔位符，不會變成 undefined",
  fillValues("NT$%s", []),
  "NT$%s",
);
check(
  "值比佔位符少時，多出來的佔位符原樣保留",
  fillValues("%s 到 %s", ["1200"]),
  "1200 到 %s",
);
check(
  "%d 與 %s 都吃，依出現順序填",
  fillValues("%d 位・NT$%s", ["3", "1200"]),
  "3 位・NT$1200",
);
check(
  "值裡剛好有 % 也不會被當成佔位符再吃一次",
  fillValues("NT$%s", ["1200 (含 5% 手續費)"]),
  "NT$1200 (含 5% 手續費)",
);

// ── 中文使用者（不翻）走同一條組裝 ─────────────────────────────────────────
check(
  "zh-TW 使用者：原文照組，格式與外語一致",
  composeBody("陳美玉", "居家陪伴", "已成交，點我看詳情。", []),
  "陳美玉・居家陪伴 已成交，點我看詳情。",
);

console.log(`\n失敗數: ${failures}`);
if (failures > 0) process.exitCode = 1;
