// 文字類（貼上的 memo）每一檔要留的那一段（2026/10/27 發起人要求）：送出後清單上看得到跟這檔有關的完整內容，
// 不只提到它的那 2 句。例如外電整理裡「- 2327國巨: 美系重申正向」接著一行說明，國巨就留這兩行；
// 開頭的「早安！10/27 外電綜合整理」不算任何一檔的。在瀏覽器裡切好，和個股一起送出。
//
// 怎麼切段：
// 1. 同一種項目符號（「- 」「1.」「【」等）在 2 個以上的段落開頭出現（沒有空行就看每一行的開頭）：
//    從這個符號開頭的那一行到下一個同樣符號的前一行算一段，中間空行也算同一段（一個項目底下有好幾個段落）。
//    好幾種符號都有時用最先出現的那種，底下的小項目不拆開。第一個符號之前的字照第 2、3 點自己切。
// 2. 沒有項目符號：空一行隔開的段落各算一段。
// 3. 也沒有空行：一行算一段（券商 memo 常常一行一檔）。
// 一則只提到一檔：整則都算它的（和標籤的判斷一樣）。一檔出現在好幾段，依原文順序接起來。

const BULLETS = /^[-－–—•・‧●○◆◇■□▪▶►▸★☆◎※✅📌🔥⭐*＊【［[《〈]/u;
const DASHES = /^[-－–—]/u;

// 這一行開頭是哪一種項目符號；不是項目就回傳 null
function markerOf(line) {
  const s = line.trimStart();
  if (/^\d{1,2}[.．、)）](?!\d)/u.test(s)) return "1.";
  if (/^[(（]\d{1,2}[)）]/u.test(s)) return "(1)";
  if (/^[①-⑳]/u.test(s)) return "①";
  const c = BULLETS.exec(s)?.[0];
  if (!c) return null;
  return DASHES.test(c) ? "-" : c;
}

// 每一行在原文裡的位置
function lineRanges(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end);
    lines.push({ start, end, blank: !line.trim(), marker: markerOf(line) });
    if (nl < 0) return lines;
    start = nl + 1;
  }
}

// 連續、非空白的行算一個段落
function paragraphsOf(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l.blank) cur = null;
    else if (cur) cur.push(l);
    else out.push((cur = [l]));
  }
  return out;
}

const span = (lines) => {
  const kept = lines.filter((l) => !l.blank);
  return kept.length ? [kept[0].start, kept[kept.length - 1].end] : null;
};

// 第 2、3 點：有空行就一段一段，沒有就一行一行
function plainSections(lines) {
  const paragraphs = paragraphsOf(lines);
  if (paragraphs.length > 1) return paragraphs.map(span);
  return (paragraphs[0] ?? []).map((l) => [l.start, l.end]);
}

// 整則切成一段一段：[[開始, 結束], …]
export function sections(text) {
  const lines = lineRanges(String(text ?? ""));
  const paragraphs = paragraphsOf(lines);
  // 有空行時只看段落的第一行（項目底下的小項目、說明裡的符號不算）
  const heads = paragraphs.length > 1 ? paragraphs.map((p) => p[0]) : lines.filter((l) => !l.blank);
  const first = new Map();
  const count = new Map();
  heads.forEach((l, i) => {
    if (!l.marker) return;
    count.set(l.marker, (count.get(l.marker) ?? 0) + 1);
    if (!first.has(l.marker)) first.set(l.marker, i);
  });
  const kinds = [...count].filter(([, n]) => n >= 2).map(([k]) => k);
  if (kinds.length === 0) return plainSections(lines);
  const top = kinds.reduce((a, b) => (first.get(b) < first.get(a) ? b : a));

  const out = [];
  let item = null;
  const preface = [];
  for (const l of lines) {
    if (l.marker === top) {
      if (item) out.push(span(item));
      item = [l];
    } else if (item) item.push(l);
    else preface.push(l);
  }
  if (item) out.push(span(item));
  return [...plainSections(preface), ...out].filter(Boolean).sort((a, b) => a[0] - b[0]);
}

// 幫每一檔加上 passage（原文裡跟它有關的那幾段）。mentions 要有 matcher.analyze 給的 spans；
// 要在拿掉個股、回答待確認之後做，只剩一檔時才會整則都算它的
export function withPassages(text, mentions) {
  const source = String(text ?? "");
  if (mentions.length === 1) return [{ ...mentions[0], passage: source.trim() }];
  const parts = sections(source);
  return mentions.map((m) => {
    const spans = Array.isArray(m.spans) ? m.spans : [];
    const picked = parts.filter(([s, e]) => spans.some(([a, b]) => a < e && b > s));
    return { ...m, passage: picked.map(([s, e]) => source.slice(s, e).trim()).join("\n\n") };
  });
}
