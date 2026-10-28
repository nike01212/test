// 在 Node 裡直接跑伺服器的程式（src/），給 API、登入的測試用：
// - 本機的 SQLite（node:sqlite）套上 migrations/ 的表格，包成 D1 的樣子（prepare、bind、all、first、run、batch）
// - src/ 的 import 沒寫副檔名、直接 import JSON，Node 原本不收，這裡補上
// - Workers 才有的 crypto.subtle.timingSafeEqual 用 Node 的補上
// 不連外面的網站、不用群組密碼，也不會碰到本機 8788、測試站、正式站的資料庫。
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    // src/ 裡寫 "./calendar"，補成 "./calendar.ts"
    if (context.parentURL?.endsWith(".ts") && /^\.\.?\//.test(specifier) && !/\.(?:[cm]?[jt]s|json)$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // import data from "../public/data/stocks.json"：當成 export default 的模組
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    return next(url, context);
  },
});

if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => a.byteLength === b.byteLength && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

const RETURNS_ROWS = /^\s*(?:SELECT|WITH)\b|\bRETURNING\b/i;

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  // D1 的參數只能是字串、數字、null；undefined 會出錯（和 D1 一樣）
  exec() {
    if (this.params.some((p) => p === undefined)) throw new Error("D1_TYPE_ERROR: undefined 不能當參數");
    this.db.queries++;
    const stmt = this.db.sqlite.prepare(this.sql);
    if (RETURNS_ROWS.test(this.sql)) {
      const results = stmt.all(...this.params);
      return { success: true, results, meta: { changes: /^\s*(?:SELECT|WITH)\b/i.test(this.sql) ? 0 : results.length } };
    }
    const r = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first(column) {
    const row = this.exec().results[0] ?? null;
    return column && row ? row[column] : row;
  }
}

// D1 的樣子：batch 是一筆交易，中間有一句出錯整批都不算
export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON"); // D1 預設開著
    this.queries = 0;
    const dir = new URL("migrations/", root);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
    }
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => s.exec());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
  // 測試裡直接查資料庫
  rows(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params);
  }
}

export async function loadServer() {
  const api = await import(new URL("src/api.ts", root).href);
  const index = (await import(new URL("src/index.ts", root).href)).default;
  const auth = await import(new URL("src/auth.ts", root).href);
  return { api, index, auth };
}

// 呼叫 handleApi：回傳 { status, body }
export function apiCaller(handleApi, env) {
  return async (method, path, body) => {
    const url = new URL(path, "https://dailynews.test");
    const init = { method };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const res = await handleApi(new Request(url, init), env, url);
    if (!res) return { status: 404, body: null };
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers };
  };
}
