import { buildMatcher, makeTitle } from "/matcher.js";
import { codesText, csvText, GROUP_SIZE, splitGroups } from "/export.js";
import { decodeHtml, extractArticle, MIN_BODY } from "/extract.js";
import { isPersistent, loadCodes, pruneOld, saveCodes } from "/marks.js";
import { recognize } from "/ocr.js";
import { extractUrl, splitPaste } from "/split.js";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_SOURCE_SENTENCES = 2;
const QUICK_HINT = "點代號可以複製";

const state = {
  date: null, // 目前看的那一天
  data: null, // /api/list 的回應
  stocks: [], // groupStocks 的結果（已依被提到的則數排好）
  matcher: null,
  dataInfo: "",
  pasteDay: null, // 手動改的「會歸到」日期；null 代表照規則
  picked: new Set(), // 這天勾選的代號（只存在這台裝置）
  added: new Set(), // 逐檔快速加入時標記「已加入」的代號（只存在這台裝置）
  exportScope: "all", // "all" 當天全部、"picked" 只匯出已勾選
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

async function loadList(date) {
  const data = await api(`/api/list${date ? `?date=${date}` : ""}`);
  if (data.date !== state.date) {
    state.picked = loadCodes("picked", data.date);
    state.added = loadCodes("added", data.date);
    // 有勾選就預設只匯出勾選的
    state.exportScope = state.picked.size ? "picked" : "all";
  }
  state.data = data;
  state.date = data.date;
  const isToday = data.date === data.today.tradingDay;
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
      s = { code: m.code, name: m.name, market: m.market, sources: new Map(), manual: false };
      stocks.set(m.code, s);
    }
    if (m.article_id === null) {
      s.manual = true;
      continue;
    }
    const src = s.sources.get(m.article_id) ?? { article: articles.get(m.article_id), sentences: [] };
    for (const t of m.sentences) {
      if (src.sentences.length < MAX_SOURCE_SENTENCES && !src.sentences.includes(t)) src.sentences.push(t);
    }
    s.sources.set(m.article_id, src);
  }
  // 被越多則提到的排越前面
  return [...stocks.values()].sort((a, b) => b.sources.size - a.sources.size || a.code.localeCompare(b.code));
}

function groupPending(data) {
  const articles = new Map(data.articles.map((a) => [a.id, a]));
  const groups = new Map();
  for (const m of data.mentions) {
    if (m.status !== "pending") continue;
    const key = `${m.raw}|${m.candidates.join(",")}|${m.reason}`;
    const g = groups.get(key) ?? { raw: m.raw, reason: m.reason, candidates: m.candidates, ids: [], sources: [] };
    g.ids.push(m.id);
    g.sources.push({ article: articles.get(m.article_id), sentences: m.sentences });
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
  $("date").textContent = `${formatDate(data.date)}開盤用`;
  $("date-picker").value = data.date;
  $("prev-day").disabled = !data.prevDate;
  $("next-day").disabled = !data.nextDate;
  $("back-today").hidden = isToday;
  document.title = `${isToday ? "今日清單" : `${shortDate(data.date)}清單`} · 新聞標的整理`;
  renderPasteDay();

  $("pending").hidden = pending.length === 0;
  $("pending-count").textContent = pending.length;
  $("pending-list").replaceChildren(...pending.map(renderPending));

  renderExport();
  $("stock-list").replaceChildren(
    ...(stocks.length
      ? stocks.map(renderStock)
      : [h("div", { class: "card empty" }, "這天還沒有資料。在上面貼上新聞或 memo，就會整理出個股清單。")]),
  );

  $("article-count").textContent = data.articles.length;
  $("article-list").replaceChildren(
    ...(data.articles.length
      ? data.articles.map(renderArticle)
      : [h("li", { class: "muted" }, "還沒有貼入的資料。")]),
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
    src.sentences.map((t) => h("blockquote", {}, highlight(t, code, extra))),
  );
}

function renderStock(s) {
  const count = s.sources.size;
  const picked = state.picked.has(s.code);
  const card = h(
    "article",
    { class: `card stock${picked ? " picked" : ""}` },
    h(
      "header",
      { class: "stock-head" },
      h(
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
      h("span", { class: "count" }, count ? `${count} 則` : "手動新增"),
      state.added.has(s.code) ? h("span", { class: "tag added" }, "已加入") : null,
      h(
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
    count ? h("ul", { class: "sources" }, [...s.sources.values()].map((src) => renderSource(src, s.code))) : null,
  );
  return card;
}

// ---- 匯出 ----

function exportStocks() {
  return state.exportScope === "picked" ? state.stocks.filter((s) => state.picked.has(s.code)) : state.stocks;
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
  const groups = chosen.length ? splitGroups(chosen, state.date) : [];
  const pendingCount = state.data.mentions.filter((m) => m.status === "pending").length;
  const notes = [];
  if (state.exportScope === "picked" && chosen.length === 0) {
    notes.push(h("p", { class: "warn" }, "還沒勾選任何個股。在下面的清單勾選要的個股，或改選「當天全部」。"));
  }
  if (groups.length > 1) {
    notes.push(
      h(
        "p",
        {},
        `超過 ${GROUP_SIZE} 檔（e點通每組最多 ${GROUP_SIZE} 檔），依被提到的則數由多到少拆成 ${groups.length} 組：`,
        `${groups.map((g) => g.label).join("、")}，${groups[0].label} 是被提到最多的。`,
      ),
    );
  }
  if (pendingCount) notes.push(h("p", { class: "muted" }, `還有 ${pendingCount} 個待確認不會匯出，處理完才會算進來。`));
  if (!isPersistent()) {
    notes.push(h("p", { class: "warn" }, "這個瀏覽器不能儲存勾選（可能是私密瀏覽），重新整理後勾選會不見。"));
  }
  $("export-notes").replaceChildren(...notes);
  $("export-groups").replaceChildren(...groups.map(renderGroup));
}

function renderGroup(g) {
  return h(
    "div",
    { class: "export-group" },
    h("p", { class: "group-head" }, h("strong", { class: "group-label" }, g.label), h("span", { class: "muted" }, ` ${g.stocks.length} 檔`)),
    h(
      "div",
      { class: "export-actions" },
      h("button", { type: "button", class: "primary", onclick: () => copyCodes(g) }, "複製代號"),
      h("button", { type: "button", class: "secondary", onclick: () => download(`${g.label}.txt`, `${codesText(g.stocks)}\n`, "text/plain") }, "下載 .txt"),
      h("button", { type: "button", class: "secondary", onclick: () => download(`${g.label}.csv`, csvText(g.stocks), "text/csv") }, "下載 CSV"),
      h("button", { type: "button", class: "secondary", onclick: () => openQuick(g) }, "逐檔加入"),
    ),
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

function pickAll() {
  state.picked = new Set(state.stocks.map((s) => s.code));
  saveCodes("picked", state.date, state.picked);
  render();
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

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
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
  const day = state.pasteDay ?? today.tradingDay;
  $("paste-day").textContent = formatDate(day);
  const notes = [];
  if (state.pasteDay) notes.push("（手動指定）");
  else if (today.missingYears.length) notes.push(`（${today.missingYears.join("、")} 年休市行事曆還沒公布，只排除週末）`);
  $("paste-day-note").textContent = notes.join("");
  $("paste-day-change").textContent = state.pasteDay ? "改回自動" : "改日期";
}

function renderDataInfo() {
  $("data-info").textContent = state.dataInfo;
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
const MENTION_FIELDS = ["status", "code", "raw", "reason", "candidates", "sentences"];

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

// 這次送出會歸到哪一天（抓網址時用來檢查是不是已經貼過）
function targetDay() {
  return state.pasteDay ?? state.data?.today.tradingDay ?? null;
}

// 拿來比對個股的內容：網址是抓到的標題和內文，加上自己補貼的
function itemContent(item) {
  if (item.type !== "url") return item.text;
  const f = item.fetch;
  const fetched = f.status === "ok" || f.status === "partial" ? [f.title, f.body] : [];
  return [...fetched, item.text].filter((t) => t?.trim()).join("\n");
}

function itemTitle(item) {
  if (item.type === "url") return item.fetch.title || makeTitle(item.note) || makeTitle(item.text) || hostOf(item.url);
  if (item.type === "image") return `（圖片）${makeTitle(item.text)}`;
  return makeTitle(item.text) || "（沒有內容）";
}

function isBusy(item) {
  return (item.type === "url" && item.fetch.status === "loading") || item.ocr?.status === "loading";
}

// 每一則現在能不能送出：ready 可以、busy 處理中、blocked 要補內容、none 沒有個股、skip 重複
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
  if (item.cache?.content !== content) item.cache = { content, analysis: state.matcher.analyze(content) };
  const { analysis } = item.cache;
  if (analysis.mentions.length === 0) return { kind: "none", message: "沒有找到個股，送出時會略過。" };
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
  const focus = active?.matches?.("#preview-list textarea")
    ? { id: active.closest("[data-item]").dataset.item, start: active.selectionStart, end: active.selectionEnd, top: active.scrollTop }
    : null;

  $("preview").hidden = preview.items.length === 0;
  $("preview-count").textContent = preview.items.length;
  $("preview-list").replaceChildren(...preview.items.map(renderItem));
  renderPreviewFooter();

  if (focus) {
    const box = $("preview-list").querySelector(`[data-item="${focus.id}"] textarea`);
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
        : `略過 ${droppable} 則`;
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
    showBox ? textBox(item, index, "把內文貼在這裡（只會存標題、網址和提到個股的句子）") : null,
  ];
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

function foundLine(item, st) {
  if (st.kind === "busy") return h("p", { class: "found muted" }, st.message);
  if (st.kind !== "ready") {
    const kind = { none: "warn", skip: "muted", blocked: "bad" }[st.kind];
    return h("p", { class: `found ${kind}` }, st.message);
  }
  const ok = st.analysis.mentions.filter((m) => m.status === "ok");
  const pending = st.analysis.mentions.filter((m) => m.status === "pending");
  return h(
    "p",
    { class: "found" },
    h("span", { class: "muted" }, `找到 ${ok.length} 檔${pending.length ? `、${pending.length} 個待確認` : ""}：`),
    ok.map((m) => h("span", { class: "chip" }, stockLabel(m.code))),
    pending.map((m) => h("span", { class: "chip pending-chip", title: m.reason }, `待確認：${m.raw}`)),
  );
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
    item.type !== "url" ? textBox(item, index, item.type === "image" ? "辨識出來的文字" : "這則的內容") : null,
    foundLine(item, st),
    item.error ? h("p", { class: "bad item-error" }, item.error) : null,
  );
}

// 打字時不重畫整則（游標會跳掉），只更新標題、找到的個股和送出按鈕
const infoTimers = new Map();
function scheduleItemInfo(item) {
  clearTimeout(infoTimers.get(item.id));
  infoTimers.set(
    item.id,
    setTimeout(() => {
      const card = $("preview-list").querySelector(`[data-item="${item.id}"]`);
      if (!card) return;
      const st = itemState(item);
      card.className = `preview-item ${st.kind}`;
      card.querySelector(".item-title").textContent = itemTitle(item);
      card.querySelector(".found").replaceWith(foundLine(item, st));
      const urlOption = card.querySelector('.type-select option[value="url"]');
      if (urlOption && item.type !== "url") urlOption.disabled = !extractUrl(item.text);
      renderPreviewFooter();
    }, 300),
  );
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
    item.text = joinText(item.note, item.url, item.text);
    Object.assign(item, { type: "text", note: "", fetch: { status: "idle" } });
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
    const text = await recognize(file, (p) => {
      item.ocr = { status: "loading", ...p };
      updateOcrProgress(item);
    });
    item.text = joinText(item.text, text);
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
  const { items, promo, duplicates } = splitPaste(box.value);
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
          tradingDay: state.pasteDay,
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
  if (day) await loadList(day).catch((err) => toast(err.message, "bad"));

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

function setPasteDay(day) {
  state.pasteDay = day;
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

async function addStock(s) {
  await run(async () => {
    await api("/api/stocks", { method: "POST", body: { date: state.date, code: s.code } });
    toast(`已新增 ${s.code} ${s.name}`);
    await loadList(state.date);
  });
}

async function resolvePending(g, code) {
  await run(async () => {
    await api("/api/pending/resolve", { method: "POST", body: { ids: g.ids, code } });
    toast(code ? `「${g.raw}」改成 ${stockLabel(code)}` : `已移除「${g.raw}」`);
    await loadList(state.date);
  });
}

async function moveArticle(a, date) {
  if (date === state.date) return;
  if (!confirm(`把「${a.title}」移到 ${formatDate(date)}？`)) return render();
  await run(async () => {
    await api(`/api/articles/${a.id}`, { method: "PATCH", body: { tradingDay: date } });
    toast(`已移到 ${formatDate(date)}`);
    await loadList(state.date);
  });
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

async function loadMatcher() {
  const [stocks, rules] = await Promise.all(
    ["/data/stocks.json", "/data/name-rules.json"].map(async (path) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path} 讀取失敗`);
      return res.json();
    }),
  );
  state.matcher = buildMatcher(stocks, rules);
  state.dataInfo = ` · 代號清單 ${state.matcher.size.toLocaleString()} 檔（${stocks.updated} 更新）`;
  renderDataInfo();
  if (state.data) render(); // 補上待確認候選的名稱、句子裡的標示
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
  input.value = state.data?.today.tradingDay ?? "";
  input.hidden = false;
  input.focus();
});
$("paste-day-input").addEventListener("change", (e) => {
  if (e.target.value) setPasteDay(e.target.value);
});
$("prev-day").addEventListener("click", () => state.data?.prevDate && run(() => loadList(state.data.prevDate)));
$("next-day").addEventListener("click", () => state.data?.nextDate && run(() => loadList(state.data.nextDate)));
$("go-today").addEventListener("click", () => run(() => loadList(null)));
$("date-picker").addEventListener("change", (e) => e.target.value && run(() => loadList(e.target.value)));
$("add-stock").append(stockPicker({ placeholder: "輸入代號或名稱，例如 2330 或 台積電", onPick: addStock }));
$("checker-input").addEventListener("change", runChecker);
$("checker-input").addEventListener("input", runChecker);

// 匯出
for (const radio of document.querySelectorAll('input[name="export-scope"]')) {
  radio.addEventListener("change", (e) => {
    state.exportScope = e.target.value;
    renderExport();
  });
}
$("pick-all").addEventListener("click", pickAll);
$("pick-none").addEventListener("click", pickNone);

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
  if (!state.date || !e.key?.endsWith(`:${state.date}`)) return;
  state.picked = loadCodes("picked", state.date);
  state.added = loadCodes("added", state.date);
  render();
  if ($("quick").open) renderQuick();
});
document.addEventListener("visibilitychange", () => {
  // 頁面放著過了 09:00，回來時重新算一次「會歸到」哪一天
  if (document.visibilityState === "visible" && state.data) {
    api("/api/trading-day")
      .then((today) => {
        state.data.today = today;
        renderPasteDay();
      })
      .catch(() => {});
  }
});

$("checker-input").value = taipeiNowLocal();
runChecker();
pruneOld(taipeiNowLocal().slice(0, 10));
loadMatcher().catch((err) => toast(`代號清單讀取失敗：${err.message}`, "bad"));
loadList(new URLSearchParams(location.search).get("date")).catch((err) => {
  $("db").textContent = "讀取失敗";
  $("db").className = "bad";
  toast(err.message, "bad");
});
