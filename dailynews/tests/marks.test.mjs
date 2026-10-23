import { test } from "node:test";
import assert from "node:assert/strict";

// 簡單的 localStorage 替身
function fakeStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

// 每個測試都重新載入模組，記憶體裡的備份才不會互相影響
let n = 0;
const freshMarks = () => import(`../public/marks.js?case=${n++}`);

function useStorage(value) {
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
}

test("勾選依日期分開存", async () => {
  const storage = fakeStorage();
  useStorage(storage);
  const marks = await freshMarks();
  marks.saveCodes("picked", "2026-10-24", new Set(["2330", "2454"]));
  assert.deepEqual([...marks.loadCodes("picked", "2026-10-24")], ["2330", "2454"]);
  assert.equal(marks.loadCodes("picked", "2026-10-27").size, 0);
  assert.equal(marks.loadCodes("added", "2026-10-24").size, 0);
  assert.equal(storage.getItem("dailynews:picked:2026-10-24"), '["2330","2454"]');
  // 全部取消就把那一天的紀錄刪掉
  marks.saveCodes("picked", "2026-10-24", new Set());
  assert.equal(storage.getItem("dailynews:picked:2026-10-24"), null);
  assert.equal(marks.isPersistent(), true);
});

test("localStorage 不能用時改記在記憶體，不會丟錯", async () => {
  const broken = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  useStorage(broken);
  const marks = await freshMarks();
  assert.equal(marks.loadCodes("picked", "2026-10-24").size, 0);
  marks.saveCodes("picked", "2026-10-24", new Set(["2330"]));
  assert.deepEqual([...marks.loadCodes("picked", "2026-10-24")], ["2330"]);
  assert.equal(marks.isPersistent(), false);
  marks.pruneOld("2026-10-24");
});

test("存的內容壞掉時當成沒勾選", async () => {
  const storage = fakeStorage();
  storage.setItem("dailynews:picked:2026-10-24", "{not json");
  storage.setItem("dailynews:added:2026-10-24", '{"a":1}');
  useStorage(storage);
  const marks = await freshMarks();
  assert.equal(marks.loadCodes("picked", "2026-10-24").size, 0);
  assert.equal(marks.loadCodes("added", "2026-10-24").size, 0);
});

test("清掉 90 天以前的紀錄，其他的不動", async () => {
  const storage = fakeStorage();
  storage.setItem("dailynews:picked:2026-07-01", '["2330"]');
  storage.setItem("dailynews:added:2026-08-01", '["2330"]');
  storage.setItem("dailynews:picked:2026-10-24", '["2330"]');
  storage.setItem("other-site", "x");
  useStorage(storage);
  const marks = await freshMarks();
  marks.pruneOld("2026-10-24");
  assert.deepEqual([...storage.data.keys()].sort(), ["dailynews:added:2026-08-01", "dailynews:picked:2026-10-24", "other-site"]);
});
