import { test } from "node:test";
import assert from "node:assert/strict";
import { findHeadline, tidyOcrText } from "../public/ocr.js";

// 辨識本身要在瀏覽器裡跑（在本機網頁上實測）；這裡測辨識結果的整理

test("中文字中間的空白拿掉，同一段的換行接回來", () => {
  const raw = "大 量 (3167) 以 高\n階 CCD 背 鑽 機 搭 配 TM\n系 列 量 測 設 備 。\n\n法 人 指 出 , 大 量 訂 單 已 排";
  assert.equal(tidyOcrText(raw), "大量 (3167) 以高階 CCD 背鑽機搭配 TM系列量測設備。\n法人指出 , 大量訂單已排");
});

test("英文單字換行時中間留一個空白", () => {
  assert.equal(tidyOcrText("TPCA\nShow 展出"), "TPCA Show 展出");
});

test("空白行、前後空白都清掉", () => {
  assert.equal(tidyOcrText("\r\n  \n第一段\r\n\n\n  第二段  \n"), "第一段\n第二段");
});

// 實測工商時報 B3 版面截圖辨識出來的行（放大後的座標）：頁首、標題被拆成左右兩段、副標、內文
const line = (text, x0, y0, height, width = 500) => ({ text, bbox: { x0, y0, x1: x0 + width, y1: y0 + height } });
const PAGE = [
  line("B3 上市櫃 1 | 2026. 10. 22 | 工商時報", 62, 35, 74, 1300),
  line("太 旺 量 測", 70, 152, 149, 480),
  line("設 備 攻 康 程 症 級 商 機", 574, 148, 154, 1400),
  line("四 軸 TM4 放 量 , 高 階 產 品 占 比 升", 206, 379, 74, 1700),
  line("李 娟 淬 / 人 台 北 報 導", 65, 530, 56),
  line("和 伺 服 器 帶 動 Ftb 朝 高 多", 67, 615, 54),
  line("層 、 大 尺 寸 與 高 孔 密 度 發 展", 10, 700, 54),
  line("備 需 求 。 大 量 (3167) 以 高", 10, 869, 54),
  line("至 2027 年 第 二 季 , 部 分 客 戶", 12, 1207, 53),
];

test("找標題：比內文大很多的字，左右兩段合成一個", () => {
  const h = findHeadline(PAGE);
  assert.equal(h.text, "太旺量測設備攻康程症級商機");
  assert.deepEqual(h.bbox, { x0: 70, y0: 148, x1: 1974, y1: 302 });
  assert.equal(h.lineHeight, 154);
});

test("字都差不多大（例如 memo 截圖）就沒有標題", () => {
  assert.equal(findHeadline(PAGE.filter((l) => l.bbox.y1 - l.bbox.y0 < 100)), null);
  assert.equal(findHeadline([]), null);
});
