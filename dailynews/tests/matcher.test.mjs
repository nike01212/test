import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAnswers, buildMatcher, normalize, pendingKey } from "../public/matcher.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const matcher = buildMatcher(await load("stocks.json"), await load("name-rules.json"));

const okCodes = (r) => r.mentions.filter((m) => m.status === "ok").map((m) => m.code);
const pendings = (r) => r.mentions.filter((m) => m.status === "pending");

test("正規化不改變長度", () => {
  const s = "臺積電（２３３０）ｔｓｍｃ　好";
  assert.equal(normalize(s).length, s.length);
  assert.equal(normalize(s), "台積電(2330)TSMC 好");
});

test("券商 memo：名稱、代號、提到次數與句子", () => {
  const r = matcher.analyze(
    [
      "【永豐投顧】評等調整",
      "台積電(2330)：維持買進，目標價上調至1,600元。",
      "聯發科（2454）調升至買進。",
      "世芯-KY(3661)：中立。",
      "統一 1216 維持中立；統一超(2912)買進。",
      "鴻海與輝達合作，廣達、緯創同步受惠。",
      "台積電先進製程產能滿載。",
      "台積電第三句不該出現。",
    ].join("\n"),
  );
  assert.equal(r.title, "【永豐投顧】評等調整");
  assert.deepEqual(okCodes(r).sort(), ["1216", "2317", "2330", "2382", "2454", "2912", "3231", "3661"]);
  const tsmc = r.mentions.find((m) => m.code === "2330");
  assert.deepEqual(tsmc.sentences, ["台積電(2330)：維持買進，目標價上調至1,600元。", "台積電先進製程產能滿載。"]);
  assert.equal(pendings(r).length, 0);
});

test("一般詞彙：易混淆的標待確認，常見詞直接略過", () => {
  const r = matcher.analyze("創意與東南亞客戶合作，全新產品大量出貨。");
  assert.deepEqual(okCodes(r), []);
  const p = pendings(r);
  assert.equal(p.length, 1);
  assert.equal(p[0].raw, "創意");
  assert.deepEqual(p[0].candidates, ["3443"]);
});

test("一般詞彙旁邊有正確代號就直接對上", () => {
  assert.deepEqual(okCodes(matcher.analyze("創意(3443)接單暢旺")), ["3443"]);
  assert.deepEqual(okCodes(matcher.analyze("全新(2455)營收創高")), ["2455"]);
});

test("同一則前面確定過，後面同名的就不再待確認", () => {
  const r = matcher.analyze("統一(1216)公布營收。統一今年展店。");
  assert.deepEqual(okCodes(r), ["1216"]);
  assert.equal(pendings(r).length, 0);
  assert.equal(r.mentions[0].sentences.length, 2);
});

test("名稱和代號對不起來 → 待確認，兩檔都是候選", () => {
  const p = pendings(matcher.analyze("台積電(2303)擴產"));
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].candidates.sort(), ["2303", "2330"]);
});

test("「台積電(2330)聯電」：前一檔的代號不會算到後一檔", () => {
  const r = matcher.analyze("台積電(2330)聯電(2303)");
  assert.deepEqual(okCodes(r).sort(), ["2303", "2330"]);
  assert.equal(pendings(r).length, 0);
});

test("同名對到兩檔 → 待確認", () => {
  const p = pendings(matcher.analyze("台南營收"));
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].candidates.sort(), ["1473", "5906"]);
});

test("清單裡沒有的代號 → 待確認", () => {
  const p = pendings(matcher.analyze("元大台灣50(0050)成交量放大"));
  assert.equal(p.length, 1);
  assert.match(p[0].raw, /0050/);
  assert.deepEqual(p[0].candidates, []);
  assert.equal(p[0].reason, "代號 0050 不在上市櫃清單裡（可能是 ETF、興櫃或剛上市）");
});

test("改名的公司，新聞寫舊簡稱也對得到（2072 世紀風電 → 世紀能源）", () => {
  assert.deepEqual(okCodes(matcher.analyze("世紀風電、世紀能源")), ["2072"]);
});

test("興櫃股：不當待確認，另外列出來說不能加入（2026/10/28 宏偉電機）", async () => {
  // 工商時報 2026/10/28「半導體擴廠潮 宏偉在手訂單翻倍」的第一段；Yahoo 股市寫「宏偉(4565.TWO)」
  for (const text of ["工業用電梯製造商宏偉電機（4565）在手訂單規模較過往翻倍增長", "宏偉(4565.TWO) 技術分析"]) {
    const r = matcher.analyze(text);
    assert.deepEqual(r.mentions, [], text);
    assert.deepEqual(r.emerging, [{ code: "4565", name: "宏偉" }], text);
  }
  // 出現好幾次只列一次；和上市櫃股寫在一起，上市櫃股照舊
  const r = matcher.analyze("宏偉(4565)接單，宏偉(4565)擴產；台積電(2330)、盛新(6930)");
  assert.deepEqual(okCodes(r), ["2330"]);
  assert.deepEqual(pendings(r), []);
  assert.deepEqual(r.emerging, [{ code: "4565", name: "宏偉" }, { code: "6930", name: "盛新" }]);
  // 名稱是上市櫃股、旁邊的代號是興櫃股：以代號為準，當成興櫃股
  const c = matcher.analyze("宏碁(7706)");
  assert.deepEqual(c.mentions, []);
  assert.deepEqual(c.emerging, [{ code: "7706", name: "宏碁創達" }]);
  // 興櫃股的名稱緊接著它的代號：名稱開頭是上市櫃股的（特力屋的「特力」、宏碁創達的「宏碁」），上市櫃股不算
  for (const [code, name] of (await load("stocks.json")).emerging) {
    for (const text of [`${name}(${code})`, `${name} (${code})`]) {
      const x = matcher.analyze(text);
      assert.deepEqual(x.mentions, [], text);
      assert.deepEqual(x.emerging, [{ code, name }], text);
    }
  }
  assert.deepEqual(okCodes(matcher.analyze("特力屋(7867)，特力股價")), ["2908"]); // 後面另外寫的「特力」照算
  // 興櫃股不比對名稱，也搜尋不到；不在清單、也不是興櫃的代號照舊是待確認
  assert.deepEqual(matcher.analyze("宏偉電機在手訂單翻倍").mentions, []);
  assert.deepEqual(matcher.analyze("宏偉電機在手訂單翻倍").emerging, []);
  assert.deepEqual(matcher.search("4565"), []);
  assert.deepEqual(matcher.analyze("元大台灣50(0050)").emerging, []);
});

test("英文別名要整個字對上", () => {
  assert.deepEqual(okCodes(matcher.analyze("TSMC and Mediatek")).sort(), ["2330", "2454"]);
  assert.deepEqual(okCodes(matcher.analyze("ASUSTEK")), []);
});

test("全名、KY 簡寫、金控", () => {
  assert.deepEqual(okCodes(matcher.analyze("中華電信、富邦金控、世芯、日月光")).sort(), ["2412", "2881", "3661", "3711"]);
});

test("年份、價格不會被當成代號", () => {
  assert.deepEqual(okCodes(matcher.analyze("2025年營收1500億元，2030年目標")), []);
});

test("很長的句子只留提到個股的前後一段", () => {
  const long = `${"甲".repeat(200)}台積電${"乙".repeat(200)}`;
  const s = matcher.analyze(long).mentions[0].sentences[0];
  assert.ok(s.length < 160);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("台積電"));
});

test("搜尋：代號、名稱、別名", () => {
  assert.equal(matcher.search("2330")[0].code, "2330");
  assert.equal(matcher.search("台積")[0].code, "2330");
  assert.equal(matcher.search("聯發科")[0].code, "2454");
  assert.ok(matcher.search("世界先進").some((s) => s.code === "5347"));
});

test("常見詞組裡的股票名稱不算", () => {
  const r = matcher.analyze("新產品可成長兩成，資通訊需求強，公司致力成為龍頭，台灣大廠擴大成本優勢。");
  assert.deepEqual(r.mentions, []);
  assert.deepEqual(okCodes(matcher.analyze("可成(2474)、力成、新產")).sort(), ["2474", "2850", "6239"]);
});

test("前面確定「台南-KY」，後面的「台南」還是待確認", () => {
  const r = matcher.analyze("台南-KY(5906)營收創高，台南也公布營收。");
  assert.deepEqual(okCodes(r), ["5906"]);
  assert.deepEqual(pendings(r)[0].candidates.sort(), ["1473", "5906"]);
});

test("新聞內文常見的「單日成交量」不是日成-KY", () => {
  const r = matcher.analyze("終場仍大漲 7.88%，單日成交量一舉爆出 5.6 萬張巨量；營收單日成長兩成。");
  assert.deepEqual(okCodes(r), []);
  assert.deepEqual(okCodes(matcher.analyze("日成-KY(4807)營收創高")), ["4807"]);
});

test("每檔記下在原文裡出現的位置（標籤判斷用）", () => {
  const text = "統一(1216)公布營收。\n台積電擴產，統一今年展店。";
  const r = matcher.analyze(text);
  const uni = r.mentions.find((m) => m.code === "1216");
  assert.deepEqual(uni.spans.map(([s, e]) => text.slice(s, e)), ["統一", "統一"]);
  const tsmc = r.mentions.find((m) => m.code === "2330");
  assert.deepEqual(tsmc.spans.map(([s, e]) => text.slice(s, e)), ["台積電"]);
});

test("「事業強勁」「產業旺季」裡的字不是業強、業旺", () => {
  assert.deepEqual(okCodes(matcher.analyze("信邦表示，受惠工業應用、醫療及健康照護等高毛利核心事業強勁成長，")), ["3023"]);
  assert.deepEqual(okCodes(matcher.analyze("電子業旺季效應發酵，半導體產業強化布局")), []);
  // 真的在講業強、業旺時照樣對得到
  assert.deepEqual(okCodes(matcher.analyze("業強(6124)營收強勁")), ["6124"]);
  assert.deepEqual(okCodes(matcher.analyze("業強今年營收創新高，業旺接單暢旺")).sort(), ["1475", "6124"]);
});

test("併進別家的公司：「矽品」算成 3711 日月光投控，句子裡寫矽品的會標出來", () => {
  const r = matcher.analyze("欣興、京元電子、矽品被點名！輝達揭AI擴產藍圖\n日月光投控今天法說會");
  assert.deepEqual(okCodes(r), ["3037", "2449", "3711"]);
  const m = r.mentions.find((x) => x.code === "3711");
  assert.deepEqual(matcher.formerNames("3711", m.sentences), ["矽品"]);
  // 只寫日月光投控、或別檔，都不標
  assert.deepEqual(matcher.formerNames("3711", ["日月光投控今天法說會"]), []);
  assert.deepEqual(matcher.formerNames("3037", m.sentences), []);
  // 待確認改代號、延續性觀察手動加，打「矽品」也搜得到
  assert.equal(matcher.search("矽品")[0].code, "3711");
});

test("name-rules.json 的 merged：代號都在上市櫃清單裡，舊名稱不是現在上市櫃的名稱", async () => {
  const rules = await load("name-rules.json");
  const stocks = await load("stocks.json");
  const names = new Set(stocks.stocks.map(([, name]) => name));
  for (const [name, code] of Object.entries(rules.merged ?? {})) {
    assert.ok(matcher.stock(code), `merged 的「${name}」對到的 ${code} 不在上市櫃清單裡`);
    assert.ok(!names.has(name), `merged 的「${name}」現在還是上市櫃的名稱`);
  }
});

test("預覽裡回答待確認：是某一檔就變成對上的個股，不是個股就拿掉，沒回答的照舊", () => {
  const { mentions } = matcher.analyze("三星與台積電(2330)合作\n台積電擴產");
  const pending = mentions.find((m) => m.status === "pending");
  assert.equal(pending.raw, "三星");
  assert.deepEqual(pending.candidates, ["5007"]);
  const key = pendingKey(pending);
  const codesOf = (list) => list.map((m) => (m.status === "ok" ? m.code : `待確認:${m.raw}`));

  assert.deepEqual(codesOf(applyAnswers(mentions, new Map())), ["2330", "待確認:三星"]);
  assert.deepEqual(codesOf(applyAnswers(mentions, new Map([[key, "5007"]]))), ["2330", "5007"]);
  assert.deepEqual(codesOf(applyAnswers(mentions, new Map([[key, null]]))), ["2330"]);
  // 改成已經對上的那一檔：不會多一列，句子併進去（每檔最多 2 句）
  const merged = applyAnswers(mentions, new Map([[key, "2330"]]));
  assert.deepEqual(codesOf(merged), ["2330"]);
  assert.ok(merged[0].sentences.length <= 2);
  assert.ok(merged[0].spans.length > mentions[0].spans.length);
  // 原本的陣列不會被改到
  assert.deepEqual(codesOf(mentions), ["2330", "待確認:三星"]);
});

test("「三星電機」是韓國公司，不問是不是 5007 三星", () => {
  const r = matcher.analyze("供應商包括日本挹斐電(Ibiden)、三星電機及欣興等業者。");
  assert.deepEqual(okCodes(r), ["3037"]);
  assert.equal(pendings(r).length, 0);
});
