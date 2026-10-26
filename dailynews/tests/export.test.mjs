import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../public/export.js";

const make = (n) => Array.from({ length: n }, (_, i) => ({ code: String(1101 + i), name: `股${i}` }));

test("組名用月日", () => {
  assert.equal(dayLabel("2026-10-24"), "1024");
  assert.equal(dayLabel("2027-01-04"), "0104");
});

test("60 檔以內一組，組名就是日期", () => {
  const groups = splitGroups(make(GROUP_SIZE), "2026-10-24");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "1024");
  assert.equal(groups[0].stocks.length, 60);
});

test("超過 60 檔拆成 A、B 組，照原本的排序切", () => {
  const stocks = make(75);
  const groups = splitGroups(stocks, "2026-10-24");
  assert.deepEqual(
    groups.map((g) => [g.label, g.stocks.length]),
    [
      ["1024-A", 60],
      ["1024-B", 15],
    ],
  );
  assert.equal(groups[0].stocks[0], stocks[0]);
  assert.equal(groups[1].stocks[0], stocks[60]);
});

test("超過 120 檔接著用 C 組", () => {
  assert.deepEqual(
    splitGroups(make(121), "2026-10-24").map((g) => g.label),
    ["1024-A", "1024-B", "1024-C"],
  );
});

test("延續性觀察另外一組：1024-延續性觀察", () => {
  assert.deepEqual(watchGroups([], "2026-10-24"), []);
  const groups = watchGroups(make(3), "2026-10-24");
  assert.deepEqual(groups.map((g) => [g.label, g.stocks.length]), [["1024-延續性觀察", 3]]);
  assert.deepEqual(
    watchGroups(make(61), "2026-10-24").map((g) => g.label),
    ["1024-延續性觀察-A", "1024-延續性觀察-B"],
  );
});

test("複製和 .txt：一行一個代號", () => {
  assert.equal(codesText(make(3)), "1101\n1102\n1103");
});

test("CSV：UTF-8 BOM、代號名稱兩欄、CRLF", () => {
  const csv = csvText([
    { code: "2330", name: "台積電" },
    { code: "3661", name: "世芯-KY" },
  ]);
  assert.equal(csv, "﻿代號,名稱\r\n2330,台積電\r\n3661,世芯-KY\r\n");
  // Blob 會把字串存成 UTF-8，開頭三個位元組就是 BOM
  assert.deepEqual([...Buffer.from(csv, "utf8").subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("CSV：有逗號或引號的欄位會加引號", () => {
  assert.equal(csvText([{ code: "9999", name: 'A,"B"' }]), '﻿代號,名稱\r\n9999,"A,""B"""\r\n');
});

// 元大、三竹的期待結果照發起人 10/23 拿到的範例檔一個字一個字寫（代號換成假的，範例檔本身不放進 repo）。
// 網頁下載時 Blob 會把字串存成 UTF-8，所以 Buffer.from(…, "utf8") 就是下載檔案的位元組
const bytes = (text) => Buffer.from(text, "utf8");
const codes = (start, n) => Array.from({ length: n }, (_, i) => ({ code: String(start + i), name: `股${i}` }));

test("元大電腦版：一行「組名=代號,…」、UTF-8 沒有 BOM、CRLF", () => {
  const out = bytes(yuantaText([{ label: "我的自選股", stocks: codes(1101, 10) }]));
  assert.deepEqual(out, bytes("我的自選股=1101,1102,1103,1104,1105,1106,1107,1108,1109,1110\r\n"));
  // 和範例檔一樣 67 個位元組；開頭直接是「我」（e6 88 91），沒有 BOM（ef bb bf）
  assert.equal(out.length, 67);
  assert.deepEqual([...out.subarray(0, 3)], [0xe6, 0x88, 0x91]);
  assert.deepEqual([...out.subarray(-2)], [0x0d, 0x0a]);
});

test("元大電腦版：網頁上的組名照用", () => {
  assert.equal(yuantaText([{ label: "1027-延續性觀察", stocks: codes(1101, 2) }]), "1027-延續性觀察=1101,1102\r\n");
  assert.equal(yuantaText([{ label: "1027-A", stocks: codes(1101, 1) }]), "1027-A=1101\r\n");
});

// 三竹：每列補到 30 欄（和範例檔一樣）
const row30 = (text) => `${text}${",".repeat(30 - text.split(",").length)}\r\n`;

test("三竹電腦版：沒上傳清單時，G1 是日期和個股、G2～G5 空白，每列 30 欄、CRLF、沒有 BOM", () => {
  const out = mitakeText(codes(1101, 3), "1027");
  assert.equal(
    out,
    "PID,MTK,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
      "G1,1027,1101,1102,1103,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
      "G2,,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
      "G3,,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
      "G4,,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
      "G5,,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n",
  );
  const lines = out.split("\r\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.every((l) => l.split(",").length === 30 && !l.includes("\n")));
  assert.ok(out.startsWith("PID"), "沒有 BOM");
});

test("三竹電腦版：上傳的清單照原樣寫回去，只把 G1 整列換成這次的個股，組名用清單裡的", () => {
  // 發起人 10/24 給的樣子：組名是自己取的 A、C、D、E、B，每列補到最長那列（5 欄）
  const list = "PID,MTK,,,\r\nG1,A,1101,1102,1103\r\nG2,C,,,\r\nG3,D,,,\r\nG4,E,,,\r\nG5,B,,,\r\n";
  assert.equal(
    mitakeText(codes(2101, 2), "1027", list),
    row30("PID,MTK") + row30("G1,A,2101,2102") + row30("G2,C") + row30("G3,D") + row30("G4,E") + row30("G5,B"),
  );
  // G1 原本沒有組名就留空，不會換成日期
  assert.ok(mitakeText(codes(2101, 1), "1027", "PID,MTK\r\nG1\r\nG2,C,2330\r\n").includes("\r\nG1,,2101,"));
  // 其他組裡原本的個股不動
  assert.ok(mitakeText(codes(2101, 1), "1027", "PID,MTK\r\nG1,A,1101\r\nG2,C,2330,2317\r\n").includes("\r\nG2,C,2330,2317,"));
});

test("三竹電腦版：照範例檔（30 欄、5 組）上傳，G1 換成它原本的內容，下載的和原檔一模一樣", () => {
  const list =
    "PID,MTK,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
    "G1,1019,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
    "G2,1020,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n" +
    "G3,1021,1101,1102,1103,1104,1105,1106,1107,1108,1109,1110,,,,,,,,,,,,,,,,,,\r\n" +
    "G4,1022,2101,2102,2103,2104,2105,2106,2107,2108,2109,2110,,,,,,,,,,,,,,,,,,\r\n" +
    "G5,1023,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n";
  // 和範例檔一樣 302 個位元組
  assert.equal(Buffer.from(binaryToBytes(list)).length, 302);
  assert.equal(mitakeText([], "1027", list), list);
});

test("三竹電腦版：組名是中文時照原本的位元組寫回去（Big5、UTF-8 都不會變亂碼）", () => {
  const big5 = Buffer.from([0xab, 0xf9, 0xaa, 0xd1]); // 「持股」的 Big5
  const utf8 = Buffer.from("觀察", "utf8");
  const file = Buffer.concat([
    Buffer.from("PID,MTK\r\nG1,A,1101\r\nG2,"),
    big5,
    Buffer.from(",2330\r\nG3,"),
    utf8,
    Buffer.from("\r\n"),
  ]);
  const out = Buffer.from(binaryToBytes(mitakeText(codes(2101, 1), "1027", bytesToBinary(file))));
  assert.ok(out.includes(Buffer.concat([Buffer.from("\r\nG2,"), big5, Buffer.from(",2330,")])));
  assert.ok(out.includes(Buffer.concat([Buffer.from("\r\nG3,"), utf8, Buffer.from(",")])));
  assert.ok(out.includes(Buffer.from("\r\nG1,A,2101,")));
  // 每個位元組都轉得回去
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(binaryToBytes(bytesToBinary(all)), all);
});

test("三竹電腦版：不是三竹匯出的自選檔不收", () => {
  assert.equal(parseMitakeList(""), null);
  assert.equal(parseMitakeList(csvText([{ code: "2330", name: "台積電" }])), null);
  assert.equal(parseMitakeList("我的自選股=2330,2317\r\n"), null);
  assert.equal(parseMitakeList("PID,MTK\r\nG2,C,2330\r\n"), null, "沒有 G1");
  assert.equal(parseMitakeList("G1,A,2330\r\nPID,MTK\r\n"), null, "第一列不是 PID,MTK");
  // 用 Excel 存過（開頭有 BOM、換行只有 LF）也收，下載的照樣沒有 BOM、換行 CRLF
  const list = "\xEF\xBB\xBFPID,MTK,,\nG1,A,1101\nG2,C,,\n";
  assert.deepEqual(parseMitakeList(list), [["PID", "MTK"], ["G1", "A", "1101"], ["G2", "C"]]);
  const out = mitakeText(codes(2101, 1), "1027", list);
  assert.equal(out, row30("PID,MTK") + row30("G1,A,2101") + row30("G2,C"));
});

test("三竹電腦版：一組超過 28 檔、或上傳的清單比較寬時，每列一起加寬", () => {
  const lines = mitakeText(codes(1101, GROUP_SIZE), "1027").split("\r\n");
  assert.equal(lines.pop(), "");
  assert.deepEqual(new Set(lines.map((l) => l.split(",").length)), new Set([GROUP_SIZE + 2]));
  assert.ok(lines[1].startsWith("G1,1027,1101,1102,"));
  assert.ok(lines[1].endsWith(",1160"));
  const wide = `PID,MTK\r\nG1,A\r\nG2,C,${codes(3001, 40).map((s) => s.code).join(",")}\r\n`;
  const out = mitakeText(codes(2101, 1), "1027", wide).split("\r\n");
  out.pop();
  assert.deepEqual(new Set(out.map((l) => l.split(",").length)), new Set([42]));
});

test("三竹電腦版的檔名：60 檔以內一個檔，超過就 -1、-2", () => {
  assert.equal(mitakeFileName("2026-10-27", 0, 1), "1027-三竹.csv");
  assert.equal(mitakeFileName("2026-10-27", 0, 2), "1027-三竹-1.csv");
  assert.equal(mitakeFileName("2026-10-27", 1, 2), "1027-三竹-2.csv");
});

// 照 OLE 複合文件的規格把串流讀出來（只讀 mini stream 裡的，富邦檔都是小串流），用來檢查 fubonDsl 寫的檔
function readOle(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (pos) => view.getUint32(pos, true);
  const sec = (n) => 512 * (n + 1);
  const fat = (n) => u32(sec(u32(0x4c)) + 4 * n);
  const chain = (start, next) => {
    const out = [];
    for (let s = start; s < 0xfffffffa; s = next(s)) out.push(s);
    return out;
  };
  const dirSecs = chain(u32(0x30), fat);
  const miniFatSecs = chain(u32(0x3c), fat);
  const miniFat = (n) => u32(sec(miniFatSecs[n >> 7]) + 4 * (n & 127));
  const entryPos = (n) => sec(dirSecs[n >> 2]) + 128 * (n & 3);
  const root = entryPos(0);
  const miniSecs = chain(u32(root + 116), fat);
  const miniByte = (offset) => bytes[sec(miniSecs[offset >> 9]) + (offset & 511)];
  const streams = new Map();
  const visit = (n) => {
    if (n === 0xffffffff) return;
    const pos = entryPos(n);
    const name = String.fromCharCode(...new Uint16Array(bytes.slice(pos, pos + view.getUint16(pos + 64, true) - 2).buffer));
    const size = u32(pos + 120);
    const data = [];
    for (const s of chain(u32(pos + 116), miniFat)) for (let k = 0; k < 64 && data.length < size; k++) data.push(miniByte(s * 64 + k));
    streams.set(name, Uint8Array.from(data));
    visit(u32(pos + 68));
    visit(u32(pos + 72));
  };
  visit(u32(root + 76));
  return streams;
}

test("富邦 e01 .dsl：OLE 複合文件，一組、組名和代號照順序，上櫃也是 .TW", () => {
  const stocks = [
    { code: "6488", name: "環球晶", market: "上櫃" },
    { code: "2330", name: "台積電", market: "上市" },
  ];
  const id = "B98449A3-7606-4594-ACF8-F44D8008565C";
  const out = fubonDsl(stocks, "1027-A", id);
  assert.deepEqual([...out.subarray(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(out.length, 2560); // 和 e01 匯出、只有一組的檔一樣大
  const streams = readOle(out);
  assert.deepEqual([...streams.keys()].sort(), ["FileContentSymbolList_0", "FileHeadFileCount", "_SSHeader_"]);
  assert.equal(bytesToBinary(streams.get("FileContentSymbolList_0")), `1,${id};1027-A,6488.TW,2330.TW`);
  assert.deepEqual([...streams.get("FileHeadFileCount")], [1, 0, 0, 0]);
  assert.equal(bytesToBinary(streams.get("_SSHeader_")), `\0\0\0\0Test${"\0".repeat(28)}`);
});

test("富邦 e01 .dsl：60 檔、空的一組都寫得出來；組名不能有中文；檔名", () => {
  const sixty = Array.from({ length: GROUP_SIZE }, (_, i) => ({ code: String(1101 + i), market: "上市" }));
  const text = bytesToBinary(readOle(fubonDsl(sixty, "1027", "X")).get("FileContentSymbolList_0"));
  assert.equal(text.split(",").length, 2 + GROUP_SIZE); // 「1」、「ID;組名」，接著 60 個代號
  assert.ok(text.endsWith(",1160.TW"));
  assert.equal(bytesToBinary(readOle(fubonDsl([], "1027", "X")).get("FileContentSymbolList_0")), "1,X;1027");
  assert.throws(() => fubonDsl([], "1027-延續性觀察", "X"));
  assert.equal(fubonDslFileName("1027-A"), "1027-A-富邦.dsl_DAQFAP");
});
