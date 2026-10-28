// 個股比對：在瀏覽器裡跑（伺服器每次請求只有 10ms CPU，比對兩千家公司名稱放在這裡做）。
// 輸入一段文字，找出提到的個股；對不到或有歧義的標成「待確認」。
// 名稱來源：public/data/stocks.json（官方清單）＋ public/data/name-rules.json（手動維護的別名與易混淆詞）。

const SENTENCE_BREAK = /[。！？!?；;\n\r]/;
const KEEP_BREAK = /[。！？!?；;]/; // 這些標點留在句子裡，換行不留
const MAX_SENTENCES = 2;
const LONG_SENTENCE = 160; // 句子太長時只留提到個股的前後一段
const CONTEXT = 70;
const TITLE_LENGTH = 60;

// 括號裡的代號：(2330)、（2330）、(2330.TW)、(2330 TT)
const BRACKET_CODE = /\(\s*(\d{4})\s*(?:[.-]?\s*(?:TWO|TW|TT))?\s*\)/g;
// 2330.TW、6488.TWO
const SUFFIX_CODE = /(?<![\d.])(\d{4})\.(?:TWO|TW)(?![A-Z])/g;
// 括號裡的年份：台灣的財經新聞常寫「今(2026)年」「去(2025)年」「明年(2027)」，2025 千興、2027 大成鋼這些代號剛好是年份
// （2026/10/28 測試找到）。括號裡只有 19xx、20xx，前面是今去明前後同隔翌年、或後面緊接「年」，就當成年份
const YEAR_IN_BRACKET = /^\(\s*(?:19|20)\d{2}\s*\)$/;
const YEAR_BEFORE = /[今去明前後同隔翌年]$/;

// 名稱的優先順序：手動別名 > 官方簡稱 > 由全名產生的別名
const TIER_MANUAL = 0;
const TIER_OFFICIAL = 1;
const TIER_DERIVED = 2;
const TIER_IGNORE_ONLY = 9;

// 逐字正規化，長度不變，位置才能對回原文：全形英數→半形、英文轉大寫、臺→台
export function normalize(text) {
  return text.replace(/[！-～　臺a-z]/g, (c) => {
    if (c === "臺") return "台";
    if (c === "　") return " ";
    const code = c.charCodeAt(0);
    const half = code >= 0xff01 ? String.fromCharCode(code - 0xfee0) : c;
    return half.toUpperCase();
  });
}

function isAsciiWordChar(c) {
  return c !== undefined && /[A-Z0-9]/.test(c);
}

// 第一個非空白行當標題
export function makeTitle(text) {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

function sentenceRanges(norm) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i <= norm.length; i++) {
    const c = norm[i];
    if (i === norm.length || SENTENCE_BREAK.test(c)) {
      const end = i < norm.length && KEEP_BREAK.test(c) ? i + 1 : i;
      if (end > start) ranges.push([start, end]);
      start = i + 1;
    }
  }
  return ranges;
}

function findRange(ranges, pos) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (pos < s) hi = mid - 1;
    else if (pos >= e) lo = mid + 1;
    else return ranges[mid];
  }
  return [pos, pos];
}

function excerpt(text, ranges, pos, len) {
  const [s, e] = findRange(ranges, pos);
  let from = s;
  let to = e;
  if (to - from > LONG_SENTENCE) {
    from = Math.max(s, pos - CONTEXT);
    to = Math.min(e, pos + len + CONTEXT);
  }
  let out = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > s) out = `…${out}`;
  if (to < e) out = `${out}…`;
  return out;
}

function pushSentence(list, sentence) {
  if (sentence && list.length < MAX_SENTENCES && !list.includes(sentence)) list.push(sentence);
}

export function buildMatcher(stocksData, rules = {}) {
  const stocks = new Map(); // 代號 → { code, name, market }
  const dict = new Map(); // 正規化後的名稱 → { tier, codes, ambiguous, ignore }
  const lengthsByFirstChar = new Map(); // 第一個字 → 可能的長度（由長到短，用來找最長的名稱）
  const keysByCode = new Map(); // 代號 → 所有名稱（標示原文用）
  const formerByCode = new Map(); // 代號 → 已經併進這一家的舊公司名稱（name-rules.json 的 merged）
  // 興櫃股：代號 → 名稱。名稱不比對（名稱裡有上市櫃股名稱的例外，見下面的 emergingKeys）；
  // 寫了代號的（「宏偉電機（4565）」）不當待確認，另外列出來，
  // 預覽上直接寫「4565 宏偉是興櫃股，不符合條件，不能加入」（2026/10/28 發起人要求）
  const emerging = new Map(stocksData.emerging ?? []);

  function register(key, tier) {
    let e = dict.get(key);
    if (!e) {
      e = { tier, codes: new Set(), ambiguous: false, ignore: false };
      dict.set(key, e);
      const lens = lengthsByFirstChar.get(key[0]) ?? [];
      if (!lens.includes(key.length)) {
        lens.push(key.length);
        lens.sort((a, b) => b - a);
      }
      lengthsByFirstChar.set(key[0], lens);
    }
    return e;
  }

  function addName(raw, code, tier) {
    const key = normalize(raw).replace(/\s+/g, "");
    if (key.length < 2) return;
    const e = register(key, tier);
    if (tier < e.tier) {
      e.tier = tier;
      e.codes = new Set();
    }
    if (tier === e.tier) e.codes.add(code);
    const keys = keysByCode.get(code) ?? [];
    if (!keys.includes(key)) keys.push(key);
    keysByCode.set(code, keys);
  }

  for (const [code, name, market, aliases] of stocksData.stocks) {
    stocks.set(code, { code, name, market });
    addName(name, code, TIER_OFFICIAL);
    // 「世芯-KY」新聞常寫成「世芯」或「世芯KY」；創新板的「-創」也一樣
    const base = name.replace(/-(?:KY創|KY|創)$/, "");
    if (base !== name) {
      addName(base, code, TIER_OFFICIAL);
      if (name.includes("KY")) addName(`${base}KY`, code, TIER_OFFICIAL);
    }
    for (const alias of aliases) addName(alias, code, TIER_DERIVED);
  }
  for (const [alias, code] of Object.entries(rules.aliases ?? {})) {
    if (stocks.has(code)) addName(alias, code, TIER_MANUAL);
  }
  // 下市、併進別家的公司（矽品 → 日月光投控）：比對、搜尋都和別名一樣，另外記下來給畫面標示
  for (const [name, code] of Object.entries(rules.merged ?? {})) {
    if (!stocks.has(code)) continue;
    addName(name, code, TIER_MANUAL);
    formerByCode.set(code, [...(formerByCode.get(code) ?? []), name]);
  }
  for (const word of rules.ambiguous ?? []) {
    const e = dict.get(normalize(word));
    if (e) e.ambiguous = true;
  }
  for (const word of rules.ignore ?? []) {
    register(normalize(word), TIER_IGNORE_ONLY).ignore = true;
  }
  // 興櫃股的名稱裡有上市櫃股的名稱（「特力屋」裡的「特力」、「宏碁創達」裡的「宏碁」，366 檔裡有 19 檔）：
  // 沒寫代號也整個名稱當成興櫃股，裡面的字不算上市櫃股（2026/10/28 發起人要求）。
  // 其他興櫃名稱照舊不比對（很多是一般用語，例如相互、開展、公信）
  const emergingKeys = [...emerging].flatMap(([code, name]) => {
    const key = normalize(name).replace(/\s+/g, "");
    const hasListed = scanNames(key).some((t) => t.entry.codes.size && !t.entry.ignore);
    return key.length >= 2 && !dict.has(key) && hasListed ? [[key, code]] : [];
  });
  for (const [key, code] of emergingKeys) register(key, TIER_IGNORE_ONLY).emerging = code;

  // 從左到右，每個位置找最長的名稱
  function scanNames(norm) {
    const tokens = [];
    for (let i = 0; i < norm.length; i++) {
      const lens = lengthsByFirstChar.get(norm[i]);
      if (!lens) continue;
      for (const len of lens) {
        if (i + len > norm.length) continue;
        const key = norm.slice(i, i + len);
        const e = dict.get(key);
        if (!e) continue;
        // 英文名稱要整個字對上（ASUS 不能對到 ASUSTEK 的一部分）
        if (isAsciiWordChar(key[0]) && isAsciiWordChar(norm[i - 1])) continue;
        if (isAsciiWordChar(key[len - 1]) && isAsciiWordChar(norm[i + len])) continue;
        tokens.push({ start: i, end: i + len, entry: e });
        i += len - 1;
        break;
      }
    }
    return tokens;
  }

  function scanCodes(norm) {
    const tokens = [];
    for (const re of [BRACKET_CODE, SUFFIX_CODE]) {
      for (const m of norm.matchAll(re)) {
        const end = m.index + m[0].length;
        const year = YEAR_IN_BRACKET.test(m[0]) && (YEAR_BEFORE.test(norm.slice(0, m.index)) || norm[end] === "年");
        tokens.push({ start: m.index, end, code: m[1], year });
      }
    }
    return tokens;
  }

  // 名稱後面（或前面）緊接著的括號代號，例如「台積電(2330)」「台積電 (2330)」。
  // 前面的代號如果已經屬於更前面的名稱（「台積電(2330)聯電」），就不算
  function adjacentCodeToken(norm, token, codeTokens, usedCodes) {
    for (const c of codeTokens) {
      if (c.start >= token.end && c.start - token.end <= 2 && !norm.slice(token.end, c.start).trim()) return c;
    }
    for (const c of codeTokens) {
      if (usedCodes.has(c)) continue;
      if (c.end <= token.start && token.start - c.end <= 1 && !norm.slice(c.end, token.start).trim()) return c;
    }
    return null;
  }

  // 沒有括號、直接黏在名稱旁邊的四位數，例如「2330 台積電」「統一1216」。
  // 這種數字也可能是年份或價格，所以只拿來「確認」，不拿來判斷衝突
  function bareAdjacentCode(norm, token) {
    const after = /^\s?(\d{4})(?!\d)/.exec(norm.slice(token.end, token.end + 6));
    const before = /(?<![\d.,])(\d{4})\s?$/.exec(norm.slice(Math.max(0, token.start - 6), token.start));
    return [after?.[1], before?.[1]].filter(Boolean);
  }

  function describe(code) {
    const s = stocks.get(code);
    return s ? `${s.code} ${s.name}` : code;
  }

  // 主要入口：回傳 { title, mentions: [{ status: "ok", code, sentences } | { status: "pending", raw, reason, candidates, sentences }],
  // emerging: [{ code, name }], emergingSpans }。emerging 是寫了代號的興櫃股（和名稱裡有上市櫃股名稱的興櫃股，例如特力屋），不算個股、不會送出，只在預覽上告訴使用者不能加入。
  // 每個 mention 另外有 spans：在原文裡出現的位置 [開始, 結束]，給標籤判斷用（public/tagger.js），不會送到伺服器
  function analyze(text) {
    const norm = normalize(text);
    const ranges = sentenceRanges(norm);
    const codeTokens = scanCodes(norm);
    // 興櫃股的名稱緊接著它的代號（「特力屋(7867)」「宏碁創達(7706)」）：名稱裡的「特力」「宏碁」不算上市櫃股
    const emergingNames = codeTokens.flatMap((c) => {
      const name = emerging.has(c.code) ? normalize(emerging.get(c.code)) : "";
      const before = norm.slice(0, c.start).trimEnd();
      return name && before.endsWith(name) ? [[before.length - name.length, c.start]] : [];
    });
    const nameTokens = scanNames(norm).filter((t) => !emergingNames.some(([s, e]) => t.start >= s && t.end <= e));
    const usedCodes = new Set();
    const hits = []; // 依出現順序
    const emergingHits = []; // 興櫃股：{ pos, len, code }

    for (const t of nameTokens) {
      const e = t.entry;
      const raw = text.slice(t.start, t.end);
      const codes = [...e.codes];
      let adj = adjacentCodeToken(norm, t, codeTokens, usedCodes);
      if (adj) usedCodes.add(adj);

      const confirming = [adj?.code, ...bareAdjacentCode(norm, t)].find((c) => c && e.codes.has(c));
      if (confirming) {
        hits.push({ pos: t.start, len: t.end - t.start, status: "ok", code: confirming });
        continue;
      }
      // 括號裡的年份只有緊接著的名稱就是那一檔時才算代號（「大成鋼(2027)」），其他當作旁邊沒有代號
      if (adj?.year) {
        usedCodes.delete(adj);
        adj = null;
      }
      // 沒寫代號的興櫃股名稱（「特力屋」）：當成興櫃股，旁邊的代號讓代號自己決定
      if (e.emerging) {
        if (adj) usedCodes.delete(adj);
        emergingHits.push({ pos: t.start, len: t.end - t.start, code: e.emerging });
        continue;
      }
      // 名稱旁邊的代號是興櫃股：以代號為準，當成興櫃股，不算這個名稱的上市櫃股
      if (adj && emerging.has(adj.code)) {
        emergingHits.push({ pos: Math.min(t.start, adj.start), len: Math.max(t.end, adj.end) - Math.min(t.start, adj.start), code: adj.code });
        continue;
      }
      if (adj && !e.ignore) {
        const codeStock = stocks.get(adj.code);
        hits.push({
          pos: t.start,
          len: adj.end - t.start,
          status: "pending",
          kind: "conflict",
          raw: text.slice(Math.min(t.start, adj.start), Math.max(t.end, adj.end)),
          reason: codeStock
            ? `名稱「${raw}」和代號 ${adj.code}（${codeStock.name}）對不起來`
            : `代號 ${adj.code} 不在上市櫃清單裡，名稱是「${raw}」`,
          candidates: [...codes, ...(codeStock && !codes.includes(adj.code) ? [adj.code] : [])],
        });
        continue;
      }
      if (adj) usedCodes.delete(adj); // 一般詞彙旁邊的代號，讓代號自己決定
      if (e.ignore || codes.length === 0) continue;
      if (codes.length > 1) {
        hits.push({
          pos: t.start,
          len: t.end - t.start,
          status: "pending",
          kind: "multi",
          raw,
          reason: `「${raw}」對到不只一檔：${codes.map(describe).join("、")}`,
          candidates: codes,
        });
      } else if (e.ambiguous) {
        hits.push({
          pos: t.start,
          len: t.end - t.start,
          status: "pending",
          kind: "ambiguous",
          raw,
          reason: `「${raw}」也常當一般用語或指其他公司，請確認是不是 ${describe(codes[0])}`,
          candidates: codes,
        });
      } else {
        hits.push({ pos: t.start, len: t.end - t.start, status: "ok", code: codes[0] });
      }
    }

    for (const c of codeTokens) {
      if (usedCodes.has(c) || c.year) continue;
      if (stocks.has(c.code)) {
        hits.push({ pos: c.start, len: c.end - c.start, status: "ok", code: c.code });
      } else if (emerging.has(c.code)) {
        emergingHits.push({ pos: c.start, len: c.end - c.start, code: c.code });
      } else {
        // 把括號前面幾個字一起顯示，比較看得出在講哪一家
        const before = /[\p{L}\p{N}-]{0,6}$/u.exec(text.slice(Math.max(0, c.start - 6), c.start))?.[0] ?? "";
        hits.push({
          pos: c.start,
          len: c.end - c.start,
          status: "pending",
          kind: "unknown",
          raw: `${before}${text.slice(c.start, c.end)}`,
          reason: `代號 ${c.code} 不在上市櫃清單裡（可能是 ETF、興櫃或剛上市）`,
          candidates: [],
        });
      }
    }
    hits.sort((a, b) => a.pos - b.pos);

    // 以個股合併；待確認以「原文 + 候選」合併
    const confirmed = new Map();
    const pending = new Map();
    for (const h of hits) {
      const sentence = excerpt(text, ranges, h.pos, h.len);
      if (h.status === "ok") {
        const item = confirmed.get(h.code) ?? { status: "ok", code: h.code, sentences: [], spans: [] };
        pushSentence(item.sentences, sentence);
        item.spans.push([h.pos, h.pos + h.len]);
        confirmed.set(h.code, item);
      } else {
        const key = `${normalize(h.raw)}|${h.candidates.join(",")}|${h.reason}`;
        const item = pending.get(key) ?? {
          status: "pending",
          kind: h.kind,
          raw: h.raw,
          reason: h.reason,
          candidates: h.candidates,
          sentences: [],
          spans: [],
        };
        pushSentence(item.sentences, sentence);
        item.spans.push([h.pos, h.pos + h.len]);
        pending.set(key, item);
      }
    }
    // 同一則裡已經確定的個股（例如前面寫了「統一(1216)」），後面同名的一般詞彙就直接併進去。
    // 對到多檔的（「台南」可能是台南或台南-KY）不併，前面確定一檔不代表後面講的也是同一檔
    for (const [key, item] of pending) {
      if (item.kind === "ambiguous" && confirmed.has(item.candidates[0])) {
        const target = confirmed.get(item.candidates[0]);
        for (const s of item.sentences) pushSentence(target.sentences, s);
        target.spans.push(...item.spans);
        pending.delete(key);
      }
    }
    emergingHits.sort((a, b) => a.pos - b.pos);
    const emergingCodes = [...new Set(emergingHits.map((x) => x.code))];
    return {
      title: makeTitle(text),
      mentions: [...confirmed.values(), ...pending.values()],
      emerging: emergingCodes.map((code) => ({ code, name: emerging.get(code) })),
      // 興櫃股在原文裡出現的位置：標籤判斷時當成「別家公司」，同一段有興櫃股就不整段算給上市櫃股（public/tagger.js）
      emergingSpans: emergingHits.map((x) => [x.pos, x.pos + x.len]),
    };
  }

  // 待確認改成其他個股、手動加到延續性觀察時的搜尋：代號開頭，或名稱、別名包含輸入的字
  function search(query, limit = 8) {
    const q = normalize(query.trim()).replace(/\s+/g, "");
    if (!q) return [];
    const scored = [];
    for (const s of stocks.values()) {
      let score = -1;
      if (s.code === q) score = 0;
      else if (s.code.startsWith(q)) score = 1;
      else {
        const name = normalize(s.name);
        if (name === q) score = 0;
        else if (name.startsWith(q)) score = 2;
        else if (name.includes(q)) score = 3;
        else if ((keysByCode.get(s.code) ?? []).some((k) => k.includes(q))) score = 4;
      }
      if (score >= 0) scored.push([score, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].code.localeCompare(b[1].code));
    return scored.slice(0, limit).map(([, s]) => s);
  }

  // 在句子裡找出這檔股票的名稱或代號出現的位置（畫面上標示用）
  function highlightRanges(sentence, code, extra = []) {
    const norm = normalize(sentence);
    const keys = [...(keysByCode.get(code) ?? []), ...(code ? [code] : []), ...extra.map((x) => normalize(x))];
    const found = [];
    for (const key of keys) {
      if (!key) continue;
      for (let i = norm.indexOf(key); i >= 0; i = norm.indexOf(key, i + key.length)) found.push([i, i + key.length]);
    }
    found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const r of found) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    return merged;
  }

  // 這檔的句子裡寫的是哪個已經併進來的舊名稱（例如 3711 的句子裡有「矽品」），預覽和清單上標出來。
  // 句子是從對到的地方截的，所以看存下來的句子就知道（每檔每則只存前 2 句，後面才寫舊名稱的不會標）
  function formerNames(code, sentences) {
    const names = formerByCode.get(code);
    if (!names) return [];
    const texts = sentences.map((s) => normalize(s).replace(/\s+/g, ""));
    return names.filter((n) => texts.some((t) => t.includes(normalize(n).replace(/\s+/g, ""))));
  }

  return {
    analyze,
    search,
    highlightRanges,
    formerNames,
    stock: (code) => stocks.get(code),
    size: stocks.size,
  };
}

// 預覽時按「×」拿掉的個股（抓錯的，例如內文的「三竹」被認成三竹資訊）。只拿掉已對上的，待確認的不動。
// 要在 tagger.tagMentions 之前拿掉，標籤和合作對象才會當作沒提到那檔重算：剩一檔時整則內容都算它的
export function withoutCodes(mentions, codes) {
  if (!codes?.size) return mentions;
  return mentions.filter((m) => !(m.status === "ok" && codes.has(m.code)));
}

// 待確認在預覽裡的答案用這個當鑰匙：同一則改字、重新比對之後，同一個待確認還對得上
export function pendingKey(m) {
  return `${m.raw}|${(m.candidates ?? []).join(",")}|${m.reason}`;
}

// 預覽裡回答的待確認（answers：pendingKey → 代號，null 是「不是個股」）。是某一檔就變成對上的個股，
// 同一檔已經對上了就把句子併進去；不是個股就拿掉；沒回答的照舊送出、到清單上再確認。
// 要在 tagger.tagMentions 之前做，標籤和合作對象才會照答案重算
export function applyAnswers(mentions, answers) {
  if (!answers?.size) return mentions;
  const ok = new Map(mentions.filter((m) => m.status === "ok").map((m) => [m.code, m]));
  const pending = [];
  for (const m of mentions) {
    if (m.status === "ok") continue;
    const key = pendingKey(m);
    if (!answers.has(key)) {
      pending.push(m);
      continue;
    }
    const code = answers.get(key);
    if (!code) continue;
    const prev = ok.get(code);
    const merged = { status: "ok", code, sentences: [...(prev?.sentences ?? [])], spans: [...(prev?.spans ?? []), ...(m.spans ?? [])] };
    for (const s of m.sentences) pushSentence(merged.sentences, s);
    ok.set(code, merged);
  }
  return [...ok.values(), ...pending];
}
