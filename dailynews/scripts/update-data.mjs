// 從證交所、櫃買中心抓官方資料，產生 public/data/stocks.json 和 public/data/holidays.json。
// 用法：npm run update-data（新股上市、或每年 12 月證交所公布明年休市日之後跑一次，再 npm run deploy）
//
// 資料來源：
// - 代號與簡稱：證交所 ISIN 一覽表（上市 strMode=2、上櫃 strMode=4），只取「股票」與「創新板」
// - 公司全名（用來產生別名）：證交所 OpenAPI t187ap03_L、櫃買中心 OpenAPI mopsfin_t187ap03_O
// - 休市日：證交所「市場開休市日期」

import { writeFile, mkdir } from "node:fs/promises";

const OUT_DIR = new URL("../public/data/", import.meta.url);

const ISIN = {
  上市: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  上櫃: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
};
const COMPANY_API = {
  上市: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
  上櫃: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
};
const HOLIDAY_API = "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date=";

// ISIN 表裡要收的分類（權證、ETF、特別股、TDR 等不收）
const STOCK_CATEGORIES = new Set(["股票", "創新板"]);

async function fetchOk(url) {
  const res = await fetch(url, { headers: { "User-Agent": "dailynews-update-data" } });
  if (!res.ok) throw new Error(`${url} 回應 ${res.status}`);
  return res;
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
    if (cells.length < 6 || !STOCK_CATEGORIES.has(category)) continue;
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
  return {
    updated: new Date().toISOString().slice(0, 10),
    sources: [...Object.values(ISIN), ...Object.values(COMPANY_API)],
    // 每一筆：[代號, 名稱, 市場, 別名]
    stocks,
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

await mkdir(OUT_DIR, { recursive: true });
const [stocks, holidays] = await Promise.all([buildStocks(), buildHolidays()]);
await writeFile(new URL("stocks.json", OUT_DIR), JSON.stringify(stocks) + "\n");
await writeFile(new URL("holidays.json", OUT_DIR), JSON.stringify(holidays, null, 1) + "\n");
console.log(`已更新 public/data/stocks.json（${stocks.stocks.length} 檔）、public/data/holidays.json（${holidays.years.join("、")} 年）`);
