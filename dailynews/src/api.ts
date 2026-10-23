// 清單相關的 API。全部都在登入檢查之後才會進來。
import holidays from "../public/data/holidays.json";
import { cleanUrl } from "../public/links.js";
import { handleFetch } from "./fetchPage";
import { json, readJson } from "./http";
import { findStock } from "./stocks";
import { addDays, assignTradingDay, isIsoDate, parseTaipeiLocal, taipeiParts, type Calendar } from "./tradingDay";

const calendar: Calendar = holidays;

// 依 PRD 只存擷取句，不存全文；每檔每則最多 2 句。例外是圖片辨識出來的全文（10/23 發起人決定要存）
const MAX_SENTENCES = 2;
const MAX_SENTENCE_LENGTH = 300;
const MAX_TITLE_LENGTH = 120;
const MAX_SOURCE_LENGTH = 120;
const MAX_BODY_LENGTH = 20_000; // 圖片全文：一整版報紙大約一萬字
export const BODY_KEEP_DAYS = 180; // 圖片全文保留幾天（10/23 發起人決定），之後每天排程刪掉
const KINDS = new Set(["url", "text", "image"]);
const MAX_URL_LENGTH = 1000;
const MAX_MENTIONS_PER_ARTICLE = 200;
const MAX_CANDIDATES = 10;
const MAX_IDS = 50;
// 標籤、合作對象（第 5 步）：瀏覽器依 public/data/ 的設定檔判斷好送來，這裡只整理格式，不對照設定檔
// （設定檔改名或刪掉的標籤，已經存下來的還要能顯示、能拿掉）
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 40;

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
  tags: string;
  partners: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// 保留換行（段落）的版本，給圖片全文用
function cleanBody(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
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

// 標籤或合作對象的清單：去掉重複和空的，太長的截掉
function cleanLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const label = cleanText(x, MAX_LABEL_LENGTH);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= MAX_LABELS) break;
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

// 同一天已經有同一篇（articles 的 trading_day + url 唯一索引擋下來的）
function isDuplicateUrl(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
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
    env.DB.prepare(
      "SELECT id, title, url, kind, source, body, pasted_at FROM articles WHERE trading_day = ? ORDER BY pasted_at, id",
    ).bind(date),
    env.DB.prepare(
      "SELECT id, article_id, code, name, market, status, raw, reason, candidates, sentences, tags, partners FROM mentions WHERE trading_day = ? ORDER BY id",
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
      tags: parseJsonArray(m.tags),
      partners: parseJsonArray(m.partners),
    })),
  });
}

// POST /api/articles：瀏覽器比對完的結果。內容是標題、網址、出處、擷取句，以及每檔的標籤和合作對象；圖片另外存辨識出來的全文
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
  let url: string | null = null;
  if (body.url !== undefined && body.url !== null) {
    url = typeof body.url === "string" ? cleanUrl(body.url) : null;
    if (!url || url.length > MAX_URL_LENGTH) return badRequest("網址格式不對");
  }
  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : url ? "url" : "text";
  const source = cleanText(body.source, MAX_SOURCE_LENGTH) || null;
  // 全文只存圖片的
  const fullText = kind === "image" ? cleanBody(body.body, MAX_BODY_LENGTH) || null : null;
  if (!Array.isArray(body.mentions) || body.mentions.length === 0) return badRequest("這則沒有找到個股");
  if (body.mentions.length > MAX_MENTIONS_PER_ARTICLE) return badRequest("一則提到的個股太多了，請分開貼");

  // 同一則裡同一檔只留一列，句子、標籤、合作對象合併
  const confirmed = new Map<string, { sentences: string[]; tags: string[]; partners: string[] }>();
  const pending: { raw: string; reason: string; candidates: string[]; sentences: string[]; tags: string[]; partners: string[] }[] =
    [];
  for (const m of body.mentions as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") return badRequest("格式錯誤");
    const sentences = cleanSentences(m.sentences);
    const tags = cleanLabels(m.tags);
    const partners = cleanLabels(m.partners);
    if (m.status === "ok") {
      if (!findStock(m.code)) return badRequest(`代號 ${String(m.code)} 不在上市櫃清單裡`);
      const code = m.code as string;
      const prev = confirmed.get(code);
      confirmed.set(code, {
        sentences: cleanSentences([...(prev?.sentences ?? []), ...sentences]),
        tags: cleanLabels([...(prev?.tags ?? []), ...tags]),
        partners: cleanLabels([...(prev?.partners ?? []), ...partners]),
      });
    } else if (m.status === "pending") {
      const candidates = Array.isArray(m.candidates)
        ? [...new Set(m.candidates.filter((c) => findStock(c)) as string[])].slice(0, MAX_CANDIDATES)
        : [];
      pending.push({ raw: cleanText(m.raw, 40), reason: cleanText(m.reason, 100), candidates, sentences, tags, partners });
    } else {
      return badRequest("格式錯誤");
    }
  }

  const created = Math.floor(now / 1000);
  // 同一個 batch 是一筆交易，中間不會有別人插進來，所以可以用 MAX(id) 拿到剛新增的那一則
  const articleId = "(SELECT MAX(id) FROM articles)";
  const statements = [
    env.DB.prepare(
      "INSERT INTO articles (trading_day, title, url, kind, source, body, pasted_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(tradingDay, title, url, kind, source, fullText, created),
  ];
  for (const [code, c] of confirmed) {
    const s = findStock(code)!;
    statements.push(
      env.DB.prepare(
        `INSERT INTO mentions (trading_day, article_id, code, name, market, status, sentences, tags, partners, created_at) VALUES (?, ${articleId}, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
      ).bind(
        tradingDay,
        s.code,
        s.name,
        s.market,
        JSON.stringify(c.sentences),
        JSON.stringify(c.tags),
        JSON.stringify(c.partners),
        created,
      ),
    );
  }
  // 待確認的也先存標籤：處理完變成某一檔時，標籤跟著過去
  for (const p of pending) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO mentions (trading_day, article_id, status, raw, reason, candidates, sentences, tags, partners, created_at) VALUES (?, ${articleId}, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        tradingDay,
        p.raw,
        p.reason,
        JSON.stringify(p.candidates),
        JSON.stringify(p.sentences),
        JSON.stringify(p.tags),
        JSON.stringify(p.partners),
        created,
      ),
    );
  }
  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    // 整個 batch 是一筆交易，擋下來時個股也不會寫進去
    if (isDuplicateUrl(err)) return json({ error: "這篇已經在這天的清單裡了", duplicate: true, tradingDay }, 409);
    throw err;
  }
  const id = (results[0].results[0] as { id: number }).id;
  return json({ id, tradingDay, confirmed: confirmed.size, pending: pending.length }, 201);
}

// PATCH /api/articles/:id：改所屬交易日（例如颱風假臨時休市）
async function handleMoveArticle(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isIsoDate(body.tradingDay)) return badRequest("日期格式要像 2026-10-23");
  let moved: D1Result;
  try {
    [moved] = await env.DB.batch([
      env.DB.prepare("UPDATE articles SET trading_day = ? WHERE id = ?").bind(body.tradingDay, id),
      env.DB.prepare("UPDATE mentions SET trading_day = ? WHERE article_id = ?").bind(body.tradingDay, id),
    ]);
  } catch (err) {
    if (isDuplicateUrl(err)) return json({ error: "那天已經有同一篇了", duplicate: true }, 409);
    throw err;
  }
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

// 「加哪些、拿掉哪些」：{ add: [...], remove: [...] }
function cleanChange(v: unknown): { add: string[]; remove: string[] } {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { add: cleanLabels(o.add), remove: cleanLabels(o.remove) };
}

function applyChange(current: unknown[], change: { add: string[]; remove: string[] }): string[] {
  const kept = cleanLabels(current).filter((x) => !change.remove.includes(x));
  return cleanLabels([...kept, ...change.add.filter((x) => !change.remove.includes(x))]);
}

// PATCH /api/stocks {date, code, tags: {add, remove}, partners: {add, remove}}：手動改這天這一檔的標籤、合作對象。
// 加的貼到提到這檔的每一則上，拿掉的從每一則拿掉。只送改了哪些，別人同時改了其他標籤也不會被蓋掉
async function handleEditLabels(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isIsoDate(body.date) || typeof body.code !== "string") return badRequest("缺少日期或代號");
  const tags = cleanChange(body.tags);
  const partners = cleanChange(body.partners);
  const { results } = await env.DB.prepare(
    "SELECT id, tags, partners FROM mentions WHERE trading_day = ? AND code = ? AND status = 'ok'",
  )
    .bind(body.date, body.code)
    .all<{ id: number; tags: string; partners: string }>();
  if (results.length === 0) return json({ error: "清單裡沒有這一檔" }, 404);
  const statements: D1PreparedStatement[] = [];
  for (const row of results) {
    const nextTags = JSON.stringify(applyChange(parseJsonArray(row.tags), tags));
    const nextPartners = JSON.stringify(applyChange(parseJsonArray(row.partners), partners));
    if (nextTags === row.tags && nextPartners === row.partners) continue;
    statements.push(env.DB.prepare("UPDATE mentions SET tags = ?, partners = ? WHERE id = ?").bind(nextTags, nextPartners, row.id));
  }
  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true, changed: statements.length });
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

// 每天排程跑一次：所屬交易日超過 180 天的圖片全文刪掉，標題、出處、擷取句都留著。
// 用 trading_day 的索引找，不會掃整張表
export async function pruneOldBodies(env: Env, nowMs = Date.now()): Promise<{ before: string; cleared: number }> {
  const before = addDays(taipeiParts(nowMs).date, -BODY_KEEP_DAYS);
  const res = await env.DB.prepare("UPDATE articles SET body = NULL WHERE trading_day < ? AND body IS NOT NULL")
    .bind(before)
    .run();
  return { before, cleared: res.meta.changes };
}

// 對不到路徑就回傳 null，交給外層回 404
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/trading-day" && method === "GET") return handleTradingDay(url);
  if (path === "/api/list" && method === "GET") return handleList(url, env);
  if (path === "/api/articles" && method === "POST") return handleCreateArticle(request, env);
  if (path === "/api/fetch" && method === "POST") return handleFetch(request, env);
  if (path === "/api/stocks" && method === "POST") return handleAddStock(request, env);
  if (path === "/api/stocks" && method === "DELETE") return handleDeleteStock(url, env);
  if (path === "/api/stocks" && method === "PATCH") return handleEditLabels(request, env);
  if (path === "/api/pending/resolve" && method === "POST") return handleResolve(request, env);

  const articleMatch = /^\/api\/articles\/(\d+)$/.exec(path);
  if (articleMatch) {
    const id = Number(articleMatch[1]);
    if (method === "PATCH") return handleMoveArticle(request, env, id);
    if (method === "DELETE") return handleDeleteArticle(env, id);
  }
  return null;
}
