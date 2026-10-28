// 用全端工程師的角度寫的（2026/10/28）：直接跑伺服器的程式（src/），資料庫是本機記憶體裡的 SQLite，
// 套上 migrations/ 的表格（tests/helpers/worker.mjs）。從 API 一路測到資料庫：貼入、重複、刪除、待確認、改日期、
// 改標籤、延續性觀察、收盤比對、登入。外面的網站（證交所、新聞網站）用假的回應，不會真的連出去。
// 這次找到的問題都改好了（說明在 PLAN.md「10/28 三個角度的測試」）；以後找到還沒改的問題，可以先寫成 todo（不算失敗）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { apiCaller, FakeD1, loadServer } from "./helpers/worker.mjs";
import { buildMatcher } from "../public/matcher.js";
import { sections, withPassages } from "../public/passage.js";
import { splitPaste } from "../public/split.js";
import { buildTagger } from "../public/tagger.js";
import { watchItems } from "../public/watch.js";
import { parseTaipeiLocal } from "../src/tradingDay.ts";

const { api, index, auth } = await loadServer();
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const { stocks } = JSON.parse(await readFile(new URL("../public/data/stocks.json", import.meta.url), "utf8"));

// 每個測試一個新的資料庫，時間固定在台北某個時刻
function setup(t, local = "2026-10-28T20:00") {
  t.mock.timers.enable({ apis: ["Date"], now: parseTaipeiLocal(local) });
  const db = new FakeD1();
  return { db, call: apiCaller(api.handleApi, { DB: db }) };
}

const ok = (code, extra = {}) => ({ status: "ok", code, sentences: [`${code} 的句子`], tags: [], partners: [], ...extra });
const article = (extra = {}) => ({ title: "測試", kind: "text", tradingDay: "2026-10-29", mentions: [ok("2330")], ...extra });
const count = (db, table) => db.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

test("貼入 → 清單：代號存官方名稱和市場，文字類存每檔那一段，網址類不存，圖片存全文", async (t) => {
  const { db, call } = setup(t);
  let r = await call("POST", "/api/articles", article({ mentions: [ok("2330", { passage: "台積電那一段\n第二行", tags: ["擴產"] })] }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { id: 1, tradingDay: "2026-10-29", confirmed: 1, pending: 0 });
  r = await call("POST", "/api/articles", article({ kind: "url", url: "https://news.cnyes.com/news/id/123456?utm_source=line", mentions: [ok("6488", { passage: "不該存" })] }));
  assert.equal(r.status, 201);
  r = await call("POST", "/api/articles", article({ kind: "image", source: "工商時報 B3", body: "辨識出來的\n\n\n\n全文", mentions: [ok("2317", { passage: "不該存" })] }));
  assert.equal(r.status, 201);

  const list = (await call("GET", "/api/list?date=2026-10-29")).body;
  const byCode = new Map(list.mentions.map((m) => [m.code, m]));
  assert.equal(byCode.get("2330").name, "台積電");
  assert.equal(byCode.get("2330").passage, "台積電那一段\n第二行");
  assert.deepEqual(byCode.get("2330").tags, ["擴產"]);
  assert.equal(byCode.get("6488").market, "上櫃");
  assert.equal(byCode.get("6488").passage, null);
  assert.equal(byCode.get("2317").passage, null);
  const urlArticle = list.articles.find((a) => a.kind === "url");
  assert.equal(urlArticle.url, "https://news.cnyes.com/news/id/123456"); // 追蹤參數伺服器也會拿掉
  const image = list.articles.find((a) => a.kind === "image");
  assert.equal(image.body, "辨識出來的\n\n全文");
  assert.equal(image.source, "工商時報 B3");
  assert.equal(list.articles.find((a) => a.kind === "text").body, null);
});

test("從貼上到清單：照網頁的順序（拆分 → 比對 → 每檔那一段 → 標籤）送出，清單上每檔有自己那一段和標籤，興櫃股不會送出", async (t) => {
  const { call } = setup(t, "2026-10-28T07:50");
  const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
  const matcher = buildMatcher(await load("stocks.json"), await load("name-rules.json"));
  const tagger = buildTagger(await load("tags.json"), await load("big-companies.json"));
  const paste = [
    "早安！10/28 外電綜合整理",
    "",
    "- 3017奇鋐: 與輝達合作液冷，獲追加訂單",
    "",
    "- 2383台光電: 美系調升目標價",
    "",
    "- 宏偉電機（4565）在手訂單翻倍",
  ].join("\n");
  const [item] = splitPaste(paste).items;
  assert.equal(item.type, "text");
  const analysis = matcher.analyze(item.text);
  assert.deepEqual(analysis.emerging, [{ code: "4565", name: "宏偉" }]);
  const mentions = tagger.tagMentions(item.text, withPassages(item.text, analysis.mentions), {
    sections: sections(item.text),
    others: analysis.emergingSpans,
  });
  const fields = ["status", "code", "raw", "reason", "candidates", "sentences", "passage", "tags", "partners"];
  const r = await call("POST", "/api/articles", {
    title: analysis.title,
    url: null,
    kind: "text",
    source: null,
    body: null,
    tradingDay: null, // 今日清單：照貼的時間，07:50 歸當天
    mentions: mentions.map((m) => Object.fromEntries(fields.map((k) => [k, m[k]]))),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.tradingDay, "2026-10-28");
  const list = (await call("GET", "/api/list")).body;
  assert.equal(list.date, "2026-10-28");
  assert.equal(list.articles[0].title, "早安！10/28 外電綜合整理");
  const byCode = new Map(list.mentions.map((m) => [m.code, m]));
  assert.deepEqual([...byCode.keys()], ["3017", "2383"]);
  assert.equal(byCode.get("3017").passage, "- 3017奇鋐: 與輝達合作液冷，獲追加訂單");
  assert.deepEqual(byCode.get("3017").tags, ["新訂單", "合作"]);
  assert.deepEqual(byCode.get("3017").partners, ["輝達（NVIDIA）"]);
  assert.deepEqual(byCode.get("2383").tags, ["調升目標價"]);
});

test("同一天同一篇（帶追蹤參數也算）：409，個股也不會寫進去；別天可以再貼", async (t) => {
  const { db, call } = setup(t);
  const url = "https://news.cnyes.com/news/id/123456";
  assert.equal((await call("POST", "/api/articles", article({ url, mentions: [ok("2330")] }))).status, 201);
  const dup = await call("POST", "/api/articles", article({ url: `${url}?utm_source=fb`, mentions: [ok("2317"), ok("2454")] }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.duplicate, true);
  assert.equal(count(db, "articles"), 1);
  assert.equal(count(db, "mentions"), 1); // 同一筆交易，2317、2454 沒有寫進去
  assert.equal((await call("POST", "/api/articles", article({ url, tradingDay: "2026-10-30" }))).status, 201);
});

test("伺服器再檢查一次代號：興櫃 4565、不存在的代號、壞掉的格式都擋下來，什麼都不寫", async (t) => {
  const { db, call } = setup(t);
  const cases = [
    [article({ mentions: [ok("2330"), ok("4565")] }), "代號 4565 不在上市櫃清單裡"],
    [article({ mentions: [ok("9999")] }), "代號 9999 不在上市櫃清單裡"],
    [article({ mentions: [] }), "這則沒有找到個股"],
    [article({ mentions: Array.from({ length: 201 }, () => ok("2330")) }), "一則提到的個股太多了，請分開貼"],
    [article({ mentions: [null] }), "格式錯誤"],
    [article({ mentions: [{ status: "maybe", code: "2330" }] }), "格式錯誤"],
    [article({ tradingDay: "2026-02-30" }), "日期格式要像 2026-10-23"],
    [article({ url: "javascript:alert(1)" }), "網址格式不對"],
    ["{壞掉的 JSON", "格式錯誤"],
    ["[1,2]", "格式錯誤"],
  ];
  for (const [body, error] of cases) {
    const r = await call("POST", "/api/articles", body);
    assert.equal(r.status, 400, error);
    assert.equal(r.body.error, error);
  }
  assert.equal(count(db, "articles"), 0);
  assert.equal(count(db, "mentions"), 0);
});

test("長度上限：標題 120 字、句子每檔 2 句各 300 字、那一段 5,000 字、標籤 20 個各 40 字", async (t) => {
  const { db, call } = setup(t);
  const long = (n) => "字".repeat(n);
  await call("POST", "/api/articles", article({
    title: long(500),
    mentions: [
      ok("2330", {
        sentences: [long(400), "第二句", "第三句"],
        passage: long(6000),
        tags: Array.from({ length: 30 }, (_, i) => `${i}${long(50)}`),
      }),
    ],
  }));
  const [a] = db.rows("SELECT title FROM articles");
  const [m] = db.rows("SELECT sentences, passage, tags FROM mentions");
  assert.equal(a.title.length, 120);
  const sentences = JSON.parse(m.sentences);
  assert.deepEqual(sentences.map((s) => s.length), [300, 3]);
  assert.equal(m.passage.length, 5000);
  const tags = JSON.parse(m.tags);
  assert.equal(tags.length, 20);
  assert.ok(tags.every((x) => x.length <= 40));
});

test("同一則裡同一檔出現兩次：只留一列，句子、那一段、標籤合併", async (t) => {
  const { db, call } = setup(t);
  await call("POST", "/api/articles", article({
    mentions: [ok("2330", { sentences: ["一"], passage: "甲", tags: ["擴產"] }), ok("2330", { sentences: ["二", "三"], passage: "乙", tags: ["漲價", "擴產"] })],
  }));
  const rows = db.rows("SELECT sentences, passage, tags FROM mentions");
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].sentences), ["一", "二"]);
  assert.equal(rows[0].passage, "甲\n\n乙");
  assert.deepEqual(JSON.parse(rows[0].tags), ["擴產", "漲價"]);
});

test("待確認：候選只留清單裡的；改成某一檔、再處理一次是 404；「不是個股」直接刪掉", async (t) => {
  const { db, call } = setup(t);
  await call("POST", "/api/articles", article({
    mentions: [
      ok("2330"),
      { status: "pending", raw: "三星", reason: "也常當一般用語", candidates: ["5007", "4565", "abc"], sentences: ["三星"], tags: ["合作"] },
      { status: "pending", raw: "創意", reason: "也常當一般用語", candidates: ["3443"], sentences: ["創意"] },
    ],
  }));
  const list = (await call("GET", "/api/list?date=2026-10-29")).body;
  const [samsung, idea] = list.mentions.filter((m) => m.status === "pending");
  assert.deepEqual(samsung.candidates, ["5007"]);

  let r = await call("POST", "/api/pending/resolve", { ids: [samsung.id], code: "5007" });
  assert.equal(r.status, 200);
  assert.equal(r.body.stock.name, "三星");
  const [row] = db.rows("SELECT code, name, status, tags, candidates FROM mentions WHERE id = ?", samsung.id);
  assert.deepEqual({ ...row }, { code: "5007", name: "三星", status: "ok", tags: '["合作"]', candidates: null }); // 標籤跟著過去
  r = await call("POST", "/api/pending/resolve", { ids: [samsung.id], code: "5007" });
  assert.equal(r.status, 404);

  assert.equal((await call("POST", "/api/pending/resolve", { ids: [idea.id], code: null })).status, 200);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM mentions WHERE id = ?", idea.id)[0].n, 0);
  assert.equal((await call("POST", "/api/pending/resolve", { ids: [idea.id], code: "4565" })).status, 400);
  assert.equal((await call("POST", "/api/pending/resolve", { ids: ["1"], code: "2330" })).status, 400);
});

test("改日期：個股跟著搬；那天已經有同一篇是 409 而且沒有搬一半；找不到是 404", async (t) => {
  const { db, call } = setup(t);
  const url = "https://news.cnyes.com/news/id/7777777";
  await call("POST", "/api/articles", article({ url, tradingDay: "2026-10-29", mentions: [ok("2330")] }));
  await call("POST", "/api/articles", article({ url, tradingDay: "2026-10-30", mentions: [ok("2317"), ok("2454")] }));
  await call("POST", "/api/articles", article({ tradingDay: "2026-10-30", mentions: [ok("3008")] }));

  let r = await call("PATCH", "/api/articles/2", { tradingDay: "2026-10-29" });
  assert.equal(r.status, 409);
  assert.deepEqual(db.rows("SELECT DISTINCT trading_day AS d FROM mentions WHERE article_id = 2").map((x) => x.d), ["2026-10-30"]);
  assert.deepEqual(db.rows("SELECT trading_day AS d FROM articles WHERE id = 2").map((x) => x.d), ["2026-10-30"]);

  r = await call("PATCH", "/api/articles/3", { tradingDay: "2026-11-02" });
  assert.equal(r.status, 200);
  assert.deepEqual(db.rows("SELECT trading_day AS d FROM mentions WHERE article_id = 3").map((x) => x.d), ["2026-11-02"]);
  assert.equal((await call("PATCH", "/api/articles/999", { tradingDay: "2026-11-02" })).status, 404);
  assert.equal((await call("PATCH", "/api/articles/3", { tradingDay: "11/02" })).status, 400);
});

test("改日期、會歸到選到週六或颱風假：歸到下一個開盤日（10/28 改的）", async (t) => {
  const { db, call } = setup(t);
  // 以前伺服器照存，那天的清單平常看不到
  let r = await call("POST", "/api/articles", article({ tradingDay: "2026-10-31" }));
  assert.equal(r.body.tradingDay, "2026-11-02");
  r = await call("POST", "/api/articles", article({ tradingDay: "2026-10-23", mentions: [ok("2317")] })); // 颱風假
  assert.equal(r.body.tradingDay, "2026-10-27");
  r = await call("PATCH", "/api/articles/1", { tradingDay: "2026-10-25" }); // 週日
  assert.deepEqual(r.body, { ok: true, tradingDay: "2026-10-27" });
  assert.deepEqual(db.rows("SELECT DISTINCT trading_day AS d FROM mentions").map((x) => x.d), ["2026-10-27"]);
  // 有開盤的照選的那天
  r = await call("PATCH", "/api/articles/1", { tradingDay: "2026-10-29" });
  assert.equal(r.body.tradingDay, "2026-10-29");
  // 網頁選日期時先問這個，選到休市日就寫「10/31（六）沒開盤，改成下一個開盤日」
  r = await call("GET", "/api/trading-day?at=2026-10-31T00:00");
  assert.deepEqual([r.body.rule, r.body.closedReason, r.body.tradingDay], ["closed", "週六", "2026-11-02"]);
  r = await call("GET", "/api/trading-day?at=2026-10-23T00:00");
  assert.deepEqual([r.body.rule, r.body.closedReason, r.body.tradingDay], ["closed", "薔琵颱風停止交易", "2026-10-27"]);
  r = await call("GET", "/api/trading-day?at=2026-10-29T00:00");
  assert.deepEqual([r.body.rule, r.body.tradingDay], ["before_open", "2026-10-29"]);
});

test("刪除：整則連同個股刪掉；選取刪除一次 95 檔（超過一個查詢 90 個參數）也刪得掉；超過 500 檔不收", async (t) => {
  const { db, call } = setup(t);
  await call("POST", "/api/articles", article({ mentions: [ok("2330"), ok("2317")] }));
  assert.equal((await call("DELETE", "/api/articles/1")).status, 200);
  assert.equal(count(db, "mentions"), 0);
  assert.equal((await call("DELETE", "/api/articles/1")).status, 404);

  const codes = stocks.slice(0, 95).map(([code]) => code);
  await call("POST", "/api/articles", article({ mentions: codes.map((c) => ok(c)) }));
  await call("POST", "/api/articles", article({ tradingDay: "2026-10-30", mentions: [ok(codes[0])] }));
  const r = await call("DELETE", `/api/stocks?date=2026-10-29&codes=${codes.join(",")}`);
  assert.deepEqual(r.body, { ok: true, deleted: 95 });
  assert.equal(count(db, "mentions"), 1); // 別天的不動
  assert.equal(count(db, "articles"), 2); // 新聞本身還在（第一則前面整則刪掉了）
  assert.equal((await call("DELETE", `/api/stocks?date=2026-10-29&codes=${Array.from({ length: 501 }, (_, i) => 1000 + i).join(",")}`)).status, 400);
  assert.equal((await call("DELETE", "/api/stocks?date=2026-10-29&codes=2330")).status, 404);
});

test("改標籤：加的貼到這檔的每一則、拿掉的每一則拿掉，別檔、別天不受影響", async (t) => {
  const { db, call } = setup(t);
  await call("POST", "/api/articles", article({ mentions: [ok("2330", { tags: ["漲價"] }), ok("2317", { tags: ["漲價"] })] }));
  await call("POST", "/api/articles", article({ mentions: [ok("2330", { tags: ["擴產"], partners: ["輝達（NVIDIA）"] })] }));
  await call("POST", "/api/articles", article({ tradingDay: "2026-10-30", mentions: [ok("2330", { tags: ["漲價"] })] }));
  const r = await call("PATCH", "/api/stocks", {
    date: "2026-10-29",
    code: "2330",
    tags: { add: ["手機鏡頭"], remove: ["漲價"] },
    partners: { add: [], remove: ["輝達（NVIDIA）"] },
  });
  assert.deepEqual(r.body, { ok: true, changed: 2 });
  const rows = db.rows("SELECT trading_day AS d, code, tags, partners FROM mentions ORDER BY id").map((x) => [x.d, x.code, x.tags, x.partners]);
  assert.deepEqual(rows, [
    ["2026-10-29", "2330", '["手機鏡頭"]', "[]"],
    ["2026-10-29", "2317", '["漲價"]', "[]"],
    ["2026-10-29", "2330", '["擴產","手機鏡頭"]', "[]"],
    ["2026-10-30", "2330", '["漲價"]', "[]"],
  ]);
  assert.equal((await call("PATCH", "/api/stocks", { date: "2026-10-29", code: "9999", tags: { add: ["x"] } })).status, 404);
});

test("延續性觀察手動加減：加、重複加 409、移出、再移出 404、再加回來", async (t) => {
  const { db, call } = setup(t);
  const day = "2026-10-29";
  assert.equal((await call("POST", "/api/watch", { date: day, code: "2330" })).status, 201);
  assert.equal((await call("POST", "/api/watch", { date: day, code: "2330" })).status, 409);
  assert.equal((await call("POST", "/api/watch", { date: day, code: "4565" })).status, 400);
  assert.equal((await call("DELETE", `/api/watch?date=${day}&code=2330`)).status, 200);
  assert.equal((await call("DELETE", `/api/watch?date=${day}&code=2330`)).status, 404);
  assert.equal((await call("POST", "/api/watch", { date: day, code: "2330" })).status, 201);
  const watch = (await call("GET", `/api/list?date=${day}`)).body.watch;
  assert.deepEqual(watch.manual.map((m) => m.code), ["2330"]);
  assert.deepEqual(watch.removed, []);
  assert.equal(count(db, "watchlist"), 1);
});

test("收盤比對：10/27 清單上 10/22 收盤漲停的麗臺、碩禾進延續性觀察；比對過的不再抓；「重新比對」1 分鐘內不能再按", async (t) => {
  const { call } = setup(t, "2026-10-27T07:30");
  const mis = await fixture("mis-20261022.json"); // 證交所即時報價系統 10/22 收盤後的真實回應（只留幾檔）
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched.push(String(url));
    if (String(url).startsWith("https://mis.twse.com.tw/")) return new Response(mis);
    return new Response("沒有這個測試資料", { status: 500 });
  });
  // 10/22 收盤後貼的：歸到 10/27（10/23 颱風休市、10/26 光復節補假）
  const posted = await call("POST", "/api/articles", { title: "盤後", mentions: [ok("2465"), ok("3691"), ok("2938"), ok("2330")] });
  assert.equal(posted.body.tradingDay, "2026-10-27");

  let r = await call("POST", "/api/closing", { date: "2026-10-27" });
  assert.equal(r.body.status, "done");
  assert.equal(r.body.day, "2026-10-22");
  assert.deepEqual(r.body.hits.map((h) => h.code).sort(), ["2465", "3691"]);
  assert.equal(fetched.length, 1); // 4 檔一次查完

  const list = (await call("GET", "/api/list?date=2026-10-27")).body;
  assert.equal(list.watch.fromDay, "2026-10-22");
  assert.deepEqual(list.watch.checks, { 2465: 1, 3691: 1, 2938: 0, 2330: 0 });
  const stocks = list.mentions.map((m) => ({ code: m.code, name: m.name, market: m.market }));
  assert.deepEqual(watchItems(stocks, list.watch).map((w) => w.code), ["2465", "3691"]);

  r = await call("POST", "/api/closing", { date: "2026-10-27" });
  assert.equal(r.body.message, "沒有新的個股要比對");
  assert.equal(fetched.length, 1);
  r = await call("POST", "/api/closing", { date: "2026-10-27", all: true });
  assert.equal(r.status, 429);

  // 移出麗臺：重新比對之後也不會回來
  await call("DELETE", "/api/watch?date=2026-10-27&code=2465");
  const after = (await call("GET", "/api/list?date=2026-10-27")).body;
  assert.deepEqual(watchItems(stocks, after.watch).map((w) => w.code), ["3691"]);
});

test("收盤比對：前一個交易日還沒收盤（交易日 09:00～14:00）就不比，也不連外", async (t) => {
  const { call } = setup(t, "2026-10-28T10:00");
  t.mock.method(globalThis, "fetch", async () => assert.fail("不該連外"));
  await call("POST", "/api/articles", { title: "盤中", mentions: [ok("2330")] });
  const r = await call("POST", "/api/closing", { date: "2026-10-29" });
  assert.equal(r.body.status, "early");
  assert.equal((await call("GET", "/api/list?date=2026-10-29")).body.watch.canRun, false);
});

test("連續被提到：10/20～10/22、10/27 都在清單上是連續 4 天，10/20 沒有的是 3 天（颱風假、補假不算中斷）", async (t) => {
  const { call } = setup(t);
  for (const day of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-27"]) {
    await call("POST", "/api/articles", article({ tradingDay: day, mentions: [ok("2330"), ...(day === "2026-10-20" ? [] : [ok("2317")])] }));
  }
  const list = (await call("GET", "/api/list?date=2026-10-27")).body;
  assert.deepEqual(list.streaks, { 2330: 4, 2317: 3 });
  assert.equal(list.prevDate, "2026-10-22");
  assert.equal((await call("GET", "/api/list?date=10-27")).status, 400);
});

test("替瀏覽器抓網頁：轉址之後的網址、同一天貼過的標題；轉到內部網路、不是網頁的都擋", async (t) => {
  const { call } = setup(t);
  const pages = {
    "https://short.example.com/a": new Response(null, { status: 301, headers: { Location: "https://news.cnyes.com/news/id/5555555?utm_source=x" } }),
    "https://news.cnyes.com/news/id/5555555?utm_source=x": new Response("<html><title>國巨漲停</title></html>", { headers: { "Content-Type": "text/html; charset=big5" } }),
    "https://evil.example.com/": new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }),
    "https://img.example.com/a.png": new Response("png", { headers: { "Content-Type": "image/png" } }),
  };
  t.mock.method(globalThis, "fetch", async (url) => pages[String(url)] ?? new Response("", { status: 404 }));
  await call("POST", "/api/articles", article({ title: "國巨漲停", url: "https://news.cnyes.com/news/id/5555555" }));

  let r = await call("POST", "/api/fetch", { url: "https://short.example.com/a", day: "2026-10-29" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Final-Url"), "https://news.cnyes.com/news/id/5555555");
  assert.equal(r.headers.get("X-Charset"), "big5");
  assert.equal(decodeURIComponent(r.headers.get("X-Duplicate-Title")), "國巨漲停");
  assert.match(r.headers.get("Content-Security-Policy"), /sandbox/);

  r = await call("POST", "/api/fetch", { url: "https://evil.example.com/" });
  assert.equal(r.body.error, "網站轉到不能抓取的網址");
  r = await call("POST", "/api/fetch", { url: "https://img.example.com/a.png" });
  assert.match(r.body.error, /不是新聞網頁/);
  r = await call("POST", "/api/fetch", { url: "https://gone.example.com/" });
  assert.match(r.body.error, /找不到這個網頁/);
  r = await call("POST", "/api/fetch", { url: "http://localhost:8788/api/list" });
  assert.equal(r.status, 400);
});

// 登入：整個網站的入口（src/index.ts），ASSETS 用假的網頁
function site(t, password = "群組密碼-test") {
  const db = new FakeD1();
  const env = {
    DB: db,
    GROUP_PASSWORD: password,
    ASSETS: { fetch: async () => new Response("<html><title>今日清單</title></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }) },
  };
  const go = (path, { method = "GET", body, cookie, ip = "203.0.113.1" } = {}, e = env) =>
    index.fetch(
      new Request(`https://dailynews.test${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}) },
      }),
      e,
    );
  const login = async (pw = password, ip) => go("/api/login", { method: "POST", body: { password: pw }, ip });
  return { db, env, go, login };
}

test("登入：沒登入時網頁轉登入頁、資料 API 回 401、程式和代號清單也拿不到；登入頁和 robots.txt 拿得到", async (t) => {
  const { go } = site(t);
  for (const path of ["/", "/index.html", "/app.js", "/data/stocks.json"]) {
    const r = await go(path);
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.get("Location"), "/login");
  }
  assert.equal((await go("/api/list")).status, 401);
  assert.equal((await go("/api/articles", { method: "POST", body: article() })).status, 401);
  assert.equal((await go("/login")).status, 200);
  assert.equal((await go("/robots.txt")).status, 200);
});

test("登入：密碼錯 401；對了發 30 天的 cookie（HttpOnly、SameSite=Lax、Secure），之後都能用", async (t) => {
  const { go, login } = site(t);
  assert.equal((await login("wrong")).status, 401);
  assert.equal((await go("/api/login")).status, 405);
  const r = await login();
  assert.equal(r.status, 200);
  const setCookie = r.headers.get("Set-Cookie");
  assert.match(setCookie, /^dn_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await go("/api/list?date=2026-10-29", { cookie })).status, 200);
  assert.equal((await go("/", { cookie })).status, 200);
  assert.equal((await go("/login", { cookie })).headers.get("Location"), "/");
  const out = await go("/api/logout", { method: "POST", cookie });
  assert.match(out.headers.get("Set-Cookie"), /dn_session=; .*Max-Age=0/);
});

test("登入：cookie 改過期限、改過簽名、過期、改了群組密碼都不能用", async (t) => {
  const { env, go, login } = site(t);
  const cookie = (await login()).headers.get("Set-Cookie").split(";")[0];
  const [exp, sig] = cookie.slice("dn_session=".length).split(".");
  for (const bad of [`dn_session=${Number(exp) + 86400}.${sig}`, `dn_session=${exp}.${sig.slice(0, -1)}A`, `dn_session=${exp}`, "dn_session=", "dn_session=abc.def"]) {
    assert.equal((await go("/api/list", { cookie: bad })).status, 401, bad);
  }
  const old = await auth.createSessionToken(env.GROUP_PASSWORD, Date.now() - 31 * 86400 * 1000);
  assert.equal((await go("/api/list", { cookie: `dn_session=${old}` })).status, 401);
  assert.equal((await go("/api/list", { cookie }, { ...env, GROUP_PASSWORD: "新密碼" })).status, 401);
});

test("登入：同一個網路位置錯 10 次就擋 15 分鐘（密碼對了也擋），別的網路位置不受影響；沒設密碼回 503", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: parseTaipeiLocal("2026-10-28T20:00") });
  const { env, login } = site(t);
  for (let i = 0; i < 10; i++) assert.equal((await login("wrong", "198.51.100.7")).status, 401);
  assert.equal((await login(undefined, "198.51.100.7")).status, 429);
  assert.equal((await login(undefined, "198.51.100.8")).status, 200);
  t.mock.timers.setTime(Date.now() + 15 * 60 * 1000 + 1000);
  assert.equal((await login(undefined, "198.51.100.7")).status, 200);
  const r = await index.fetch(new Request("https://dailynews.test/api/login", { method: "POST", body: '{"password":""}' }), { ...env, GROUP_PASSWORD: "" });
  assert.equal(r.status, 503);
});

test("每個回應都帶 noindex、no-referrer、nosniff、不能被嵌進別的網站", async (t) => {
  const { go, login } = site(t);
  const cookie = (await login()).headers.get("Set-Cookie").split(";")[0];
  for (const r of [await go("/"), await go("/login"), await go("/api/list"), await go("/api/list", { cookie }), await go("/robots.txt")]) {
    assert.match(r.headers.get("X-Robots-Tag"), /noindex/);
    assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  }
});

test("資料庫出錯時回「伺服器出了點問題」，不會把錯誤細節給瀏覽器", async (t) => {
  const { env, go, login } = site(t);
  const cookie = (await login()).headers.get("Set-Cookie").split(";")[0];
  t.mock.method(console, "error", () => {});
  const broken = { ...env, DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error("D1_ERROR: no such table"); } } };
  const r = await go("/api/list?date=2026-10-29", { cookie }, broken);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "伺服器出了點問題，請稍後再試。" });
});
