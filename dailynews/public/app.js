import { applyAnswers, buildMatcher, makeTitle, pendingKey, withoutCodes } from "/matcher.js";
import {
  binaryToBytes,
  bytesToBinary,
  codesText,
  csvText,
  dayLabel,
  fubonDsl,
  fubonDslFileName,
  GROUP_SIZE,
  mitakeFileName,
  mitakeText,
  parseMitakeList,
  splitGroups,
  watchGroups,
  yuantaText,
} from "/export.js";
import { decodeHtml, extractArticle, MIN_BODY } from "/extract.js";
import { isPersistent, loadCodes, loadMitakeList, pruneOld, saveCodes, saveMitakeList } from "/marks.js";
import { recognize } from "/ocr.js";
import { sections, withPassages } from "/passage.js";
import { extractUrl, splitPaste } from "/split.js";
import { buildTagger, describeLabels, mergeChange } from "/tagger.js";
import { uncheckedCount, watchItems } from "/watch.js";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_SOURCE_SENTENCES = 2;
const QUICK_HINT = "點代號可以複製";
const COMPANY_LIST_REFRESH_DAYS = 183; // 國際大廠名單大約每半年照市值排名更新一次，超過就在網頁最下面提醒
// 代號清單 GitHub Actions 每個交易日早上自動更新（2026/10/29），超過這幾天沒更新就在網頁最下面提醒
// （GitHub 在專案 60 天沒有新的 commit 時會自動停掉排程，要到 Actions 頁面重新啟用）
const STOCK_LIST_STALE_DAYS = 7;
const MITAKE_MAX_BYTES = 100_000; // 三竹的自選清單只有幾百個位元組，比這大的一定不是
const TITLE_PREFIX = document.documentElement.dataset.titlePrefix ?? ""; // 測試站是「【測試站】」（伺服器加的），正式站沒有

const state = {
  date: null, // 目前看的那一天
  data: null, // /api/list 的回應
  stocks: [], // groupStocks 的結果（已依被提到的則數排好）
  matcher: null,
  tagger: null, // 標籤和國際大廠名單；null 還在讀，false 讀取失敗（照樣可以送出，只是沒有標籤）
  dataInfo: "",
  tagInfo: "",
  labelEdit: null, // 正在改標籤的那一檔：{ code, base: { tags, partners }, tags: Set, partners: Set }
  deleting: null, // 選取刪除：選了哪些代號（Set）；null 是平常（2026/10/27 發起人同意的設計）
  pasteDay: null, // 手動改的「會歸到」日期；null 代表照規則
  pasteDayNote: "", // 手動選到休市日、改成下一個開盤日時的說明
  // 自己選的那一頁（‹ ›、日期框、網址帶 ?date=、送出後跳過去的）；null 是今日清單，
  // 或頁面放著過了 09:00 自己變成前一天的那頁（不是自己選的）
  chosenDate: null,
  picked: new Set(), // 這天勾選的代號（只存在這台裝置）
  added: new Set(), // 逐檔快速加入時標記「已加入」的代號（只存在這台裝置）
  exportScope: "all", // "all" 當天全部、"picked" 只匯出已勾選
  mitakeList: loadMitakeList(), // 上傳的三竹自選清單（只存在這台裝置）；null 是還沒上傳
  mitakeError: false, // 上傳的不是三竹匯出的自選檔
};

// 逐檔快速加入：目前在看哪一組、第幾檔（index 等於檔數代表看完了）
const quick = { label: "", stocks: [], index: 0 };

// 拆分預覽：送出前的每一則。只在這個分頁的記憶體裡，圖片也只在這裡，重新整理就不見
const preview = { items: [], nextId: 1, submitting: false, fetchToken: 0 };

const $ = (id) => document.getElementById(id);

// 建立 DOM 元素。文字一律當純文字放進去，不會被當成 HTML
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ---- 日期格式 ----

function weekday(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${y}/${m}/${d}（${weekday(isoDate)}）`;
}

function shortDate(isoDate) {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${m}/${d}（${weekday(isoDate)}）`;
}

// "2026-10-23T21:00" → "2026/10/23（五）21:00"
function formatDateTime(local) {
  const [date, time] = local.split("T");
  return `${formatDate(date)}${time}`;
}

// Unix 秒 → 台北時間 "10/23 14:05"
function taipeiTime(seconds) {
  const d = new Date(seconds * 1000 + TAIPEI_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 現在的台北時間，給 datetime-local 用
function taipeiNowLocal() {
  return new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 16);
}

// ---- 共用 ----

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.replace("/login");
    throw new Error("請重新登入");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "發生錯誤，請再試一次。");
    err.data = data;
    throw err;
  }
  return data;
}

function setResult(box, message, kind) {
  box.textContent = message;
  box.className = `result${kind ? ` ${kind}` : ""}`;
}

function articleLink(article) {
  return article.url
    ? h("a", { href: article.url, target: "_blank", rel: "noopener noreferrer" }, article.title)
    : article.title;
}

let toastTimer;
function toast(message, kind = "ok") {
  const box = $("toast");
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4000);
}

// 把句子裡提到這檔股票的地方標出來
function highlight(sentence, code, extra = []) {
  const ranges = state.matcher ? state.matcher.highlightRanges(sentence, code, extra) : [];
  const out = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s > pos) out.push(sentence.slice(pos, s));
    out.push(h("mark", {}, sentence.slice(s, e)));
    pos = e;
  }
  if (pos < sentence.length) out.push(sentence.slice(pos));
  return out;
}

function stockLabel(code) {
  const s = state.matcher?.stock(code);
  return s ? `${s.code} ${s.name}` : code;
}

// 新聞寫的是已經併進這檔的舊公司（name-rules.json 的 merged，例如矽品 → 日月光投控）
function formerNamesOf(code, sentences) {
  return state.matcher?.formerNames(code, sentences) ?? [];
}

// 預覽：「3711 日月光投控（矽品）」
function formerNote(code, sentences) {
  const names = formerNamesOf(code, sentences);
  return names.length ? `（${names.join("、")}）` : "";
}

// 清單：名稱旁邊標「新聞寫「矽品」」（2026/10/26 發起人選的樣式）
function formerTag(s) {
  const names = formerNamesOf(s.code, s.rows.flatMap((m) => m.sentences));
  if (!names.length) return null;
  return h(
    "span",
    { class: "tag former", title: `${names.join("、")}已經併入${s.name}，這裡算成 ${s.code}` },
    `新聞寫「${names.join("」「")}」`,
  );
}

// 輸入代號或名稱，跳出候選清單
function stockPicker({ placeholder, onPick }) {
  const input = h("input", { type: "search", placeholder, autocomplete: "off", enterkeyhint: "done" });
  const list = h("ul", { class: "suggestions", hidden: true });
  let results = [];

  function update() {
    const q = input.value.trim();
    results = q && state.matcher ? state.matcher.search(q) : [];
    if (q && results.length === 0) {
      list.replaceChildren(h("li", { class: "muted none" }, state.matcher ? "找不到符合的上市櫃個股" : "代號清單載入中…"));
    } else {
      list.replaceChildren(
        ...results.map((s) =>
          h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: "suggestion", onclick: () => pick(s) },
              h("span", { class: "code" }, s.code),
              h("span", {}, s.name),
              h("span", { class: "tag" }, s.market),
            ),
          ),
        ),
      );
    }
    list.hidden = !q;
  }

  async function pick(s) {
    input.value = "";
    update();
    await onPick(s);
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (results[0]) pick(results[0]);
    } else if (e.key === "Escape") {
      input.value = "";
      update();
    }
  });
  return h("div", { class: "picker" }, input, list);
}

// ---- 讀取與畫面 ----

// choose：這是自己選的那一頁（換頁、送出後跳過去），之後貼的歸到這一頁；重新讀同一頁時不帶，原本是不是自己選的照舊
async function loadList(date, { choose = false } = {}) {
  const data = await api(`/api/list${date ? `?date=${date}` : ""}`);
  if (data.date !== state.date) {
    state.picked = loadCodes("picked", data.date);
    state.added = loadCodes("added", data.date);
    // 有勾選就預設只匯出勾選的
    state.exportScope = state.picked.size ? "picked" : "all";
    state.labelEdit = null;
    state.deleting = null; // 換天就離開選取刪除
  }
  state.data = data;
  state.date = data.date;
  const isToday = data.date === data.today.tradingDay;
  if (choose) state.chosenDate = isToday ? null : data.date;
  history.replaceState(null, "", isToday ? "/" : `/?date=${data.date}`);
  $("db").textContent = "連線正常";
  $("db").className = "ok";
  render();
}

function groupStocks(data) {
  const articles = new Map(data.articles.map((a) => [a.id, a]));
  const stocks = new Map();
  for (const m of data.mentions) {
    if (m.status !== "ok") continue;
    let s = stocks.get(m.code);
    if (!s) {
      // mentions 依 id 排好了，第一列就是這檔最早加進清單的那一次
      s = { code: m.code, name: m.name, market: m.market, sources: new Map(), manual: false, rows: [], addedAt: m.created_at, firstId: m.id };
      stocks.set(m.code, s);
    }
    s.rows.push(m); // 標籤、合作對象是每一則各自存的，畫面上合起來
    if (m.article_id === null) {
      s.manual = true;
      continue;
    }
    const src = s.sources.get(m.article_id) ?? { article: articles.get(m.article_id), sentences: [], passages: [] };
    for (const t of m.sentences) {
      if (src.sentences.length < MAX_SOURCE_SENTENCES && !src.sentences.includes(t)) src.sentences.push(t);
    }
    if (m.passage && !src.passages.includes(m.passage)) src.passages.push(m.passage);
    s.sources.set(m.article_id, src);
  }
  for (const s of stocks.values()) Object.assign(s, unionLabels(s.rows));
  // 依加進清單的時間，新的在前面（10/23 發起人要求）；同一則裡的照原文出現的順序
  return [...stocks.values()].sort((a, b) => b.addedAt - a.addedAt || a.firstId - b.firstId);
}

// 匯出照舊依被提到的則數由多到少排（超過 60 檔拆組時，A 組是被提到最多的）
function byMentionCount(stocks) {
  return [...stocks].sort((a, b) => b.sources.size - a.sources.size || a.code.localeCompare(b.code));
}

// 好幾則的標籤、合作對象合在一起；設定檔讀到了就依設定檔的順序
function unionLabels(rows) {
  if (state.tagger) return state.tagger.union(rows);
  return {
    tags: [...new Set(rows.flatMap((m) => m.tags ?? []))],
    partners: [...new Set(rows.flatMap((m) => m.partners ?? []))],
  };
}

function groupPending(data) {
  const articles = new Map(data.articles.map((a) => [a.id, a]));
  const groups = new Map();
  for (const m of data.mentions) {
    if (m.status !== "pending") continue;
    const key = `${m.raw}|${m.candidates.join(",")}|${m.reason}`;
    const g = groups.get(key) ?? { raw: m.raw, reason: m.reason, candidates: m.candidates, ids: [], sources: [] };
    g.ids.push(m.id);
    g.sources.push({ article: articles.get(m.article_id), sentences: m.sentences, passages: m.passage ? [m.passage] : [] });
    groups.set(key, g);
  }
  return [...groups.values()];
}

function render() {
  const data = state.data;
  const isToday = data.date === data.today.tradingDay;
  const stocks = groupStocks(data);
  const pending = groupPending(data);
  state.stocks = stocks;

  $("list-title").textContent = isToday ? "今日清單" : `${shortDate(data.date)}清單`;
  $("count").textContent = stocks.length;
  $("count-wrap").hidden = false;
  $("date").textContent = `${formatDate(data.date)}開盤用`;
  $("date-picker").value = data.date;
  $("prev-day").disabled = !data.prevDate;
  $("next-day").disabled = !data.nextDate;
  $("back-today").hidden = isToday;
  document.title = `${TITLE_PREFIX}${isToday ? "今日清單" : `${shortDate(data.date)}清單`} · 盤後新聞標的整理`;
  renderPasteDay();

  $("pending").hidden = pending.length === 0;
  $("pending-count").textContent = pending.length;
  $("pending-list").replaceChildren(...pending.map(renderPending));

  renderWatch();
  renderExport();
  // 選取刪除：別人刪掉的、這頁已經沒有的不算選了；清單空了就離開
  if (state.deleting) {
    const codes = new Set(stocks.map((s) => s.code));
    state.deleting = stocks.length ? new Set([...state.deleting].filter((c) => codes.has(c))) : null;
  }
  $("stocks-head").hidden = stocks.length === 0;
  $("stocks-count").textContent = stocks.length;
  $("delete-mode").hidden = !!state.deleting;
  $("delete-banner").hidden = !state.deleting;
  $("delete-bar").hidden = !state.deleting;
  $("stock-list").classList.toggle("deleting", !!state.deleting);
  renderDeleteBar();
  $("stock-list").replaceChildren(
    ...(stocks.length
      ? stocks.map(renderStock)
      : [h("div", { class: "card empty" }, "這天還沒有資料。在上面貼上新聞或 memo，就會整理出個股清單。")]),
  );

  $("article-count").textContent = data.articles.length;
  // 這天貼入的資料：新貼的在最上面（10/24 發起人要求；伺服器給的是舊到新）
  const newestFirst = [...data.articles].sort((a, b) => b.pasted_at - a.pasted_at || b.id - a.id);
  $("article-list").replaceChildren(
    ...(newestFirst.length
      ? newestFirst.map(renderArticle)
      : [h("li", { class: "muted" }, "還沒有貼入的資料。")]),
  );
}

// 圖片的出處：「（圖片）B3 上市櫃 1 | 2026. 10. 22 | 工商時報」
function articleOrigin(a) {
  return a?.kind === "image" ? h("span", { class: "origin muted" }, `（圖片）${a.source ?? ""}`) : null;
}

// 圖片辨識出來的全文，預設收起來
function articleBody(a) {
  if (!a?.body) return null;
  return h(
    "details",
    { class: "article-body" },
    h("summary", {}, `辨識出來的全文（${a.body.length.toLocaleString()} 字）`),
    h("p", {}, a.body),
  );
}

function renderSource(src, code, extra) {
  return h(
    "li",
    {},
    h(
      "p",
      { class: "source-title" },
      src.article ? articleLink(src.article) : "（這則已刪除）",
      src.article ? h("span", { class: "muted" }, ` · ${taipeiTime(src.article.pasted_at)}`) : null,
    ),
    articleOrigin(src.article),
    // 文字類（memo）存了跟這檔有關的那一段就顯示整段，沒有的（網址、圖片、10/27 之前貼的）照舊顯示句子
    src.passages?.length
      ? src.passages.map((t) => h("blockquote", { class: "passage" }, highlight(t, code, extra)))
      : src.sentences.map((t) => h("blockquote", {}, highlight(t, code, extra))),
    articleBody(src.article),
  );
}

function renderStock(s) {
  const count = s.sources.size;
  const picked = state.picked.has(s.code);
  const deleting = !!state.deleting;
  const toDelete = deleting && state.deleting.has(s.code);
  const card = h(
    "article",
    {
      class: `card stock${deleting ? (toDelete ? " delete-picked" : "") : picked ? " picked" : ""}`,
      "data-code": s.code,
      // 刪除模式點整張卡片就是選取（手機上比點小方框好按）；點到連結、按鈕、展開全文照原本的
      onclick: deleting
        ? (e) => !e.target.closest("a, button, summary, input, label") && toggleDelete(s.code)
        : undefined,
    },
    h(
      "header",
      { class: "stock-head" },
      // 刪除模式換成刪除用的選取，匯出的勾選先藏起來（兩個分開，免得把要匯出的勾選拿去刪）
      deleting
        ? h(
            "label",
            { class: "pick delete-pick", title: "選取要刪除的個股" },
            h("input", {
              type: "checkbox",
              checked: toDelete,
              "aria-label": `選取要刪除的 ${s.code} ${s.name}`,
              onchange: () => toggleDelete(s.code),
            }),
          )
        : h(
            "label",
            { class: "pick", title: "勾選要匯出的個股" },
            h("input", {
              type: "checkbox",
              checked: picked,
              "aria-label": `勾選 ${s.code} ${s.name}`,
              onchange: (e) => togglePick(s, e.target.checked, card),
            }),
          ),
      h("span", { class: "code" }, s.code),
      h("span", { class: "name" }, s.name),
      h("span", { class: "tag" }, s.market),
      formerTag(s),
      // 「手動新增個股」10/23 拿掉了（漏掉的在預覽裡補），之前手動加的還會顯示「手動新增」
      h("span", { class: "count" }, count ? `${count} 則` : "手動新增"),
      streakTag(s.code),
      addedTag(s.code),
      deleting
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "link-button small danger",
              "aria-label": `刪除 ${s.code} ${s.name}`,
              onclick: () => deleteStock(s),
            },
            "刪除",
          ),
    ),
    renderLabels(s),
    count ? h("ul", { class: "sources" }, [...s.sources.values()].map((src) => renderSource(src, s.code))) : null,
  );
  return card;
}

// 在「逐檔加入」按過「已加入」的（只記在這台裝置的瀏覽器，別人看不到）
function addedTag(code) {
  if (!state.added.has(code)) return null;
  return h("span", { class: "tag added", title: "在「逐檔加入」按過「已加入」，代表已經加進券商自選；只記在這台裝置" }, "已加入自選");
}

// ---- 連續被提到、收盤漲停 ----

// 連續被提到幾個交易日（伺服器依休市行事曆算好，2 天以上才有）
function streakTag(code) {
  const n = state.data.streaks?.[code];
  if (!n) return null;
  const max = state.data.maxStreak;
  const days = n >= max ? `${max} 天以上` : `${n} 天`;
  return h("span", { class: "tag streak", title: `連續 ${days}被提到（以交易日算，週末、休市日不算中斷）` }, `連續 ${days}`);
}

// ---- 延續性觀察（程式裡叫 watch，以前叫續看清單）----
// 這一頁新聞裡的個股，前一個交易日收盤漲停的（10/23 發起人說明的需求）。比對結果由伺服器存好，
// 哪幾檔要顯示在 watch.js 算，所以之後才貼的新聞比對完也會出現

const closingCheck = { day: null, busy: false }; // 正在比對哪一頁

function renderWatch() {
  const w = state.data.watch;
  const from = shortDate(w.fromDay);
  const items = watchItems(state.stocks, w);
  $("watch-count").textContent = items.length;
  $("watch-help").textContent = `新聞裡的個股如果 ${from}收盤漲停，會自動加進來，${shortDate(state.date)}觀察延續性。`;
  $("watch-status").replaceChildren(...watchStatus(w));
  const empty = !state.stocks.length
    ? "還沒有個股。"
    : uncheckedCount(state.stocks, w)
      ? "比對完收盤，漲停的會出現在這裡。"
      : `清單上的個股 ${from}都沒有收盤漲停。`;
  $("watch-list").replaceChildren(...(items.length ? items.map(renderWatchItem) : [h("li", { class: "muted" }, empty)]));
  // 另外存成一組自選，所以匯出放在這一區，不放在上面清單的匯出裡
  const groups = watchGroups(items, state.date).map((g) => ({ ...g, watch: true }));
  $("watch-export").hidden = groups.length === 0;
  $("watch-export-groups").replaceChildren(...groups.map(renderGroup));
}

function watchStatus(w) {
  const from = shortDate(w.fromDay);
  const run = w.run;
  const unchecked = uncheckedCount(state.stocks, w);
  const button = (label, all, title) =>
    h("button", { type: "button", class: "link-button small", title, onclick: () => checkClosing(state.date, { all }) }, label);
  if (closingCheck.busy && closingCheck.day === state.date) return [h("span", { class: "muted" }, `正在比對${from}的收盤…`)];
  if (!w.canRun) return [h("span", { class: "muted" }, `${from}收盤後（約 14:30）會自動比對。`)];
  if (run && run.status !== "done") {
    const at = taipeiTime(run.updated_at);
    const text = run.status === "waiting" ? `${from}收盤比對：${run.message}（${at}）。` : `${from}收盤比對失敗：${run.message}（${at}）。`;
    return [h("span", { class: run.status === "waiting" ? "warn" : "bad" }, `${text}可以按`), button("現在比對", false)];
  }
  if (unchecked) return [h("span", { class: "warn" }, `還有 ${unchecked} 檔還沒比對${from}的收盤。`), button("現在比對", false)];
  if (!state.stocks.length) return [];
  // 都比對完了就只留按鈕（10/23 發起人要求），上次比對的時間放在滑鼠停上去的提示裡
  return [button("重新比對", true, run ? `上次比對：${taipeiTime(run.updated_at)}` : undefined)];
}

function renderWatchItem(item) {
  // 自動加的本來就是收盤漲停才會進來（一定也在下面的清單裡），不另外標；手動加的才標出來
  return h(
    "li",
    { class: "watch-item" },
    h("span", { class: "code" }, item.code),
    h("span", { class: "name" }, item.name),
    h("span", { class: "tag" }, item.market),
    item.source === "manual" ? h("span", { class: "tag" }, "手動加入") : null,
    addedTag(item.code),
    h(
      "button",
      {
        type: "button",
        class: "link-button small danger",
        "aria-label": `把 ${item.code} ${item.name} 移出延續性觀察`,
        onclick: () => removeWatch(item),
      },
      "移出",
    ),
  );
}

async function addWatch(s) {
  await run(async () => {
    await api("/api/watch", { method: "POST", body: { date: state.date, code: s.code } });
    toast(`已把 ${s.code} ${s.name} 加到延續性觀察`);
    await loadList(state.date);
  });
}

async function removeWatch(item) {
  if (!confirm(`把 ${item.code} ${item.name} 移出 ${shortDate(state.date)}的延續性觀察？`)) return;
  await run(async () => {
    await api(`/api/watch?date=${state.date}&code=${encodeURIComponent(item.code)}`, { method: "DELETE" });
    toast(`已移出 ${item.code} ${item.name}`);
    await loadList(state.date);
  });
}

// 比對 day 這一頁清單上的個股在前一個交易日收盤有沒有漲停。all：整頁重新比對（「重新比對」）；
// 平常只比對還沒比對過的。quiet：送出新聞後自動跑的，成功就不跳提示
async function checkClosing(day, { all = false, quiet = false } = {}) {
  if (closingCheck.busy) return;
  Object.assign(closingCheck, { day, busy: true });
  if (state.date === day) renderWatch();
  try {
    const r = await api("/api/closing", { method: "POST", body: { date: day, all } });
    if (r.status === "early") {
      // 前一個交易日還沒收盤，排程收盤後會比對
    } else if (r.status !== "done") toast(r.message, "bad");
    else if (!quiet) toast(`${shortDate(r.day)}收盤比對完成：${r.message}`);
    else if (r.hits.length) toast(`${r.hits.map((x) => `${x.code} ${x.name}`).join("、")} ${shortDate(r.day)}收盤漲停，加進延續性觀察`);
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    closingCheck.busy = false;
  }
  if (state.date === day) await run(() => loadList(day));
}

// ---- 標籤與合作對象 ----

function labelChips(tags) {
  return tags.map((t) => h("span", { class: "label-chip" }, t));
}

function renderLabels(s) {
  if (state.labelEdit?.code === s.code) return renderLabelEditor(s);
  const empty = s.tags.length === 0 && s.partners.length === 0;
  return h(
    "div",
    { class: "stock-labels" },
    labelChips(s.tags),
    s.partners.length
      ? h("span", { class: "partners" }, h("span", { class: "muted" }, "合作對象 "), s.partners.join("、"))
      : null,
    h(
      "button",
      {
        type: "button",
        class: "link-button small",
        "aria-label": `${empty ? "加" : "改"} ${s.code} ${s.name} 的標籤`,
        onclick: (e) => openLabelEdit(s, e.target),
      },
      empty ? "加標籤" : "改標籤",
    ),
  );
}

function openLabelEdit(s, button) {
  state.labelEdit = {
    code: s.code,
    base: { tags: [...s.tags], partners: [...s.partners] },
    tags: new Set(s.tags),
    partners: new Set(s.partners),
    saving: false,
  };
  const card = button.closest(".stock");
  redrawLabels(s, card);
  card?.querySelector(".label-editor input")?.focus();
}

// 只重畫這一檔的標籤區，勾到一半的不會因為整個清單重畫而跳掉
function redrawLabels(s, card) {
  card?.querySelector(".stock-labels, .label-editor")?.replaceWith(renderLabels(s));
}

function labelOption(set, value, name) {
  return h(
    "label",
    { class: "label-option" },
    h("input", {
      type: "checkbox",
      name,
      checked: set.has(value),
      onchange: (e) => (e.target.checked ? set.add(value) : set.delete(value)),
    }),
    h("span", {}, value),
  );
}

// 自己填的標籤、合作對象最長幾個字（伺服器最多收 40 字）
const CUSTOM_TAG_LENGTH = 20;
const CUSTOM_PARTNER_LENGTH = 40;
const tidyLabel = (text) => text.replace(/\s+/g, " ").trim();

// 標籤編輯區：清單上的一檔、預覽的一則共用。ctx 是：
//   edit（正在改的 { base, tags, partners }）、key（表單名稱用）、who（給讀螢幕軟體的說明，例如「3711 日月光投控」）、
//   redraw()（重畫編輯區，回傳它所在的卡片）、help、saveText、onSave、onCancel

// 加完一個之後重畫編輯區，游標放回原本的輸入框，可以接著加下一個
function addToDraft(ctx, set, value, selector) {
  set.add(value);
  ctx.redraw()?.querySelector(selector)?.focus();
}

// 自己填標籤：設定檔裡沒有的也可以加，只加在這裡
function customTagInput(ctx) {
  const input = h("input", {
    type: "text",
    class: "custom-tag",
    placeholder: "自己填標籤",
    maxlength: CUSTOM_TAG_LENGTH,
    enterkeyhint: "done",
    autocomplete: "off",
    "aria-label": `幫 ${ctx.who} 自己填標籤`,
  });
  const add = () => {
    const name = tidyLabel(input.value);
    if (name) addToDraft(ctx, ctx.edit.tags, name, ".custom-tag");
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  return h("span", { class: "label-input" }, input, h("button", { type: "button", class: "secondary", onclick: add }, "加入"));
}

// 加合作對象：搜尋大廠名單（中英文、別名、代號都可以），名單裡沒有的就照打的字加
function partnerSearch(ctx) {
  const edit = ctx.edit;
  const input = h("input", {
    type: "search",
    class: "partner-search",
    placeholder: "搜尋大廠，或直接打公司名稱",
    maxlength: CUSTOM_PARTNER_LENGTH,
    enterkeyhint: "done",
    autocomplete: "off",
    "aria-label": `幫 ${ctx.who} 加合作對象`,
  });
  const list = h("ul", { class: "suggestions", hidden: true });
  let options = [];
  const add = (label) => addToDraft(ctx, edit.partners, label, ".partner-search");

  function update() {
    const text = tidyLabel(input.value);
    const tagger = state.tagger || null;
    options = text && tagger ? tagger.searchCompanies(text).filter((c) => !edit.partners.has(c)) : [];
    // 打的字剛好是名單裡的公司（例如 nvidia）就用名單的名稱，不另外列「自己填」
    const known = tagger?.findCompany(text);
    const custom = text && !known && !edit.partners.has(text) ? text : null;
    const items = options.map((label) => h("li", {}, h("button", { type: "button", class: "suggestion", onclick: () => add(label) }, label)));
    if (custom) {
      items.push(h("li", {}, h("button", { type: "button", class: "suggestion custom", onclick: () => add(custom) }, `自己填「${custom}」`)));
      options = [...options, custom];
    }
    list.replaceChildren(...items);
    list.hidden = options.length === 0;
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (options[0]) add(options[0]);
    } else if (e.key === "Escape") {
      input.value = "";
      update();
    }
  });
  return h("div", { class: "picker partner-picker" }, input, list);
}

function labelEditor(ctx) {
  const edit = ctx.edit;
  const tagger = state.tagger || null;
  // 設定檔裡的標籤，加上已經存下來、但設定檔裡沒有的（改名、刪掉或自己填的），才拿得掉
  const tagNames = [...new Set([...(tagger?.tagNames ?? []), ...edit.base.tags, ...edit.tags])];
  const partnerList = [...edit.base.partners, ...edit.partners];
  const partnerNames = tagger ? tagger.sortPartners(partnerList) : [...new Set(partnerList)];
  return h(
    "div",
    { class: "label-editor" },
    h(
      "fieldset",
      {},
      h("legend", {}, "標籤"),
      tagNames.map((t) => labelOption(edit.tags, t, `tags-${ctx.key}`)),
      state.tagger === null ? h("span", { class: "muted" }, "標籤設定載入中…") : null,
      state.tagger === false ? h("span", { class: "warn" }, "標籤設定讀取失敗（public/data/tags.json）") : null,
      customTagInput(ctx),
    ),
    h(
      "fieldset",
      {},
      h("legend", {}, "合作對象"),
      partnerNames.map((p) => labelOption(edit.partners, p, `partners-${ctx.key}`)),
      partnerSearch(ctx),
    ),
    h("p", { class: "muted label-help" }, ctx.help),
    h(
      "div",
      { class: "label-actions" },
      h("button", { type: "button", class: "primary", disabled: edit.saving, onclick: ctx.onSave }, ctx.saveText),
      h("button", { type: "button", class: "secondary", onclick: ctx.onCancel }, "取消"),
    ),
  );
}

function renderLabelEditor(s) {
  const edit = state.labelEdit;
  const card = () => $("stock-list").querySelector(`[data-code="${s.code}"]`);
  return labelEditor({
    edit,
    key: s.code,
    who: `${s.code} ${s.name}`,
    redraw: () => {
      const c = card();
      redrawLabels(s, c);
      return c;
    },
    help: "改的是這一天的這一檔，提到它的每一則都會一起改。自己填的只加在這裡；想讓以後的新聞自動判斷，要請發起人加進設定檔。",
    saveText: edit.saving ? "儲存中…" : "儲存",
    onSave: () => saveLabelEdit(s),
    onCancel: () => {
      state.labelEdit = null;
      redrawLabels(s, card());
    },
  });
}

async function saveLabelEdit(s) {
  const edit = state.labelEdit;
  if (!edit || edit.saving) return;
  const change = (now, base) => ({ add: [...now].filter((x) => !base.includes(x)), remove: base.filter((x) => !now.has(x)) });
  const tags = change(edit.tags, edit.base.tags);
  const partners = change(edit.partners, edit.base.partners);
  const card = $("stock-list").querySelector(`[data-code="${s.code}"]`);
  if (!tags.add.length && !tags.remove.length && !partners.add.length && !partners.remove.length) {
    state.labelEdit = null;
    redrawLabels(s, card);
    return;
  }
  edit.saving = true;
  redrawLabels(s, card);
  try {
    await api("/api/stocks", { method: "PATCH", body: { date: state.date, code: s.code, tags, partners } });
    state.labelEdit = null;
    toast(`已更新 ${s.code} ${s.name} 的標籤`);
    await loadList(state.date);
  } catch (err) {
    edit.saving = false;
    redrawLabels(s, $("stock-list").querySelector(`[data-code="${s.code}"]`));
    toast(err.message, "bad");
  }
}

// ---- 匯出 ----

function exportStocks() {
  const all = byMentionCount(state.stocks);
  return state.exportScope === "picked" ? all.filter((s) => state.picked.has(s.code)) : all;
}

function renderExport() {
  const all = state.stocks;
  const pickedCount = all.filter((s) => state.picked.has(s.code)).length;
  $("export").hidden = all.length === 0;
  $("scope-all-count").textContent = all.length;
  $("scope-picked-count").textContent = pickedCount;
  for (const radio of document.querySelectorAll('input[name="export-scope"]')) {
    radio.checked = radio.value === state.exportScope;
  }
  $("pick-none").disabled = pickedCount === 0;

  const chosen = exportStocks();
  // 主清單的每一組另外有元大、三竹、富邦 e01 電腦版的匯入檔；三竹檔每 60 檔一個（1027-三竹-1.csv…）
  const groups = (chosen.length ? splitGroups(chosen, state.date) : []).map((g, i, all) => ({
    ...g,
    mitakeFile: mitakeFileName(state.date, i, all.length),
  }));
  const pendingCount = state.data.mentions.filter((m) => m.status === "pending").length;
  const notes = [];
  if (state.exportScope === "picked" && chosen.length === 0) {
    notes.push(h("p", { class: "warn" }, "還沒勾選任何個股。在下面的清單勾選要的個股，或改選「當天全部」。"));
  }
  // 文字照 10/24 發起人要求的寫法（拆組的規則寫在 README「分組」）
  if (groups.length > 1) notes.push(h("p", {}, `超過 ${GROUP_SIZE} 檔，將分成多份檔案。`));
  if (pendingCount) notes.push(h("p", { class: "muted" }, `還有 ${pendingCount} 個待確認不會匯出，處理完才會算進來。`));
  if (!isPersistent()) {
    notes.push(h("p", { class: "warn" }, "這個瀏覽器不能儲存資料（可能是私密瀏覽），重新整理後勾選和匯入的三竹清單會不見。"));
  }
  $("export-notes").replaceChildren(...notes);
  renderMitakeList();
  $("export-groups").replaceChildren(...groups.map(renderGroup));
}

// 三竹匯入會把軟體裡的自選全部蓋掉：提醒可以先上傳原本的清單，新的個股放在 G1 這一列
function renderMitakeList() {
  const note = $("mitake-note");
  note.className = state.mitakeList ? "muted" : "warn";
  note.textContent = state.mitakeList
    ? "已匯入三竹清單，新的個股會放在 G1 這一列，其他組照原本的清單。"
    : "三竹匯入會覆蓋全部自選。如果要保留原本的清單，請先按「匯入三竹清單」上傳；新的個股會放在 G1 這一列。";
  $("mitake-error").hidden = !state.mitakeError;
}

async function importMitakeList(input) {
  const file = input.files[0];
  input.value = ""; // 同一個檔再選一次也會觸發
  if (!file) return;
  const list = file.size <= MITAKE_MAX_BYTES ? bytesToBinary(new Uint8Array(await file.arrayBuffer())) : "";
  state.mitakeError = !parseMitakeList(list);
  if (state.mitakeError) {
    toast("這不是三竹匯出的自選檔，請重新上傳正確的檔案。", "bad");
  } else {
    state.mitakeList = list;
    saveMitakeList(list);
    toast("已匯入三竹清單");
  }
  renderExport();
}

function renderGroup(g) {
  const actions = [
    h("button", { type: "button", class: "primary", onclick: () => copyCodes(g) }, "複製代號"),
    h("button", { type: "button", class: "secondary", onclick: () => download(`${g.label}.txt`, `${codesText(g.stocks)}\n`, "text/plain") }, "下載 .txt"),
    h("button", { type: "button", class: "secondary", onclick: () => download(`${g.label}.csv`, csvText(g.stocks), "text/csv") }, "下載 CSV"),
  ];
  // 元大、三竹的匯入檔只有主清單（延續性觀察那組沒有）；副檔名也是 .csv，檔名加券商免得和上面那個撞名
  if (g.mitakeFile) {
    actions.push(
      h(
        "button",
        { type: "button", class: "secondary", title: "元大電腦版看盤匯入自選股用，匯入後是新的一組", onclick: () => download(`${g.label}-元大.csv`, yuantaText([g]), "text/csv") },
        "下載元大檔",
      ),
      h(
        "button",
        {
          type: "button",
          class: "secondary",
          title: "三竹電腦版匯入自選股用：匯入會覆蓋全部自選，這組放在 G1",
          onclick: () => download(g.mitakeFile, binaryToBytes(mitakeText(g.stocks, dayLabel(state.date), state.mitakeList)), "text/csv"),
        },
        "下載三竹檔",
      ),
    );
  }
  // 富邦 e01 的自選股匯出檔：主清單和延續性觀察都有（10/26 發起人要求）。
  // 組名是這組的名稱，每次下載都是新的 ID（匯入後加在最後面）
  actions.push(
    h(
      "button",
      {
        type: "button",
        class: "secondary",
        title: "富邦 e01 匯入自選股用，匯入後最後面多一組，組名是這組的名稱",
        onclick: () => download(fubonDslFileName(g.label), fubonDsl(g.stocks, g.label, crypto.randomUUID().toUpperCase()), "application/octet-stream"),
      },
      "下載富邦檔",
    ),
    h("button", { type: "button", class: "secondary", onclick: () => openQuick(g) }, "逐檔加入"),
  );
  return h(
    "div",
    { class: `export-group${g.watch ? " watch-group" : ""}` },
    h("p", { class: "group-head" }, h("strong", { class: "group-label" }, g.label), h("span", { class: "muted" }, ` ${g.stocks.length} 檔`)),
    h("div", { class: `export-actions${g.mitakeFile ? " with-brokers" : ""}` }, ...actions),
  );
}

function togglePick(s, checked, card) {
  const wasEmpty = state.picked.size === 0;
  if (checked) state.picked.add(s.code);
  else state.picked.delete(s.code);
  saveCodes("picked", state.date, state.picked);
  card.classList.toggle("picked", checked);
  // 第一次勾選時自動切到「只匯出已勾選」
  if (checked && wasEmpty) state.exportScope = "picked";
  renderExport();
}

function pickNone() {
  const count = state.stocks.filter((s) => state.picked.has(s.code)).length;
  if (!confirm(`取消 ${shortDate(state.date)}清單的全部 ${count} 個勾選？`)) return;
  state.picked = new Set();
  saveCodes("picked", state.date, state.picked);
  render();
}

// 先用剪貼簿 API；不支援或被擋時，退回舊的選取再複製
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.className = "copy-buffer";
    // 對話框開著時要放在對話框裡，才選得到
    ($("quick").open ? $("quick") : document.body).append(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    box.remove();
    return ok;
  }
}

async function copyCodes(g) {
  if (await copyText(codesText(g.stocks))) toast(`已複製 ${g.label} 的 ${g.stocks.length} 個代號（一行一個）`);
  else toast("這個瀏覽器不能自動複製，請改用「下載 .txt」。", "bad");
}

// 字串存成 UTF-8；三竹檔是位元組（Uint8Array），照原樣存，上傳的清單是 Big5 也不會變
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type: typeof content === "string" ? `${type};charset=utf-8` : type }));
  const link = h("a", { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`已下載 ${filename}`);
}

// ---- 逐檔快速加入 ----

function openQuick(g) {
  quick.label = g.label;
  quick.stocks = g.stocks;
  // 從第一檔還沒加入的開始，中途切去 App 再回來也接得上
  const first = g.stocks.findIndex((s) => !state.added.has(s.code));
  quick.index = first === -1 ? 0 : first;
  renderQuick();
  $("quick").showModal();
  $(quick.index < quick.stocks.length ? "quick-add-next" : "quick-restart").focus();
}

function renderQuick() {
  const { stocks, index } = quick;
  const total = stocks.length;
  const done = index >= total;
  const addedCount = stocks.filter((s) => state.added.has(s.code)).length;
  $("quick-group").textContent = quick.label;
  $("quick-progress").textContent = done ? `${total} 檔都看過了` : `第 ${index + 1} / ${total} 檔`;
  $("quick-added").textContent = `已加入 ${addedCount} / ${total} 檔`;
  $("quick-bar-fill").style.width = `${(addedCount / total) * 100}%`;
  $("quick-main").hidden = done;
  $("quick-done").hidden = !done;
  $("quick-add-next").hidden = done;
  $("quick-prev").disabled = index === 0;
  $("quick-next").disabled = done;
  $("quick-hint").textContent = QUICK_HINT;
  if (done) {
    const missing = stocks.filter((s) => !state.added.has(s.code));
    $("quick-remaining").textContent = missing.length
      ? `還沒加入 ${missing.length} 檔：${missing.map((s) => s.code).join("、")}`
      : "這組全部都加入了。";
    $("quick-first-missing").hidden = missing.length === 0;
    return;
  }
  const s = stocks[index];
  $("quick-code").textContent = s.code;
  $("quick-code").setAttribute("aria-label", `複製代號 ${s.code}`);
  $("quick-name").textContent = s.name;
  $("quick-state").classList.toggle("off", !state.added.has(s.code));
}

function quickGo(index) {
  quick.index = Math.max(0, Math.min(index, quick.stocks.length));
  renderQuick();
}

function setAdded(code, added) {
  if (added) state.added.add(code);
  else state.added.delete(code);
  saveCodes("added", state.date, state.added);
}

function renderPending(g) {
  return h(
    "article",
    { class: "card pending-item" },
    h(
      "p",
      { class: "pending-raw" },
      h("strong", {}, `「${g.raw}」`),
      g.ids.length > 1 ? h("span", { class: "muted" }, ` 出現在 ${g.ids.length} 則`) : null,
    ),
    h("p", { class: "pending-reason" }, g.reason),
    h("ul", { class: "sources" }, g.sources.map((src) => renderSource(src, null, [g.raw]))),
    h(
      "div",
      { class: "pending-actions" },
      g.candidates.map((code) =>
        h("button", { type: "button", class: "choice", onclick: () => resolvePending(g, code) }, `是 ${stockLabel(code)}`),
      ),
      h("button", { type: "button", class: "secondary", onclick: () => resolvePending(g, null) }, "不是個股"),
    ),
    stockPicker({ placeholder: "改成其他個股：輸入代號或名稱", onPick: (s) => resolvePending(g, s.code) }),
  );
}

function renderArticle(a) {
  const own = state.data.mentions.filter((m) => m.article_id === a.id);
  const okCount = new Set(own.filter((m) => m.status === "ok").map((m) => m.code)).size;
  const pendingCount = own.filter((m) => m.status === "pending").length;
  const dateInput = h("input", { type: "date", value: state.date, hidden: true, "aria-label": "改到哪一天" });
  const changeButton = h(
    "button",
    {
      type: "button",
      class: "link-button small",
      onclick: () => {
        dateInput.hidden = false;
        changeButton.hidden = true;
        dateInput.focus();
      },
    },
    "改日期",
  );
  dateInput.addEventListener("change", () => dateInput.value && moveArticle(a, dateInput.value));
  return h(
    "li",
    { class: "article" },
    h("p", { class: "article-title" }, h("span", { class: "muted" }, `${taipeiTime(a.pasted_at)} `), articleLink(a)),
    articleOrigin(a),
    articleBody(a),
    h(
      "div",
      { class: "article-meta" },
      h("span", { class: "muted" }, `${okCount} 檔${pendingCount ? `・${pendingCount} 個待確認` : ""}`),
      changeButton,
      dateInput,
      h("button", { type: "button", class: "link-button small danger", onclick: () => deleteArticle(a) }, "刪除這則"),
    ),
  );
}

function renderPasteDay() {
  const today = state.data?.today;
  if (!today) return;
  const page = pageDay();
  $("paste-day").textContent = formatDate(targetDay());
  const notes = [];
  if (state.pasteDay) notes.push(`（手動指定${state.pasteDayNote ? `；${state.pasteDayNote}` : ""}）`);
  else if (page === state.data.date) notes.push("（你正在看這一天的清單）");
  else if (page) notes.push(`（你正在看 ${shortDate(state.data.date)}，那天沒開盤，歸到下一個開盤日）`);
  else if (today.missingYears.length) notes.push(`（${today.missingYears.join("、")} 年休市行事曆還沒公布，只排除週末）`);
  $("paste-day-note").textContent = notes.join("");
  $("paste-day-change").textContent = state.pasteDay ? "改回自動" : "改日期";
}

function renderDataInfo() {
  $("data-info").textContent = state.dataInfo + state.tagInfo;
}

// ---- 動作 ----

async function run(action) {
  try {
    await action();
  } catch (err) {
    toast(err.message, "bad");
  }
}

// ---- 拆分預覽 ----

const BODY_PREVIEW = 1500; // 「看抓到的內容」最多顯示幾個字
const TITLE_NOTE = 80; // 文字改成網址時，剩下的字在這個長度以內、只有一行，才當成分享文字
const MENTION_FIELDS = ["status", "code", "raw", "reason", "candidates", "sentences", "passage", "tags", "partners"];

function newItem(fields) {
  return {
    id: preview.nextId++,
    type: "text", // url 網址、text 文字、image 圖片
    url: null, // 清掉追蹤參數的網址（抓完之後換成轉址後的網址）
    rawUrl: null, // 貼進來的原始網址
    note: "", // 網址旁邊的分享文字
    text: "", // 文字內容；網址類型是自己補貼的內文；圖片是辨識出來的文字
    fetch: { status: "idle" }, // idle / loading / ok / partial / failed
    ocr: null, // { status: loading / done / failed }
    images: [], // 圖片的暫時網址（只在這個分頁）
    headline: "", // 圖片的標題（辨識時找最大的字，可以修改），送出時當成這則的標題
    source: "", // 圖片的出處（標題上面那行，通常是版名和日期），送出時存起來
    removed: new Set(), // 按「×」拿掉的個股代號（只有網址類可以拿掉，不能復原）
    answers: new Map(), // 預覽裡回答的待確認：pendingKey → 代號，null 是「不是個股」
    openPending: null, // 展開選項的那個待確認（pendingKey）
    labelChange: null, // 預覽裡改的標籤、合作對象：{ tags: { add, remove }, partners: { add, remove } }，套到這一則的每一檔
    labelEdit: null, // 正在改標籤：{ base, tags: Set, partners: Set }
    error: "",
    ...fields,
  };
}

function joinText(...parts) {
  return parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join("\n\n");
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// 自己選了某一天的清單頁，貼的就歸到那一頁（2026/10/27 發起人要求），休市日那頁歸到下一個開盤日（伺服器算好的 openDay）。
// 今日清單、或頁面放著過了 09:00 自己變成前一天的那頁不算，回傳 null，照貼的時間：
// 手機分頁常常開著好幾天，晚上回來貼盤後新聞，不能因為畫面停在前一天就歸錯
function pageDay() {
  const d = state.data;
  return d && state.chosenDate === d.date && d.date !== d.today.tradingDay ? d.openDay : null;
}

// 送出時指定的日期：手動改的 > 正在看的那一頁；都沒有是 null，交給伺服器照貼的時間算
function chosenPasteDay() {
  return state.pasteDay ?? pageDay();
}

// 這次送出會歸到哪一天（畫面上的「會歸到」，抓網址時也用來檢查是不是已經貼過）
function targetDay() {
  return chosenPasteDay() ?? state.data?.today.tradingDay ?? null;
}

// 拿來比對個股的內容：網址是抓到的標題和內文，加上自己補貼的
function itemContent(item) {
  if (item.type === "image") return [item.headline, item.text].filter((t) => t?.trim()).join("\n");
  if (item.type !== "url") return item.text;
  const f = item.fetch;
  const fetched = f.status === "ok" || f.status === "partial" ? [f.title, f.body] : [];
  return [...fetched, item.text].filter((t) => t?.trim()).join("\n");
}

function itemTitle(item) {
  if (item.type === "url") return item.fetch.title || makeTitle(item.note) || makeTitle(item.text) || hostOf(item.url);
  if (item.type === "image") return item.headline.trim() || makeTitle(item.text) || "（圖片）";
  return makeTitle(item.text) || "（沒有內容）";
}

function isBusy(item) {
  return (item.type === "url" && item.fetch.status === "loading") || item.ocr?.status === "loading";
}

// 每一則現在能不能送出：ready 可以、busy 處理中、blocked 要補內容、none 沒有個股、
// emptied 個股都拿掉了、editing 標籤還沒改完、skip 重複
function itemState(item) {
  if (isBusy(item)) return { kind: "busy", message: "" };
  if (item.type === "url") {
    const index = preview.items.indexOf(item);
    const twin = preview.items.findIndex((o, i) => i < index && o.type === "url" && o.url === item.url);
    if (twin >= 0) return { kind: "skip", message: `和第 ${twin + 1} 則是同一篇，不會重複送出。` };
    const f = item.fetch;
    if (f.existingTitle && f.existingDay === targetDay()) {
      return { kind: "skip", message: `這篇已經在${shortDate(f.existingDay)}的清單裡了（${f.existingTitle}），不會重複送出。` };
    }
    if (f.status === "failed" && !item.text.trim()) return { kind: "blocked", message: "還沒補內文，不會送出。" };
  }
  const content = itemContent(item);
  if (!content.trim()) return { kind: "blocked", message: "沒有內容，不會送出。" };
  if (!state.matcher) return { kind: "busy", message: "代號清單載入中…" };
  // 標籤要在送出前判斷好（不存全文，送出後不能重算），所以等設定檔讀完；讀取失敗就照樣送出、不貼標籤
  if (state.tagger === null) return { kind: "busy", message: "標籤設定載入中…" };
  const edits = JSON.stringify([[...item.removed], [...item.answers], item.labelChange]);
  if (item.cache?.content !== content || item.cache.tagger !== state.tagger || item.cache.edits !== edits) {
    const analysis = state.matcher.analyze(content);
    const found = analysis.mentions.length;
    // 回答的待確認、拿掉的個股都在貼標籤之前處理，標籤和合作對象照結果重算（2026/10/26 發起人決定）
    analysis.mentions = withoutCodes(applyAnswers(analysis.mentions, item.answers), item.removed);
    // 文字類（memo）每檔另外存跟它有關的那一段（2026/10/27 發起人要求）
    if (item.type === "text") analysis.mentions = withPassages(content, analysis.mentions);
    if (state.tagger) {
      // 文字類：那一段只提到這一檔就整段算它的，同一段有別檔（含興櫃股）只看寫到它的那幾行（2026/10/28 發起人決定）
      analysis.mentions = state.tagger.tagMentions(content, analysis.mentions, {
        sections: item.type === "text" ? sections(content) : null,
        others: analysis.emergingSpans,
      });
      if (item.labelChange) analysis.mentions = state.tagger.applyChange(analysis.mentions, item.labelChange);
    }
    item.cache = { content, tagger: state.tagger, edits, found, analysis };
  }
  const { analysis, found } = item.cache;
  if (analysis.mentions.length === 0) {
    // 全部拿掉的留在預覽裡，不送出也不自動清掉（2026/10/26 發起人決定）
    const { emerging } = analysis;
    if (found) return { kind: "emptied", message: "個股都拿掉了，這則不會送出。不要的話按這則的「刪除」。", emerging };
    return { kind: "none", message: "沒有找到個股，送出時會略過。", emerging };
  }
  // 改標籤改到一半先不送，免得勾好的沒有按「完成」就送出去
  if (item.labelEdit) return { kind: "editing", analysis };
  return { kind: "ready", analysis };
}

// 不能合併的原因；可以合併回傳 null
function mergeProblem(prev, item) {
  if (isBusy(prev) || isBusy(item)) return "等抓取、辨識完成再合併";
  if (prev.type === "url" && item.type === "url") return "兩個網址不能合併成一則（同一篇會自動略過）";
  return null;
}

function renderPreview() {
  // 重畫之前記住正在打字的框，畫完把游標放回去
  const active = document.activeElement;
  const focus = active?.matches?.("#preview-list textarea, #preview-list input[type=text]")
    ? {
        id: active.closest("[data-item]").dataset.item,
        // 圖片有標題、出處兩個欄位，用 class 分辨是哪一個
        selector: active.tagName === "TEXTAREA" ? "textarea" : `input.${active.classList[0]}`,
        start: active.selectionStart,
        end: active.selectionEnd,
        top: active.scrollTop,
      }
    : null;

  $("preview").hidden = preview.items.length === 0;
  $("preview-count").textContent = preview.items.length;
  $("preview-list").replaceChildren(...preview.items.map(renderItem));
  renderPreviewFooter();

  if (focus) {
    const box = $("preview-list").querySelector(`[data-item="${focus.id}"] ${focus.selector}`);
    if (box) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(focus.start, focus.end);
      box.scrollTop = focus.top;
    }
  }
}

function renderPreviewFooter() {
  const states = preview.items.map(itemState);
  const count = (kind) => states.filter((s) => s.kind === kind).length;
  const ready = count("ready");
  const busy = count("busy");
  const parts = [];
  if (busy) parts.push(`${busy} 則還在處理`);
  if (count("blocked")) parts.push(`${count("blocked")} 則要補內容`);
  if (count("none")) parts.push(`${count("none")} 則沒有個股`);
  if (count("emptied")) parts.push(`${count("emptied")} 則個股都拿掉了`);
  if (count("editing")) parts.push(`${count("editing")} 則標籤還沒按「完成」`);
  if (count("skip")) parts.push(`${count("skip")} 則重複`);
  $("preview-summary").textContent = parts.join("・");
  // 只剩重複、沒有個股的，按下去就是把它們清掉
  const droppable = count("skip") + count("none");
  const button = $("preview-submit");
  button.textContent = preview.submitting
    ? "送出中…"
    : busy
      ? "處理完才能送出"
      : ready
        ? `送出 ${ready} 則`
        : droppable
          ? `略過 ${droppable} 則`
          : "沒有可以送出的";
  button.disabled = preview.submitting || busy > 0 || ready + droppable === 0;
}

function typeControl(item, index) {
  if (item.type === "image") return h("span", { class: "type-badge" }, "圖片");
  const select = h(
    "select",
    { class: "type-select", "aria-label": `第 ${index + 1} 則的類型`, onchange: (e) => changeType(item, e.target.value) },
    h("option", { value: "url", disabled: item.type !== "url" && !extractUrl(item.text) }, "網址"),
    h("option", { value: "text" }, "文字"),
  );
  select.value = item.type;
  return select;
}

function textBox(item, index, placeholder) {
  const lines = item.text.split("\n").length;
  return h(
    "textarea",
    {
      class: "item-text",
      rows: Math.min(10, Math.max(3, lines + 1)),
      placeholder,
      disabled: item.ocr?.status === "loading",
      "aria-label": `第 ${index + 1} 則的內容`,
      oninput: (e) => {
        item.text = e.target.value;
        scheduleItemInfo(item);
      },
    },
    item.text,
  );
}

function urlBody(item, index) {
  const f = item.fetch;
  const showBox = f.status === "failed" || f.status === "partial" || item.text || item.manual;
  const status = {
    loading: h("p", { class: "item-status muted" }, "抓取內文中…"),
    ok: h("p", { class: "item-status ok" }, `✓ 已抓到內文（${(f.body ?? "").length.toLocaleString()} 字）`),
    partial: h("p", { class: "item-status warn" }, "⚠ 只抓到標題和摘要，可能漏掉個股。可以打開網址，把內文貼在下面。"),
    failed: h(
      "p",
      { class: "item-status bad" },
      `✗ 抓取失敗：${f.error}。請打開網址，把內文複製貼在下面。`,
      h("button", { type: "button", class: "link-button small", onclick: () => fetchArticle(item) }, "重新抓取"),
    ),
  }[f.status];
  return [
    h(
      "p",
      { class: "item-url" },
      h("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.url),
      item.rawUrl && item.rawUrl !== item.url ? h("span", { class: "muted" }, " （已清掉追蹤參數）") : null,
    ),
    item.note ? h("p", { class: "item-note muted" }, item.note) : null,
    status,
    f.status === "ok"
      ? h(
          "details",
          { class: "fetched", open: item.bodyOpen, ontoggle: (e) => (item.bodyOpen = e.target.open) },
          h("summary", {}, "看抓到的內容"),
          h("p", { class: "fetched-title" }, f.title),
          h("p", { class: "fetched-body" }, f.body.length > BODY_PREVIEW ? `${f.body.slice(0, BODY_PREVIEW)}…` : f.body),
        )
      : null,
    f.status === "ok" && !showBox
      ? h(
          "button",
          {
            type: "button",
            class: "link-button small",
            onclick: () => {
              item.manual = true;
              renderPreview();
            },
          },
          "自己補貼內文",
        )
      : null,
    showBox ? textBox(item, index, "把內文貼在這裡（只會存標題、網址、提到個股的句子和標籤）") : null,
  ];
}

// 圖片的標題、出處：送出時存起來（清單上看得到），辨識錯的字可以在這裡改
function fieldBox(item, index, key, label, emptyHint) {
  return h(
    "label",
    { class: "item-field" },
    h("span", { class: "muted" }, label),
    h("input", {
      type: "text",
      class: `field-${key}`,
      value: item[key],
      placeholder: item.ocr?.status === "loading" ? "辨識完會自動填入" : emptyHint,
      disabled: item.ocr?.status === "loading",
      "aria-label": `第 ${index + 1} 則的${label}`,
      oninput: (e) => {
        item[key] = e.target.value;
        scheduleItemInfo(item);
      },
    }),
  );
}

function ocrStepText(o) {
  const pct = o.progress ? ` ${Math.round(o.progress * 100)}%` : "";
  const first = /下載/.test(o.step) ? "（第一次使用要下載約 6 MB，之後就不用）" : "";
  return `${o.step}${pct}${first}`;
}

function imageBody(item) {
  const o = item.ocr;
  return [
    h(
      "div",
      { class: "thumbs" },
      item.images.map((src) =>
        h("img", { src, alt: "貼上的圖片（點一下放大）", class: "thumb", onclick: (e) => e.target.classList.toggle("zoomed") }),
      ),
    ),
    o?.status === "loading"
      ? h(
          "div",
          { class: "ocr-progress" },
          h("p", { class: "muted ocr-step" }, ocrStepText(o)),
          h("div", { class: "bar" }, h("div", { class: "bar-fill", style: `width: ${Math.round((o.progress ?? 0) * 100)}%` })),
        )
      : null,
    o?.status === "done" ? h("p", { class: "item-status ok" }, "✓ 辨識完成。不準的地方可以直接改下面的文字。") : null,
    o?.status === "failed" ? h("p", { class: "item-status bad" }, `✗ 辨識失敗：${o.error}。可以自己把文字打在下面。`) : null,
    h("p", { class: "muted item-note" }, "圖片只在這台裝置上辨識，不會上傳；送出或刪除這則之後就丟掉。"),
  ];
}

// 找到的個股，加上展開的待確認選項（打字時只重畫這一塊）
function foundLine(item, st) {
  return h(
    "div",
    { class: "found-block" },
    foundChips(item, st),
    emergingNote(st.analysis?.emerging ?? st.emerging),
    st.analysis ? pendingPanel(item, st.analysis) : null,
  );
}

// 寫了代號的興櫃股：不給待確認的選項，直接說不能加入（2026/10/28 發起人要求）
function emergingNote(list) {
  if (!list?.length) return null;
  const names = list.map((s) => `${s.code} ${s.name}`).join("、");
  return h("p", { class: "found bad" }, `${names}是興櫃股，不符合條件，不能加入`);
}

function foundChips(item, st) {
  if (st.kind === "busy") return h("p", { class: "found muted" }, st.message);
  if (!st.analysis) {
    const kind = { none: "warn", emptied: "warn", skip: "muted", blocked: "bad" }[st.kind];
    return h("p", { class: `found ${kind}` }, st.message);
  }
  const ok = st.analysis.mentions.filter((m) => m.status === "ok");
  const pending = st.analysis.mentions.filter((m) => m.status === "pending");
  // 每檔的標籤放在提示文字裡（提到好幾檔時，每檔只看提到它的段落，可能不一樣）
  const labelsOf = (m) => describeLabels(m) || undefined;
  // 網址類的內文不能改，抓錯的個股按「×」拿掉（文字、圖片類可以直接改字）
  const removeButton = (code) =>
    h(
      "button",
      {
        type: "button",
        class: "chip-remove",
        "aria-label": `拿掉 ${stockLabel(code)}`,
        title: "抓錯了，拿掉這檔（不會送出，不能復原）",
        onclick: () => removeStock(item, code),
      },
      "×",
    );
  const removable = item.type === "url";
  // 待確認點了展開選項，送出前就能回答（2026/10/26 發起人要求）；不回答照舊送出、到清單上再確認
  const pendingButton = (m) => {
    const key = pendingKey(m);
    const open = item.openPending === key;
    return h(
      "button",
      {
        type: "button",
        class: "chip pending-chip",
        "data-key": key,
        "aria-expanded": String(open),
        title: [m.reason, labelsOf(m)].filter(Boolean).join("\n"),
        onclick: () => togglePending(item, key),
      },
      `${open ? "▾" : "▸"} 待確認：${m.raw}`,
    );
  };
  return h(
    "p",
    { class: "found" },
    h("span", { class: "muted" }, `找到 ${ok.length} 檔${pending.length ? `、${pending.length} 個待確認` : ""}：`),
    ok.map((m) =>
      h(
        "span",
        { class: removable ? "chip removable" : "chip", title: labelsOf(m) },
        stockLabel(m.code) + formerNote(m.code, m.sentences),
        removable ? removeButton(m.code) : null,
      ),
    ),
    pending.map(pendingButton),
  );
}

// 展開的待確認：和清單上「待確認」一樣的選項
function pendingPanel(item, analysis) {
  const m = analysis.mentions.find((x) => x.status === "pending" && pendingKey(x) === item.openPending);
  if (!m) return null;
  const key = pendingKey(m);
  return h(
    "div",
    { class: "preview-pending" },
    h("p", { class: "pending-reason" }, m.reason),
    m.sentences.map((t) => h("blockquote", {}, highlight(t, null, [m.raw]))),
    h(
      "div",
      { class: "pending-actions" },
      m.candidates.map((code) =>
        h("button", { type: "button", class: "choice", onclick: () => answerPending(item, key, code) }, `是 ${stockLabel(code)}`),
      ),
      h("button", { type: "button", class: "secondary", onclick: () => answerPending(item, key, null) }, "不是個股"),
    ),
    stockPicker({ placeholder: "改成其他個股：輸入代號或名稱", onPick: (s) => answerPending(item, key, s.code) }),
  );
}

// 預覽上的標籤和合作對象（這一則所有個股合起來），可以按「改標籤」改這一則的每一檔
function labelLine(item, st) {
  if (!st.analysis) return h("p", { class: "found-labels", hidden: true });
  if (state.tagger === false) return h("p", { class: "found-labels warn" }, "標籤設定讀取失敗，這則送出時不會有標籤和合作對象。");
  if (item.labelEdit) return previewLabelEditor(item);
  const mentions = st.analysis.mentions;
  const { tags, partners } = state.tagger.union(mentions);
  const key = (m) => `${m.tags.join()}|${m.partners.join()}`;
  const differs = mentions.some((m) => key(m) !== key(mentions[0]));
  return h(
    "p",
    { class: "found-labels" },
    h("span", { class: "muted" }, "標籤："),
    tags.length ? labelChips(tags) : h("span", { class: "muted" }, "沒有"),
    h("span", { class: "muted" }, "合作對象："),
    partners.length ? h("span", {}, partners.join("、")) : h("span", { class: "muted" }, "沒有"),
    differs ? h("span", { class: "muted" }, "（每檔只看提到它的段落，各檔不一樣，送出後在清單上看）") : null,
    h(
      "button",
      {
        type: "button",
        class: "link-button small",
        "aria-label": `改「${itemTitle(item)}」的標籤和合作對象`,
        onclick: () => openPreviewLabelEdit(item),
      },
      "改標籤",
    ),
  );
}

function previewLabelEditor(item) {
  return labelEditor({
    edit: item.labelEdit,
    key: `item-${item.id}`,
    who: `「${itemTitle(item)}」`,
    redraw: () => updateItemInfo(item),
    help: "改的是這一則的每一檔：勾掉的從每一檔拿掉，加的每一檔都加上，沒動的照原本（各檔可能不一樣）。按「完成」才會套用，送出時一起存。自己填的只加在這一則；想讓以後的新聞自動判斷，要請發起人加進設定檔。",
    saveText: "完成",
    onSave: () => finishPreviewLabelEdit(item),
    onCancel: () => {
      item.labelEdit = null;
      updateItemInfo(item);
    },
  });
}

function renderItem(item, index) {
  const st = itemState(item);
  const prev = preview.items[index - 1];
  const problem = prev ? mergeProblem(prev, item) : null;
  return h(
    "li",
    { class: `preview-item ${st.kind}`, "data-item": item.id },
    h(
      "div",
      { class: "item-head" },
      h("span", { class: "item-num" }, `${index + 1}`),
      typeControl(item, index),
      h("strong", { class: "item-title" }, itemTitle(item)),
      h(
        "span",
        { class: "item-actions" },
        prev
          ? h(
              "button",
              {
                type: "button",
                class: "link-button small",
                disabled: !!problem,
                title: problem ?? "和上一則合併成一則",
                onclick: () => mergeUp(index),
              },
              "合併到上一則",
            )
          : null,
        h("button", { type: "button", class: "link-button small danger", onclick: () => removeItem(item) }, "刪除"),
      ),
    ),
    item.type === "url" ? urlBody(item, index) : null,
    item.images.length ? imageBody(item) : null,
    item.type === "image" ? fieldBox(item, index, "headline", "標題", "沒找到標題，可以自己打") : null,
    item.type === "image" ? fieldBox(item, index, "source", "出處", "例如：B3 上市櫃 | 2026.10.22 | 工商時報") : null,
    item.type !== "url" ? textBox(item, index, item.type === "image" ? "辨識出來的文字" : "這則的內容") : null,
    foundLine(item, st),
    labelLine(item, st),
    item.error ? h("p", { class: "bad item-error" }, item.error) : null,
  );
}

// 打字時不重畫整則（游標會跳掉），只更新標題、找到的個股和送出按鈕
const infoTimers = new Map();
function scheduleItemInfo(item) {
  clearTimeout(infoTimers.get(item.id));
  infoTimers.set(item.id, setTimeout(() => updateItemInfo(item), 300));
}

function updateItemInfo(item) {
  const card = $("preview-list").querySelector(`[data-item="${item.id}"]`);
  if (!card) return null;
  const st = itemState(item);
  card.className = `preview-item ${st.kind}`;
  card.querySelector(".item-title").textContent = itemTitle(item);
  card.querySelector(".found-block").replaceWith(foundLine(item, st));
  card.querySelector(".found-labels, .label-editor").replaceWith(labelLine(item, st));
  const urlOption = card.querySelector('.type-select option[value="url"]');
  if (urlOption && item.type !== "url") urlOption.disabled = !extractUrl(item.text);
  renderPreviewFooter();
  return card;
}

// 回答待確認：是某一檔就變成對上的個股，不是個股就拿掉（跟「×」一樣不能復原）
function answerPending(item, key, code) {
  item.answers.set(key, code);
  item.openPending = null;
  updateItemInfo(item);
}

function togglePending(item, key) {
  item.openPending = item.openPending === key ? null : key;
  const card = updateItemInfo(item);
  // 整塊重畫過，焦點放回同一個待確認，用鍵盤操作的人才不會跳掉
  card?.querySelector(`.pending-chip[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function openPreviewLabelEdit(item) {
  const { tags, partners } = state.tagger.union(itemState(item).analysis.mentions);
  item.labelEdit = { base: { tags, partners }, tags: new Set(tags), partners: new Set(partners) };
  updateItemInfo(item)?.querySelector(".label-editor input")?.focus();
}

// 這次勾的和之前改過的合在一起，之後重新比對（改字、重新抓取）也照樣套上
function finishPreviewLabelEdit(item) {
  const edit = item.labelEdit;
  item.labelChange = {
    tags: mergeChange(item.labelChange?.tags, edit.tags, edit.base.tags),
    partners: mergeChange(item.labelChange?.partners, edit.partners, edit.base.partners),
  };
  item.labelEdit = null;
  updateItemInfo(item);
}

// 按「×」拿掉抓錯的個股：直接消失、不能復原（2026/10/26 發起人決定），按錯就刪掉整則重貼
function removeStock(item, code) {
  const hadFocus = document.activeElement?.classList.contains("chip-remove");
  item.removed.add(code);
  const card = updateItemInfo(item);
  // 按鈕跟著那一檔不見了，用鍵盤操作的人接著停在同一則的下一個「×」
  if (hadFocus) card?.querySelector(".chip-remove")?.focus({ preventScroll: true });
}

function updateOcrProgress(item) {
  const card = $("preview-list").querySelector(`[data-item="${item.id}"]`);
  const step = card?.querySelector(".ocr-step");
  if (!step) return;
  step.textContent = ocrStepText(item.ocr);
  card.querySelector(".bar-fill").style.width = `${Math.round((item.ocr.progress ?? 0) * 100)}%`;
}

function dropItem(item) {
  for (const src of item.images) URL.revokeObjectURL(src);
  preview.items = preview.items.filter((o) => o !== item);
}

function removeItem(item) {
  dropItem(item);
  renderPreview();
}

function clearPreview() {
  if (!confirm(`清掉預覽裡的 ${preview.items.length} 則？還沒送出的內容都會不見。`)) return;
  for (const item of [...preview.items]) dropItem(item);
  setResult($("preview-result"), "");
  renderPreview();
}

function mergeUp(index) {
  const prev = preview.items[index - 1];
  const item = preview.items[index];
  if (!prev || !item || mergeProblem(prev, item)) return;
  // 有網址的那則當主體，另一則的文字變成補貼的內文
  const base = prev.type === "url" ? prev : item.type === "url" ? item : prev;
  const merged = {
    ...base,
    id: prev.id,
    text: joinText(prev.text, item.text),
    images: [...prev.images, ...item.images],
    ocr: prev.ocr ?? item.ocr,
    removed: new Set([...prev.removed, ...item.removed]),
    answers: new Map([...prev.answers, ...item.answers]),
    openPending: null,
    labelEdit: null,
    error: "",
    cache: null,
  };
  preview.items.splice(index - 1, 2, merged);
  renderPreview();
}

function changeType(item, type) {
  if (type === item.type) return;
  if (type === "text") {
    // 網址改成文字：不抓了，分享文字和網址都變成這則的內容
    // 文字類沒有「×」，改成直接改字，所以原本拿掉的個股不再拿掉
    item.text = joinText(item.note, item.url, item.text);
    Object.assign(item, { type: "text", note: "", fetch: { status: "idle" }, removed: new Set() });
  } else {
    const found = extractUrl(item.text);
    if (!found) {
      toast("這則文字裡沒有網址", "bad");
      renderPreview();
      return;
    }
    // 剩下的字只有一行短短的（像是標題）就當分享文字；比較長的當補貼的內文，一樣拿去比對個股
    const rest = found.rest.replace(/\n{3,}/g, "\n\n");
    const isNote = !rest.includes("\n") && rest.length <= TITLE_NOTE;
    Object.assign(item, { type: "url", url: found.url, rawUrl: found.rawUrl, note: isNote ? rest : "", text: isNote ? "" : rest });
    fetchArticle(item);
  }
  item.cache = null;
  renderPreview();
}

// 請伺服器把網頁轉過來，在瀏覽器裡取出標題和內文
async function fetchArticle(item) {
  const token = ++preview.fetchToken;
  item.fetchToken = token;
  item.fetch = { status: "loading" };
  renderPreview();
  const day = targetDay();
  let result;
  try {
    const res = await fetch("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, day }),
    });
    if (res.status === 401) {
      location.replace("/login");
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `伺服器回應錯誤（${res.status}）`);
    }
    const finalUrl = res.headers.get("X-Final-Url") || item.url;
    const page = extractArticle(decodeHtml(await res.arrayBuffer(), res.headers.get("X-Charset")), finalUrl);
    if (page.body.length >= MIN_BODY) result = { status: "ok", title: page.title, body: page.body };
    else if (page.title || page.description) result = { status: "partial", title: page.title, body: page.description };
    else result = { status: "failed", error: "抓到網頁，但找不到內文（可能要登入、付費，或內容是另外載入的）" };
    const existing = res.headers.get("X-Duplicate-Title");
    if (existing) Object.assign(result, { existingTitle: decodeURIComponent(existing), existingDay: day });
    result.finalUrl = finalUrl;
  } catch (err) {
    result = { status: "failed", error: err.message === "Failed to fetch" ? "連不到伺服器" : err.message };
  }
  // 等的時候這則被刪掉、改成文字或重新抓了，就不用了
  if (item.fetchToken !== token || item.type !== "url" || !preview.items.includes(item)) return;
  if (result.finalUrl) item.url = result.finalUrl; // 短網址轉址之後的真正網址，去重才準
  item.fetch = result;
  renderPreview();
}

async function runOcr(item, file) {
  try {
    const { text, headline, source } = await recognize(file, (p) => {
      item.ocr = { status: "loading", ...p };
      updateOcrProgress(item);
    });
    item.text = joinText(item.text, text);
    item.headline ||= headline;
    item.source ||= source;
    item.ocr = { status: "done" };
  } catch (err) {
    console.error("ocr", err);
    item.ocr = { status: "failed", error: err?.message || "不明原因" };
  }
  item.cache = null;
  if (preview.items.includes(item)) renderPreview();
}

function addImages(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return false;
  for (const file of files) {
    const item = newItem({
      type: "image",
      images: [URL.createObjectURL(file)],
      ocr: { status: "loading", step: "排隊中", progress: 0 },
    });
    preview.items.push(item);
    runOcr(item, file);
  }
  setResult($("paste-result"), `加入 ${files.length} 張圖片，正在辨識文字。`, "ok");
  setResult($("preview-result"), "");
  renderPreview();
  return true;
}

// 按「拆分預覽」：把框裡的內容拆成一則一則，加到預覽
function addPaste() {
  const box = $("paste-text");
  const result = $("paste-result");
  if (!box.value.trim()) {
    setResult(result, "請先貼上內容。圖片可以直接貼上、拖曳進來，或按「加入圖片」。", "bad");
    return;
  }
  const { items, promo, duplicates, noUrl } = splitPaste(box.value);
  let skipped = duplicates;
  const added = [];
  for (const fields of items) {
    if (fields.type === "url" && preview.items.some((o) => o.type === "url" && o.url === fields.url)) {
      skipped++;
      continue;
    }
    const item = newItem(fields);
    preview.items.push(item);
    added.push(item);
  }
  box.value = "";
  const urls = added.filter((i) => i.type === "url").length;
  const notes = [
    added.length ? `拆成 ${added.length} 則（網址 ${urls}、文字 ${added.length - urls}）` : "沒有拆出新的內容",
  ];
  if (promo) notes.push(`拿掉 ${promo} 個 App 推廣文字或連結`);
  if (skipped) notes.push(`略過 ${skipped} 個重複的網址`);
  if (noUrl) notes.push(`略過 ${noUrl} 則沒有網址的訊息`);
  setResult(result, `${notes.join("，")}。${added.length ? "請確認下面的預覽再送出。" : ""}`, added.length ? "ok" : "bad");
  setResult($("preview-result"), "");
  renderPreview();
  for (const item of added) if (item.type === "url") fetchArticle(item);
  if (added.length) {
    $("preview-list").querySelector(`[data-item="${added[0].id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function submitPreview() {
  preview.submitting = true;
  renderPreviewFooter();
  const tally = { sent: 0, pending: 0, dup: 0, none: 0, failed: 0 };
  let day = null;
  for (const item of [...preview.items]) {
    const st = itemState(item);
    if (st.kind === "skip" || st.kind === "none") {
      dropItem(item);
      tally[st.kind === "skip" ? "dup" : "none"]++;
      continue;
    }
    if (st.kind !== "ready") continue;
    try {
      const res = await api("/api/articles", {
        method: "POST",
        body: {
          title: itemTitle(item),
          url: item.type === "url" ? item.url : null,
          kind: item.type,
          // 圖片另外存出處和辨識出來的全文，文字另外存每檔的那一段（mentions 的 passage）；網址只存擷取句
          source: item.type === "image" ? item.source : null,
          body: item.type === "image" ? item.text : null,
          tradingDay: chosenPasteDay(),
          mentions: st.analysis.mentions.map((m) => Object.fromEntries(MENTION_FIELDS.map((k) => [k, m[k]]))),
        },
      });
      tally.sent++;
      tally.pending += res.pending;
      day = res.tradingDay;
      dropItem(item);
    } catch (err) {
      if (err.data?.duplicate) {
        tally.dup++;
        day ??= err.data.tradingDay;
        dropItem(item);
      } else {
        item.error = `送出失敗：${err.message}`;
        tally.failed++;
      }
    }
  }
  preview.submitting = false;
  if (preview.items.length === 0) setPasteDay(null);
  if (day) await loadList(day, { choose: true }).catch((err) => toast(err.message, "bad"));
  // 新貼的個股馬上比對前一個交易日收盤有沒有漲停（不用等排程）；還沒收盤會直接略過
  if (day && tally.sent) checkClosing(day, { quiet: true });

  const parts = [];
  if (tally.sent) {
    parts.push(
      `已送出 ${tally.sent} 則到 ${formatDate(day)}的清單，清單現在 ${state.stocks.length} 檔${tally.pending ? `（另有 ${tally.pending} 個待確認）` : ""}`,
    );
  }
  if (tally.dup) parts.push(`${tally.dup} 則已經貼過，沒有重複送出`);
  if (tally.none) parts.push(`${tally.none} 則沒有找到個股，沒有送出`);
  if (preview.items.length) {
    parts.push(`還有 ${preview.items.length} 則留在預覽裡${tally.failed ? `（${tally.failed} 則送出失敗）` : ""}`);
  }
  // 預覽清空時整區會藏起來，結果改顯示在貼上的地方
  const message = `${parts.join("；")}。`;
  const kind = tally.failed ? "bad" : "ok";
  setResult($("preview-result"), preview.items.length ? message : "", kind);
  setResult($("paste-result"), preview.items.length ? "" : message, kind);
  renderPreview();
  if (preview.items.length === 0) $("paste-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setPasteDay(day, note = "") {
  state.pasteDay = day;
  state.pasteDayNote = day ? note : "";
  const input = $("paste-day-input");
  input.hidden = true;
  renderPasteDay();
}

async function deleteStock(s) {
  if (!confirm(`從 ${shortDate(state.date)}的清單刪除 ${s.code} ${s.name}？`)) return;
  await run(async () => {
    await api(`/api/stocks?date=${state.date}&code=${encodeURIComponent(s.code)}`, { method: "DELETE" });
    toast(`已刪除 ${s.code} ${s.name}`);
    await loadList(state.date);
  });
}

// ---- 選取刪除（2026/10/27 發起人同意的設計，見 PLAN「個股複選刪除」）----
// 刪掉的大家都看不到，所以和匯出的勾選（只存在自己的瀏覽器）分開選；按「刪除 N 檔」先確認，不能復原

function enterDeleteMode() {
  state.deleting = new Set();
  state.labelEdit = null;
  render();
}

function exitDeleteMode() {
  state.deleting = null;
  render();
}

// 只換那一張卡片和底下那一條，不整頁重畫
function toggleDelete(code) {
  if (!state.deleting) return;
  if (state.deleting.has(code)) state.deleting.delete(code);
  else state.deleting.add(code);
  const card = $("stock-list").querySelector(`[data-code="${code}"]`);
  if (card) {
    card.classList.toggle("delete-picked", state.deleting.has(code));
    const box = card.querySelector(".delete-pick input");
    if (box) box.checked = state.deleting.has(code);
  }
  renderDeleteBar();
}

function renderDeleteBar() {
  if (!state.deleting) return;
  const n = state.deleting.size;
  const all = n > 0 && n === state.stocks.length;
  $("delete-count").textContent = `已選 ${n} 檔`;
  $("delete-all").textContent = all ? "全不選" : "全選";
  $("delete-confirm").textContent = `刪除 ${n} 檔`;
}

function toggleDeleteAll() {
  if (!state.deleting) return;
  const all = state.deleting.size === state.stocks.length;
  state.deleting = all ? new Set() : new Set(state.stocks.map((s) => s.code));
  render();
}

async function deleteSelected() {
  const chosen = state.stocks.filter((s) => state.deleting?.has(s.code));
  if (chosen.length === 0) return toast("先點要刪除的個股", "bad");
  const SHOW = 10;
  const names = chosen.slice(0, SHOW).map((s) => `${s.code} ${s.name}`).join("、");
  const more = chosen.length > SHOW ? `…等 ${chosen.length} 檔` : "";
  if (!confirm(`從 ${shortDate(state.date)}的清單刪除這 ${chosen.length} 檔？\n${names}${more}\n大家都會看不到，不能復原。`)) return;
  await run(async () => {
    const codes = chosen.map((s) => s.code);
    await api(`/api/stocks?date=${state.date}&codes=${codes.map(encodeURIComponent).join(",")}`, { method: "DELETE" });
    // 匯出的勾選也拿掉
    for (const c of codes) state.picked.delete(c);
    saveCodes("picked", state.date, state.picked);
    state.deleting = null;
    toast(`已刪除 ${chosen.length} 檔`);
    await loadList(state.date);
  });
}

async function resolvePending(g, code) {
  await run(async () => {
    await api("/api/pending/resolve", { method: "POST", body: { ids: g.ids, code } });
    toast(code ? `「${g.raw}」改成 ${stockLabel(code)}` : `已移除「${g.raw}」`);
    await loadList(state.date);
    if (code) checkClosing(state.date, { quiet: true });
  });
}

async function moveArticle(a, date) {
  if (date === state.date) return;
  await run(async () => {
    const { day, note } = await openDayFor(date);
    if (day === state.date) {
      toast(`${note}，就是現在這一天，沒有移動`);
      return render();
    }
    if (!confirm(`${note ? `${note}。\n` : ""}把「${a.title}」移到 ${formatDate(day)}？`)) return render();
    const res = await api(`/api/articles/${a.id}`, { method: "PATCH", body: { tradingDay: day } });
    toast(`已移到 ${formatDate(res.tradingDay)}`);
    await loadList(state.date);
  });
}

// 日期框選到休市日（週末、颱風假）就改成下一個開盤日，那天的清單平常看不到（2026/10/28 發起人決定；伺服器也會再改一次）。
// 回傳 { day, note }，有開盤的 note 是空的
async function openDayFor(date) {
  const r = await api(`/api/trading-day?at=${date}T00:00`);
  if (r.rule !== "closed") return { day: date, note: "" };
  const why = /^週[六日]$/.test(r.closedReason) ? "沒開盤" : r.closedReason;
  return { day: r.tradingDay, note: `${shortDate(date)}${why}，改成下一個開盤日` };
}

async function deleteArticle(a) {
  if (!confirm(`刪除「${a.title}」？這則對到的個股也會一起從清單拿掉。`)) return;
  await run(async () => {
    await api(`/api/articles/${a.id}`, { method: "DELETE" });
    toast("已刪除這則");
    await loadList(state.date);
  });
}

// 交易日檢查小工具
async function runChecker() {
  const at = $("checker-input").value;
  const box = $("checker-result");
  if (!at) {
    box.replaceChildren();
    return;
  }
  try {
    const r = await api(`/api/trading-day?at=${encodeURIComponent(at)}`);
    const why = {
      before_open: "交易日 09:00 前貼入，歸當天。",
      after_open: "交易日 09:00 之後貼入，歸下一個開盤日。",
      closed: `這天沒有開盤（${r.closedReason}），歸下一個開盤日。`,
    }[r.rule];
    box.replaceChildren(
      h(
        "div",
        {},
        h("p", {}, `${formatDateTime(r.at)} 貼入 → `, h("strong", {}, formatDate(r.tradingDay))),
        h("p", { class: "muted" }, why),
        r.skipped.length
          ? h("p", { class: "muted" }, `跳過：${r.skipped.map((s) => `${shortDate(s.date)}${s.reason}`).join("、")}`)
          : null,
        r.missingYears.length
          ? h("p", { class: "warn" }, `${r.missingYears.join("、")} 年的休市行事曆證交所還沒公布，這段只排除了週末和元旦，請自行確認。`)
          : null,
      ),
    );
  } catch (err) {
    box.replaceChildren(h("p", { class: "bad" }, err.message));
  }
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} 讀取失敗`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${path} 格式錯誤（可能少了逗號或引號）`);
  }
}

async function loadMatcher() {
  const [stocks, rules] = await Promise.all(["/data/stocks.json", "/data/name-rules.json"].map(fetchJson));
  state.matcher = buildMatcher(stocks, rules);
  const age = (Date.now() - Date.parse(`${stocks.updated}T00:00:00+08:00`)) / 86_400_000;
  const stale = !(age <= STOCK_LIST_STALE_DAYS) ? `，超過 ${STOCK_LIST_STALE_DAYS} 天沒自動更新了` : "";
  state.dataInfo = ` · 代號清單 ${state.matcher.size.toLocaleString()} 檔（${stocks.updated} 更新${stale}）`;
  renderDataInfo();
  if (state.data) render(); // 補上待確認候選的名稱、句子裡的標示
  renderPreview();
}

// 標籤和國際大廠名單（發起人手動維護的設定檔）。讀不到不影響貼入，只是這段時間送出的沒有標籤
async function loadTagger() {
  try {
    const [tags, companies] = await Promise.all(["/data/tags.json", "/data/big-companies.json"].map(fetchJson));
    state.tagger = buildTagger(tags, companies);
    const age = (Date.now() - Date.parse(`${companies.updated}T00:00:00+08:00`)) / 86_400_000;
    const stale = !(age <= COMPANY_LIST_REFRESH_DAYS) ? "，超過半年沒更新了" : "";
    state.tagInfo = ` · 標籤 ${state.tagger.tagNames.length} 個、國際大廠 ${state.tagger.companyLabels.length} 家（${companies.updated ?? "沒寫日期"}${stale}）`;
  } catch (err) {
    state.tagger = false;
    toast(`標籤設定讀取失敗：${err.message}。送出的資料不會有標籤和合作對象。`, "bad");
  }
  renderDataInfo();
  if (state.data) render(); // 依設定檔的順序排標籤
  renderPreview();
}

// ---- 事件 ----

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.replace("/login");
});
$("paste-submit").addEventListener("click", addPaste);
$("paste-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addPaste();
});
$("paste-images").addEventListener("change", (e) => {
  addImages(e.target.files);
  e.target.value = "";
});
$("preview-submit").addEventListener("click", submitPreview);
$("preview-clear").addEventListener("click", clearPreview);

// 圖片：貼上（任何地方）或拖曳進來
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.some((f) => f.type.startsWith("image/"))) return;
  addImages(files);
  // 同時有文字（例如從網頁複製）就讓文字照常貼上
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
});
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $("paste-card").classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0;
    $("paste-card").classList.remove("dragging");
  }
});
// 擋掉瀏覽器預設「拖進來就打開圖片」，不然預覽會不見
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("paste-card").classList.remove("dragging");
  if (!addImages(e.dataTransfer.files)) setResult($("paste-result"), "只能拖圖片進來；網址和文字請直接貼上。", "bad");
});
// 預覽裡還有沒送出的，關掉或重新整理前先提醒
window.addEventListener("beforeunload", (e) => {
  if (preview.items.length) e.preventDefault();
});
$("paste-day-change").addEventListener("click", () => {
  if (state.pasteDay) return setPasteDay(null);
  const input = $("paste-day-input");
  input.value = targetDay() ?? "";
  input.hidden = false;
  input.focus();
});
$("paste-day-input").addEventListener("change", (e) => {
  const value = e.target.value;
  if (!value) return;
  run(async () => {
    const { day, note } = await openDayFor(value);
    setPasteDay(day, note);
  });
});
$("prev-day").addEventListener("click", () => state.data?.prevDate && run(() => loadList(state.data.prevDate, { choose: true })));
$("next-day").addEventListener("click", () => state.data?.nextDate && run(() => loadList(state.data.nextDate, { choose: true })));
$("go-today").addEventListener("click", () => run(() => loadList(null, { choose: true })));
$("date-picker").addEventListener("change", (e) => e.target.value && run(() => loadList(e.target.value, { choose: true })));
$("watch-add").append(stockPicker({ placeholder: "手動加到延續性觀察：輸入代號或名稱", onPick: addWatch }));
$("checker-input").addEventListener("change", runChecker);
$("checker-input").addEventListener("input", runChecker);

// 匯出
for (const radio of document.querySelectorAll('input[name="export-scope"]')) {
  radio.addEventListener("change", (e) => {
    state.exportScope = e.target.value;
    renderExport();
  });
}
$("mitake-file").addEventListener("change", (e) => importMitakeList(e.target));
$("pick-none").addEventListener("click", pickNone);

// 選取刪除
$("delete-mode").addEventListener("click", enterDeleteMode);
$("delete-cancel").addEventListener("click", exitDeleteMode);
$("delete-all").addEventListener("click", toggleDeleteAll);
$("delete-confirm").addEventListener("click", deleteSelected);

// 逐檔快速加入
$("quick-add-next").addEventListener("click", () => {
  setAdded(quick.stocks[quick.index].code, true);
  quickGo(quick.index + 1);
});
$("quick-next").addEventListener("click", () => quickGo(quick.index + 1));
$("quick-prev").addEventListener("click", () => quickGo(quick.index - 1));
$("quick-unmark").addEventListener("click", () => {
  setAdded(quick.stocks[quick.index].code, false);
  renderQuick();
});
$("quick-code").addEventListener("click", async () => {
  const code = quick.stocks[quick.index].code;
  $("quick-hint").textContent = (await copyText(code)) ? `已複製 ${code}` : "這個瀏覽器不能自動複製";
});
$("quick-restart").addEventListener("click", () => quickGo(0));
$("quick-first-missing").addEventListener("click", () => {
  quickGo(quick.stocks.findIndex((s) => !state.added.has(s.code)));
});
$("quick-close").addEventListener("click", () => $("quick").close());
$("quick").addEventListener("close", () => render()); // 清單上補上「已加入」標記
$("quick").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") quickGo(quick.index + 1);
  else if (e.key === "ArrowLeft") quickGo(quick.index - 1);
});

// 同一個瀏覽器開了好幾個分頁時，跟著別的分頁的勾選更新
window.addEventListener("storage", (e) => {
  if (e.key === "dailynews:mitake-list") {
    state.mitakeList = loadMitakeList();
    if (state.data) renderExport();
    return;
  }
  if (!state.date || !e.key?.endsWith(`:${state.date}`)) return;
  state.picked = loadCodes("picked", state.date);
  state.added = loadCodes("added", state.date);
  render();
  if ($("quick").open) renderQuick();
});
document.addEventListener("visibilitychange", () => {
  // 頁面放著過了 09:00，回來時重新算一次「會歸到」哪一天；換天的話原本的「今日清單」變成前一天的清單，
  // 標題和「回到今日清單」也要跟著改
  if (document.visibilityState === "visible" && state.data) {
    api("/api/trading-day")
      .then((today) => {
        const changed = today.tradingDay !== state.data.today.tradingDay;
        state.data.today = today;
        if (changed) render();
        else renderPasteDay();
      })
      .catch(() => {});
  }
});

$("checker-input").value = taipeiNowLocal();
runChecker();
pruneOld(taipeiNowLocal().slice(0, 10));
loadMatcher().catch((err) => toast(`代號清單讀取失敗：${err.message}`, "bad"));
loadTagger();
loadList(new URLSearchParams(location.search).get("date"), { choose: true }).catch((err) => {
  $("list-title").textContent = "清單讀取失敗";
  $("db").textContent = "讀取失敗";
  $("db").className = "bad";
  toast(err.message, "bad");
});
