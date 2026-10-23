// 勾選和「已加入」只存在各人的瀏覽器（localStorage），不寫進資料庫，也不會跟到別台裝置。
// 私密瀏覽、儲存空間被封鎖時讀寫都可能丟錯：這時改記在記憶體裡，頁面照常可用，只是重新整理後就不見了。

const PREFIX = "dailynews:";
const KEEP_DAYS = 90; // 超過 90 天的勾選紀錄開頁時順便清掉
const DAY_MS = 24 * 60 * 60 * 1000;

const memory = new Map();
let persistent = true;

function read(key) {
  try {
    const value = globalThis.localStorage.getItem(PREFIX + key);
    if (value !== null) return value;
  } catch {
    persistent = false;
  }
  return memory.get(key) ?? null;
}

function write(key, value) {
  memory.set(key, value);
  try {
    if (value === null) globalThis.localStorage.removeItem(PREFIX + key);
    else globalThis.localStorage.setItem(PREFIX + key, value);
  } catch {
    persistent = false;
  }
}

// 讀寫失敗過就回 false，畫面上提醒「重新整理後不會留著」
export function isPersistent() {
  return persistent;
}

// kind："picked"（勾選）或 "added"（逐檔快速加入標記的「已加入」），依日期分開存
export function loadCodes(kind, isoDate) {
  try {
    const list = JSON.parse(read(`${kind}:${isoDate}`) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((c) => typeof c === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCodes(kind, isoDate, codes) {
  write(`${kind}:${isoDate}`, codes.size ? JSON.stringify([...codes]) : null);
}

// 清掉太舊的日期，免得越存越多
export function pruneOld(todayIso) {
  const cutoff = new Date(Date.parse(todayIso) - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  try {
    const storage = globalThis.localStorage;
    const stale = [];
    for (let i = 0; i < storage.length; i++) {
      const m = /^dailynews:(?:picked|added):(\d{4}-\d{2}-\d{2})$/.exec(storage.key(i) ?? "");
      if (m && m[1] < cutoff) stale.push(m[0]);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    persistent = false;
  }
}
