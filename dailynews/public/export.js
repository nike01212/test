// 匯出用的純邏輯（不碰畫面，方便測試）：分組（含延續性觀察那一組）、組名、複製文字、.txt、CSV、元大、三竹和富邦 e01 電腦版的匯入檔。

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

// 富邦 e01 電腦版（核心是 XQ）的代號：上市、上櫃都加 .TW（沒加的匯入後變紅色不能用）。
// 10/26 發起人實測：.TWO 匯入時整檔被丟掉，上櫃寫 .TW 正常。
// 原本也有一行一個代號的 CSV，但匯入後組名一律是「新組合」，發起人決定只留下面的 .dsl
function fubonCode(s) {
  return `${s.code}.TW`;
}

// 富邦 e01 的自選股匯出檔（.dsl_DAQFAP），格式照發起人 10/26 從 e01 匯出的檔拆出來的：
// OLE 複合文件（舊版 Office 檔那種），裡面 3 種串流：_SSHeader_（固定內容）、FileHeadFileCount（幾組）、
// FileContentSymbolList_0、_1…（一組一個，Big5 文字「1,組的 ID;組名,2330.TW,…」）。
// 匯入規則（10/26 實測）：ID 已經有的組整組略過，新的 ID 才加成一組，一定加在最後面；組名和個股順序照檔案。
// 所以一個檔只放一組、每次用新的 ID（id 由呼叫的人給，網頁用 crypto.randomUUID）。
// 組名只能是英數字（網頁上是 1027、1027-A），瀏覽器沒有 Big5 編碼器，中文會寫不進去
export function fubonDsl(stocks, name, id) {
  const line = [`1,${id};${name}`, ...stocks.map(fubonCode)].join(",");
  if (/[^\x20-\x7e]/.test(line)) throw new Error("富邦 .dsl 的組名只能是英數字");
  const header = new Uint8Array(36);
  header.set([0x54, 0x65, 0x73, 0x74], 4); // "Test"，照匯出檔原樣
  return oleFile([
    ["_SSHeader_", header],
    ["FileHeadFileCount", Uint8Array.of(1, 0, 0, 0)],
    ["FileContentSymbolList_0", binaryToBytes(line)],
  ]);
}

export function fubonDslFileName(label) {
  return `${label}-富邦.dsl_DAQFAP`;
}

// 最簡單的 OLE 複合文件（第 3 版，sector 512 位元組）：每個串流都小於 4096 位元組，全部放在 mini stream。
// 版面依序是：表頭、FAT（1 個 sector）、目錄、mini FAT、mini stream。目錄是平衡的二元樹、全部黑色
const OLE_SECTOR = 512;
const OLE_MINI = 64;
const OLE_CUTOFF = 4096;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

function oleFile(streams) {
  const miniFat = [];
  const starts = streams.map(([, data]) => {
    if (data.length >= OLE_CUTOFF) throw new Error("串流太大");
    const n = Math.ceil(data.length / OLE_MINI);
    const start = n ? miniFat.length : ENDOFCHAIN;
    for (let k = 0; k < n; k++) miniFat.push(k < n - 1 ? miniFat.length + 1 : ENDOFCHAIN);
    return start;
  });
  const count = (bytes) => Math.ceil(bytes / OLE_SECTOR);
  const dirSecs = count((streams.length + 1) * 128);
  const miniFatSecs = count(miniFat.length * 4);
  const miniSecs = count(miniFat.length * OLE_MINI);
  const total = 1 + dirSecs + miniFatSecs + miniSecs;
  const buf = new Uint8Array(OLE_SECTOR * (1 + total));
  const view = new DataView(buf.buffer);
  const u16 = (pos, v) => view.setUint16(pos, v, true);
  const u32 = (pos, v) => view.setUint32(pos, v, true);
  const sec = (n) => OLE_SECTOR * (n + 1);

  // 表頭
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  u16(0x18, 0x3e);
  u16(0x1a, 3);
  u16(0x1c, 0xfffe);
  u16(0x1e, 9); // sector 512
  u16(0x20, 6); // mini sector 64
  u32(0x2c, 1); // FAT 用 1 個 sector
  u32(0x30, 1); // 目錄從第 1 個 sector 開始
  u32(0x38, OLE_CUTOFF);
  u32(0x3c, miniFatSecs ? 1 + dirSecs : ENDOFCHAIN);
  u32(0x40, miniFatSecs);
  u32(0x44, ENDOFCHAIN); // 沒有 DIFAT
  for (let i = 0; i < 109; i++) u32(0x4c + 4 * i, i === 0 ? 0 : FREESECT); // FAT 在第 0 個 sector

  // FAT：每一段都是連續的 sector
  if (total > OLE_SECTOR / 4) throw new Error("檔案太大");
  for (let i = 0; i < OLE_SECTOR / 4; i++) u32(sec(0) + 4 * i, FREESECT);
  u32(sec(0), FATSECT);
  const chain = (first, n) => {
    for (let k = 0; k < n; k++) u32(sec(0) + 4 * (first + k), k < n - 1 ? first + k + 1 : ENDOFCHAIN);
    return n ? first : ENDOFCHAIN;
  };
  chain(1, dirSecs);
  chain(1 + dirSecs, miniFatSecs);
  const miniStart = chain(1 + dirSecs + miniFatSecs, miniSecs);

  // 目錄：0 是 Root Entry，串流是 1、2…。兄弟之間照「名稱短的在前，一樣長比大寫」排成平衡的二元樹
  const left = streams.map(() => NOSTREAM);
  const right = streams.map(() => NOSTREAM);
  const order = streams
    .map((_, i) => i)
    .sort((a, b) => {
      const [x, y] = [streams[a][0].toUpperCase(), streams[b][0].toUpperCase()];
      return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
    });
  const build = (lo, hi) => {
    if (lo >= hi) return NOSTREAM;
    const mid = (lo + hi) >> 1;
    const i = order[mid];
    left[i] = build(lo, mid);
    right[i] = build(mid + 1, hi);
    return i + 1;
  };
  const top = build(0, order.length);
  const entry = (n, name, type, l, r, child, start, size) => {
    const pos = sec(1) + 128 * n;
    for (let j = 0; j < name.length; j++) u16(pos + 2 * j, name.charCodeAt(j));
    u16(pos + 64, name ? (name.length + 1) * 2 : 0);
    buf[pos + 66] = type;
    buf[pos + 67] = type ? 1 : 0; // 黑色
    u32(pos + 68, l);
    u32(pos + 72, r);
    u32(pos + 76, child);
    u32(pos + 116, start);
    u32(pos + 120, size);
  };
  for (let n = streams.length + 1; n < (dirSecs * OLE_SECTOR) / 128; n++) entry(n, "", 0, NOSTREAM, NOSTREAM, NOSTREAM, 0, 0);
  entry(0, "Root Entry", 5, NOSTREAM, NOSTREAM, top, miniStart, miniFat.length * OLE_MINI);
  streams.forEach(([name, data], i) => entry(i + 1, name, 2, left[i], right[i], NOSTREAM, starts[i], data.length));

  // mini FAT（沒用到的是 FREESECT）和 mini stream
  const miniFatPos = sec(1 + dirSecs);
  buf.fill(0xff, miniFatPos, miniFatPos + miniFatSecs * OLE_SECTOR);
  miniFat.forEach((v, i) => u32(miniFatPos + 4 * i, v));
  const miniPos = sec(1 + dirSecs + miniFatSecs);
  streams.forEach(([, data], i) => {
    if (data.length) buf.set(data, miniPos + starts[i] * OLE_MINI);
  });
  return buf;
}
