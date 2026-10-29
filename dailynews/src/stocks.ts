// 上市櫃代號清單（public/data/stocks.json，由 npm run update-data 從證交所、櫃買中心產生）。
// 比對在瀏覽器做；伺服器這邊只用來確認代號存在，並且一律用官方名稱存檔。
//
// 2026/10/29 起代號清單自動更新：GitHub Actions 每天跑 update-data，傳到 POST /api/stock-data 存進資料庫
// （stock_data）。網站用資料庫那份和部署時帶的 stocks.json 裡比較新的（updated 日期比較晚的；同一天用資料庫的），
// 瀏覽器讀的 /data/stocks.json 也一樣。資料庫那份每個執行個體最多 5 分鐘查一次。
import bundled from "../public/data/stocks.json";
import { json } from "./http";

declare global {
  interface Env {
    // GitHub Actions 傳代號清單用的權杖（wrangler secret put STOCK_UPLOAD_TOKEN）；沒設就不收
    STOCK_UPLOAD_TOKEN?: string;
  }
}

type StockRow = [string, string, string, string[]];
type EmergingRow = [string, string];

export interface StockData {
  updated: string;
  sources?: string[];
  stocks: StockRow[];
  emerging: EmergingRow[];
}

export interface Stock {
  code: string;
  name: string;
  market: string;
}

const CACHE_MS = 5 * 60_000;
// 傳上來的清單少於這些就當來源格式變了，不收（和 update-data.mjs 的檢查一樣）
const MIN_STOCKS = 1500;
const MIN_EMERGING = 100;
const MAX_UPLOAD_BYTES = 1_000_000;

let current: { data: StockData; text: string | null } = { data: bundled as StockData, text: null };
let byCode: Map<string, Stock> | null = null;
let checkedAt = -Infinity;

function use(data: StockData, text: string | null): void {
  current = { data, text };
  byCode = null;
}

// 換成資料庫裡比較新的那份。API 和排程開頭都會呼叫；查不到（例如還沒套 migration）就照舊用部署時帶的
export async function loadStocks(db: D1Database, nowMs = Date.now()): Promise<void> {
  if (nowMs - checkedAt < CACHE_MS) return;
  checkedAt = nowMs;
  try {
    const row = await db
      .prepare("SELECT json FROM stock_data WHERE id = 1 AND updated >= ?")
      .bind(bundled.updated)
      .first<{ json: string }>();
    if (!row) {
      if (current.text !== null) use(bundled as StockData, null);
    } else if (row.json !== current.text) {
      use(JSON.parse(row.json) as StockData, row.json);
    }
  } catch (err) {
    console.error("讀資料庫的代號清單失敗，先用部署時帶的", err);
  }
}

// 資料庫那份比較新時，給瀏覽器的 /data/stocks.json；否則 null（用部署時帶的檔案）
export function stockDataText(): string | null {
  return current.text;
}

export function findStock(code: unknown): Stock | undefined {
  if (typeof code !== "string") return undefined;
  if (!byCode) {
    byCode = new Map();
    for (const [c, name, market] of current.data.stocks) {
      byCode.set(c, { code: c, name, market });
    }
  }
  return byCode.get(code);
}

// 全部上櫃股的代號（存上櫃收盤快照用）
export function otcCodes(): string[] {
  return current.data.stocks.filter((s) => s[2] === "上櫃").map((s) => s[0]);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// 檢查傳上來的清單，格式不對回傳錯誤訊息
function checkStockData(body: unknown): StockData | string {
  if (!body || typeof body !== "object") return "格式錯誤";
  const { updated, sources, stocks, emerging } = body as Record<string, unknown>;
  if (typeof updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) return "updated 要像 2026-10-29";
  if (!Array.isArray(stocks) || !Array.isArray(emerging)) return "缺少 stocks 或 emerging";
  if (stocks.length < MIN_STOCKS) return `上市櫃只有 ${stocks.length} 檔，可能是來源格式變了，不更新`;
  if (emerging.length < MIN_EMERGING) return `興櫃只有 ${emerging.length} 檔，可能是來源格式變了，不更新`;
  for (const s of stocks) {
    if (
      !Array.isArray(s) ||
      s.length !== 4 ||
      !/^\d{4}$/.test(s[0]) ||
      typeof s[1] !== "string" ||
      !s[1] ||
      (s[2] !== "上市" && s[2] !== "上櫃") ||
      !isStrings(s[3])
    ) {
      return `上市櫃這一筆格式不對：${JSON.stringify(s).slice(0, 80)}`;
    }
  }
  for (const s of emerging) {
    if (!Array.isArray(s) || s.length !== 2 || !/^\d{4}$/.test(s[0]) || typeof s[1] !== "string" || !s[1]) {
      return `興櫃這一筆格式不對：${JSON.stringify(s).slice(0, 80)}`;
    }
  }
  return { updated, sources: isStrings(sources) ? sources : [], stocks: stocks as StockRow[], emerging: emerging as EmergingRow[] };
}

// 和目前用的清單比，列出新增、拿掉、改名的上市櫃股（給 GitHub Actions 的紀錄看）
function diff(before: StockData, after: StockData): { added: string[]; removed: string[]; renamed: string[] } {
  const old = new Map(before.stocks.map((s) => [s[0], s]));
  const now = new Map(after.stocks.map((s) => [s[0], s]));
  const label = (s: StockRow) => `${s[0]} ${s[1]}（${s[2]}）`;
  return {
    added: after.stocks.filter((s) => !old.has(s[0])).map(label),
    removed: before.stocks.filter((s) => !now.has(s[0])).map(label),
    renamed: after.stocks
      .filter((s) => old.has(s[0]) && (old.get(s[0])![1] !== s[1] || old.get(s[0])![2] !== s[2]))
      .map((s) => `${label(old.get(s[0])!)} → ${label(s)}`),
  };
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

// POST /api/stock-data：GitHub Actions 傳代號清單進來（Authorization: Bearer 權杖），不用群組密碼登入
export async function handleStockUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.STOCK_UPLOAD_TOKEN) return json({ error: "網站還沒設定 STOCK_UPLOAD_TOKEN" }, 503);
  const given = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [a, b] = await Promise.all([sha256(given), sha256(env.STOCK_UPLOAD_TOKEN)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return json({ error: "權杖不對" }, 401);

  const text = await request.text();
  if (text.length > MAX_UPLOAD_BYTES) return json({ error: "內容太大" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "格式錯誤" }, 400);
  }
  const data = checkStockData(body);
  if (typeof data === "string") return json({ error: data }, 400);

  await loadStocks(env.DB);
  const changes = diff(current.data, data);
  const saved = JSON.stringify(data);
  await env.DB.prepare(
    `INSERT INTO stock_data (id, updated, json, saved_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET updated = excluded.updated, json = excluded.json, saved_at = excluded.saved_at`,
  )
    .bind(data.updated, saved, Math.floor(Date.now() / 1000))
    .run();
  use(data, saved);
  return json({ ok: true, updated: data.updated, stocks: data.stocks.length, emerging: data.emerging.length, ...changes });
}
