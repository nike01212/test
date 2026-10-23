// 匯出用的純邏輯（不碰畫面，方便測試）：分組（含延續性觀察那一組）、組名、複製文字、.txt、CSV。

// 富邦e點通每個自選組最多 60 檔
export const GROUP_SIZE = 60;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// "2026-10-24" → "1024"
export function dayLabel(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${m}${d}`;
}

// 60 檔以內一組，組名就是 base；超過就每 60 檔切一組：base-A、base-B…
function chunk(stocks, base, size) {
  if (stocks.length <= size) return [{ label: base, stocks }];
  const groups = [];
  for (let i = 0; i < stocks.length; i += size) {
    const n = i / size;
    const suffix = n < LETTERS.length ? LETTERS[n] : String(n + 1);
    groups.push({ label: `${base}-${suffix}`, stocks: stocks.slice(i, i + size) });
  }
  return groups;
}

// stocks 要先依被提到的則數由多到少排好（app.js 的 groupStocks 已經排過）。
// 60 檔以內一組，組名就是日期（1024）；超過就每 60 檔切一組：1024-A、1024-B…
export function splitGroups(stocks, isoDate, size = GROUP_SIZE) {
  return chunk(stocks, dayLabel(isoDate), size);
}

// 延續性觀察（程式裡叫 watch）另外存成一組自選：1024-延續性觀察（超過 60 檔一樣切：1024-延續性觀察-A…）
export function watchGroups(stocks, isoDate, size = GROUP_SIZE) {
  return stocks.length ? chunk(stocks, `${dayLabel(isoDate)}-延續性觀察`, size) : [];
}

// 一行一個代號（複製、.txt 都用這個）
export function codesText(stocks) {
  return stocks.map((s) => s.code).join("\n");
}

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// 代號、名稱兩欄。開頭加 UTF-8 BOM，Excel 打開中文才不會變亂碼；換行用 CRLF（CSV 的標準寫法）
export function csvText(stocks) {
  const rows = [["代號", "名稱"], ...stocks.map((s) => [s.code, s.name])];
  return `﻿${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}
