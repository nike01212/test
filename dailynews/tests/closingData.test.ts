import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isLimitUp,
  loadTpexQuotes,
  misUrl,
  NotPublished,
  parseMisQuotes,
  parseTpexQuotes,
  parseTwseCloses,
  parseTwseLimits,
  readSnapshot,
  Replaced,
  scanRows,
  snapshotText,
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
  assert.throws(() => parseMisQuotes(text, "2026-10-21"), Replaced);
  assert.throws(() => parseMisQuotes(text, "2026-10-21"), /只有 10\/22 的資料/);
  assert.throws(() => parseMisQuotes(text, "2026-10-27"), NotPublished);
  assert.throws(() => parseMisQuotes("<html>擋掉了</html>", "2026-10-22"), /不是資料/);
  // 盤中查（當天 11:05）：還沒收盤
  const open = text
    .replaceAll('"t":"13:30:00"', '"t":"11:05:00"')
    .replace('"sysDate":"20261023"', '"sysDate":"20261022"')
    .replace('"sysTime":"17:22:31"', '"sysTime":"11:05:10"');
  assert.throws(() => parseMisQuotes(open, "2026-10-22"), NotPublished);
});

test("即時報價系統：查的時候已經收盤了，某一檔時間停在更早（例如暫停交易）也照樣用", async () => {
  const text = await fixture("mis-20261022.json");
  const halted = text.replace('"t":"13:30:00"', '"t":"10:15:00"');
  assert.notEqual(halted, text);
  assert.equal(parseMisQuotes(halted, "2026-10-22").size, parseMisQuotes(text, "2026-10-22").size);
  // 當天 14:00 以後查也算收盤了；13:40 還不算
  const sameDay = (time: string) =>
    halted.replace('"sysDate":"20261023"', '"sysDate":"20261022"').replace('"sysTime":"17:22:31"', `"sysTime":"${time}"`);
  assert.equal(parseMisQuotes(sameDay("14:30:05"), "2026-10-22").get("3691")?.close, 109);
  assert.throws(() => parseMisQuotes(sameDay("13:40:00"), "2026-10-22"), NotPublished);
});

test("上櫃收盤快照：每一檔都存，查不到的存 null，讀回來一樣", async () => {
  const quotes = parseMisQuotes(await fixture("mis-20261022.json"), "2026-10-22");
  const text = snapshotText(["3691", "4304", "5455", "9999"], quotes);
  assert.equal(text, '{"3691":[109,109],"4304":[18.15,18.15],"5455":[null,33.95],"9999":[null,null]}');
  const back = readSnapshot(text, ["3691", "5455", "9999", "1234"]);
  assert.deepEqual([...back], [
    ["3691", { close: 109, limitUp: 109 }],
    ["5455", { close: null, limitUp: 33.95 }],
    ["9999", { close: null, limitUp: null }],
  ]); // 1234 不在快照裡
  assert.equal(isLimitUp(back.get("3691")), true);
});

test("櫃買：前一個交易日沒資料（颱風假）就再往前找漲停價", async () => {
  const files: Record<string, string> = {
    "2026/10/22": "tpex-20261022.json",
    "2026/10/21": "tpex-20261021.json",
  };
  const asked: string[] = [];
  const fetchText = async (url: string) => {
    const date = decodeURIComponent(/date=([^&]+)/.exec(url)![1]);
    asked.push(date);
    return fixture(files[date] ?? "tpex-20261023-empty.json");
  };
  // 假裝 10/22 的前一個交易日是沒資料的 10/23（行事曆還沒補上颱風假），再往前才是 10/21
  const prev: Record<string, string> = { "2026-10-22": "2026-10-23", "2026-10-23": "2026-10-21" };
  const quotes = await loadTpexQuotes("2026-10-22", new Set(["3691", "3105", "2073", "9999"]), fetchText, (d) => prev[d]);
  assert.deepEqual(asked, ["2026/10/22", "2026/10/23", "2026/10/21"]);
  assert.deepEqual(quotes.get("3691"), { close: 109, limitUp: 109 });
  assert.equal(quotes.get("2073")?.close, null); // 當天沒有成交
  assert.equal(quotes.has("9999"), false); // 櫃買中心沒有這檔
});
