// 標籤與國際大廠合作對象：在瀏覽器裡判斷（伺服器每次請求只有 10ms CPU），送出時和個股一起存。
// 網址和文字不存全文，送出之後就不能重算，所以要在送出前、瀏覽器手上還有完整內容的時候判斷好。
// 設定檔：public/data/tags.json（標籤和關鍵字）、public/data/big-companies.json（全球市值前 100 名），由發起人手動維護。
import { normalize } from "./matcher.js";

const GAP = 20; // 關鍵字裡的 * 最多隔幾個字
const SAME_SENTENCE = "[^。!?;\\n]"; // 正規化之後全形的！？；已經是半形
const LABEL_SEPARATOR = "、";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWordChar = (c) => c !== undefined && /[A-Z0-9]/.test(c);
const list = (v) => (Array.isArray(v) ? v : []);

// 「營收*新高」→ 營收、同一句裡隔最多 20 個字、新高。英文開頭結尾要整個字對上（ARM 不會對到 ARMY），空白可有可無
export function compileKeyword(word, flags = "u") {
  const key = normalize(String(word ?? "")).replace(/\s+/g, " ").trim();
  const parts = key.split("*").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const body = parts.map((p) => escapeRe(p).replace(/ /g, "\\s*")).join(`${SAME_SENTENCE}{0,${GAP}}?`);
  const head = isWordChar(parts[0][0]) ? "(?<![A-Z0-9])" : "";
  const last = parts[parts.length - 1];
  const tail = isWordChar(last[last.length - 1]) ? "(?![A-Z0-9])" : "";
  return new RegExp(`${head}${body}${tail}`, flags);
}

// 「輝達（NVIDIA）」；沒有中文名稱就只有英文
export function companyLabel(c) {
  const zh = String(c?.zh ?? "").trim();
  const en = String(c?.en ?? "").trim();
  return zh && en ? `${zh}（${en}）` : zh || en;
}

// 例外的詞先換成等長的空白，位置不變、也不會接成新的詞
function mask(norm, excepts) {
  let out = norm;
  for (const re of excepts) out = out.replace(re, (m) => " ".repeat(m.length));
  return out;
}

function lineRanges(norm) {
  return [...norm.matchAll(/[^\n]+/g)].map((m) => [m.index, m.index + m[0].length]);
}

// 依設定檔的順序排；設定檔裡沒有的（改名或刪掉的）照原本的順序放最後
function orderBy(names) {
  const rank = new Map(names.map((n, i) => [n, i]));
  return (items) => {
    const unique = [...new Set(items)];
    return unique
      .map((x, i) => [rank.get(x) ?? names.length + i, x])
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x);
  };
}

export function buildTagger(tagsConfig = {}, companiesConfig = {}) {
  const tags = list(tagsConfig.tags)
    .map((t) => ({
      name: String(t?.name ?? "").trim(),
      keywords: list(t?.keywords).map((w) => compileKeyword(w)).filter(Boolean),
      except: list(t?.except).map((w) => compileKeyword(w, "gu")).filter(Boolean),
    }))
    .filter((t) => t.name && t.keywords.length);
  const companies = list(companiesConfig.companies)
    .map((c) => ({
      label: companyLabel(c),
      aliases: list(c?.aliases).map((w) => compileKeyword(w)).filter(Boolean),
      except: list(c?.except).map((w) => compileKeyword(w, "gu")).filter(Boolean),
    }))
    .filter((c) => c.label);
  const tagNames = [...new Set(tags.map((t) => t.name))];
  const companyLabels = [...new Set(companies.map((c) => c.label))];
  const sortTags = orderBy(tagNames);
  const sortPartners = orderBy(companyLabels);

  // 一段（已正規化的）文字裡有哪些標籤、提到哪些大廠
  function judgeNormalized(norm) {
    const found = { tags: [], partners: [] };
    for (const t of tags) {
      const text = mask(norm, t.except);
      if (t.keywords.some((re) => re.test(text)) && !found.tags.includes(t.name)) found.tags.push(t.name);
    }
    for (const c of companies) {
      if (c.aliases.length === 0) continue;
      const text = mask(norm, c.except);
      if (c.aliases.some((re) => re.test(text)) && !found.partners.includes(c.label)) found.partners.push(c.label);
    }
    return found;
  }

  // 幫 matcher.analyze 找到的每一檔貼上標籤和合作對象（回傳新的陣列，多了 tags、partners）。
  // 只提到一檔：整則內容都算它的。提到好幾檔：只看提到那一檔的段落（一行或一個段落），
  // 券商 memo 一行一檔，才不會把別檔的「調升目標價」貼到這檔上
  function tagMentions(text, mentions) {
    const norm = normalize(String(text ?? ""));
    const lines = mentions.length > 1 ? lineRanges(norm) : [];
    const cache = new Map();
    return mentions.map((m) => {
      const spans = list(m.spans);
      const picked = lines.filter(([s, e]) => spans.some(([a, b]) => a < e && b > s));
      const context = picked.length ? picked.map(([s, e]) => norm.slice(s, e)).join("\n") : norm;
      let found = cache.get(context);
      if (!found) {
        found = judgeNormalized(context);
        cache.set(context, found);
      }
      return { ...m, tags: [...found.tags], partners: [...found.partners] };
    });
  }

  // 好幾則（或好幾檔）的標籤、合作對象合在一起，依設定檔的順序
  function union(items) {
    return {
      tags: sortTags(items.flatMap((m) => list(m.tags))),
      partners: sortPartners(items.flatMap((m) => list(m.partners))),
    };
  }

  return {
    tagNames,
    companyLabels,
    judge: (text) => judgeNormalized(normalize(String(text ?? ""))),
    tagMentions,
    union,
    sortTags,
    sortPartners,
  };
}

// 「訂單、合作；合作對象：輝達（NVIDIA）」，什麼都沒有回傳空字串
export function describeLabels({ tags = [], partners = [] } = {}) {
  const parts = [];
  if (tags.length) parts.push(tags.join(LABEL_SEPARATOR));
  if (partners.length) parts.push(`合作對象：${partners.join(LABEL_SEPARATOR)}`);
  return parts.join("；");
}
