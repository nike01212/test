import { test } from "node:test";
import assert from "node:assert/strict";
import { codesText, csvText, dayLabel, GROUP_SIZE, splitGroups, watchGroups } from "../public/export.js";

const make = (n) => Array.from({ length: n }, (_, i) => ({ code: String(1101 + i), name: `股${i}` }));

test("組名用月日", () => {
  assert.equal(dayLabel("2026-10-24"), "1024");
  assert.equal(dayLabel("2027-01-04"), "0104");
});

test("60 檔以內一組，組名就是日期", () => {
  const groups = splitGroups(make(GROUP_SIZE), "2026-10-24");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "1024");
  assert.equal(groups[0].stocks.length, 60);
});

test("超過 60 檔拆成 A、B 組，照原本的排序切", () => {
  const stocks = make(75);
  const groups = splitGroups(stocks, "2026-10-24");
  assert.deepEqual(
    groups.map((g) => [g.label, g.stocks.length]),
    [
      ["1024-A", 60],
      ["1024-B", 15],
    ],
  );
  assert.equal(groups[0].stocks[0], stocks[0]);
  assert.equal(groups[1].stocks[0], stocks[60]);
});

test("超過 120 檔接著用 C 組", () => {
  assert.deepEqual(
    splitGroups(make(121), "2026-10-24").map((g) => g.label),
    ["1024-A", "1024-B", "1024-C"],
  );
});

test("延續性觀察另外一組：1024-延續性觀察", () => {
  assert.deepEqual(watchGroups([], "2026-10-24"), []);
  const groups = watchGroups(make(3), "2026-10-24");
  assert.deepEqual(groups.map((g) => [g.label, g.stocks.length]), [["1024-延續性觀察", 3]]);
  assert.deepEqual(
    watchGroups(make(61), "2026-10-24").map((g) => g.label),
    ["1024-延續性觀察-A", "1024-延續性觀察-B"],
  );
});

test("複製和 .txt：一行一個代號", () => {
  assert.equal(codesText(make(3)), "1101\n1102\n1103");
});

test("CSV：UTF-8 BOM、代號名稱兩欄、CRLF", () => {
  const csv = csvText([
    { code: "2330", name: "台積電" },
    { code: "3661", name: "世芯-KY" },
  ]);
  assert.equal(csv, "﻿代號,名稱\r\n2330,台積電\r\n3661,世芯-KY\r\n");
  // Blob 會把字串存成 UTF-8，開頭三個位元組就是 BOM
  assert.deepEqual([...Buffer.from(csv, "utf8").subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("CSV：有逗號或引號的欄位會加引號", () => {
  assert.equal(csvText([{ code: "9999", name: 'A,"B"' }]), '﻿代號,名稱\r\n9999,"A,""B"""\r\n');
});
