import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isLimitUp,
  misUrl,
  NotPublished,
  parseMisQuotes,
  parseTpexQuotes,
  parseTwseCloses,
  parseTwseLimits,
  scanRows,
  toLimitUp,
  toPrice,
  tpexQuotesUrl,
  twseCloseUrl,
  twseLimitsUrl,
} from "../src/closingData.ts";

// tests/fixtures/ 是 2026/10/22 證交所、櫃買中心的真實資料，只留下幾檔
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("網址：證交所用 20261022，櫃買用 2026/10/22，即時報價系統一次查好幾檔", () => {
  assert.equal(
    misUrl([
      { code: "3691", market: "otc" },
      { code: "2465", market: "tse" },
    ]),
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=otc_3691.tw%7Ctse_2465.tw",
  );
  assert.match(twseLimitsUrl("2026-10-22"), /TWT84U\?.*date=20261022/);
  assert.match(twseCloseUrl("2026-10-22"), /MI_INDEX\?.*date=20261022/);
  assert.match(tpexQuotesUrl("2026-10-22"), /date=2026%2F10%2F22/);
});

test("價格：千分位、沒有成交、沒有漲跌幅限制", () => {
  assert.equal(toPrice("2,620.00"), 2620);
  assert.equal(toPrice("96.20"), 96.2);
  assert.equal(toPrice("--"), null);
  assert.equal(toPrice("----"), null);
  assert.equal(toPrice(""), null);
  assert.equal(toLimitUp("9,999.95"), null);
  // 川湖、信驊的漲停價超過 9,999.95，不能當成「沒有限制」
  assert.equal(toLimitUp("11,085.00"), 11085);
});

test("收盤漲停：收盤價等於漲停價才算，用分比較", () => {
  assert.equal(isLimitUp({ close: 96.2, limitUp: 96.2 }), true);
  assert.equal(isLimitUp({ close: 0.1 + 0.2, limitUp: 0.3 }), true);
  assert.equal(isLimitUp({ close: 96.1, limitUp: 96.2 }), false);
  assert.equal(isLimitUp({ close: null, limitUp: 96.2 }), false);
  assert.equal(isLimitUp({ close: 15, limitUp: null }), false);
  assert.equal(isLimitUp(undefined), false);
});

test("只解析需要的那幾列", () => {
  const text = '{"data":[["2330","台積電","1"],["2317","鴻海","2"],["00400A","ETF","3"]]}';
  const rows = scanRows(text, new Set(["2317", "9999"]));
  assert.deepEqual([...rows], [["2317", ["2317", "鴻海", "2"]]]);
});

test("證交所 10/22：麗臺、華經、暉盛-創 收盤漲停，台積電沒有", async () => {
  const codes = new Set(["1101", "2059", "2330", "2465", "2468", "7730", "0061"]);
  const limits = parseTwseLimits(await fixture("twse-limits-20261022.json"), "2026-10-22", codes);
  const closes = parseTwseCloses(await fixture("twse-close-20261022.json"), "2026-10-22", codes);
  assert.equal(limits.get("2465"), 96.2);
  assert.equal(limits.get("2059"), 11085);
  assert.equal(limits.get("0061"), null); // 沒有漲跌幅限制
  assert.equal(closes.get("2330"), 2385);
  const hits = [...codes].filter((c) => isLimitUp({ close: closes.get(c) ?? null, limitUp: limits.get(c) ?? null }));
  assert.deepEqual(hits.sort(), ["2465", "2468", "7730"]);
});

test("證交所：收盤行情還沒公布、日期不對", async () => {
  const codes = new Set(["2330"]);
  const empty = await fixture("twse-close-20261023-empty.json");
  assert.throws(() => parseTwseCloses(empty, "2026-10-23", codes), NotPublished);
  const text = await fixture("twse-close-20261022.json");
  assert.throws(() => parseTwseCloses(text, "2026-10-23", codes), /日期不對/);
});

test("證交所漲停價：要了還沒公布的日子會拿到舊的，用最近成交日擋下來", async () => {
  const text = await fixture("twse-limits-20261022.json");
  // 10/22 那份的最近成交日是 10/21，拿來當 10/21 的漲停價就不對
  assert.throws(() => parseTwseLimits(text, "2026-10-21", new Set(["2330"])), /日期不對/);
  assert.throws(() => parseTwseLimits('{"stat":"很抱歉，沒有符合條件的資料!"}', "2026-10-22", new Set(["2330"])), NotPublished);
});

test("櫃買 10/22：漲停價用 10/21 的次日漲停價，碩禾收盤漲停", async () => {
  const codes = new Set(["2073", "3105", "3691", "5274", "6488"]);
  const before = parseTpexQuotes(await fixture("tpex-20261021.json"), "2026-10-21", codes);
  const today = parseTpexQuotes(await fixture("tpex-20261022.json"), "2026-10-22", codes);
  assert.equal(today.get("3105")?.close, 486);
  assert.equal(today.get("2073")?.close, null); // 雄順當天沒有成交
  assert.equal(before.get("5274")?.nextLimitUp, 18165);
  const hits = [...codes].filter((c) =>
    isLimitUp({ close: today.get(c)?.close ?? null, limitUp: before.get(c)?.nextLimitUp ?? null }),
  );
  assert.deepEqual(hits, ["3691"]);
});

test("櫃買：還沒公布（筆數 0）、日期不對", async () => {
  const codes = new Set(["3105"]);
  const empty = await fixture("tpex-20261023-empty.json");
  assert.throws(() => parseTpexQuotes(empty, "2026-10-23", codes), NotPublished);
  const text = await fixture("tpex-20261022.json");
  assert.throws(() => parseTpexQuotes(text, "2026-10-23", codes), /日期不對/);
});

test("欄位改名就說格式變了，不會默默算錯", () => {
  const text = '{"stat":"OK","date":"20261022","fields":["證券代號","證券名稱","漲停價格"],"data":[["2330","台積電","1"]]}';
  assert.throws(() => parseTwseLimits(text, "2026-10-22", new Set(["2330"])), /格式變了/);
});


test("即時報價系統 10/22：最後一盤沒成交就用最後一筆成交價", async () => {
  const quotes = parseMisQuotes(await fixture("mis-20261022.json"), "2026-10-22");
  assert.deepEqual(quotes.get("3691"), { close: 109, limitUp: 109 }); // 碩禾：最後一盤成交在漲停
  assert.deepEqual(quotes.get("4304"), { close: 18.15, limitUp: 18.15 }); // 勝昱：漲停鎖住、最後一盤沒成交
  assert.deepEqual(quotes.get("2938"), { close: 17.85, limitUp: 19.65 });
  assert.deepEqual(quotes.get("5455"), { close: null, limitUp: 33.95 }); // 整天沒成交
  assert.deepEqual(quotes.get("2465"), { close: 96.2, limitUp: 96.2 }); // 上市的也查得到（麗臺）
  assert.equal(isLimitUp(quotes.get("4304")), true);
  assert.equal(isLimitUp(quotes.get("2938")), false);
});

test("即時報價系統：只有最近一個交易日，別天的資料不能用", async () => {
  const text = await fixture("mis-20261022.json");
  assert.throws(() => parseMisQuotes(text, "2026-10-21"), /只有 10\/22 的資料/);
  assert.throws(() => parseMisQuotes(text, "2026-10-27"), NotPublished);
  assert.throws(() => parseMisQuotes("<html>擋掉了</html>", "2026-10-22"), /不是資料/);
  const open = text.replaceAll('"t":"13:30:00"', '"t":"11:05:00"');
  assert.throws(() => parseMisQuotes(open, "2026-10-22"), NotPublished);
});
