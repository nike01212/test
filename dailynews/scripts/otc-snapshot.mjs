// 在家裡的電腦補「上櫃收盤快照」（otc_snapshots）。
// 排程收盤後會從即時報價系統存全部上櫃股的收盤價、漲停價；萬一那天都沒存成（清單頁寫「收盤後沒有存到上櫃的
// 收盤資料」），網站就比對不到那天的上櫃股：即時報價系統隔天早上就換掉，櫃買中心又擋掉 Cloudflare。
// 櫃買中心沒有擋家裡的電腦，所以在這裡抓那天的「上櫃股票每日收盤行情」補進資料庫，再到清單頁按「現在比對」。
//
// 用法：
//   npm run otc-snapshot -- 2026-10-22            正式站
//   npm run otc-snapshot -- 2026-10-22 --staging  測試站
//   npm run otc-snapshot -- 2026-10-22 --local    本機（.claude/launch.json 的 dailynews-8788）
// 那天已經有快照的話會蓋掉（櫃買中心公布的就是正式的收盤資料）。要先登入 wrangler（npx wrangler login）

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isLimitUp, loadTpexQuotes, snapshotText } from "../src/closingData.ts";
import { closedReason, nextTradingDay, previousTradingDay } from "../src/tradingDay.ts";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const args = process.argv.slice(2);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!day) {
  console.error("用法：npm run otc-snapshot -- 2026-10-22 [--staging | --local]");
  process.exit(1);
}
const [target, wranglerArgs] = args.includes("--local")
  ? ["本機（8788）", ["--local", "--persist-to", ".wrangler/state-8788"]]
  : args.includes("--staging")
    ? ["測試站", ["--remote", "--env", "staging"]]
    : ["正式站", ["--remote"]];

const [stocks, holidays, closures] = await Promise.all([
  readJson("../public/data/stocks.json"),
  readJson("../public/data/holidays.json"),
  readJson("../public/data/closures.json"),
]);
const calendar = { years: holidays.years, closed: { ...holidays.closed, ...closures.closed } };
const closed = closedReason(day, calendar);
if (closed) {
  console.error(`${day} 沒開盤（${closed}），不用補`);
  process.exit(1);
}
const names = new Map(stocks.stocks.filter((s) => s[2] === "上櫃").map((s) => [s[0], s[1]]));
const codes = [...names.keys()];

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 dailynews-otc-snapshot", Accept: "application/json" },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`櫃買中心轉址到 ${res.headers.get("Location")}（被擋了？）`);
  if (!res.ok) throw new Error(`櫃買中心回應 ${res.status}`);
  return res.text();
}

let quotes;
try {
  quotes = await loadTpexQuotes(day, new Set(codes), fetchText, (d) => previousTradingDay(d, calendar));
} catch (err) {
  console.error(`抓不到櫃買中心的資料：${err.message}`);
  process.exit(1);
}
const hits = codes.filter((c) => isLimitUp(quotes.get(c)));
console.log(`${day} 上櫃 ${codes.length} 檔，櫃買中心有 ${quotes.size} 檔，收盤漲停 ${hits.length} 檔：`);
console.log(hits.map((c) => `${c} ${names.get(c)}`).join("、") || "（沒有）");

// 快照只有代號和數字，沒有單引號；保險起見照 SQL 的寫法跳脫
const text = snapshotText(codes, quotes).replaceAll("'", "''");
const now = Math.floor(Date.now() / 1000);
const sql = `INSERT INTO otc_snapshots (trading_day, quotes, count, source, created_at) VALUES ('${day}', '${text}', ${quotes.size}, 'tpex', ${now})
  ON CONFLICT (trading_day) DO UPDATE SET quotes = excluded.quotes, count = excluded.count, source = excluded.source, created_at = excluded.created_at`;
console.log(`寫進${target}的資料庫…`);
execFileSync("npx", ["wrangler", "d1", "execute", "DB", ...wranglerArgs, "--yes", "--command", sql], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "ignore", "inherit"],
});
console.log(`完成。到${target}的 ${nextTradingDay(day, calendar)} 清單頁，在延續性觀察按「現在比對」。`);
