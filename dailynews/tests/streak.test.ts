import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countStreaks, MAX_STREAK } from "../src/streak.ts";
import { assignTradingDay, isIsoDate, nextTradingDay, parseTaipeiLocal, previousTradingDay, previousTradingDays, type Calendar } from "../src/tradingDay.ts";

const readData = async (name: string) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const calendar: Calendar = await readData("holidays.json");
// 和 src/calendar.ts 一樣：證交所的行事曆加上手動補的臨時休市日
const closures = await readData("closures.json");
const withClosures: Calendar = { years: calendar.years, closed: { ...calendar.closed, ...closures.closed } };

const seen = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([c, days]) => [c, new Set(days)]));

test("前後一個開盤日：跳過週末和光復節補假", () => {
  assert.equal(nextTradingDay("2026-10-23", calendar), "2026-10-27");
  assert.equal(previousTradingDay("2026-10-27", calendar), "2026-10-23");
  assert.equal(previousTradingDay("2026-10-22", calendar), "2026-10-21");
  // 春節：最後交易日 2/11，開始交易日 2/23
  assert.equal(nextTradingDay("2026-02-11", calendar), "2026-02-23");
  assert.equal(previousTradingDay("2026-02-23", calendar), "2026-02-11");
});

test("往前 n 個開盤日，由近到遠", () => {
  assert.deepEqual(previousTradingDays("2026-10-28", calendar, 4), ["2026-10-27", "2026-10-23", "2026-10-22", "2026-10-21"]);
});

test("週末、休市日不算中斷：週四、週五、下週二連續 3 天（只用證交所行事曆）", () => {
  const days = previousTradingDays("2026-10-27", calendar, MAX_STREAK - 1);
  const streaks = countStreaks(["2330", "2317", "3105"], days, seen({
    2330: ["2026-10-23", "2026-10-22", "2026-10-20"], // 10/21 沒有，到 10/22 為止
    2317: ["2026-10-22"], // 10/23 沒有，就算 10/22 有也只有 1 天
  }));
  assert.equal(streaks.get("2330"), 3);
  assert.equal(streaks.get("2317"), 1);
  assert.equal(streaks.get("3105"), 1);
});

test("貼在休市日的不影響（只看開盤日）", () => {
  const days = previousTradingDays("2026-10-27", calendar, 5);
  const streaks = countStreaks(["2330"], days, seen({ 2330: ["2026-10-26", "2026-10-23"] }));
  assert.equal(streaks.get("2330"), 2);
});

test("最多算到 MAX_STREAK 天", () => {
  const days = previousTradingDays("2026-10-27", calendar, MAX_STREAK - 1);
  const streaks = countStreaks(["2330"], days, seen({ 2330: days }));
  assert.equal(streaks.get("2330"), MAX_STREAK);
});

test("臨時休市設定檔：日期格式正確、有寫原因、不是週末", () => {
  for (const [day, reason] of Object.entries(closures.closed)) {
    assert.ok(isIsoDate(day), day);
    assert.ok(typeof reason === "string" && reason.trim(), `${day} 要寫原因`);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    assert.ok(weekday !== 0 && weekday !== 6, `${day} 是週末，本來就不開盤`);
  }
});

test("10/23 颱風休市：前一個開盤日跳過它，那天早上貼的歸到 10/27", () => {
  assert.equal(previousTradingDay("2026-10-27", withClosures), "2026-10-22");
  assert.equal(nextTradingDay("2026-10-22", withClosures), "2026-10-27");
  assert.equal(assignTradingDay(parseTaipeiLocal("2026-10-23T08:00")!, withClosures).tradingDay, "2026-10-27");
  // 連續被提到：10/22 → 10/27 不算中斷
  const days = previousTradingDays("2026-10-27", withClosures, 3);
  assert.deepEqual(days, ["2026-10-22", "2026-10-21", "2026-10-20"]);
  assert.equal(countStreaks(["2330"], days, seen({ 2330: ["2026-10-22"] })).get("2330"), 2);
});
