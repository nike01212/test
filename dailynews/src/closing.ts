// 收盤比對（延續性觀察）：收盤後貼進來的新聞歸到下一個開盤日的清單，清單上的個股如果前一個交易日
// 收盤漲停（收盤價等於漲停價），就是那一頁的延續性觀察。比對結果存在 closes（hit = 1 就是每日漲停紀錄），
// 清單頁直接拿來對，所以之後才貼的新聞也會跟著出現。
// 誰來比對：送出新聞後網頁會馬上要求比對新的個股；排程收盤後到隔天開盤前再補幾次；清單頁也可以按「重新比對」。
//
// 收盤價、漲停價先向證交所即時報價系統查清單上那幾檔（資料很小，CPU 約 2 毫秒）。它只有最近一個交易日，
// 比對過去的日子、或它連不上時，才改抓交易所的每日收盤資料：證交所那兩份有幾百 KB，正式站剛啟動時
// 解析要 6～10 毫秒，快碰到免費方案的上限；櫃買中心則擋掉 Cloudflare 的機房，正式站上櫃一定抓不到。
import { calendar } from "./calendar";
import { findStock } from "./stocks";
import {
  isLimitUp,
  MIS_BATCH,
  misUrl,
  NotPublished,
  parseMisQuotes,
  parseTpexQuotes,
  parseTwseCloses,
  parseTwseLimits,
  tpexQuotesUrl,
  twseCloseUrl,
  twseLimitsUrl,
  type Quote,
} from "./closingData";
import { assignTradingDay, previousTradingDay, taipeiParts } from "./tradingDay";

// 13:30 收盤，收盤行情在收盤之後才陸續公布，14:00 之前不比對
const EARLIEST_MINUTES = 14 * 60;
// 收盤後到這個時間還沒有資料，多半是那天臨時休市
const LAST_RUN_MINUTES = 18 * 60 + 30;
const FETCH_TIMEOUT_MS = 20_000;
// 即時報價系統從 Cloudflare 連有時候要等很久（2026/10/23 實測 3～20 多秒），等久一點，沒回應再試一次。
// 等回應的時間不算 CPU，排程也可以跑很久，只是按「現在比對」的人要多等一下
const MIS_TIMEOUT_MS = 30_000;
const MIS_RETRY_DELAY_MS = 3_000;
// 「重新比對」（整頁重抓）的間隔：證交所對同一個來源短時間內太多次的請求會暫時擋掉，避免大家同時一直按
export const MANUAL_COOLDOWN_SECONDS = 60;
// 櫃買中心的漲停價在前一個交易日那一份裡。遇到臨時休市（例如颱風假）那天沒資料，最多再往前找幾天
const TPEX_LOOKBACK = 3;

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "zh-TW,zh;q=0.9",
};

export interface Hit {
  code: string;
  name: string;
  market: string;
  close: number;
}

export interface ClosingResult {
  day: string; // 比對的是哪一天的收盤
  listDay: string; // 哪一頁清單（day 的下一個開盤日）
  // done 完成；waiting 資料還沒公布；error 出錯；early 還沒收盤
  status: "done" | "waiting" | "error" | "early";
  message: string;
  checked: number;
  hits: Hit[];
}

interface Candidate {
  code: string;
  name: string;
  market: string;
}

function nowSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

// 這天收盤了沒（之後的日子、當天 14:00 前都還沒）
export function isAfterClose(day: string, nowMs = Date.now()): boolean {
  const now = taipeiParts(nowMs);
  return day < now.date || (day === now.date && now.minutes >= EARLIEST_MINUTES);
}

// 交易所的資料網址不會轉址；會轉址的是擋掉了（櫃買中心對雲端機房一律轉到錯誤頁）
async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const host = new URL(url).hostname;
  let res: Response;
  try {
    res = await fetch(url, { headers: REQUEST_HEADERS, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`連不到 ${host}（${(err as Error).name === "TimeoutError" ? "太久沒回應" : (err as Error).message}）`);
  }
  if (res.status >= 300 && res.status < 400) {
    console.log(`${host} 轉址到 ${res.headers.get("Location")}`);
    throw new Error(`${host} 擋掉了這個網站的連線`);
  }
  if (!res.ok) throw new Error(`${host} 回應 ${res.status}`);
  return res.text();
}

// 櫃買中心：收盤價在當天那一份，漲停價在前一個交易日那一份的「次日漲停價」
async function loadTpex(day: string, codes: Set<string>): Promise<Map<string, Quote>> {
  const today = parseTpexQuotes(await fetchText(tpexQuotesUrl(day)), day, codes);
  let before: ReturnType<typeof parseTpexQuotes> | null = null;
  let prev = day;
  for (let i = 0; i < TPEX_LOOKBACK && !before; i++) {
    prev = previousTradingDay(prev, calendar);
    try {
      before = parseTpexQuotes(await fetchText(tpexQuotesUrl(prev)), prev, codes);
    } catch (err) {
      if (!(err instanceof NotPublished)) throw err;
    }
  }
  if (!before) throw new Error("找不到櫃買中心前一個交易日的收盤行情（漲停價要從那裡拿）");
  const out = new Map<string, Quote>();
  for (const code of codes) {
    out.set(code, { close: today.get(code)?.close ?? null, limitUp: before.get(code)?.nextLimitUp ?? null });
  }
  return out;
}

// 證交所即時報價系統：只查需要的那幾檔，一次最多 MIS_BATCH 檔
async function loadMis(day: string, candidates: Candidate[]): Promise<Map<string, Quote>> {
  const list = candidates.map((c) => ({ code: c.code, market: c.market === "上櫃" ? ("otc" as const) : ("tse" as const) }));
  const out = new Map<string, Quote>();
  for (let i = 0; i < list.length; i += MIS_BATCH) {
    const url = misUrl(list.slice(i, i + MIS_BATCH));
    let text: string;
    try {
      text = await fetchText(url, MIS_TIMEOUT_MS);
    } catch (err) {
      console.log(`即時報價系統：${(err as Error).message}，${MIS_RETRY_DELAY_MS / 1000} 秒後再試一次`);
      await new Promise((resolve) => setTimeout(resolve, MIS_RETRY_DELAY_MS));
      text = await fetchText(url, MIS_TIMEOUT_MS);
    }
    for (const [code, q] of parseMisQuotes(text, day)) out.set(code, q);
  }
  return out;
}

// 交易所的每日收盤資料：上市抓證交所兩份；上櫃抓櫃買中心兩份（只取需要的那幾列，不把整份轉成物件）
async function loadDaily(day: string, candidates: Candidate[]): Promise<Map<string, Quote>> {
  const twse = new Set(candidates.filter((c) => c.market === "上市").map((c) => c.code));
  const tpex = new Set(candidates.filter((c) => c.market === "上櫃").map((c) => c.code));
  const quotes = new Map<string, Quote>();
  if (twse.size) {
    const [limitsText, closeText] = await Promise.all([fetchText(twseLimitsUrl(day)), fetchText(twseCloseUrl(day))]);
    const closes = parseTwseCloses(closeText, day, twse);
    const limits = parseTwseLimits(limitsText, day, twse);
    for (const code of twse) quotes.set(code, { close: closes.get(code) ?? null, limitUp: limits.get(code) ?? null });
  }
  if (tpex.size) {
    const otc = await loadTpex(day, tpex);
    for (const code of tpex) quotes.set(code, otc.get(code) ?? { close: null, limitUp: null });
  }
  return quotes;
}

// 抓這幾檔在這天的收盤價和漲停價：先用即時報價系統，不行再抓每日收盤資料。
// note：用了備案就寫進比對結果的說明
export async function loadQuotes(day: string, candidates: Candidate[]): Promise<{ quotes: Map<string, Quote>; note: string }> {
  let misError: Error;
  try {
    const mis = await loadMis(day, candidates);
    const quotes = new Map(candidates.map((c) => [c.code, mis.get(c.code) ?? { close: null, limitUp: null }]));
    return { quotes, note: "" };
  } catch (err) {
    misError = err as Error;
    console.log(`即時報價系統：${misError.message}，改抓交易所的每日收盤資料`);
  }
  try {
    return { quotes: await loadDaily(day, candidates), note: "用交易所每日收盤資料" };
  } catch (err) {
    // 兩邊都還沒公布才算「還沒公布」，晚一點再試；其他情況兩個原因都寫出來
    if (err instanceof NotPublished && misError instanceof NotPublished) throw err;
    // 正式站抓不到櫃買中心，即時報價系統又換成別天的資料時，上櫃就補不到了
    const otc = candidates.some((c) => c.market === "上櫃") ? "。上櫃只能在當天收盤後、隔天開盤前比對" : "";
    throw new Error(`${misError.message}，改抓每日收盤資料也不行（${(err as Error).message}）${otc}`);
  }
}

// 清單上的個股（已對上代號，含以前手動新增的）；all = false 時只要這天收盤還沒比對過的
async function loadCandidates(env: Env, listDay: string, day: string, all: boolean): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT code, MIN(name) AS name, MIN(market) AS market FROM mentions
     WHERE trading_day = ? AND status = 'ok' ${all ? "" : "AND code NOT IN (SELECT code FROM closes WHERE trading_day = ?)"}
     GROUP BY code`,
  )
    .bind(...(all ? [listDay] : [listDay, day]))
    .all<Candidate>();
  return results;
}

// 記下最後一次比對的狀態，清單頁用來顯示「還沒公布」「出錯」
function recordRun(env: Env, r: ClosingResult, nowMs: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO closing_runs (trading_day, status, checked, hits, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (trading_day) DO UPDATE SET status = excluded.status, checked = excluded.checked, hits = excluded.hits,
       message = excluded.message, updated_at = excluded.updated_at`,
  ).bind(r.day, r.status, r.checked, r.hits.length, r.message, nowSeconds(nowMs));
}

// 比對 listDay 這一頁清單上的個股，在前一個交易日（day）收盤有沒有漲停（10/23 發起人說明的需求：
// 收盤後貼進來的新聞，裡面的個股當天收盤漲停的，就是這一頁的延續性觀察）。
// 平常只比對還沒比對過的（新貼的）；all 是「重新比對」，整頁重新抓。
// dryRun 只抓資料、算結果，不寫進資料庫（在正式站測試用），這時可以用 codes 指定代號、不讀清單
export async function checkCloses(
  env: Env,
  listDay: string,
  {
    all = false,
    dryRun = false,
    codes,
    nowMs = Date.now(),
  }: { all?: boolean; dryRun?: boolean; codes?: string[]; nowMs?: number } = {},
): Promise<ClosingResult> {
  const day = previousTradingDay(listDay, calendar);
  const base = { day, listDay, checked: 0, hits: [] as Hit[] };
  if (!isAfterClose(day, nowMs)) return { ...base, status: "early", message: `${day} 還沒收盤，14:00 之後才能比對` };

  const candidates =
    dryRun && codes
      ? codes.flatMap((c) => {
          const s = findStock(c);
          return s ? [{ code: s.code, name: s.name, market: s.market }] : [];
        })
      : await loadCandidates(env, listDay, day, all);
  if (candidates.length === 0) return { ...base, status: "done", message: "沒有新的個股要比對" };

  let quotes: Map<string, Quote>;
  let note = "";
  try {
    ({ quotes, note } = await loadQuotes(day, candidates));
  } catch (err) {
    const waiting = err instanceof NotPublished;
    // 收盤後好幾個小時還沒有資料，多半是那天臨時休市
    const late = taipeiParts(nowMs).date > day || taipeiParts(nowMs).minutes >= LAST_RUN_MINUTES;
    const result: ClosingResult = {
      ...base,
      checked: candidates.length,
      status: waiting ? "waiting" : "error",
      message: `${(err as Error).message}${waiting && late ? "。到傍晚還沒有的話，可能是那天臨時休市（例如颱風假）" : ""}`,
    };
    if (!dryRun) await recordRun(env, result, nowMs).run();
    return result;
  }

  const hits: Hit[] = candidates
    .filter((c) => isLimitUp(quotes.get(c.code)))
    .map((c) => ({ ...c, close: quotes.get(c.code)!.close! }));
  const result: ClosingResult = {
    ...base,
    status: "done",
    checked: candidates.length,
    hits,
    message: `比對 ${candidates.length} 檔，收盤漲停 ${hits.length} 檔${note ? `（${note}）` : ""}`,
  };
  if (dryRun) return result;

  const now = nowSeconds(nowMs);
  await env.DB.batch([
    ...candidates.map((c) => {
      const q = quotes.get(c.code);
      return env.DB.prepare(
        `INSERT INTO closes (trading_day, code, name, market, close, limit_up, hit, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (trading_day, code) DO UPDATE SET close = excluded.close, limit_up = excluded.limit_up, hit = excluded.hit, checked_at = excluded.checked_at`,
      ).bind(day, c.code, c.name, c.market, q?.close ?? null, q?.limitUp ?? null, isLimitUp(q) ? 1 : 0, now);
    }),
    recordRun(env, result, nowMs),
  ]);
  return result;
}

// 排程（wrangler.jsonc）：收盤後到隔天開盤前跑好幾次，比對「現在貼會歸到的那一頁」新貼的個股。
// 已經比對過的不再抓，沒有新的就直接結束
export async function scheduledClosing(env: Env, scheduledMs: number): Promise<string> {
  const listDay = assignTradingDay(scheduledMs, calendar).tradingDay;
  const r = await checkCloses(env, listDay, { nowMs: scheduledMs });
  return `收盤比對：${listDay} 的清單 vs ${r.day} 收盤 ${r.status} ${r.message}${r.hits.length ? `（${r.hits.map((h) => h.code).join("、")}）` : ""}`;
}
