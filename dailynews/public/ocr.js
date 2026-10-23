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

let workerPromise = null;
let report = null; // 目前這張圖的進度回報
let queue = Promise.resolve(); // 一次只辨識一張

function getWorker() {
  if (!workerPromise) {
    workerPromise = import(TESSERACT_URL).then(async ({ default: Tesseract }) => {
      const worker = await Tesseract.createWorker("chi_tra", 1, {
        langPath: LANG_PATH,
        logger: (m) => report?.({ step: STEPS[m.status] ?? "準備中", progress: m.progress ?? 0 }),
      });
      // 預設把整張圖當成一個文字區塊，報紙分欄會被橫著讀成一行；改成自動找出欄位和段落
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
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

// 辨識一張圖，回傳整理過的文字。onProgress({ step, progress }) 回報進度（progress 是 0～1）
export function recognize(file, onProgress) {
  const job = queue.then(async () => {
    report = onProgress;
    onProgress?.({ step: "排隊中", progress: 0 });
    try {
      const worker = await getWorker();
      // rotateAuto：手機拍得有點歪也會先轉正
      const { data } = await worker.recognize(await prepare(file), { rotateAuto: true });
      return tidyOcrText(data.text);
    } finally {
      report = null;
    }
  });
  queue = job.catch(() => {});
  return job;
}
