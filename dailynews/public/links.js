// 網址相關的純邏輯，瀏覽器（拆分預覽）和伺服器（抓內文、存檔）共用：
// 找出文字裡的網址、清掉追蹤參數、認出 App 推廣連結和推廣文字。

// 網址遇到空白、中文標點或全形括號就結束
const URL_PATTERN = /https?:\/\/[^\s<>"'`「」『』（）【】《》〈〉，。、！？；：…]+/gi;
// 網址結尾常黏到的英文標點（句點、逗號、右括號等）
const TRAILING_PUNCT = /[.,;:!?'"\]}>]+$/;

// 一律拿掉的追蹤參數（不分大小寫）
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "from",
  "fromsite",
  "share",
  "shared",
  "share_id",
  "shareid",
  "sharetype",
  "share_source",
  "openexternalbrowser", // LINE 開外部瀏覽器用的
  "spm",
  "ocid",
  "cmpid",
]);
const TRACKING_PREFIX = /^(?:utm_|pk_|mtm_|hsa_|ga_)/i;

// 常見新聞網站：網址的哪些部分才是「同一篇」。dropQuery 代表查詢參數全部不需要
const SITE_RULES = [
  // 經濟日報、聯合新聞網：/money/story/分類/編號
  { host: /(^|\.)udn\.com$/, dropQuery: true },
  // 鉅亨網：手機版、App 分享的網址都換成 news.cnyes.com/news/id/編號
  {
    host: /(^|\.)cnyes\.com$/,
    dropQuery: true,
    rewrite(u) {
      const m = /^\/news\/id\/(\d+)/.exec(u.pathname);
      if (m) {
        u.hostname = "news.cnyes.com";
        u.pathname = `/news/id/${m[1]}`;
      }
    },
  },
  // 工商時報：/news/日期編號
  { host: /(^|\.)ctee\.com\.tw$/, dropQuery: true },
  // Yahoo 股市、Yahoo 新聞
  { host: /^tw\.(?:stock|news)\.yahoo\.com$/, dropQuery: true },
];

// App 下載、加好友之類的連結，不是新聞
const PROMO_HOSTS = [
  /^apps\.apple\.com$/,
  /^itunes\.apple\.com$/,
  /^play\.google\.com$/,
  /^onelink\.to$/,
  /\.onelink\.me$/,
  /\.page\.link$/,
  /\.app\.link$/,
  /^app\.adjust\.com$/,
  /\.adj\.st$/,
  /^lin\.ee$/,
];

// App 推廣、加好友、看更多之類的文字（只看短的行，長的行可能是內文）
const PROMO_TEXT = [
  /(?:下載|安裝).{0,15}(?:app|應用程式)/i,
  /(?:app|應用程式).{0,10}(?:下載|看更多|閱讀全文|更多新聞|搶先看)/i,
  /(?:看|閱讀)更多.{0,12}(?:新聞|文章|資訊|報導)/,
  /加入.{0,12}(?:好友|官方帳號|line)/i,
  /(?:追蹤|訂閱).{0,12}(?:line|官方帳號|頻道|電子報|粉專|粉絲專頁)/i,
  /(?:分享自|透過.{0,12}分享)/,
];
const PROMO_MAX_LENGTH = 60;

// 文字裡的網址，依出現順序：{ raw, start, end }
export function findUrls(text) {
  const out = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    let raw = m[0];
    // 右括號只有在網址裡沒有左括號時才當成結尾標點
    for (;;) {
      const trimmed = raw.replace(TRAILING_PUNCT, "");
      const noParen = trimmed.endsWith(")") && !trimmed.includes("(") ? trimmed.slice(0, -1) : trimmed;
      if (noParen === raw) break;
      raw = noParen;
    }
    if (raw.length > "https://".length) out.push({ raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

function isTrackingParam(pair) {
  let key = pair.split("=")[0].replace(/\+/g, " ");
  try {
    key = decodeURIComponent(key);
  } catch {}
  return TRACKING_PARAMS.has(key.toLowerCase()) || TRACKING_PREFIX.test(key);
}

// 清掉追蹤參數，回傳「同一篇就會一樣」的網址；不是 http(s) 網址就回傳 null
export function cleanUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  const rule = SITE_RULES.find((r) => r.host.test(u.hostname));
  if (rule) {
    u.protocol = "https:";
    if (rule.dropQuery) u.search = "";
    rule.rewrite?.(u);
  }
  if (u.search) {
    // 沒有要拿掉的就不動，避免改變原本的編碼方式
    const pairs = u.search.slice(1).split("&").filter(Boolean);
    const kept = pairs.filter((p) => !isTrackingParam(p));
    if (kept.length !== pairs.length) u.search = kept.length ? `?${kept.join("&")}` : "";
  }
  return u.href.replace(/\?$/, "");
}

export function isPromoUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (PROMO_HOSTS.some((re) => re.test(u.hostname))) return true;
  // LINE 加好友
  return /(^|\.)line\.me$/.test(u.hostname) && /^\/(?:R\/)?ti\//.test(u.pathname);
}

// 推廣文字那一行如果也附了網址，只有像文章的網址（路徑裡有編號或長的英文代稱）才留下
export function looksLikeArticle(url) {
  try {
    const path = new URL(url).pathname;
    return /\d{5,}/.test(path) || /[\w-]{20,}/.test(path);
  } catch {
    return false;
  }
}

// 這一行（去掉網址之後）是不是 App 推廣、加好友之類的文字
export function isPromoText(line) {
  const text = line.trim();
  return text.length > 0 && text.length <= PROMO_MAX_LENGTH && PROMO_TEXT.some((re) => re.test(text));
}

// 伺服器要不要替人去抓這個網址：只抓一般網站，不抓本機、內部網路或直接寫 IP 的網址
export function isFetchable(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const host = u.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return !/(?:^|\.)(?:localhost|local|internal|lan|home|arpa)$/.test(host);
}
