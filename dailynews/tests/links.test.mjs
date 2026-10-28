import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, findUrls, isFetchable, isPromoText, isPromoUrl, looksLikeArticle } from "../public/links.js";

test("找網址：中文標點、括號、句點結尾都不算進去", () => {
  const text =
    "鉅亨網：https://news.cnyes.com/news/id/6636489。另見（https://money.udn.com/money/story/5612/9087654）" +
    "和 https://example.com/a(b) 以及 https://www.ctee.com.tw/news/20261022700075-439901, 結束";
  assert.deepEqual(
    findUrls(text).map((u) => u.raw),
    [
      "https://news.cnyes.com/news/id/6636489",
      "https://money.udn.com/money/story/5612/9087654",
      "https://example.com/a(b)",
      "https://www.ctee.com.tw/news/20261022700075-439901",
    ],
  );
});

test("經濟日報：分享參數拿掉後和原本的網址一樣", () => {
  const plain = "https://money.udn.com/money/story/5612/9087654";
  assert.equal(cleanUrl(`${plain}?from=edn_maintab_index&utm_source=line&utm_medium=share`), plain);
  assert.equal(cleanUrl(`${plain}#article_body`), plain);
  assert.equal(cleanUrl(plain.replace("https:", "http:")), plain);
  assert.equal(cleanUrl(plain), plain);
});

test("鉅亨網：手機版、帶參數的網址都換成同一個", () => {
  const plain = "https://news.cnyes.com/news/id/6636489";
  assert.equal(cleanUrl(`${plain}?exp=a`), plain);
  assert.equal(cleanUrl("https://m.cnyes.com/news/id/6636489?utm_source=app"), plain);
});

test("工商時報、Yahoo：查詢參數都拿掉", () => {
  assert.equal(
    cleanUrl("https://www.ctee.com.tw/news/20261022700075-439901?utm_source=line&openExternalBrowser=1"),
    "https://www.ctee.com.tw/news/20261022700075-439901",
  );
  assert.equal(
    cleanUrl("https://tw.stock.yahoo.com/news/abc-123.html?guccounter=1"),
    "https://tw.stock.yahoo.com/news/abc-123.html",
  );
});

test("其他網站：只拿掉追蹤參數，文章編號之類的參數留著", () => {
  assert.equal(
    cleanUrl("https://www.moneydj.com/kmdj/news/newsviewer.aspx?a=abc-123&utm_source=line&fbclid=XYZ"),
    "https://www.moneydj.com/kmdj/news/newsviewer.aspx?a=abc-123",
  );
  assert.equal(cleanUrl("https://example.com/news?id=5&From=line&ID2=%E5%8F%B0"), "https://example.com/news?id=5&ID2=%E5%8F%B0");
  assert.equal(cleanUrl("https://example.com/p?fbclid=1"), "https://example.com/p");
  assert.equal(cleanUrl("https://example.com/p?x=%ZZ"), "https://example.com/p?x=%ZZ");
});

test("不是網址就回傳 null", () => {
  assert.equal(cleanUrl("javascript:alert(1)"), null);
  assert.equal(cleanUrl("ftp://example.com/a"), null);
  assert.equal(cleanUrl("不是網址"), null);
});

test("App 推廣連結和推廣文字", () => {
  assert.ok(isPromoUrl("https://apps.apple.com/tw/app/id123"));
  assert.ok(isPromoUrl("https://play.google.com/store/apps/details?id=com.cnyes.android"));
  assert.ok(isPromoUrl("https://cnyes.page.link/abc"));
  assert.ok(isPromoUrl("https://lin.ee/abcd"));
  assert.ok(isPromoUrl("https://line.me/R/ti/p/@abc"));
  assert.ok(!isPromoUrl("https://today.line.me/tw/v2/article/abc"));
  assert.ok(!isPromoUrl("https://news.cnyes.com/news/id/6636489"));

  assert.ok(isPromoText("下載鉅亨App，看更多新聞"));
  assert.ok(isPromoText("看更多經濟日報新聞，請下載經濟日報App："));
  assert.ok(isPromoText("加入經濟日報 LINE 好友"));
  assert.ok(isPromoText("分享自 Yahoo奇摩股市"));
  assert.ok(isPromoText("「 全球財經 盡在鉅亨App： 」"));
  assert.ok(!isPromoText("台積電法說會釋出樂觀展望，AI 需求持續強勁"));
  // 很長的一行可能是內文，不當成推廣文字
  assert.ok(!isPromoText(`法人表示，${"市場".repeat(30)}，建議下載 App 追蹤`));

  assert.ok(looksLikeArticle("https://money.udn.com/money/story/5612/9087654"));
  assert.ok(!looksLikeArticle("https://money.udn.com/money/index"));
});

test("伺服器只替人抓一般網站", () => {
  assert.ok(isFetchable("https://news.cnyes.com/news/id/6636489"));
  assert.ok(isFetchable("http://example.com:80/a"));
  assert.ok(!isFetchable("http://localhost:8787/api/list"));
  assert.ok(!isFetchable("http://127.0.0.1/"));
  assert.ok(!isFetchable("http://10.0.0.1/"));
  assert.ok(!isFetchable("http://[::1]/"));
  assert.ok(!isFetchable("http://router.local/"));
  assert.ok(!isFetchable("http://intranet/"));
  assert.ok(!isFetchable("https://example.com:8443/"));
  assert.ok(!isFetchable("file:///etc/passwd"));
});
