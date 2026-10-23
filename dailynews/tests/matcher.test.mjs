import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMatcher, normalize } from "../public/matcher.js";

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
