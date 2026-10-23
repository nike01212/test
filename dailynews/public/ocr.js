// 圖片文字辨識：在每個人自己的瀏覽器裡用 Tesseract.js 做，圖片不會上傳到伺服器。
// 第一次用要下載辨識程式和繁體中文字庫（約 6 MB），之後瀏覽器會留著，不用再下載。

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";
const LANG_PATH = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int";
// 圖片長邊的大小：太大先縮小（辨識比較快），太小先放大（小字比較認得出來）。
// 實測工商時報版面截圖（長邊 1,113 px）：原尺寸中文字只認對 6%，放大兩倍 88%，放大三倍 85%
const MAX_SIDE = 4000;
const MIN_SIDE = 2000;
const TARGET_SIDE = 2200;

// 中文字和全形標點
const CJK = "\\p{Script=Han}\\u3000-\\u303f\\uff00-\\uffef";
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, "gu");
const CJK_END = new RegExp(`[${CJK}]$`, "u");
const CJK_START = new RegExp(`^[${CJK}]`, "u");

// 辨識結果整理：中文字中間的空白拿掉；同一段裡因為版面換行的地方接回來（句子才不會斷掉）
export function tidyOcrText(text) {
  return String(text)
    .replace(/\r/g, "")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => {
      let out = "";
      for (const line of paragraph.split("\n").map((l) => l.trim())) {
        if (!line) continue;
        if (!out) out = line;
        else if (CJK_END.test(out) || CJK_START.test(line)) out += line;
        else out += ` ${line}`;
      }
      return out.replace(CJK_GAP, "");
    })
    .filter(Boolean)
    .join("\n");
}

const STEPS = {
  "loading tesseract core": "下載辨識程式",
  "initializing tesseract": "準備辨識程式",
  "loading language traineddata": "下載中文字庫",
  "loading language traineddata (from cache)": "讀取中文字庫",
  "initializing api": "準備辨識程式",
  "recognizing text": "辨識中",
};

// 標題：行高至少是一般內文的這個倍數，才算標題（實測工商時報版面：標題約 150、內文約 54、副標約 74）
const HEADLINE_RATIO = 1.6;
// 標題另外裁下來重新辨識時，字縮放到這個高度（實測 48 最準；整張圖裡標題字太大反而認不好）
const HEADLINE_HEIGHT = 48;
const HEADLINE_PAD = 0.15; // 裁切時四周多留行高的幾倍

const hanCount = (s) => (s.match(/\p{Script=Han}/gu) ?? []).length;

// 從辨識出來的每一行（依閱讀順序，含位置）找出標題：比內文大很多的那一行，連同前後一樣大的行
// （標題常被拆成兩行或左右兩段）。找不到回傳 null
export function findHeadline(lines) {
  const rows = lines
    .map((l) => ({ text: l.text, bbox: l.bbox, height: l.bbox.y1 - l.bbox.y0 }))
    .filter((l) => hanCount(l.text) >= 2);
  if (rows.length < 3) return null;
  const sorted = rows.map((l) => l.height).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  if (max < median * HEADLINE_RATIO) return null;
  const big = (l) => l.height >= max * 0.75;
  let from = rows.findIndex((l) => l.height === max);
  let to = from;
  while (from > 0 && big(rows[from - 1])) from--;
  while (to < rows.length - 1 && big(rows[to + 1])) to++;
  const group = rows.slice(from, to + 1);
  return {
    text: tidyOcrText(group.map((l) => l.text).join("\n")).replace(/\n/g, ""),
    lineHeight: max,
    bbox: {
      x0: Math.min(...group.map((l) => l.bbox.x0)),
      y0: Math.min(...group.map((l) => l.bbox.y0)),
      x1: Math.max(...group.map((l) => l.bbox.x1)),
      y1: Math.max(...group.map((l) => l.bbox.y1)),
    },
  };
}

let workerPromise = null;
let PSM = null;
let report = null; // 目前這張圖的進度回報
let queue = Promise.resolve(); // 一次只辨識一張

function getWorker() {
  if (!workerPromise) {
    workerPromise = import(TESSERACT_URL).then(async ({ default: Tesseract }) => {
      PSM = Tesseract.PSM;
      const worker = await Tesseract.createWorker("chi_tra", 1, {
        langPath: LANG_PATH,
        logger: (m) => report?.({ step: STEPS[m.status] ?? "準備中", progress: m.progress ?? 0 }),
      });
      // 預設把整張圖當成一個文字區塊，報紙分欄會被橫著讀成一行；改成自動找出欄位和段落
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return worker;
    });
    // 下載失敗（例如網路斷了）下次再試
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

// 太大縮小、太小放大，畫到 canvas 上交給辨識程式。
// 一律經過 canvas：手機照片的方向寫在 EXIF 裡，瀏覽器畫的時候會轉正，直接給原檔可能是橫的
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.max(bitmap.width, bitmap.height);
  const scale = side > MAX_SIDE ? MAX_SIDE / side : side < MIN_SIDE ? Math.min(3, TARGET_SIDE / side) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

// 把標題那一塊裁下來：縮放到適合辨識的字高，彩色字（例如藍色的公司名）改成深色，不然會被當成背景
function cropHeadline(source, headline) {
  const { bbox, lineHeight } = headline;
  const pad = lineHeight * HEADLINE_PAD;
  const sx = Math.max(0, bbox.x0 - pad);
  const sy = Math.max(0, bbox.y0 - pad);
  const sw = Math.min(source.width, bbox.x1 + pad) - sx;
  const sh = Math.min(source.height, bbox.y1 + pad) - sy;
  const k = HEADLINE_HEIGHT / lineHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.min(d[i], d[i + 1], d[i + 2]);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 標題重新辨識；認不出中文就用整張圖辨識時的結果
async function readHeadline(worker, image, headline) {
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const { data } = await worker.recognize(cropHeadline(image, headline));
    const text = tidyOcrText(data.text).replace(/\n/g, "");
    return hanCount(text) >= 2 ? text : headline.text;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
}

// 辨識一張圖，回傳 { text: 整理過的全文, headline: 標題（找不到是空字串） }。
// onProgress({ step, progress }) 回報進度（progress 是 0～1）
export function recognize(file, onProgress) {
  const job = queue.then(async () => {
    report = onProgress;
    onProgress?.({ step: "排隊中", progress: 0 });
    try {
      const worker = await getWorker();
      const image = await prepare(file);
      // rotateAuto：手機拍得有點歪也會先轉正；blocks：每一行的位置，用來找標題
      const { data } = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true });
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      const found = findHeadline(lines);
      report = null; // 標題重新辨識很快，不用再回報進度
      const headline = found ? await readHeadline(worker, image, found) : "";
      return { text: tidyOcrText(data.text), headline };
    } finally {
      report = null;
    }
  });
  queue = job.catch(() => {});
  return job;
}
