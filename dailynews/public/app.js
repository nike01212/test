import { buildMatcher } from "/matcher.js";
import { codesText, csvText, GROUP_SIZE, splitGroups } from "/export.js";
import { isPersistent, loadCodes, pruneOld, saveCodes } from "/marks.js";

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
  if (!res.ok) throw new Error(data.error || "發生錯誤，請再試一次。");
  return data;
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
      src.article ? src.article.title : "（這則已刪除）",
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
    h("p", { class: "article-title" }, h("span", { class: "muted" }, `${taipeiTime(a.pasted_at)} `), a.title),
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

async function submitPaste() {
  const text = $("paste-text").value;
  const result = $("paste-result");
  result.className = "result";
  if (!text.trim()) {
    result.textContent = "請先貼上內容。";
    result.className = "result bad";
    return;
  }
  if (!state.matcher) {
    result.textContent = "代號清單還在載入，請稍等一下再按。";
    result.className = "result bad";
    return;
  }
  const analyzed = state.matcher.analyze(text);
  if (analyzed.mentions.length === 0) {
    result.textContent = "沒有找到個股。如果有漏掉的，可以用下面的「手動新增個股」補上。";
    result.className = "result bad";
    return;
  }
  const button = $("paste-submit");
  button.disabled = true;
  try {
    const res = await api("/api/articles", {
      method: "POST",
      body: {
        title: analyzed.title,
        tradingDay: state.pasteDay,
        mentions: analyzed.mentions.map(({ status, code, raw, reason, candidates, sentences }) => ({
          status,
          code,
          raw,
          reason,
          candidates,
          sentences,
        })),
      },
    });
    $("paste-text").value = "";
    setPasteDay(null);
    result.textContent = `找到 ${res.confirmed} 檔${res.pending ? `、${res.pending} 個待確認` : ""}，已加入 ${formatDate(res.tradingDay)}的清單。`;
    result.className = "result ok";
    await loadList(res.tradingDay);
  } catch (err) {
    result.textContent = err.message;
    result.className = "result bad";
  } finally {
    button.disabled = false;
  }
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
}

// ---- 事件 ----

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.replace("/login");
});
$("paste-submit").addEventListener("click", submitPaste);
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
