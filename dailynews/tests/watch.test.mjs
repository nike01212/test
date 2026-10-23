import { test } from "node:test";
import assert from "node:assert/strict";
import { uncheckedCount, watchItems } from "../public/watch.js";

// 10/27 這一頁的清單（畫面上的順序），10/22 收盤比對的結果
const stocks = [
  { code: "2465", name: "麗臺", market: "上市" },
  { code: "2330", name: "台積電", market: "上市" },
  { code: "3691", name: "碩禾", market: "上櫃" },
  { code: "6213", name: "聯茂", market: "上櫃" },
];
const checks = { 2465: 1, 2330: 0, 3691: 1 }; // 聯茂還沒比對

test("清單上前一個交易日收盤漲停的，依清單的順序列出來", () => {
  const items = watchItems(stocks, { checks, manual: [], removed: [] });
  assert.deepEqual(
    items.map((i) => [i.code, i.source]),
    [
      ["2465", "auto"],
      ["3691", "auto"],
    ],
  );
});

test("手動移出的不顯示；手動加的接在後面，已經自動在裡面的不重複", () => {
  const items = watchItems(stocks, {
    checks,
    removed: ["3691"],
    manual: [
      { code: "2317", name: "鴻海", market: "上市" },
      { code: "2465", name: "麗臺", market: "上市" },
    ],
  });
  assert.deepEqual(
    items.map((i) => [i.code, i.source]),
    [
      ["2465", "auto"],
      ["2317", "manual"],
    ],
  );
});

test("刪掉清單上的個股，延續性觀察也跟著不見（自動加的一定在清單裡）", () => {
  const items = watchItems(stocks.slice(1), { checks, manual: [], removed: [] });
  assert.deepEqual(items.map((i) => i.code), ["3691"]);
});

test("還沒比對過收盤的有幾檔", () => {
  assert.equal(uncheckedCount(stocks, { checks }), 1);
  assert.equal(uncheckedCount(stocks, { checks: {} }), 4);
  assert.equal(uncheckedCount([], { checks }), 0);
});
