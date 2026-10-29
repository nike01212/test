// 收盤比對（延續性觀察）：收盤後貼進來的新聞歸到下一個開盤日的清單，清單上的個股如果前一個交易日
// 收盤漲停（收盤價等於漲停價），就是那一頁的延續性觀察。比對結果存在 closes（hit = 1 就是每日漲停紀錄），
// 清單頁直接拿來對，所以之後才貼的新聞也會跟著出現。
// 誰來比對：送出新聞後網頁會馬上要求比對新的個股；排程收盤後到隔天開盤前再補幾次；清單頁也可以按「重新比對」。
//
// 收盤價、漲停價先向證交所即時報價系統查清單上那幾檔（資料很小，CPU 約 2 毫秒）。它只有最近一個交易日，
// 比對過去的日子、或它連不上時，才改抓交易所的每日收盤資料：證交所那兩份有幾百 KB，正式站剛啟動時
// 解析要 6～10 毫秒，快碰到免費方案的上限；櫃買中心則擋掉 Cloudflare 的機房，正式站上櫃一定抓不到。
// 所以排程收盤後另外把全部上櫃股存一份「上櫃收盤快照」，上櫃股都先看快照（2026/10/27 修 10/22 比對失敗）。
import { calendar } from "./calendar";
import { findStock, loadStocks, otcCodes } from "./stocks";
import {
  isLimitUp,
  loadTpexQuotes,
  MIS_BATCH,
  misUrl,
  NotPublished,
  parseMisQuotes,
  parseTwseCloses,
  parseTwseLimits,
  readSnapshot,
  Replaced,
  snapshotText,
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
// 上櫃收盤快照至少要查到幾成的上櫃股才存（2026/10/27 實測 896 檔查到 895 檔），太少多半是即時報價系統出問題
const SNAPSHOT_MIN_RATIO = 0.9;

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

// 證交所：漲停價在「股價升降幅度」，收盤價在「每日收盤行情」
async function loadTwse(day: string, codes: Set<string>): Promise<Map<string, Quote>> {
  const [limitsText, closeText] = await Promise.all([fetchText(twseLimitsUrl(day)), fetchText(twseCloseUrl(day))]);
  const closes = parseTwseCloses(closeText, day, codes);
  const limits = parseTwseLimits(limitsText, day, codes);
  return new Map([...codes].map((code) => [code, { close: closes.get(code) ?? null, limitUp: limits.get(code) ?? null }]));
}

// 證交所即時報價系統：只查需要的那幾檔，一次最多 MIS_BATCH 檔
async function loadMis(day: string, candidates: { code: string; market: string }[]): Promise<Map<string, Quote>> {
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

// 抓這幾檔在這天的收盤價和漲停價。上櫃先看收盤快照，其他的問即時報價系統，不行再抓交易所的每日收盤資料：
// 上市抓證交所、上櫃抓櫃買中心，分開抓，一邊不行另一邊照樣用（以前一邊不行就整批不存）。
// 抓不到的不在 quotes 裡，原因在 error；note：用了每日收盤資料就寫進比對結果的說明
export async function loadQuotes(
  day: string,
  candidates: Candidate[],
  snapshot: Map<string, Quote>,
): Promise<{ quotes: Map<string, Quote>; note: string; error: Error | null }> {
  const quotes = new Map<string, Quote>();
  for (const c of candidates) {
    const q = c.market === "上櫃" ? snapshot.get(c.code) : undefined;
    if (q) quotes.set(c.code, q);
  }
  const rest = candidates.filter((c) => !quotes.has(c.code));
  if (rest.length === 0) return { quotes, note: "", error: null };

  let misError: Error;
  try {
    const mis = await loadMis(day, rest);
    for (const c of rest) quotes.set(c.code, mis.get(c.code) ?? { close: null, limitUp: null });
    return { quotes, note: "", error: null };
  } catch (err) {
    misError = err as Error;
    console.log(`即時報價系統：${misError.message}，改抓交易所的每日收盤資料`);
  }

  let note = "";
  const errors: Error[] = [];
  for (const market of ["上市", "上櫃"]) {
    const codes = new Set(rest.filter((c) => c.market === market).map((c) => c.code));
    if (codes.size === 0) continue;
    try {
      const daily =
        market === "上市"
          ? await loadTwse(day, codes)
          : await loadTpexQuotes(day, codes, fetchText, (d) => previousTradingDay(d, calendar));
      for (const code of codes) quotes.set(code, daily.get(code) ?? { close: null, limitUp: null });
      note = "用交易所每日收盤資料";
    } catch (err) {
      errors.push(err as Error);
    }
  }
  if (errors.length === 0) return { quotes, note, error: null };
  // 兩邊都還沒公布才算「還沒公布」，晚一點再試；其他情況兩個原因都寫出來
  if (misError instanceof NotPublished && errors.every((e) => e instanceof NotPublished)) {
    return { quotes, note, error: errors[0] };
  }
  // 即時報價系統已經換成之後的日子，上櫃又沒有快照：正式站再也抓不到，只能用家裡的電腦補快照
  const lost = misError instanceof Replaced && rest.some((c) => c.market === "上櫃" && !quotes.has(c.code));
  const hint = lost ? `。${day.slice(5, 7)}/${day.slice(8)} 收盤後沒有存到上櫃的收盤資料，要請發起人用家裡的電腦補` : "";
  const why = errors.map((e) => e.message).join("；");
  return { quotes, note, error: new Error(`${misError.message}，改抓每日收盤資料也不行（${why}）${hint}`) };
}

// 上櫃收盤快照裡這幾檔的收盤價、漲停價（沒有快照、或沒有上櫃股就是空的）
async function loadSnapshot(env: Env, day: string, candidates: Candidate[]): Promise<Map<string, Quote>> {
  const codes = candidates.filter((c) => c.market === "上櫃").map((c) => c.code);
  if (codes.length === 0) return new Map();
  const row = await env.DB.prepare("SELECT quotes FROM otc_snapshots WHERE trading_day = ?")
    .bind(day)
    .first<{ quotes: string }>();
  return row ? readSnapshot(row.quotes, codes) : new Map();
}

// 存這天的上櫃收盤快照：即時報價系統只有最近一個交易日（下一個交易日早上 8 點前就換掉），櫃買中心又擋掉
// Cloudflare，所以收盤後把全部上櫃股（約 900 檔，一次 100 檔、查 9 次）存一份，之後才貼的上櫃股從這裡比對。
// 一天一列（約 22 KB）；全部解析約 2 毫秒 CPU。存過就不再抓
export async function saveOtcSnapshot(env: Env, day: string, nowMs = Date.now()): Promise<string> {
  if (!isAfterClose(day, nowMs)) return `${day} 還沒收盤`;
  const saved = await env.DB.prepare("SELECT count FROM otc_snapshots WHERE trading_day = ?")
    .bind(day)
    .first<{ count: number }>();
  if (saved) return `${day} 已經存過（${saved.count} 檔）`;
  const codes = otcCodes();
  const quotes = await loadMis(day, codes.map((code) => ({ code, market: "上櫃" })));
  if (quotes.size < codes.length * SNAPSHOT_MIN_RATIO) {
    throw new Error(`即時報價系統只查到 ${quotes.size} 檔（上櫃共 ${codes.length} 檔）`);
  }
  await env.DB.prepare(
    `INSERT INTO otc_snapshots (trading_day, quotes, count, source, created_at) VALUES (?, ?, ?, 'mis', ?)
     ON CONFLICT (trading_day) DO NOTHING`,
  )
    .bind(day, snapshotText(codes, quotes), quotes.size, nowSeconds(nowMs))
    .run();
  const hits = [...quotes].filter(([, q]) => isLimitUp(q)).map(([code]) => code);
  return `${day} 存了 ${quotes.size} 檔，收盤漲停 ${hits.length} 檔（${hits.join("、")}）`;
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

  const { quotes, note, error } = await loadQuotes(day, candidates, await loadSnapshot(env, day, candidates));
  // 抓到的照樣存起來；抓不到的下次比對（排程、「現在比對」）再試
  const compared = candidates.filter((c) => quotes.has(c.code));
  const hits: Hit[] = compared
    .filter((c) => isLimitUp(quotes.get(c.code)))
    .map((c) => ({ ...c, close: quotes.get(c.code)!.close! }));
  let message = `比對 ${compared.length} 檔，收盤漲停 ${hits.length} 檔${note ? `（${note}）` : ""}`;
  let status: ClosingResult["status"] = "done";
  if (error) {
    status = error instanceof NotPublished ? "waiting" : "error";
    // 收盤後好幾個小時還沒有資料，多半是那天臨時休市
    const late = taipeiParts(nowMs).date > day || taipeiParts(nowMs).minutes >= LAST_RUN_MINUTES;
    const why = `${error.message}${status === "waiting" && late ? "。到傍晚還沒有的話，可能是那天臨時休市（例如颱風假）" : ""}`;
    message = compared.length ? `${message}；另外 ${candidates.length - compared.length} 檔沒有比對到：${why}` : why;
  }
  const result: ClosingResult = { ...base, status, checked: candidates.length, hits, message };
  if (dryRun) return result;
  if (compared.length === 0) {
    await recordRun(env, result, nowMs).run();
    return result;
  }

  const now = nowSeconds(nowMs);
  await env.DB.batch([
    ...compared.map((c) => {
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

// 排程（wrangler.jsonc）：收盤後到隔天開盤前跑好幾次。先存前一個交易日的上櫃收盤快照（存過就跳過，
// 沒存成功下一次排程再試），再比對「現在貼會歸到的那一頁」新貼的個股（比對過的不再抓，沒有新的就直接結束）
export async function scheduledClosing(env: Env, scheduledMs: number): Promise<string> {
  await loadStocks(env.DB); // 新上櫃的也要存進快照
  const listDay = assignTradingDay(scheduledMs, calendar).tradingDay;
  const day = previousTradingDay(listDay, calendar);
  const snapshot = await saveOtcSnapshot(env, day, scheduledMs).catch((err: Error) => `${day} 沒存成：${err.message}`);
  const r = await checkCloses(env, listDay, { nowMs: scheduledMs });
  return `上櫃收盤快照：${snapshot}\n收盤比對：${listDay} 的清單 vs ${r.day} 收盤 ${r.status} ${r.message}${r.hits.length ? `（${r.hits.map((h) => h.code).join("、")}）` : ""}`;
}
