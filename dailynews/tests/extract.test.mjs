import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanParagraphs, cleanTitle, decodeHtml, detectCharset, findLdArticle, isBoilerplate } from "../public/extract.js";

// extractArticle 要用瀏覽器的 DOMParser，在本機網頁上實測；這裡測不需要 DOM 的部分

test("標題去掉網站名稱和分類", () => {
  assert.equal(cleanTitle("薔琵暴風圈壟罩全台 下午起降雨最嚴重 | 生活 | 要聞 | 經濟日報", "經濟日報"), "薔琵暴風圈壟罩全台 下午起降雨最嚴重");
  assert.equal(cleanTitle("AI推升PCB升級 高階載板迎高成長 - 日報 - 工商時報", "工商時報"), "AI推升PCB升級 高階載板迎高成長");
  assert.equal(cleanTitle("台積電 - 法說會前瞻 - 鉅亨網", "鉅亨網"), "台積電 - 法說會前瞻");
  assert.equal(cleanTitle("台積電 - 法說會前瞻"), "台積電 - 法說會前瞻");
  assert.equal(cleanTitle("  標題\n  第二行  "), "標題 第二行");
});

test("從 JSON-LD 找出新聞的標題和內文", () => {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "鉅亨網" },
      { "@type": "NewsArticle", headline: "東台接單滿載", articleBody: "工具機大廠東台(4526-TW)..." },
    ],
  };
  assert.deepEqual(findLdArticle(graph), { headline: "東台接單滿載", articleBody: "工具機大廠東台(4526-TW)..." });
  assert.deepEqual(findLdArticle([{ "@type": ["WebPage"] }, { "@type": ["Article"], headline: "A" }]), {
    headline: "A",
    articleBody: "",
  });
  assert.equal(findLdArticle({ "@type": "WebSite" }), null);
});

test("版權、分享提示的短段落不算內文", () => {
  assert.ok(isBoilerplate("已將目前網頁的網址複製到您的剪貼簿！"));
  assert.ok(isBoilerplate("※ 歡迎用「轉貼」或「分享」的方式轉傳文章連結；未經授權，請勿複製轉貼文章內容"));
  assert.ok(!isBoilerplate("欣興持續整合生產資料、設備狀態與自動檢測資訊，從異常分類、原因分析，走向預警與製程調整。"));
});

test("段落整理：拿掉版權提示，相關新聞之後都不算", () => {
  assert.deepEqual(
    cleanParagraphs([
      "  銅箔基板CCL聯茂、台光電\n及台燿等強勢股拉回並不需要太擔心。 ",
      "",
      "【看原文連結】",
      "更多中時新聞網報導金居、富喬...PCB上游材料誰能追？",
      "中華電飆上155.5元",
    ]),
    ["銅箔基板CCL聯茂、台光電 及台燿等強勢股拉回並不需要太擔心。"],
  );
  assert.deepEqual(cleanParagraphs(["內文。", "延伸閱讀：台積電法說會"]), ["內文。"]);
  assert.deepEqual(cleanParagraphs(["相關個股表現強勢，台積電領漲。"]), ["相關個股表現強勢，台積電領漲。"]);
});

test("網頁編碼：標頭優先，再看 meta，最後用 UTF-8", () => {
  const big5Page = new TextEncoder().encode('<html><head><meta charset="big5"></head>');
  assert.equal(detectCharset(big5Page, "utf-8"), "utf-8");
  assert.equal(detectCharset(big5Page, null), "big5");
  assert.equal(detectCharset(new TextEncoder().encode("<html>"), null), "utf-8");
  // 「台積電」的 Big5 編碼
  const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xa5, 0x78, 0xbf, 0x6e, 0xb9, 0x71]);
  assert.equal(decodeHtml(bytes.buffer, "big5"), "<p>台積電");
  assert.equal(decodeHtml(new TextEncoder().encode("<p>台積電").buffer, "no-such-charset"), "<p>台積電");
});
