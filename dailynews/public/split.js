// 拆分預覽用的純邏輯：把一次貼進來的一大段（可能混了好幾則網址和 memo）拆成一則一則。
// 拆錯沒關係，預覽畫面可以合併、刪除、改類型。拿不準的時候寧可拆開，讓人合併。
import { cleanUrl, findUrls, isPromoText, isPromoUrl, looksLikeArticle } from "./links.js";

// 空白行之後如果是這些符號開頭，通常是另一則的標題（例如「【永豐投顧】」「《盤前》」）
const HEADER_START = /^[【［[《〈＜<◆■●★▲☆◎▶►✅📌🔥⭐]/u;
// 網址旁邊的文字超過這個長度，就當成一則文字（例如附了來源連結的 memo），網址不另外抓
export const MAX_NOTE = 150;
// 網址前面空一行的單行短標題，最長幾個字還算是這個網址的說明
const TITLE_LINE = 80;

// LINE「儲存聊天」匯出的格式：時間<Tab>名字<Tab>訊息；多行的訊息會用雙引號包起來
const LINE_MESSAGE = /^(?:上午|下午)?\d{1,2}:\d{2}\t[^\t\n]*\t/;
const LINE_DATE = /^\d{4}[./]\d{1,2}[./]\d{1,2}(?:\s*[（(][^）)]{1,3}[）)]|\s+星期.)?$/;
const LINE_HEADER = /^(?:\[LINE\]|儲存日期[:：]|Saved on:)/;

// 從 LINE 電腦版選好幾則訊息複製的格式：時間 名字 訊息（空白隔開，也可能是 Tab），多行的訊息後面幾行沒有時間
const COPY_LINE = /^(?:上午|下午)?\d{1,2}:\d{2}[ \t]+(?=\S)/;
const NAME_MAX = 20; // LINE 的名字最多 20 個字

function unquote(s) {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replaceAll('""', '"') : t;
}

// 是 LINE 匯出的聊天紀錄就拆成一則一則訊息（去掉時間和名字）；不是就回傳 null
function lineMessages(text) {
  const lines = text.split("\n");
  if (!lines.some((l) => LINE_MESSAGE.test(l))) return null;
  const messages = [];
  let current = null;
  let open = false; // 正在讀雙引號包起來的多行訊息
  for (const line of lines) {
    if (open) {
      current.push(line);
      if (/"\s*$/.test(line)) open = false;
    } else if (LINE_MESSAGE.test(line)) {
      const first = line.replace(LINE_MESSAGE, "");
      current = [first];
      messages.push(current);
      open = first.startsWith('"') && !/.+"\s*$/.test(first);
    } else if (LINE_DATE.test(line.trim()) || LINE_HEADER.test(line.trim())) {
      current = null;
    } else if (current) {
      current.push(line);
    } else if (line.trim()) {
      // 第一則訊息之前自己打的字，當成一則
      current = [line];
      messages.push(current);
    }
  }
  return messages.map((m) => unquote(m.join("\n")));
}

// 同一次貼上的內容裡，看得出名字在哪裡結束的：「名字 網址」「名字已收回訊息」。短的在前面
function knownNames(heads) {
  const names = new Set();
  for (const head of heads) {
    const m = /^(.+?)(?:[ \t]+https?:\/\/|已收回訊息\s*$)/.exec(head);
    if (m && m[1].trim().length <= NAME_MAX) names.add(m[1].trim());
  }
  return [...names].sort((a, b) => a.length - b.length);
}

// 拿掉訊息第一行開頭的名字。名字可能有空白（「I’m 九孔 C」），先找上面認得的名字，認不得就拿掉第一個空白前的字
function withoutName(head, names) {
  const tab = /^[^\t]{1,20}\t/.exec(head);
  if (tab) return head.slice(tab[0].length);
  const name = names.find((n) => head === n || head.startsWith(`${n} `));
  return name ? head.slice(name.length + 1) : head.replace(/^\S+\s*/, "");
}

// 是從 LINE 選好幾則訊息複製的就拆成一則一則訊息（每則是好幾行，第一行去掉時間和名字）；不是就回傳 null。
// 第一行就是「時間 名字…」、至少兩行這樣開頭、而且有網址才算，自己寫的 memo 裡有「09:30 台積電法說會」這種行事曆不會被拆開
function lineCopyMessages(text) {
  const lines = text.split("\n");
  const first = lines.find((l) => l.trim() && !LINE_DATE.test(l.trim()));
  if (!first || !COPY_LINE.test(first)) return null;
  if (lines.filter((l) => COPY_LINE.test(l)).length < 2 || findUrls(text).length === 0) return null;
  const messages = [];
  for (const line of lines) {
    if (COPY_LINE.test(line)) messages.push([line.replace(COPY_LINE, "")]);
    else if (messages.length && !LINE_DATE.test(line.trim())) messages[messages.length - 1].push(line);
  }
  const names = knownNames(messages.map((m) => m[0]));
  return messages.map(([head, ...rest]) => [withoutName(head, names), ...rest]);
}

// LINE 轉貼的一則訊息：只收網址，每個網址一則，訊息裡其他的字當成它的說明（不管多長）；
// 沒有網址的（已收回、閒聊、寫到個股的文字）整則略過，memo 要分開貼（2026/10/28 發起人決定）
function copiedUrlItems(lines, stats) {
  if (!lines.some((l) => findUrls(l).length)) {
    stats.noUrl++;
    return [];
  }
  return urlItems(readBlock(lines.filter((l) => l.trim()), stats));
}

// 一段（空白行隔開）裡的每一行：拿掉 App 推廣連結和推廣文字，記下文章網址
function readBlock(lines, stats) {
  const out = [];
  for (const line of lines) {
    const urls = [];
    let rest = "";
    let display = "";
    let pos = 0;
    for (const u of findUrls(line)) {
      rest += line.slice(pos, u.start);
      display += line.slice(pos, u.start);
      pos = u.end;
      const url = cleanUrl(u.raw);
      if (!url || isPromoUrl(url)) {
        stats.promo++;
        continue;
      }
      urls.push({ url, rawUrl: u.raw });
      display += url;
    }
    rest = (rest + line.slice(pos)).replace(/\s+/g, " ").trim();
    display = (display + line.slice(pos)).trim();
    if (isPromoText(rest)) {
      const articles = urls.filter((u) => looksLikeArticle(u.url));
      if (articles.length === 0) {
        stats.promo++;
        continue;
      }
      // 推廣文字後面附的是文章網址：留網址、拿掉文字
      out.push({ text: "", urls: articles, display: articles.map((u) => u.url).join(" ") });
      continue;
    }
    if (rest || urls.length) out.push({ text: rest, urls, display });
  }
  return out;
}

// 一段裡的網址各成一則；網址前面（或同一行）的文字當成它的說明
function urlItems(lines) {
  const items = [];
  let buffer = [];
  for (const l of lines) {
    if (!l.urls.length) {
      if (l.text) buffer.push(l.text);
      continue;
    }
    l.urls.forEach((u, k) => {
      const note = k === 0 ? [...buffer, l.text].filter(Boolean).join("\n") : "";
      items.push({ type: "url", url: u.url, rawUrl: u.rawUrl, note });
    });
    buffer = [];
  }
  // 最後一個網址後面還有字，也算它的說明
  if (buffer.length && items.length) {
    const last = items[items.length - 1];
    last.note = [last.note, ...buffer].filter(Boolean).join("\n");
  }
  return items;
}

function paragraphs(text) {
  const blocks = [];
  let cur = [];
  for (const line of text.split("\n")) {
    if (line.trim()) cur.push(line.trimEnd());
    else if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

function splitChunk(text, stats) {
  const blocks = paragraphs(text)
    .map((lines) => readBlock(lines, stats))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const urls = lines.flatMap((l) => l.urls);
      const note = lines.map((l) => l.text).filter(Boolean).join("\n");
      return {
        lines,
        text: lines.map((l) => l.display).join("\n"),
        // 網址旁邊只有短短的說明 → 網址各成一則；說明很長 → 整段當文字（例如附了來源連結的 memo）
        urlItems: urls.length && note.length <= MAX_NOTE ? urlItems(lines) : null,
      };
    });

  const items = [];
  let textItem = null;
  blocks.forEach((b, i) => {
    if (b.urlItems) {
      items.push(...b.urlItems);
      textItem = null;
      return;
    }
    // 網址前面空一行的單行短標題
    const next = blocks[i + 1];
    if (b.lines.length === 1 && b.text.length <= TITLE_LINE && next?.urlItems && !next.urlItems[0].note) {
      next.urlItems[0].note = b.text;
      return;
    }
    // 連續的文字段落算同一則，除非新的一段看起來是另一則的標題
    if (textItem && !HEADER_START.test(b.text)) textItem.text += `\n\n${b.text}`;
    else {
      textItem = { type: "text", text: b.text };
      items.push(textItem);
    }
  });
  return items;
}

// 主要入口：回傳 { items: [{ type: "url", url, rawUrl, note } | { type: "text", text }], promo, duplicates, noUrl }
// promo：拿掉幾個 App 推廣連結或推廣文字；duplicates：略過幾個重複的網址（同一篇幾個人分享都只留一則）；
// noUrl：LINE 轉貼裡略過幾則沒有網址的訊息
export function splitPaste(text) {
  const stats = { promo: 0, duplicates: 0, noUrl: 0 };
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[​﻿]/g, "");
  const copied = lineCopyMessages(normalized);
  const found = copied
    ? copied.flatMap((m) => copiedUrlItems(m, stats))
    : (lineMessages(normalized) ?? [normalized]).flatMap((chunk) => splitChunk(chunk, stats));
  const items = [];
  const seen = new Set();
  for (const item of found) {
    if (item.type === "url") {
      if (seen.has(item.url)) {
        stats.duplicates++;
        continue;
      }
      seen.add(item.url);
    } else {
      item.text = item.text.trim();
      if (!item.text) continue;
    }
    items.push(item);
  }
  return { items, promo: stats.promo, duplicates: stats.duplicates, noUrl: stats.noUrl };
}

// 文字改成網址類型時用：找出第一個文章網址，其餘文字另外回傳
export function extractUrl(text) {
  for (const u of findUrls(text)) {
    const url = cleanUrl(u.raw);
    if (url && !isPromoUrl(url)) {
      return { url, rawUrl: u.raw, rest: `${text.slice(0, u.start)}${text.slice(u.end)}`.trim() };
    }
  }
  return null;
}
