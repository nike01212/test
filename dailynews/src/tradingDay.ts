// 所屬交易日：看「貼進來的時候，下一次開盤是哪一天」。
// - 交易日 09:00 前貼入 → 當天
// - 其他時間（09:00 之後、週末、休市日）→ 下一個開盤日
// 休市日來自證交所公布的行事曆（public/data/holidays.json，由 npm run update-data 產生）。

export interface Calendar {
  years: number[]; // 行事曆有涵蓋的年份
  closed: Record<string, string>; // 日期 → 休市原因
}

export interface SkippedDay {
  date: string;
  reason: string;
}

export interface Assignment {
  at: string; // 台北時間 YYYY-MM-DDTHH:MM
  tradingDay: string; // YYYY-MM-DD
  rule: "before_open" | "after_open" | "closed";
  closedReason?: string; // rule 是 closed 時，當天為什麼沒開盤
  skipped: SkippedDay[]; // 往後找開盤日時跳過的日子
  missingYears: number[]; // 用到、但行事曆還沒公布的年份
}

const OPEN_MINUTES = 9 * 60;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKEND = ["週日", "", "", "", "", "", "週六"];

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 台灣沒有日光節約時間，固定 UTC+8
export function taipeiParts(ms: number): { date: string; minutes: number } {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// "2026-10-23T08:30"（台北時間）→ Unix 毫秒；格式不對回傳 null
export function parseTaipeiLocal(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m || !isIsoDate(m[1])) return null;
  const [h, min] = [Number(m[2]), Number(m[3])];
  if (h > 23 || min > 59) return null;
  return Date.parse(`${m[1]}T00:00:00Z`) + (h * 60 + min) * 60000 - TAIPEI_OFFSET_MS;
}

// 沒開盤就回傳原因，有開盤回傳 null
export function closedReason(date: string, cal: Calendar, missing?: Set<number>): string | null {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (WEEKEND[weekday]) return WEEKEND[weekday];
  if (cal.closed[date]) return cal.closed[date];
  const year = Number(date.slice(0, 4));
  if (!cal.years.includes(year)) {
    missing?.add(year);
    // 行事曆還沒公布的年份，至少知道元旦一定休市
    if (date.endsWith("-01-01")) return "中華民國開國紀念日";
  }
  return null;
}

export function assignTradingDay(ms: number, cal: Calendar): Assignment {
  const { date, minutes } = taipeiParts(ms);
  const missing = new Set<number>();
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const at = `${date}T${hh}:${mm}`;

  const todayClosed = closedReason(date, cal, missing);
  if (!todayClosed && minutes < OPEN_MINUTES) {
    return { at, tradingDay: date, rule: "before_open", skipped: [], missingYears: [...missing] };
  }

  const skipped: SkippedDay[] = [];
  let day = addDays(date, 1);
  // 最長的連假也不會超過兩週，設上限避免資料有誤時無窮迴圈
  for (let i = 0; i < 30; i++) {
    const reason = closedReason(day, cal, missing);
    if (!reason) break;
    skipped.push({ date: day, reason });
    day = addDays(day, 1);
  }
  return {
    at,
    tradingDay: day,
    rule: todayClosed ? "closed" : "after_open",
    ...(todayClosed ? { closedReason: todayClosed } : {}),
    skipped,
    missingYears: [...missing],
  };
}
