// 用交易者的角度寫的情境（2026/10/28）：拿每天真的會貼的外電整理、券商評等、新聞寫法來比對，
// 看清單上會出現哪幾檔、每檔留哪一段、貼什麼標籤、歸到哪一天。
// 這次找到的問題都改好了（說明在 PLAN.md「10/28 三個角度的測試」）；以後找到還沒改的問題，可以先寫成 todo（不算失敗）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMatcher } from "../public/matcher.js";
import { sections, withPassages } from "../public/passage.js";
import { buildTagger } from "../public/tagger.js";
import { assignTradingDay, parseTaipeiLocal } from "../src/tradingDay.ts";

const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const matcher = buildMatcher(await load("stocks.json"), await load("name-rules.json"));
const tagger = buildTagger(await load("tags.json"), await load("big-companies.json"));
const holidays = await load("holidays.json");
const closures = await load("closures.json");
const calendar = { years: holidays.years, closed: { ...holidays.closed, ...closures.closed } };

const okCodes = (text) => matcher.analyze(text).mentions.filter((m) => m.status === "ok").map((m) => m.code);
const pendingRaws = (text) => matcher.analyze(text).mentions.filter((m) => m.status === "pending").map((m) => m.raw);

// 和預覽（app.js 的 itemState）一樣的順序：比對 → 每檔那一段 → 標籤（文字類）
function preview(text) {
  const analysis = matcher.analyze(text);
  const mentions = withPassages(text, analysis.mentions);
  const tagged = tagger.tagMentions(text, mentions, { sections: sections(text), others: analysis.emergingSpans });
  return new Map(tagged.map((m) => [m.code ?? m.raw, m]));
}

const morningMemo = [
  "早安！10/28 外電綜合整理",
  "",
  "- 2327國巨: 美系重申正向",
  "被動元件報價持續上揚，MLCC 交期拉長，目標價調升至 900 元。",
  "",
  "- 2330台積電: 日系調升目標價至 1,800 元",
  "CoWoS 產能滿載，先進封裝明年再擴產。",
  "",
  "- 3017奇鋐: 與輝達合作液冷，獲追加訂單",
].join("\n");

test("早安外電整理：代號黏在名稱前面也對得到，每檔留自己那一項，開頭的問候不算任何一檔", () => {
  const items = preview(morningMemo);
  assert.deepEqual([...items.keys()], ["2327", "2330", "3017"]);
  assert.equal(items.get("2327").passage, "- 2327國巨: 美系重申正向\n被動元件報價持續上揚，MLCC 交期拉長，目標價調升至 900 元。");
  assert.ok(items.get("2330").passage.endsWith("先進封裝明年再擴產。"));
  for (const m of items.values()) assert.ok(!m.passage.includes("早安"), m.code);
  // 奇鋐那一行自己寫了合作、追加訂單、輝達
  assert.deepEqual(items.get("3017").tags, ["新訂單", "合作"]);
  assert.deepEqual(items.get("3017").partners, ["輝達（NVIDIA）"]);
  assert.deepEqual(items.get("2330").tags.includes("調升目標價"), true);
});

test("外電整理：國巨那一項第二行寫了報價上揚、目標價調升，標籤有漲價、調升目標價（10/28 改的）", () => {
  // 以前只看寫到國巨的那一行，第二行的內容算不到
  const items = preview(morningMemo);
  assert.deepEqual(items.get("2327").tags, ["漲價", "調升目標價"]);
  assert.deepEqual(items.get("2330").tags, ["供不應求", "擴產", "調升目標價"]);
  assert.deepEqual(items.get("3017").tags, ["新訂單", "合作"]);
});

test("標籤整段算的前提是那一段只有這一檔：同一段寫了別檔、待確認或興櫃股，只看寫到它的那幾行", () => {
  // 鴻海那行的「報價上揚」不會貼到台積電；同一行寫了兩檔的（第一行）兩檔都算，和以前一樣
  let items = preview("- 2330台積電、2317鴻海: 台積電調升目標價\n鴻海報價上揚\n\n- 2454聯發科: 擴產");
  assert.deepEqual(items.get("2330").tags, ["調升目標價"]);
  assert.deepEqual(items.get("2317").tags, ["漲價", "調升目標價"]);
  assert.deepEqual(items.get("2454").tags, ["擴產"]);
  // 興櫃股宏偉的「接獲新訂單」不會貼到國巨
  items = preview("- 2327國巨: 報價上揚\n宏偉(4565)接獲新訂單\n\n- 2330台積電: 擴產");
  assert.deepEqual(items.get("2327").tags, ["漲價"]);
  // 待確認的三星那行不算台積電的
  items = preview("- 2330台積電: 與三星合作\n三星報價上揚\n\n- 2317鴻海: 持平");
  assert.deepEqual(items.get("2330").tags, ["合作"]);
  // 只有一檔上市櫃股、另外寫了興櫃股：不再整則都算它的
  items = preview("台積電擴產。\n\n宏偉電機（4565）接獲新訂單");
  assert.deepEqual(items.get("2330").tags, ["擴產"]);
  // 開頭的問候（沒寫任何一檔）不算任何一檔的
  items = preview("早安，費半創新高，蘋果漲價\n\n- 2330台積電: 持平\n\n- 2317鴻海: 持平");
  assert.deepEqual([...items.values()].map((m) => m.tags), [[], []]);
  // 沒有項目符號、空一行隔開的段落：一段只有一檔就整段算它的
  items = preview("台積電今天法說會，\n產能滿載。\n\n鴻海表示接獲新訂單。");
  assert.deepEqual(items.get("2330").tags, ["供不應求"]);
  assert.deepEqual(items.get("2317").tags, ["新訂單"]);
});

test("券商報告的代號寫法：(2330-TW)、(2330.TT)、(2330 TT)、2330.TW、代號黏在名稱前後", () => {
  for (const text of ["台積電(2330-TW)", "台積電（2330.TT）", "TSMC (2330 TT)", "台積電 2330.TW", "2330 台積電", "2330台積電", "台積電2330"]) {
    assert.deepEqual(okCodes(text), ["2330"], text);
  }
  assert.deepEqual(okCodes("國巨*(2327)：維持買進"), ["2327"]);
  assert.deepEqual(okCodes("統一1216、統一超(2912)"), ["1216", "2912"]);
});

test("名稱長短不同的兩檔不會搞混：南亞科、南電、長榮航太、長榮航、長榮", () => {
  assert.deepEqual(okCodes("南亞科技"), ["2408"]);
  assert.deepEqual(okCodes("南亞電路板"), ["8046"]);
  assert.deepEqual(okCodes("長榮航太"), ["2645"]);
  assert.deepEqual(okCodes("長榮航"), ["2618"]);
  assert.deepEqual(okCodes("長榮"), ["2603"]);
  assert.deepEqual(okCodes("華邦電、鴻準、台達電、緯穎、力積電"), ["2344", "2354", "2308", "6669", "6770"]);
  // 「南亞」也是一般用語（東南亞、南亞地區），要問
  assert.deepEqual(pendingRaws("南亞"), ["南亞"]);
});

test("股價、張數、金額、目標價不會變成代號", () => {
  assert.deepEqual(okCodes("台積電1050元，外資賣超2萬張"), ["2330"]);
  assert.deepEqual(okCodes("營收2330億元，年增15%"), []);
  assert.deepEqual(okCodes("目標價(1,600)"), []);
  assert.deepEqual(pendingRaws("目標價(1,600)"), []);
});

test("新聞寫「今(2026)年」「去(2025)年」「明(2027)年」：括號裡的年份不是代號（10/28 修的）", () => {
  // 以前 2025 千興、2027 大成鋼會被加進清單，2026 變成待確認
  assert.deepEqual(okCodes("台積電今(2026)年營收將創高"), ["2330"]);
  assert.deepEqual(okCodes("鴻海去(2025)年第4季"), ["2317"]);
  assert.deepEqual(okCodes("聯發科明(2027)年推出新品"), ["2454"]);
  for (const text of ["今（2026）年", "今年(2026)EPS 預估", "明年（2027）產能倍增", "預計（2028）年量產", "後(2028)年"]) {
    assert.deepEqual(matcher.analyze(text).mentions, [], text);
  }
  // 名稱緊接著代號、或寫了 .TW 的，照樣是代號
  assert.deepEqual(okCodes("大成鋼(2027)"), ["2027"]);
  assert.deepEqual(okCodes("(2027)大成鋼"), ["2027"]);
  assert.deepEqual(okCodes("千興(2025)今年營收"), ["2025"]);
  assert.deepEqual(okCodes("大成鋼（2027）明(2027)年擴產"), ["2027"]);
  assert.deepEqual(okCodes("(2025)"), ["2025"]);
  assert.deepEqual(okCodes("明(2027.TW)年"), ["2027"]);
});

test("投顧、大學當出處時不是在講那一檔（10/28 加進 name-rules.json 的 ignore）", () => {
  for (const text of ["第一金投顧指出", "統一投顧表示", "宏遠投顧看好", "大同大學研究團隊", "長榮大學"]) {
    assert.deepEqual(matcher.analyze(text).mentions, [], text);
  }
  // 真的在講那一檔的照樣對得到
  assert.deepEqual(okCodes("第一金投顧指出，第一金獲利創高；大同、長榮營收成長"), ["2892", "2371", "2603"]);
  assert.deepEqual(pendingRaws("統一投顧看好統一"), ["統一"]);
});

test("其他投顧當出處本來就不會對到（元大、凱基、群益、永豐、富邦、國泰）", () => {
  for (const text of ["元大投顧指出", "凱基投顧表示", "群益投顧", "永豐投顧", "富邦投顧", "國泰證券", "【永豐投顧】評等調整"]) {
    assert.deepEqual(matcher.analyze(text).mentions, [], text);
  }
});

test("合併、改名的公司，新聞寫舊名字也對得到：新光金、台新金、開發金、晶電（10/28 加的）", () => {
  assert.deepEqual(okCodes("新光金"), ["2887"]);
  assert.deepEqual(okCodes("新光金控、台新金控"), ["2887"]);
  assert.deepEqual(okCodes("台新金"), ["2887"]);
  assert.deepEqual(okCodes("開發金"), ["2883"]);
  assert.deepEqual(okCodes("晶電"), ["3714"]);
  // 下市併進別家的（merged）在清單上標「新聞寫「新光金」」；改名的（aliases）不標
  const r = matcher.analyze("新光金壽險獲利回升");
  assert.deepEqual(matcher.formerNames("2887", r.mentions[0].sentences), ["新光金"]);
  assert.deepEqual(matcher.formerNames("2887", ["台新金今天法說會"]), []);
  // 名稱裡有「晶電」的別檔不受影響
  assert.deepEqual(okCodes("嘉晶電子、光聚晶電"), ["3016", "6111"]);
});

test("只寫興櫃股名稱、沒寫代號：名稱裡的上市櫃股名稱不算（特力屋不是特力，10/28 改的）", async () => {
  assert.deepEqual(okCodes("特力屋今年展店"), []);
  assert.deepEqual(matcher.analyze("特力屋今年展店").emerging, [{ code: "7867", name: "特力屋" }]);
  // 同一則另外寫的特力、宏碁照算
  assert.deepEqual(okCodes("特力集團旗下特力屋"), ["2908"]);
  assert.deepEqual(okCodes("宏碁創達、宏碁智醫，母公司宏碁"), ["2353"]);
  // 類似的 19 檔（名稱裡有上市櫃股名稱的興櫃股）沒寫代號也都不會對到上市櫃股、不會多出待確認
  const { emerging } = await load("stocks.json");
  const similar = ["智通聯網", "久裕興", "大同精化", "達輝光電", "雷虎生", "昱厚生技", "光鼎生技", "宏碁智醫", "大江基因", "益鈞環科", "捷立康", "宏碁創達", "訊聯智藥", "經貿聯網", "金聯成", "特力屋", "宇川精材", "中華立鼎", "亞昕科技"];
  for (const name of similar) {
    const r = matcher.analyze(`${name}今年營收創新高`);
    assert.deepEqual(r.mentions, [], name);
    assert.deepEqual(r.emerging.map((e) => e.name), [name]);
  }
  for (const [, name] of emerging) assert.deepEqual(matcher.analyze(name).mentions, [], name);
  // 其他興櫃名稱照舊不比對（很多是一般用語）
  assert.deepEqual(matcher.analyze("宏偉電機在手訂單翻倍").emerging, []);
});

test("ETF：4 碼的（0050、0056）變待確認並說明可能是 ETF，5 碼的（00878）不理", () => {
  const r = matcher.analyze("元大高股息(0056)、國泰永續高股息(00878)成交量放大");
  assert.deepEqual(r.mentions.map((m) => m.status), ["pending"]);
  assert.match(r.mentions[0].reason, /代號 0056 不在上市櫃清單裡（可能是 ETF/);
});

test("所屬交易日：週五盤後歸下週一，跨年歸 1/4 並提醒明年行事曆還沒公布，颱風假、補假都跳過", () => {
  const at = (local) => assignTradingDay(parseTaipeiLocal(local), calendar);
  assert.equal(at("2026-10-30T21:00").tradingDay, "2026-11-02");
  assert.equal(at("2026-12-31T08:59").tradingDay, "2026-12-31");
  const newYear = at("2026-12-31T09:00");
  assert.equal(newYear.tradingDay, "2027-01-04");
  assert.deepEqual(newYear.missingYears, [2027]);
  // 10/22（四）收盤後貼的，10/23 颱風休市、10/26 光復節補假，歸到 10/27（二）
  assert.equal(at("2026-10-22T20:00").tradingDay, "2026-10-27");
  assert.deepEqual(at("2026-10-22T20:00").skipped.map((d) => d.date), ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
});
