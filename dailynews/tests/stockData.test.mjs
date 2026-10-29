// 代號清單每天自動更新（2026/10/29）：GitHub Actions 傳到 POST /api/stock-data 存進資料庫，
// 網站（伺服器的代號檢查、瀏覽器讀的 /data/stocks.json）改用資料庫那份。
// 另外一個檔案：上傳的清單在伺服器裡是整個程式共用的，和 api.test.mjs 放一起會互相影響。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FakeD1, loadServer } from "./helpers/worker.mjs";

const { index, auth } = await loadServer();
const bundled = JSON.parse(await readFile(new URL("../public/data/stocks.json", import.meta.url), "utf8"));
const TOKEN = "upload-token-test";
const PASSWORD = "群組密碼-test";

// 每個測試往後 1 小時，超過網站 5 分鐘的快取，才會重新讀這個測試自己的資料庫
let hour = 0;
async function site(t, extra = {}) {
  const now = Date.parse("2026-11-02T00:00:00Z") + ++hour * 3_600_000;
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now });
  const db = new FakeD1();
  const env = {
    DB: db,
    GROUP_PASSWORD: PASSWORD,
    STOCK_UPLOAD_TOKEN: TOKEN,
    ASSETS: { fetch: async () => new Response(JSON.stringify(bundled), { headers: { "Content-Type": "application/json" } }) },
    ...extra,
  };
  const cookie = `${auth.SESSION_COOKIE}=${await auth.createSessionToken(PASSWORD)}`;
  const go = async (path, { method = "GET", body, token, login = true } = {}) => {
    const headers = { "CF-Connecting-IP": "203.0.113.1" };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (login) headers.Cookie = cookie;
    const res = await index.fetch(
      new Request(`https://dailynews.test${path}`, { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), headers }),
      env,
    );
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  };
  return { db, go };
}

// 拿部署時帶的清單改一改：新增 9999、拿掉 1101、2330 改名
function changed(updated = "2099-01-01") {
  const stocks = bundled.stocks
    .filter((s) => s[0] !== "1101")
    .map((s) => (s[0] === "2330" ? ["2330", "台積電新名", "上市", s[3]] : s))
    .concat([["9999", "測試新股", "上櫃", ["測試新股份"]]]);
  return { ...bundled, updated, stocks };
}

const post = (go, body, token = TOKEN) => go("/api/stock-data", { method: "POST", body, token, login: false });

test("上傳：權杖對了才收，不用群組密碼；網站沒設權杖就不收", async (t) => {
  const { go, db } = await site(t);
  assert.equal((await post(go, changed(), "wrong")).status, 401);
  assert.equal((await post(go, changed(), "")).status, 401);
  assert.equal((await go("/api/stock-data", { method: "GET", token: TOKEN, login: false })).status, 405);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM stock_data")[0].n, 0);

  const noToken = await site(t, { STOCK_UPLOAD_TOKEN: undefined });
  assert.equal((await post(noToken.go, changed(), "")).status, 503);
});

test("上傳：存進資料庫，回傳新增、拿掉、改名的個股；之後伺服器和瀏覽器都用新的清單", async (t) => {
  const { go, db } = await site(t);
  const r = await post(go, changed());
  assert.equal(r.status, 200);
  assert.equal(r.body.updated, "2099-01-01");
  assert.deepEqual(r.body.added, ["9999 測試新股（上櫃）"]);
  assert.deepEqual(r.body.removed, ["1101 台泥（上市）"]);
  assert.deepEqual(r.body.renamed, ["2330 台積電（上市） → 2330 台積電新名（上市）"]);
  assert.equal(db.rows("SELECT updated FROM stock_data")[0].updated, "2099-01-01");

  // 瀏覽器讀的 /data/stocks.json
  const file = await go("/data/stocks.json");
  assert.equal(file.body.updated, "2099-01-01");
  assert.ok(file.body.stocks.some((s) => s[0] === "9999"));

  // 伺服器的代號檢查：新股可以加入，拿掉的不行，存檔用新名稱
  const article = (code) => ({ title: "測試", kind: "text", tradingDay: "2099-01-05", mentions: [{ status: "ok", code, sentences: ["句子"], tags: [], partners: [] }] });
  assert.equal((await go("/api/articles", { method: "POST", body: article("9999") })).status, 201);
  assert.equal((await go("/api/articles", { method: "POST", body: article("1101") })).status, 400);
  assert.equal((await go("/api/articles", { method: "POST", body: article("2330") })).status, 201);
  assert.deepEqual(
    db.rows("SELECT code, name, market FROM mentions ORDER BY code").map((m) => ({ ...m })),
    [
      { code: "2330", name: "台積電新名", market: "上市" },
      { code: "9999", name: "測試新股", market: "上櫃" },
    ],
  );

  // 再傳一次一樣的：蓋掉，沒有新增拿掉
  const again = await post(go, changed());
  assert.deepEqual([again.body.added, again.body.removed, again.body.renamed], [[], [], []]);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM stock_data")[0].n, 1);
});

test("上傳：格式不對、檔數太少（來源格式變了）都不收，照舊用原本的清單", async (t) => {
  const { go, db } = await site(t);
  const few = { ...changed(), stocks: bundled.stocks.slice(0, 100) };
  assert.match((await post(go, few)).body.error, /只有 100 檔/);
  assert.match((await post(go, { ...changed(), emerging: [] })).body.error, /興櫃只有 0 檔/);
  assert.match((await post(go, { ...changed(), updated: "昨天" })).body.error, /updated/);
  const bad = changed();
  bad.stocks[0] = ["12", "太短", "上市", []];
  assert.match((await post(go, bad)).body.error, /格式不對/);
  bad.stocks[0] = ["1234", "市場錯", "興櫃", []];
  assert.match((await post(go, bad)).body.error, /格式不對/);
  assert.equal((await post(go, "{不是 JSON")).status, 400);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM stock_data")[0].n, 0);
  // 網站照舊用部署時帶的（ASSETS 那份）
  assert.equal((await go("/data/stocks.json")).body.updated, bundled.updated);
});

test("資料庫那份比部署時帶的舊（之後手動跑 update-data 又部署了），用部署時帶的", async (t) => {
  const { go, db } = await site(t);
  const old = changed("2000-01-01");
  db.sqlite.prepare("INSERT INTO stock_data (id, updated, json, saved_at) VALUES (1, ?, ?, 0)").run(old.updated, JSON.stringify(old));
  assert.equal((await go("/data/stocks.json")).body.updated, bundled.updated);
  const article = { title: "測試", kind: "text", tradingDay: "2026-11-03", mentions: [{ status: "ok", code: "9999", sentences: ["句子"], tags: [], partners: [] }] };
  assert.equal((await go("/api/articles", { method: "POST", body: article })).status, 400);
});

test("/data/stocks.json 從資料庫拿也要先登入", async (t) => {
  const { go } = await site(t);
  await post(go, changed());
  const r = await go("/data/stocks.json", { login: false });
  assert.equal(r.status, 302);
});
