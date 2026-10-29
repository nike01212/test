// 從證交所、櫃買中心抓官方資料，產生 public/data/stocks.json 和 public/data/holidays.json。
// 用法：npm run update-data（新股上市、或每年 12 月證交所公布明年休市日之後跑一次，再 npm run deploy）
//
// 代號清單每天自動更新（2026/10/29）：GitHub Actions（.github/workflows/dailynews-stock-data.yml）每天跑
//   node scripts/update-data.mjs --upload https://dailynews-staging.tw-notes-8317.workers.dev,https://（好幾個網站用逗號隔開）
// 抓完把代號清單傳到每個網站的 /api/stock-data（權杖放在環境變數 STOCK_UPLOAD_TOKEN），存進資料庫，不用重新部署。
// 休市日不會自動更新，照舊要跑這個、再部署。
//
// 資料來源：
// - 代號與簡稱：證交所 ISIN 一覽表（上市 strMode=2、上櫃 strMode=4），只取「股票」與「創新板」
// - 興櫃股的代號與簡稱：ISIN 一覽表（興櫃 strMode=5）。不比對，只用來在待確認寫出「代號 4565（宏偉）是興櫃股」
// - 公司全名（用來產生別名）：證交所 OpenAPI t187ap03_L、櫃買中心 OpenAPI mopsfin_t187ap03_O
// - 休市日：證交所「市場開休市日期」

import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const OUT_DIR = new URL("../public/data/", import.meta.url);

const ISIN = {
  上市: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  上櫃: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
  興櫃: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=5",
};
const COMPANY_API = {
  上市: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
  上櫃: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
};
const HOLIDAY_API = "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date=";

// ISIN 表裡要收的分類（權證、ETF、特別股、TDR 等不收）
const STOCK_CATEGORIES = new Set(["股票", "創新板"]);

// 上市那份一覽表約 10 MB。從 GitHub 的機器用 Node 的 fetch 下載會停住（2026/10/29 實測：65 秒到 3 分鐘以上都有），
// 同一個網址用 curl 15 秒就下載完，所以改用 curl（GitHub 的機器和 Mac 都有）。每次最多等 3 分鐘，最多抓 3 次
const FETCH_TIMEOUT_SECONDS = 180;
const FETCH_TRIES = 3;
const run = promisify(execFile);

async function fetchOnce(url) {
  const { stdout } = await run(
    "curl",
    ["--silent", "--show-error", "--fail", "--location", "--max-time", String(FETCH_TIMEOUT_SECONDS), "--user-agent", "dailynews-update-data", url],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    arrayBuffer: async () => stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
    json: async () => JSON.parse(stdout.toString("utf8")),
  };
}

async function fetchOk(url) {
  for (let i = 1; ; i++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      if (i >= FETCH_TRIES) throw err;
      console.warn(`${url} 第 ${i} 次失敗（${String(err.stderr ?? err.message).trim()}），重抓`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

async function loadIsin(market) {
  const buf = await (await fetchOk(ISIN[market])).arrayBuffer();
  // 頁面是 Big5（MS950）編碼
  const html = new TextDecoder("big5").decode(buf);
  const stocks = [];
  let category = "";
  for (const [, row] of html.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => stripTags(m[1]));
    if (cells.length === 1) {
      category = cells[0];
      continue;
    }
    // 興櫃一覽表沒有分類那一列，整頁都是興櫃股票
    if (cells.length < 6 || (market !== "興櫃" && !STOCK_CATEGORIES.has(category))) continue;
    const [code, name] = cells[0].split("　").map((s) => s.trim());
    if (!/^\d{4}$/.test(code) || !name) continue;
    stocks.push({ code, name, market });
  }
  return stocks;
}

// 回傳 代號 → [全名, 公開資訊觀測站的簡稱]
async function loadCompanyNames(market) {
  const rows = await (await fetchOk(COMPANY_API[market])).json();
  const out = new Map();
  for (const r of rows) {
    const code = r["公司代號"] ?? r.SecuritiesCompanyCode;
    const full = r["公司名稱"] ?? r.CompanyName;
    const short = r["公司簡稱"] ?? r.CompanyAbbreviation;
    if (code) out.set(String(code).trim(), [String(full ?? "").trim(), String(short ?? "").trim()]);
  }
  return out;
}

const FOREIGN_PREFIX = /^(英屬開曼群島商|英屬維京群島商|英屬蓋曼群島商|開曼群島商|開曼商|百慕達商|薩摩亞商|香港商|新加坡商|美商|日商)/;
const COMPANY_SUFFIX = /(股份有限公司|有限公司|公司)$/;
// 從全名尾巴一層一層拿掉的字，拿掉後剩 3 個字以上才當別名（例如「全新光電科技」→「全新光電」）
const GENERIC_TAILS = ["控股", "投資", "集團", "科技", "電子", "工業", "實業", "企業", "國際", "製造", "精密", "股份"];

function normalizeName(s) {
  return s.replace(/臺/g, "台").replace(/[*＊]/g, "").replace(/\s+/g, "");
}

function aliasesFrom(full, short, officialName) {
  const out = new Set();
  const add = (s) => {
    s = normalizeName(s);
    if (s.length >= 3 && s !== normalizeName(officialName)) out.add(s);
  };
  if (short) add(short);
  if (full) {
    let base = normalizeName(full)
      .replace(/\(開曼\)|（開曼）/g, "")
      .replace(/\(股\)公司$/, "")
      .replace(FOREIGN_PREFIX, "")
      .replace(COMPANY_SUFFIX, "");
    if (/[一-鿿]/.test(base)) {
      add(base);
      for (let changed = true; changed; ) {
        changed = false;
        for (const tail of GENERIC_TAILS) {
          if (base.endsWith(tail) && base.length - tail.length >= 3) {
            base = base.slice(0, -tail.length);
            add(base);
            changed = true;
          }
        }
      }
    }
  }
  // 「富邦金」→ 新聞常寫「富邦金控」
  if (officialName.endsWith("金") && full.includes("金融控股")) add(officialName + "控");
  return [...out];
}

async function buildStocks() {
  const stocks = [];
  for (const market of ["上市", "上櫃"]) {
    const list = await loadIsin(market);
    let names = new Map();
    try {
      names = await loadCompanyNames(market);
    } catch (err) {
      console.warn(`抓 ${market} 公司全名失敗，這次只用簡稱：${err.message}`);
    }
    for (const s of list) {
      const [full = "", short = ""] = names.get(s.code) ?? [];
      // 有些簡稱帶「*」註記，顯示時拿掉
      const display = s.name.replace(/[*＊]/g, "");
      stocks.push([s.code, display, market, aliasesFrom(full, short, display)]);
    }
    console.log(`${market}：${list.length} 檔`);
  }
  if (stocks.length < 1500) throw new Error(`只抓到 ${stocks.length} 檔，可能是來源格式變了，先不覆蓋舊檔`);
  stocks.sort((a, b) => a[0].localeCompare(b[0]));

  // 興櫃股不比對（很多名稱是一般用語，例如相互、開展、台視、悠遊卡），只用來寫待確認的說明（2026/10/28 發起人決定）
  const listed = new Set(stocks.map((s) => s[0]));
  const emerging = (await loadIsin("興櫃"))
    .filter((s) => !listed.has(s.code))
    .map((s) => [s.code, s.name.replace(/[*＊]/g, "")]);
  console.log(`興櫃：${emerging.length} 檔`);
  if (emerging.length < 100) throw new Error(`興櫃只抓到 ${emerging.length} 檔，可能是來源格式變了，先不覆蓋舊檔`);
  emerging.sort((a, b) => a[0].localeCompare(b[0]));

  return {
    updated: new Date().toISOString().slice(0, 10),
    sources: [...Object.values(ISIN), ...Object.values(COMPANY_API)],
    // 每一筆：[代號, 名稱, 市場, 別名]
    stocks,
    // 興櫃股，每一筆：[代號, 名稱]
    emerging,
  };
}

async function buildHolidays() {
  const thisYear = Number(new Date().toISOString().slice(0, 4));
  const closed = {};
  const years = [];
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const data = await (await fetchOk(`${HOLIDAY_API}${year}0101`)).json();
    if (data.stat !== "ok" || !Array.isArray(data.data) || data.data.length === 0) {
      console.log(`${year} 年：證交所還沒公布`);
      continue;
    }
    years.push(year);
    for (const [date, name] of data.data) {
      // 「開始交易日」「最後交易日」本身有開盤，其他列出來的都是沒有交易的日子
      if (/開始交易|最後交易/.test(name)) continue;
      closed[date] = name.trim();
    }
    console.log(`${year} 年：${data.data.length} 筆`);
  }
  if (years.length === 0) throw new Error("沒有抓到任何一年的休市日");
  return { updated: new Date().toISOString().slice(0, 10), source: HOLIDAY_API, years, closed };
}

// --upload 網址：只更新代號清單，傳到那個網站（src/stocks.ts 的 handleStockUpload）
async function upload(site, stocks) {
  const token = process.env.STOCK_UPLOAD_TOKEN;
  if (!token) throw new Error("沒有設定環境變數 STOCK_UPLOAD_TOKEN");
  const res = await fetch(new URL("/api/stock-data", site), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(stocks),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${site} 回應 ${res.status}：${body.error ?? "不是 JSON"}`);
  console.log(`已傳到 ${site}：上市櫃 ${body.stocks} 檔、興櫃 ${body.emerging} 檔（${body.updated}）`);
  const list = (title, items) => console.log(`${title} ${items.length} 檔${items.length ? "：" + items.join("、") : ""}`);
  list("新增", body.added);
  list("拿掉", body.removed);
  list("改名或換市場", body.renamed);
}

const uploadAt = process.argv.indexOf("--upload");
if (uploadAt >= 0) {
  const sites = (process.argv[uploadAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (sites.length === 0 || !sites.every((s) => /^https?:\/\//.test(s))) {
    console.error("用法：node scripts/update-data.mjs --upload https://網站網址[,https://另一個網站]");
    process.exit(1);
  }
  const stocks = await buildStocks();
  // 一個網站失敗照樣傳下一個，最後再算失敗
  let failed = 0;
  for (const site of sites) {
    try {
      await upload(site, stocks);
    } catch (err) {
      failed++;
      console.error(`傳到 ${site} 失敗：${err.message}`);
    }
  }
  if (failed) process.exit(1);
} else {
  await mkdir(OUT_DIR, { recursive: true });
  const [stocks, holidays] = await Promise.all([buildStocks(), buildHolidays()]);
  await writeFile(new URL("stocks.json", OUT_DIR), JSON.stringify(stocks) + "\n");
  await writeFile(new URL("holidays.json", OUT_DIR), JSON.stringify(holidays, null, 1) + "\n");
  console.log(`已更新 public/data/stocks.json（${stocks.stocks.length} 檔）、public/data/holidays.json（${holidays.years.join("、")} 年）`);
}
