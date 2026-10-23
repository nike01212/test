// 從新聞網頁取出標題和內文。在瀏覽器裡做：伺服器只負責把網頁原樣轉過來（伺服器每次請求只有 10ms CPU）。
// 內文只拿來比對個股、擷取提到個股的句子，不會整篇存起來。

// 已知網站的內文位置；找不到就用通用的找法
const SITE_BODY = [
  [/(^|\.)udn\.com$/, "#article_body, .article-content__editor"],
  [/(^|\.)cnyes\.com$/, "#article-container"],
  [/(^|\.)ctee\.com\.tw$/, "article"],
  [/(^|\.)yahoo\.com$/, ".caas-body, .atoms"],
];
const GENERIC_BODY = ['[itemprop="articleBody"]', "article", "main"];

// 內文以外、會混進來的東西
const NOISE =
  "script, style, noscript, template, iframe, svg, figure, figcaption, aside, nav, footer, form, button, " +
  "[id^='div-gpt-ad'], [class*='ad-box'], [class*='related'], [class*='recommend'], .read-more-vendor";

// 內文裡的版權、分享提示（只看短的段落）
const BOILERPLATE = [/網址複製/, /歡迎.{0,12}(?:轉貼|分享)/, /未經.{0,6}(?:授權|同意)/, /著作權所有/, /All Rights Reserved/i, /偏好來源/, /閒置超過/, /看原文/];
const BOILERPLATE_MAX = 80;
// 內文最後的相關新聞標題：從這段開始後面都不算（不然會對到別篇新聞的個股）
const RELATED_START = /^[【《〔]?(?:更多.{0,12}(?:報導|新聞|文章)|延伸閱讀|相關(?:新聞|報導|文章|閱讀)|推薦閱讀|你可能也想看|看更多)/;

const ARTICLE_TYPES = /^(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/;

// 內文夠長才算抓到；不夠長但有標題、摘要，算「只抓到摘要」
export const MIN_BODY = 100;

export function tidy(text) {
  return String(text ?? "")
    .replace(/[ 　]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function isBoilerplate(paragraph) {
  return paragraph.length <= BOILERPLATE_MAX && BOILERPLATE.some((re) => re.test(paragraph));
}

// 拿掉版權提示、空段落，遇到「更多報導」「延伸閱讀」就停
export function cleanParagraphs(list) {
  const out = [];
  for (const raw of list) {
    const t = tidy(raw).replace(/\n/g, " ");
    if (RELATED_START.test(t)) break;
    if (t && !isBoilerplate(t)) out.push(t);
  }
  return out;
}

// 「標題 | 分類 | 經濟日報」「標題 - 日報 - 工商時報」→「標題」
export function cleanTitle(title, siteName = "") {
  let t = tidy(title).replace(/\n/g, " ");
  t = t.split(/\s[|｜]\s/)[0];
  if (siteName) {
    const parts = t.split(/\s[-–—]\s/);
    const at = parts.findIndex((p, i) => i > 0 && p.includes(siteName));
    if (at > 0) t = parts.slice(0, at).join(" - ");
    // 「標題 - 日報 - 工商時報」裡的「日報」也是網站的分類
    if (at > 1 && parts[at - 1].length <= 4) t = parts.slice(0, at - 1).join(" - ");
  }
  return t.trim();
}

// 從 JSON-LD 物件（可能是陣列、@graph）裡找出新聞那一個
export function findLdArticle(data) {
  const queue = [data];
  while (queue.length) {
    const d = queue.shift();
    if (!d || typeof d !== "object") continue;
    if (Array.isArray(d)) {
      queue.push(...d);
      continue;
    }
    const types = [d["@type"]].flat();
    if (types.some((t) => typeof t === "string" && ARTICLE_TYPES.test(t))) {
      return {
        headline: typeof d.headline === "string" ? d.headline : "",
        articleBody: typeof d.articleBody === "string" ? d.articleBody : "",
      };
    }
    if (d["@graph"]) queue.push(d["@graph"]);
  }
  return null;
}

// 網頁的編碼：伺服器回應標頭說的 > 網頁開頭 <meta charset> 說的 > UTF-8
export function detectCharset(bytes, headerCharset) {
  if (headerCharset) return headerCharset;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : "utf-8";
}

export function decodeHtml(buffer, headerCharset) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder(detectCharset(bytes, headerCharset)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// 一個區塊裡的段落文字
function paragraphsIn(el) {
  const ps = [...el.querySelectorAll("p")].map((p) => p.textContent);
  return cleanParagraphs(ps.length ? ps : tidy(el.textContent).split("\n"));
}

const totalLength = (list) => list.reduce((n, t) => n + t.length, 0);

// 通用的找法：哪一個區塊直接包著最多段落文字，就是內文
function densestParagraphs(doc) {
  const score = new Map();
  for (const p of doc.querySelectorAll("p")) {
    const len = tidy(p.textContent).length;
    if (len < 20 || !p.parentElement) continue;
    score.set(p.parentElement, (score.get(p.parentElement) ?? 0) + len);
  }
  let best = null;
  let bestScore = 0;
  for (const [el, s] of score) {
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  return best ? paragraphsIn(best) : [];
}

function bodyParagraphs(doc, host) {
  const site = SITE_BODY.filter(([re]) => re.test(host)).map(([, sel]) => sel);
  for (const sel of [...site, ...GENERIC_BODY]) {
    for (const el of doc.querySelectorAll(sel)) {
      const ps = paragraphsIn(el);
      if (totalLength(ps) >= MIN_BODY) return ps;
    }
  }
  return densestParagraphs(doc);
}

// 主要入口（要在瀏覽器裡跑，會用到 DOMParser）：回傳 { title, body, description }
export function extractArticle(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {}
  const meta = (sel) => tidy(doc.querySelector(sel)?.getAttribute("content"));

  let ld = null;
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      ld = findLdArticle(JSON.parse(s.textContent));
    } catch {}
    if (ld) break;
  }
  const siteName = meta('meta[property="og:site_name"]');
  const title = cleanTitle(
    ld?.headline || meta('meta[property="og:title"]') || doc.querySelector("h1")?.textContent || doc.title || "",
    siteName,
  );
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');

  for (const el of doc.querySelectorAll(NOISE)) el.remove();
  let body = bodyParagraphs(doc, host).join("\n");
  const ldBody = tidy(ld?.articleBody);
  if (ldBody.length > body.length) body = ldBody;
  return { title, body, description };
}
