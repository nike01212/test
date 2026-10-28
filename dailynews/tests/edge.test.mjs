// 用測試工程師的角度寫的（2026/10/28）：邊界值、奇怪的輸入、很長的內容、Windows 換行、設定檔之間對不對得起來。
// 這次找到的問題都改好了（說明在 PLAN.md「10/28 三個角度的測試」）；以後找到還沒改的問題，可以先寫成 todo（不算失敗）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAnswers, buildMatcher, makeTitle, normalize, pendingKey } from "../public/matcher.js";
import { sections, withPassages } from "../public/passage.js";
import { splitPaste } from "../public/split.js";
import { cleanUrl, findUrls, isFetchable } from "../public/links.js";
import { compileKeyword, mergeChange } from "../public/tagger.js";
import { csvText, fubonDsl, parseMitakeList, splitGroups } from "../public/export.js";
import { assignTradingDay, isIsoDate, parseTaipeiLocal } from "../src/tradingDay.ts";
import { countStreaks } from "../src/streak.ts";

const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const stocksData = await load("stocks.json");
const rules = await load("name-rules.json");
const holidays = await load("holidays.json");
const matcher = buildMatcher(stocksData, rules);
const calendar = { years: holidays.years, closed: holidays.closed };

const okCodes = (text) => matcher.analyze(text).mentions.filter((m) => m.status === "ok").map((m) => m.code);

// 固定種子的亂數，每次跑都一樣，出錯時重跑得出來
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

test("正規化：任何字串長度都不變（亂數字串，含全形、emoji、臺、換行），位置才對得回原文", () => {
  const pool = ["臺", "灣", "Ａ", "ｚ", "１", "（", "）", "　", "📈", "a", "Z", "9", "\n", "\r", "-", "．", "～", "！", "台積電", "(2330)"];
  const next = random(20261028);
  for (let i = 0; i < 500; i++) {
    let s = "";
    for (let n = Math.floor(next() * 40); n > 0; n--) s += pool[Math.floor(next() * pool.length)];
    assert.equal(normalize(s).length, s.length, JSON.stringify(s));
  }
});

test("空的、只有空白、只有符號：不會出錯，什麼都沒有", () => {
  for (const text of ["", "   ", "\n\n\r\n", "。，、！？", "()（）【】", "(    )"]) {
    const r = matcher.analyze(text);
    assert.deepEqual(r.mentions, [], JSON.stringify(text));
    assert.deepEqual(r.emerging, []);
  }
  assert.deepEqual(sections(""), []);
  assert.deepEqual(withPassages("", []), []);
  assert.deepEqual(splitPaste("   \n ").items, []);
});

test("很長的內容：12 萬字的 memo、20 萬字沒有標點，比對都在 1 秒內", () => {
  const long = `${"台積電擴產。".repeat(20000)}台積電第二句。台積電第三句。鴻海`;
  let t = performance.now();
  const r = matcher.analyze(long);
  assert.ok(performance.now() - t < 1000);
  assert.deepEqual(r.mentions.map((m) => m.code), ["2330", "2317"]);
  assert.deepEqual(r.mentions[0].sentences, ["台積電擴產。", "台積電第二句。"]); // 每檔最多 2 句、重複的不算
  t = performance.now();
  matcher.analyze("甲".repeat(200000));
  assert.ok(performance.now() - t < 1000);
});

test("括號代號：全形數字、全形括號、括號裡有空白、小寫 .two 都對得到；5 位數、3 位數不算", () => {
  for (const text of ["台積電（２３３０）", "台積電（２３３０．ＴＷ）", "( 2330 )", "(2330.two)", "（2330 TT）"]) {
    assert.deepEqual(okCodes(text), ["2330"], text);
  }
  assert.deepEqual(matcher.analyze("(23300)").mentions, []);
  assert.deepEqual(matcher.analyze("(233)").mentions, []);
  assert.deepEqual(okCodes("(2330)(2317)"), ["2330", "2317"]);
});

test("代號後綴的邊界：12330.TW、2330.TWA 不算；網址裡的 2330.TW 算", () => {
  assert.deepEqual(okCodes("12330.TW"), []);
  assert.deepEqual(okCodes("2330.TWA"), []);
  assert.deepEqual(okCodes("2330.TW,"), ["2330"]);
  assert.deepEqual(okCodes("https://tw.stock.yahoo.com/quote/2330.TW"), ["2330"]);
});

test("Windows 換行（CRLF）和一般換行比對、句子、每檔那一段的結果一樣", () => {
  const lf = "- 台積電擴產\n說明一\n- 鴻海接單\n說明二";
  const crlf = lf.replaceAll("\n", "\r\n");
  const a = matcher.analyze(lf);
  const b = matcher.analyze(crlf);
  assert.deepEqual(b.mentions.map((m) => [m.code, m.sentences]), a.mentions.map((m) => [m.code, m.sentences]));
  assert.deepEqual(
    withPassages(crlf, b.mentions).map((m) => m.passage.replaceAll("\r", "")),
    withPassages(lf, a.mentions).map((m) => m.passage),
  );
});

test("標題：第一個有字的行，剛好 60 字不加 …，61 字截成 60 字加 …", () => {
  assert.equal(makeTitle(`\n\n  ${"a".repeat(60)}  \nb`), "a".repeat(60));
  assert.equal(makeTitle("a".repeat(61)), `${"a".repeat(60)}…`);
  assert.equal(makeTitle(""), "");
});

test("切段：兩位數的編號（9. 10. 11.）照樣一項一段", () => {
  const text = "9.台積電\n10.鴻海\n11.聯發科";
  assert.deepEqual(sections(text).map(([s, e]) => text.slice(s, e)), ["9.台積電", "10.鴻海", "11.聯發科"]);
});

test("拆分：網址旁的說明 150 字以內算網址，151 字整段當文字；BOM、零寬字元拿掉", () => {
  assert.deepEqual(splitPaste(`${"說".repeat(150)} https://news.cnyes.com/news/id/123456`).items.map((i) => i.type), ["url"]);
  assert.deepEqual(splitPaste(`${"說".repeat(151)} https://news.cnyes.com/news/id/123456`).items.map((i) => i.type), ["text"]);
  assert.deepEqual(splitPaste("﻿台積電​漲").items, [{ type: "text", text: "台積電漲" }]);
});

test("網址清理：追蹤參數大寫、編碼過也拿掉；帳號密碼、# 拿掉；不是 http 的不收", () => {
  assert.equal(cleanUrl("https://ex.com/a?UTM_SOURCE=x&id=1"), "https://ex.com/a?id=1");
  assert.equal(cleanUrl("https://ex.com/a?%75tm_source=x&id=1"), "https://ex.com/a?id=1");
  assert.equal(cleanUrl("https://u:p@ex.com/a#frag"), "https://ex.com/a");
  assert.equal(cleanUrl("HTTP://WWW.UDN.COM/news/story/1/2?from=x"), "https://www.udn.com/news/story/1/2");
  for (const bad of ["javascript:alert(1)", "ftp://ex.com/a", "data:text/html,hi", "not a url", ""]) assert.equal(cleanUrl(bad), null, bad);
  assert.deepEqual(findUrls("看這篇https://ex.com/a(b)c）結束").map((u) => u.raw), ["https://ex.com/a(b)c"]);
});

test("伺服器只替人抓一般網站：各種寫法的本機、內部網路、IP 都擋", () => {
  for (const url of [
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://intranet/",
    "HTTP://LOCALHOST/",
    "http://example.com:8080/",
  ]) {
    assert.equal(isFetchable(url), false, url);
  }
  assert.equal(isFetchable("https://news.cnyes.com/news/id/123456"), true);
  assert.equal(isFetchable("http://example.com:443/"), true);
});

test("伺服器只替人抓一般網站：結尾多一個點的 localhost.、foo.localhost. 也擋（10/28 修的）", () => {
  assert.equal(isFetchable("http://localhost./"), false);
  assert.equal(isFetchable("http://localhost../"), false);
  assert.equal(isFetchable("http://foo.localhost./x"), false);
  assert.equal(isFetchable("http://metadata.google.internal./"), false);
  assert.equal(isFetchable("https://news.cnyes.com./news/id/123456"), true);
});

test("標籤關鍵字：* 最多隔 20 個字、不跨句；英文要整個字；只有 * 或空的不算", () => {
  const re = compileKeyword("營收*新高");
  assert.ok(re.test(`營收${"甲".repeat(20)}新高`));
  assert.ok(!re.test(`營收${"甲".repeat(21)}新高`));
  assert.ok(!re.test("營收。新高"));
  assert.ok(!re.test("營收\n新高"));
  assert.ok(!compileKeyword("ARM").test("ARMY"));
  assert.ok(compileKeyword("ARM").test("ARM架構"));
  assert.ok(compileKeyword("C++").test("C++新品")); // 特殊符號照字面比
  assert.equal(compileKeyword(""), null);
  assert.equal(compileKeyword("*"), null);
  assert.equal(compileKeyword(null), null);
});

test("預覽裡改標籤：同一個改動按兩次「完成」結果一樣", () => {
  const base = ["漲價"];
  const once = mergeChange(null, new Set(["擴產"]), base);
  assert.deepEqual(mergeChange(once, new Set(["擴產"]), base), once);
});

test("預覽裡回答待確認：回答的鑰匙對不上（內容改過）就照舊是待確認，不會弄丟", () => {
  const { mentions } = matcher.analyze("三星與台積電(2330)合作");
  const answers = new Map([["不存在的鑰匙", "5007"]]);
  assert.deepEqual(applyAnswers(mentions, answers), mentions);
  const key = pendingKey(mentions.find((m) => m.status === "pending"));
  assert.deepEqual(applyAnswers(mentions, new Map([[key, null]])).map((m) => m.code), ["2330"]);
});

test("匯出：CSV 名稱有逗號、引號、換行會包起來；超過 26 組接著用數字", () => {
  assert.equal(csvText([{ code: "2330", name: '台,"積\n電' }]), '﻿代號,名稱\r\n2330,"台,""積\n電"\r\n');
  const many = Array.from({ length: 27 * 60 + 1 }, (_, i) => ({ code: String(1000 + i) }));
  assert.deepEqual(splitGroups(many, "2026-10-28").map((g) => g.label).slice(-3), ["1028-Z", "1028-27", "1028-28"]);
  assert.deepEqual(splitGroups([], "2026-10-28"), [{ label: "1028", stocks: [] }]);
});

test("富邦檔：組名有 Big5 沒有的字會直接說，不會寫出亂碼的檔（網頁產生的組名只有數字和「延續性觀察」）", () => {
  assert.throws(() => fubonDsl([{ code: "2330" }], "1028-𠀀", "id"), /不能用 Big5 寫/);
  assert.ok(fubonDsl([{ code: "2330" }], "1028-延續性觀察", "id") instanceof Uint8Array);
});

test("三竹清單：第一列欄位前後有空白也認得；沒有 G1 那一列不收", () => {
  assert.ok(parseMitakeList("PID ,MTK \r\nG1,x\r\n"));
  assert.equal(parseMitakeList("PID,MTK\r\nG2,x,2330\r\n"), null);
  assert.equal(parseMitakeList(""), null);
});

test("日期：閏年、月底、格式不對的都分得出來", () => {
  assert.ok(isIsoDate("2028-02-29"));
  for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-5", "20261028", "2026-10-28T00:00", null, 20261028]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
  for (const bad of ["2026-10-23T24:00", "2026-10-23T9:00", "2026-10-23T08:60", "2026-02-30T08:00", "2026-10-23 08:00"]) {
    assert.equal(parseTaipeiLocal(bad), null, bad);
  }
});

test("09:00 的邊界：08:59:59.999 還是當天，09:00:00.000 就是下一個開盤日", () => {
  const nine = parseTaipeiLocal("2026-10-28T09:00");
  assert.equal(assignTradingDay(nine - 1, calendar).tradingDay, "2026-10-28");
  assert.equal(assignTradingDay(nine, calendar).tradingDay, "2026-10-29");
});

test("連續被提到：上限 1 天、清單外的代號都算 1 天", () => {
  const seen = new Map([["2330", new Set(["2026-10-22"])]]);
  assert.deepEqual([...countStreaks(["2330", "2317"], ["2026-10-22"], seen, 1)], [["2330", 1], ["2317", 1]]);
  assert.deepEqual([...countStreaks(["2330", "2317"], ["2026-10-22"], seen)], [["2330", 2], ["2317", 1]]);
  assert.deepEqual([...countStreaks([], ["2026-10-22"], seen)], []);
});

test("代號清單：4 碼、不重複、市場只有上市上櫃，和興櫃不重疊，至少 1,800 檔", () => {
  const codes = stocksData.stocks.map(([code]) => code);
  assert.ok(codes.length >= 1800, `只有 ${codes.length} 檔，來源格式可能變了`);
  assert.equal(new Set(codes).size, codes.length);
  for (const [code, name, market] of stocksData.stocks) {
    assert.match(code, /^\d{4}$/, code);
    assert.ok(name, code);
    assert.ok(market === "上市" || market === "上櫃", `${code} ${market}`);
  }
  const listed = new Set(codes);
  assert.deepEqual(stocksData.emerging.filter(([code]) => listed.has(code)), []);
});

test("比對規則：aliases、merged 打出來就對得到那一檔；ambiguous 的詞打出來都是待確認（沒有寫了沒作用的）", () => {
  for (const [word, code] of Object.entries({ ...rules.aliases, ...rules.merged })) {
    assert.deepEqual(okCodes(word), [code], word);
  }
  for (const word of rules.ambiguous) {
    const m = matcher.analyze(word).mentions;
    assert.ok(m.length === 1 && m[0].status === "pending" && m[0].raw === word, `ambiguous 的「${word}」沒有作用`);
  }
});

test("休市行事曆：涵蓋今年；明年還沒公布時只排除週末和元旦（交易日檢查會提醒）", () => {
  const year = Number(new Date().toISOString().slice(0, 4));
  assert.ok(holidays.years.includes(year), `holidays.json 沒有 ${year} 年，請跑 npm run update-data`);
  for (const date of Object.keys(holidays.closed)) assert.ok(isIsoDate(date), date);
});
