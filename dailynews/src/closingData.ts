// 交易所收盤資料：網址和解析（不碰資料庫，方便測試）。
//
// 上市（證交所）
//   - 漲停價：「股價升降幅度」TWT84U，當天開盤前就公布，已經算好除權息之後的漲停價
//   - 收盤價：「每日收盤行情」MI_INDEX，收盤後公布
// 上櫃（櫃買中心）「上櫃股票每日收盤行情」
//   - 收盤價：當天那一份
//   - 漲停價：前一個交易日那一份的「次日漲停價」
// 證交所「基本市況報導」（即時報價系統 mis.twse.com.tw）：上市、上櫃都查得到，只查需要的那幾檔，
// 資料很小，所以先用這個（src/closing.ts）。只有最近一個交易日的資料（隔天開盤前換掉）。
// 櫃買中心擋掉雲端機房的連線（2026/10/23 實測，從 Cloudflare 連一律轉到錯誤頁），正式站上櫃只能靠這個，
// 所以上櫃要在當天收盤後、隔天開盤前比對（排程本來就是當天跑）。
//
// 整份資料幾百 KB，免費方案每次排程只有 10 毫秒 CPU，所以不把整份 JSON 轉成物件，
// 只在文字裡找需要的那幾檔（["2330", 開頭的那一列）再解析。
// 這個檔案不 import 別的檔案，npm test 可以直接載入

// 首五日無漲跌幅、外國成分 ETF 等沒有漲跌幅限制的，漲停價欄位寫 9,999.95
const NO_LIMIT_CENTS = 999_995;

export interface Quote {
  close: number | null; // 當天收盤價；沒有成交是 null
  limitUp: number | null; // 當天漲停價；沒有漲跌幅限制或查不到是 null
}

// 資料還沒公布（排程晚一點會再試）
export class NotPublished extends Error {}

const compact = (day: string) => day.replaceAll("-", "");

// 民國年：2026-10-22 → { y: 115, m: "10", d: "22" }
function roc(day: string) {
  const [y, m, d] = day.split("-");
  return { y: Number(y) - 1911, m, d };
}

export function twseLimitsUrl(day: string): string {
  return `https://www.twse.com.tw/rwd/zh/variation/TWT84U?response=json&date=${compact(day)}&selectType=ALLBUT0999`;
}

export function twseCloseUrl(day: string): string {
  return `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${compact(day)}&type=ALLBUT0999`;
}

// 即時報價系統一次查幾檔
export const MIS_BATCH = 50;

export function misUrl(stocks: { code: string; market: "otc" | "tse" }[]): string {
  const list = stocks.map((s) => `${s.market}_${s.code}.tw`).join("|");
  return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(list)}`;
}

export function tpexQuotesUrl(day: string): string {
  return `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?response=json&type=EW&date=${day.replaceAll("-", "%2F")}`;
}

// "2,620.00" → 2620；"--"、"----"、空的 → null
export function toPrice(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// 漲停價欄位：9,999.95 代表沒有漲跌幅限制
export function toLimitUp(v: unknown): number | null {
  const n = toPrice(v);
  return n === null || Math.round(n * 100) === NO_LIMIT_CENTS ? null : n;
}

// 收盤價等於漲停價才算（盤中碰到漲停、收盤打開的不算）。價格最小到 0.01 元，用「分」比較避免小數誤差
export function isLimitUp(q: Quote | undefined): boolean {
  if (!q || q.close === null || q.limitUp === null) return false;
  return Math.round(q.close * 100) === Math.round(q.limitUp * 100);
}

// 欄位名稱：拿掉 <br> 後面的單位和前後空白（櫃買的欄位名稱後面有空白）
function fieldName(f: unknown): string {
  return String(f).replace(/<br>.*$/s, "").trim();
}

// 讀出欄位名稱（第一個欄位是 first 的那個表格；不指定就是第一個表格）；找不到就是格式變了
function readFields(text: string, first = ""): { fields: string[]; end: number } {
  const marker = new RegExp(`"fields"\\s*:\\s*\\[${first ? `\\s*"${first}"` : ""}`);
  const found = marker.exec(text);
  if (!found) throw new Error("資料格式變了（找不到欄位名稱）");
  const start = text.indexOf("[", found.index);
  const end = text.indexOf("]", start);
  const fields = (JSON.parse(text.slice(start, end + 1)) as unknown[]).map(fieldName);
  return { fields, end };
}

function column(fields: string[], name: string): number {
  const i = fields.indexOf(name);
  if (i < 0) throw new Error(`資料格式變了（找不到「${name}」欄）`);
  return i;
}

// 從 start 之後找每一列 ["1234", …]，只解析 codes 裡有的。一列裡不會有 ]（漲跌欄的 HTML 也沒有）
export function scanRows(text: string, codes: Set<string>, start = 0): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /\["(\d{4})",/g;
  re.lastIndex = start;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = text.indexOf("]", m.index);
    if (end < 0) break;
    if (codes.has(m[1]) && !out.has(m[1])) {
      const row = JSON.parse(text.slice(m.index, end + 1)) as unknown[];
      out.set(m[1], row.map((v) => String(v)));
    }
    re.lastIndex = end;
  }
  return out;
}

// 最外層的某個字串欄位（例如 "stat"、"date"）。證交所、櫃買都把它們放在最外層的最前面或最後面，
// 表格裡面也有同名欄位（櫃買的 "date"），所以看最外層那一個：開頭的就用第一個，結尾的就用最後一個
function topField(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "g");
  const all = [...text.slice(0, 200).matchAll(re)];
  if (all.length) return all[0][1];
  const tail = [...text.slice(-300).matchAll(re)];
  return tail.length ? tail.at(-1)![1] : null;
}

// 證交所 TWT84U：這天的漲停價。拿到的是「最近成交日」比這天早的資料才對（要了還沒公布的日子，會拿到最新那份）
export function parseTwseLimits(text: string, day: string, codes: Set<string>): Map<string, number | null> {
  const stat = topField(text, "stat");
  if (stat?.toUpperCase() !== "OK") throw new NotPublished("證交所的漲停價還沒公布");
  const { fields, end } = readFields(text);
  const limitCol = column(fields, "漲停價");
  const lastTradeCol = column(fields, "最近成交日");
  const out = new Map<string, number | null>();
  for (const [code, row] of scanRows(text, codes, end)) {
    // 最近成交日是民國年 115.10.22
    const [y, m, d] = row[lastTradeCol].split(".");
    const lastTrade = `${Number(y) + 1911}-${m}-${d}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastTrade) && lastTrade >= day) {
      throw new Error(`證交所漲停價的日期不對（${code} 最近成交日 ${row[lastTradeCol]}）`);
    }
    out.set(code, toLimitUp(row[limitCol]));
  }
  return out;
}

// 證交所 MI_INDEX：這天的收盤價
export function parseTwseCloses(text: string, day: string, codes: Set<string>): Map<string, number | null> {
  const stat = topField(text, "stat");
  if (stat?.toUpperCase() !== "OK") throw new NotPublished("證交所的收盤行情還沒公布");
  const date = topField(text, "date");
  if (date !== compact(day)) throw new Error(`證交所收盤行情的日期不對（${date}）`);
  const { fields, end } = readFields(text, "證券代號");
  const closeCol = column(fields, "收盤價");
  const out = new Map<string, number | null>();
  for (const [code, row] of scanRows(text, codes, end)) out.set(code, toPrice(row[closeCol]));
  return out;
}

// 櫃買中心：這天的收盤價和次日漲停價。還沒公布（或那天沒開盤）時 totalCount 是 0
export function parseTpexQuotes(
  text: string,
  day: string,
  codes: Set<string>,
): Map<string, { close: number | null; nextLimitUp: number | null }> {
  const total = /"totalCount"\s*:\s*(\d+)/.exec(text);
  if (!total || Number(total[1]) === 0) throw new NotPublished("櫃買中心的收盤行情還沒公布");
  const { y, m, d } = roc(day);
  if (!new RegExp(`"date"\\s*:\\s*"${y}/${m}/${d}"`).test(text)) throw new Error(`櫃買中心收盤行情的日期不對（要 ${y}/${m}/${d}）`);
  const { fields, end } = readFields(text);
  const closeCol = column(fields, "收盤");
  const nextCol = column(fields, "次日漲停價");
  const out = new Map<string, { close: number | null; nextLimitUp: number | null }>();
  for (const [code, row] of scanRows(text, codes, end)) {
    out.set(code, { close: toPrice(row[closeCol]), nextLimitUp: toLimitUp(row[nextCol]) });
  }
  return out;
}

interface MisRow {
  c?: string; // 代號
  d?: string; // 資料日期 20261022
  t?: string; // 資料時間 13:30:00
  z?: string; // 最近成交價；最後一盤沒有成交時是 "-"
  u?: string; // 當天漲停價
  trade?: { z?: string } | null; // 最後一筆成交
}

// 即時報價系統：這天的收盤價和漲停價。收盤價是最後一盤的成交價，最後一盤沒有成交（例如漲停鎖住、沒有人賣）
// 就用最後一筆成交價，這就是交易所公布的收盤價（2026/10/22 實測 140 檔，和證交所、櫃買的收盤價全部一樣）
export function parseMisQuotes(text: string, day: string): Map<string, Quote> {
  let data: { rtcode?: string; msgArray?: MisRow[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("即時報價系統回傳的不是資料（可能被擋了）");
  }
  if (!Array.isArray(data.msgArray)) throw new Error(`即時報價系統沒有回傳資料（${data.rtcode ?? "沒有代碼"}）`);
  const out = new Map<string, Quote>();
  for (const m of data.msgArray) {
    if (!m.c) continue;
    const d = String(m.d ?? "");
    if (d < compact(day)) throw new NotPublished(`即時報價系統還沒有 ${day} 的資料`);
    if (d > compact(day)) throw new Error(`即時報價系統只有 ${d.slice(4, 6)}/${d.slice(6)} 的資料`);
    if (String(m.t ?? "") < "13:30:00") throw new NotPublished(`即時報價系統的 ${day} 資料還沒收盤`);
    out.set(m.c, { close: toPrice(m.z) ?? toPrice(m.trade?.z), limitUp: toLimitUp(m.u) });
  }
  return out;
}
