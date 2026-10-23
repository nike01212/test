// POST /api/fetch {url, day}：替瀏覽器去抓新聞網頁（瀏覽器自己抓別的網站會被擋），原樣轉回去，
// 由瀏覽器取出標題和內文。伺服器每次請求只有 10ms CPU，所以這裡不解析 HTML；等網站回應的時間不算 CPU。
import { cleanUrl, isFetchable } from "../public/links.js";
import { json, readJson } from "./http";
import { isIsoDate } from "./tradingDay";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

// 用一般瀏覽器的樣子去要網頁，有些新聞網站不給沒有這些標頭的請求
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
};

function fail(message: string, status = 502): Response {
  return json({ error: message }, status);
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403 || status === 429) return `網站拒絕了這次連線（${status}），可能擋掉了雲端主機`;
  if (status === 404 || status === 410) return "找不到這個網頁（可能已經下架）";
  return `網站回應錯誤（${status}）`;
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const start = typeof body?.url === "string" ? cleanUrl(body.url) : null;
  if (!start || !isFetchable(start)) return fail("這個網址不能抓取", 400);

  // 自己跟著轉址走，每一步都檢查，避免被轉到內部網路
  let current = start;
  let res: Response;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(current, { headers: REQUEST_HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const location = res.headers.get("Location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) return fail("網站一直轉址，抓不到內容");
      const next = new URL(location, current).href;
      if (!isFetchable(next)) return fail("網站轉到不能抓取的網址");
      current = next;
    }
  } catch (err) {
    const name = (err as Error)?.name;
    return fail(name === "TimeoutError" || name === "AbortError" ? "網站太久沒回應" : "連不到這個網站");
  }

  if (!res.ok) return fail(statusMessage(res.status));
  const type = res.headers.get("Content-Type") ?? "";
  if (type && !/html|xml|text\/plain/i.test(type)) return fail("這個網址不是新聞網頁（可能是圖片或檔案）");
  if (Number(res.headers.get("Content-Length") ?? 0) > MAX_BYTES) return fail("網頁太大了");
  const page = await res.arrayBuffer();
  if (page.byteLength > MAX_BYTES) return fail("網頁太大了");

  const finalUrl = cleanUrl(current) ?? start;
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "X-Final-Url": finalUrl,
  };
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1];
  if (charset) headers["X-Charset"] = charset;

  // 同一天已經貼過同一篇，告訴瀏覽器（送出時伺服器也會再擋一次）
  if (isIsoDate(body?.day)) {
    const existing = await env.DB.prepare("SELECT id, title FROM articles WHERE trading_day = ? AND url = ? LIMIT 1")
      .bind(body.day, finalUrl)
      .first<{ id: number; title: string }>();
    if (existing) headers["X-Duplicate-Title"] = encodeURIComponent(existing.title);
  }
  return new Response(page, { headers });
}
