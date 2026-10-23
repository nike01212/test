// 清單相關的 API。全部都在登入檢查之後才會進來。
import holidays from "../public/data/holidays.json";
import { json, readJson } from "./http";
import { findStock } from "./stocks";
import { assignTradingDay, isIsoDate, parseTaipeiLocal, type Calendar } from "./tradingDay";

const calendar: Calendar = holidays;

// 依 PRD 只存擷取句，不存全文；每檔每則最多 2 句
const MAX_SENTENCES = 2;
const MAX_SENTENCE_LENGTH = 300;
const MAX_TITLE_LENGTH = 120;
const MAX_MENTIONS_PER_ARTICLE = 200;
const MAX_CANDIDATES = 10;
const MAX_IDS = 50;

interface MentionRow {
  id: number;
  article_id: number | null;
  code: string | null;
  name: string | null;
  market: string | null;
  status: string;
  raw: string | null;
  reason: string | null;
  candidates: string | null;
  sentences: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanSentences(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    const text = cleanText(s, MAX_SENTENCE_LENGTH);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_SENTENCES) break;
  }
  return out;
}

function parseJsonArray(text: string | null): unknown[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function cleanIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is number => Number.isInteger(x) && x > 0))].slice(0, MAX_IDS);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

// GET /api/trading-day?at=2026-10-23T08:30（台北時間；不帶 at 就是現在）
function handleTradingDay(url: URL): Response {
  const at = url.searchParams.get("at");
  let ms = Date.now();
  if (at) {
    const parsed = parseTaipeiLocal(at);
    if (parsed === null) return badRequest("時間格式要像 2026-10-23T08:30");
    ms = parsed;
  }
  return json({ ...assignTradingDay(ms, calendar), calendarYears: calendar.years });
}

// GET /api/list?date=YYYY-MM-DD（不帶 date 就是現在貼入會歸到的那一天）
async function handleList(url: URL, env: Env): Promise<Response> {
  const today = assignTradingDay(Date.now(), calendar);
  const dateParam = url.searchParams.get("date");
  if (dateParam && !isIsoDate(dateParam)) return badRequest("日期格式要像 2026-10-23");
  const date = dateParam ?? today.tradingDay;

  const [articles, mentions, prev, next] = await env.DB.batch([
    env.DB.prepare("SELECT id, title, url, pasted_at FROM articles WHERE trading_day = ? ORDER BY pasted_at, id").bind(date),
    env.DB.prepare(
      "SELECT id, article_id, code, name, market, status, raw, reason, candidates, sentences FROM mentions WHERE trading_day = ? ORDER BY id",
    ).bind(date),
    // 前後「有資料的日子」，用索引直接找，不用掃整張表
    env.DB.prepare("SELECT MAX(trading_day) AS d FROM mentions WHERE trading_day < ?").bind(date),
    env.DB.prepare("SELECT MIN(trading_day) AS d FROM mentions WHERE trading_day > ?").bind(date),
  ]);

  return json({
    date,
    today,
    prevDate: (prev.results[0] as { d: string | null } | undefined)?.d ?? null,
    nextDate: (next.results[0] as { d: string | null } | undefined)?.d ?? null,
    articles: articles.results,
    mentions: (mentions.results as unknown as MentionRow[]).map((m) => ({
      ...m,
      candidates: parseJsonArray(m.candidates),
      sentences: parseJsonArray(m.sentences),
    })),
  });
}

// POST /api/articles：瀏覽器比對完的結果。內容只有標題和擷取句，沒有全文
async function handleCreateArticle(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("格式錯誤");

  const now = Date.now();
  let tradingDay = assignTradingDay(now, calendar).tradingDay;
  if (body.tradingDay !== undefined && body.tradingDay !== null) {
    if (!isIsoDate(body.tradingDay)) return badRequest("日期格式要像 2026-10-23");
    tradingDay = body.tradingDay;
  }
  const title = cleanText(body.title, MAX_TITLE_LENGTH) || "（沒有標題）";
  if (!Array.isArray(body.mentions) || body.mentions.length === 0) return badRequest("這則沒有找到個股");
  if (body.mentions.length > MAX_MENTIONS_PER_ARTICLE) return badRequest("一則提到的個股太多了，請分開貼");

  // 同一則裡同一檔只留一列，句子合併
  const confirmed = new Map<string, string[]>();
  const pending: { raw: string; reason: string; candidates: string[]; sentences: string[] }[] = [];
  for (const m of body.mentions as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") return badRequest("格式錯誤");
    const sentences = cleanSentences(m.sentences);
    if (m.status === "ok") {
      if (!findStock(m.code)) return badRequest(`代號 ${String(m.code)} 不在上市櫃清單裡`);
      const code = m.code as string;
      confirmed.set(code, cleanSentences([...(confirmed.get(code) ?? []), ...sentences]));
    } else if (m.status === "pending") {
      const candidates = Array.isArray(m.candidates)
        ? [...new Set(m.candidates.filter((c) => findStock(c)) as string[])].slice(0, MAX_CANDIDATES)
        : [];
      pending.push({ raw: cleanText(m.raw, 40), reason: cleanText(m.reason, 100), candidates, sentences });
    } else {
      return badRequest("格式錯誤");
    }
  }

  const created = Math.floor(now / 1000);
  // 同一個 batch 是一筆交易，中間不會有別人插進來，所以可以用 MAX(id) 拿到剛新增的那一則
  const articleId = "(SELECT MAX(id) FROM articles)";
  const statements = [
    env.DB.prepare("INSERT INTO articles (trading_day, title, pasted_at) VALUES (?, ?, ?) RETURNING id").bind(
      tradingDay,
      title,
      created,
    ),
  ];
  for (const [code, sentences] of confirmed) {
    const s = findStock(code)!;
    statements.push(
      env.DB.prepare(
        `INSERT INTO mentions (trading_day, article_id, code, name, market, status, sentences, created_at) VALUES (?, ${articleId}, ?, ?, ?, 'ok', ?, ?)`,
      ).bind(tradingDay, s.code, s.name, s.market, JSON.stringify(sentences), created),
    );
  }
  for (const p of pending) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO mentions (trading_day, article_id, status, raw, reason, candidates, sentences, created_at) VALUES (?, ${articleId}, 'pending', ?, ?, ?, ?, ?)`,
      ).bind(tradingDay, p.raw, p.reason, JSON.stringify(p.candidates), JSON.stringify(p.sentences), created),
    );
  }
  const results = await env.DB.batch(statements);
  const id = (results[0].results[0] as { id: number }).id;
  return json({ id, tradingDay, confirmed: confirmed.size, pending: pending.length }, 201);
}

// PATCH /api/articles/:id：改所屬交易日（例如颱風假臨時休市）
async function handleMoveArticle(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isIsoDate(body.tradingDay)) return badRequest("日期格式要像 2026-10-23");
  const [moved] = await env.DB.batch([
    env.DB.prepare("UPDATE articles SET trading_day = ? WHERE id = ?").bind(body.tradingDay, id),
    env.DB.prepare("UPDATE mentions SET trading_day = ? WHERE article_id = ?").bind(body.tradingDay, id),
  ]);
  if (!moved.meta.changes) return json({ error: "找不到這一則" }, 404);
  return json({ ok: true, tradingDay: body.tradingDay });
}

// DELETE /api/articles/:id：整則刪掉，連同它對到的個股
async function handleDeleteArticle(env: Env, id: number): Promise<Response> {
  const [, removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM mentions WHERE article_id = ?").bind(id),
    env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id),
  ]);
  if (!removed.meta.changes) return json({ error: "找不到這一則" }, 404);
  return json({ ok: true });
}

// POST /api/stocks {date, code}：手動新增個股
async function handleAddStock(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isIsoDate(body.date)) return badRequest("日期格式要像 2026-10-23");
  const stock = findStock(body.code);
  if (!stock) return badRequest("找不到這個代號");
  const exists = await env.DB.prepare("SELECT 1 FROM mentions WHERE trading_day = ? AND code = ? AND status = 'ok' LIMIT 1")
    .bind(body.date, stock.code)
    .first();
  if (exists) return json({ error: `${stock.code} ${stock.name} 已經在清單裡了` }, 409);
  await env.DB.prepare(
    "INSERT INTO mentions (trading_day, code, name, market, status, created_at) VALUES (?, ?, ?, ?, 'ok', ?)",
  )
    .bind(body.date, stock.code, stock.name, stock.market, nowSeconds())
    .run();
  return json({ ok: true, stock }, 201);
}

// DELETE /api/stocks?date=&code=：從這天的清單刪掉一檔（所有提到它的紀錄）
async function handleDeleteStock(url: URL, env: Env): Promise<Response> {
  const date = url.searchParams.get("date");
  const code = url.searchParams.get("code");
  if (!isIsoDate(date) || !code) return badRequest("缺少日期或代號");
  const res = await env.DB.prepare("DELETE FROM mentions WHERE trading_day = ? AND code = ? AND status = 'ok'")
    .bind(date, code)
    .run();
  if (!res.meta.changes) return json({ error: "清單裡沒有這一檔" }, 404);
  return json({ ok: true });
}

// POST /api/pending/resolve {ids, code}：待確認改成某一檔；code 是 null 代表「不是個股」，直接刪掉
async function handleResolve(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const ids = cleanIds(body?.ids);
  if (!body || ids.length === 0) return badRequest("缺少要處理的項目");
  const placeholders = ids.map(() => "?").join(", ");

  if (body.code === null) {
    await env.DB.prepare(`DELETE FROM mentions WHERE status = 'pending' AND id IN (${placeholders})`)
      .bind(...ids)
      .run();
    return json({ ok: true });
  }
  const stock = findStock(body.code);
  if (!stock) return badRequest("找不到這個代號");
  const res = await env.DB.prepare(
    `UPDATE mentions SET code = ?, name = ?, market = ?, status = 'ok', reason = NULL, candidates = NULL WHERE status = 'pending' AND id IN (${placeholders})`,
  )
    .bind(stock.code, stock.name, stock.market, ...ids)
    .run();
  if (!res.meta.changes) return json({ error: "這些項目已經處理過了" }, 404);
  return json({ ok: true, stock });
}

// 對不到路徑就回傳 null，交給外層回 404
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/trading-day" && method === "GET") return handleTradingDay(url);
  if (path === "/api/list" && method === "GET") return handleList(url, env);
  if (path === "/api/articles" && method === "POST") return handleCreateArticle(request, env);
  if (path === "/api/stocks" && method === "POST") return handleAddStock(request, env);
  if (path === "/api/stocks" && method === "DELETE") return handleDeleteStock(url, env);
  if (path === "/api/pending/resolve" && method === "POST") return handleResolve(request, env);

  const articleMatch = /^\/api\/articles\/(\d+)$/.exec(path);
  if (articleMatch) {
    const id = Number(articleMatch[1]);
    if (method === "PATCH") return handleMoveArticle(request, env, id);
    if (method === "DELETE") return handleDeleteArticle(env, id);
  }
  return null;
}
