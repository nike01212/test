import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyOcrText } from "../public/ocr.js";

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
