// 匯出用的純邏輯（不碰畫面，方便測試）：分組（含延續性觀察那一組）、組名、複製文字、.txt、CSV、元大和三竹電腦版的匯入檔。

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

// 下面兩種是券商電腦版看盤軟體能匯入的自選股檔，格式照發起人 10/23 拿到的範例檔（別人給的，能匯入）。
// 範例檔都沒有 BOM、換行 CRLF、最後一行也有換行。只放在主清單的匯出，延續性觀察那組沒有（10/24 發起人決定）。

// 元大電腦版看盤：一組一行「組名=代號,代號,…」，匯入後是新的一組。groups 是 [{ label, stocks }]，網頁上一次放一組
export function yuantaText(groups) {
  return groups.map((g) => `${g.label}=${g.stocks.map((s) => s.code).join(",")}\r\n`).join("");
}

// 三竹電腦版：第一列 PID,MTK，接著一組一列「G1,組名,代號,…」，每列都用空欄補到一樣寬（範例檔是 30 欄）。
// 匯入時會把軟體裡的自選全部換成檔案的內容（10/24 發起人實測），所以使用者可以先上傳自己從三竹匯出的清單：
// 下載時只把 G1 那一列換成這次的個股，其他列照他的清單寫回去；沒上傳就是 G1 放個股、G2～G5 空白
export const MITAKE_COLUMNS = 30;
const MITAKE_EMPTY_GROUPS = 5; // 沒上傳清單時寫 G1～G5

// 上傳的清單存成「一個字元一個位元組」的字串，組名不管是 Big5 還是 UTF-8 都原樣寫回去，不會變亂碼。
// 拆欄、拆列只看逗號和換行，這兩個位元組在 Big5、UTF-8 的中文字裡都不會出現
export function bytesToBinary(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

export function binaryToBytes(text) {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// 是三竹匯出的自選檔（第一列 PID,MTK、有 G1 那一列）就拆成一列一列（每列後面的空欄拿掉），不是回傳 null
export function parseMitakeList(binary) {
  const text = binary.startsWith("\xEF\xBB\xBF") ? binary.slice(3) : binary; // 用 Excel 存過可能多了 BOM
  const rows = text
    .split(/\r?\n/)
    .map((line) => {
      const cells = line.split(",");
      while (cells.length && cells.at(-1) === "") cells.pop();
      return cells;
    })
    .filter((cells) => cells.length);
  if (rows[0]?.[0]?.trim() !== "PID" || rows[0][1]?.trim() !== "MTK") return null;
  return rows.some((r) => r[0].trim() === "G1") ? rows : null;
}

// list 是上傳的清單（bytesToBinary 的字串），沒上傳是 null。G1 的組名用清單裡原本的；沒上傳就用 name（日期，例如 1027）。
// 回傳的也是一個字元一個位元組的字串，下載前用 binaryToBytes 轉回去
export function mitakeText(stocks, name, list = null) {
  const parsed = list ? parseMitakeList(list) : null;
  const rows = parsed ?? [["PID", "MTK"], ...Array.from({ length: MITAKE_EMPTY_GROUPS }, (_, i) => [`G${i + 1}`])];
  const g1 = rows.findIndex((r) => r[0].trim() === "G1");
  rows[g1] = [rows[g1][0], parsed ? (rows[g1][1] ?? "") : name, ...stocks.map((s) => s.code)];
  // 一組超過 28 檔、或上傳的清單比較寬時整份一起加寬，每列欄數還是一樣
  const width = Math.max(MITAKE_COLUMNS, ...rows.map((r) => r.length));
  return rows.map((r) => `${r.join(",")}${",".repeat(width - r.length)}\r\n`).join("");
}

// 60 檔以內：1027-三竹.csv；超過就每 60 檔一個檔：1027-三竹-1.csv、1027-三竹-2.csv（每個檔都只換 G1）
export function mitakeFileName(isoDate, index, total) {
  return `${dayLabel(isoDate)}-三竹${total > 1 ? `-${index + 1}` : ""}.csv`;
}
