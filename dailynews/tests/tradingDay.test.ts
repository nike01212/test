import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assignTradingDay, parseTaipeiLocal, type Calendar } from "../src/tradingDay.ts";

const calendar: Calendar = JSON.parse(await readFile(new URL("../public/data/holidays.json", import.meta.url), "utf8"));

function assign(local: string) {
  const ms = parseTaipeiLocal(local);
  assert.ok(ms !== null, local);
  return assignTradingDay(ms, calendar);
}

test("平日 08:30 → 當天", () => {
  const a = assign("2026-10-22T08:30");
  assert.equal(a.tradingDay, "2026-10-22");
  assert.equal(a.rule, "before_open");
});

test("09:00 整點起就算下一個開盤日", () => {
  assert.equal(assign("2026-10-22T08:59").tradingDay, "2026-10-22");
  assert.equal(assign("2026-10-22T09:00").tradingDay, "2026-10-23");
});

test("平日 14:00 → 隔天", () => {
  const a = assign("2026-10-22T14:00");
  assert.equal(a.tradingDay, "2026-10-23");
  assert.equal(a.rule, "after_open");
});

test("週五 21:00 → 跳過週末和週一的光復節補假，到週二", () => {
  const a = assign("2026-10-23T21:00");
  assert.equal(a.tradingDay, "2026-10-27");
  assert.deepEqual(
    a.skipped.map((s) => s.date),
    ["2026-10-24", "2026-10-25", "2026-10-26"],
  );
  assert.match(a.skipped[2].reason, /光復/);
});

test("週末、休市日當天早上 → 下一個開盤日", () => {
  const sat = assign("2026-10-24T08:00");
  assert.equal(sat.tradingDay, "2026-10-27");
  assert.equal(sat.rule, "closed");
  assert.equal(sat.closedReason, "週六");
  assert.equal(assign("2026-10-26T08:00").tradingDay, "2026-10-27");
});

test("春節：最後交易日早上照常、下午跳到年後開始交易日", () => {
  assert.equal(assign("2026-02-11T08:00").tradingDay, "2026-02-11");
  assert.equal(assign("2026-02-11T14:00").tradingDay, "2026-02-23");
});

test("行事曆還沒公布的年份：至少排除週末和元旦，並提醒", () => {
  const a = assign("2026-12-31T14:00");
  assert.equal(a.tradingDay, "2027-01-04");
  assert.deepEqual(a.missingYears, [2027]);
});

test("時區：用 UTC 時間算也一樣是台北時間", () => {
  // 台北 2026-10-23 08:30 = UTC 2026-10-23 00:30
  assert.equal(assignTradingDay(Date.UTC(2026, 9, 23, 0, 30), calendar).tradingDay, "2026-10-23");
  // 台北 2026-10-23 09:30 = UTC 01:30
  assert.equal(assignTradingDay(Date.UTC(2026, 9, 23, 1, 30), calendar).tradingDay, "2026-10-27");
});

test("時間格式不對回傳 null", () => {
  assert.equal(parseTaipeiLocal("2026-13-01T08:00"), null);
  assert.equal(parseTaipeiLocal("2026-10-23 08:00"), null);
  assert.equal(parseTaipeiLocal("2026-10-23T24:00"), null);
});
