import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrl, splitPaste } from "../public/split.js";

const kinds = (r) => r.items.map((i) => (i.type === "url" ? `url:${i.url}` : `text:${i.text.split("\n")[0]}`));

test("只有文字、沒有網址：整段是一則（和以前一樣）", () => {
  const r = splitPaste("【永豐投顧】評等調整\n台積電(2330)：維持買進。\n\n聯發科（2454）調升至買進。\n");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, "text");
  assert.match(r.items[0].text, /聯發科/);
});

test("LINE 分享：標題＋網址＋App 推廣文字 → 一則網址，推廣文字拿掉", () => {
  const r = splitPaste(
    [
      "〈熱門股〉東台PCB鑽孔機接單滿載直達2027年底 | 鉅亨網",
      "https://news.cnyes.com/news/id/6636489?exp=a&utm_source=line",
      "下載鉅亨App，看更多即時新聞 https://cnyes.page.link/app",
    ].join("\n"),
  );
  assert.deepEqual(kinds(r), ["url:https://news.cnyes.com/news/id/6636489"]);
  assert.equal(r.items[0].note, "〈熱門股〉東台PCB鑽孔機接單滿載直達2027年底 | 鉅亨網");
  assert.equal(r.items[0].rawUrl, "https://news.cnyes.com/news/id/6636489?exp=a&utm_source=line");
  assert.equal(r.promo, 2);
});

test("混貼：網址、memo、網址；同一篇帶參數和不帶參數只留一則", () => {
  const r = splitPaste(
    [
      "https://money.udn.com/money/story/5612/9087654?from=edn_maintab_index",
      "",
      "【元大投顧】晨會重點",
      "鴻海(2317)：AI 伺服器出貨優於預期。",
      "",
      "廣達(2382)：維持買進。",
      "",
      "工商時報",
      "",
      "https://www.ctee.com.tw/news/20261022700075-439901",
      "",
      "https://money.udn.com/money/story/5612/9087654",
    ].join("\n"),
  );
  assert.deepEqual(kinds(r), [
    "url:https://money.udn.com/money/story/5612/9087654",
    "text:【元大投顧】晨會重點",
    "url:https://www.ctee.com.tw/news/20261022700075-439901",
  ]);
  // memo 的兩段算同一則
  assert.match(r.items[1].text, /廣達/);
  // 網址前面空一行的短標題，當成網址的說明
  assert.equal(r.items[2].note, "工商時報");
  assert.equal(r.duplicates, 1);
});

test("空白行後面是【】開頭，就是另一則 memo", () => {
  const r = splitPaste("【永豐投顧】晨訊\n台積電(2330)買進。\n\n【元大投顧】晨訊\n聯發科(2454)買進。\n\n補充：鴻海(2317)中立。");
  assert.deepEqual(kinds(r), ["text:【永豐投顧】晨訊", "text:【元大投顧】晨訊"]);
  assert.match(r.items[1].text, /鴻海/);
});

test("同一段裡有好幾個網址：各自一則，前一行是它的標題", () => {
  const r = splitPaste(
    [
      "台積電法說會 釋出樂觀展望",
      "https://money.udn.com/money/story/5612/111111",
      "聯發科 新晶片打入大廠",
      "https://news.cnyes.com/news/id/222222 （鉅亨網）",
    ].join("\n"),
  );
  assert.deepEqual(
    r.items.map((i) => [i.url, i.note]),
    [
      ["https://money.udn.com/money/story/5612/111111", "台積電法說會 釋出樂觀展望"],
      ["https://news.cnyes.com/news/id/222222", "聯發科 新晶片打入大廠\n（鉅亨網）"],
    ],
  );
});

test("附了來源連結的長 memo：整段當文字，網址不另外抓", () => {
  const memo = `${"法人指出，大量(3167)訂單已排至2027年第二季，高階產品占比提升。".repeat(5)}\n資料來源：https://www.ctee.com.tw/news/20261022700075-439901?utm_source=line`;
  const r = splitPaste(memo);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, "text");
  // 文字裡的網址也清掉追蹤參數
  assert.match(r.items[0].text, /資料來源：https:\/\/www\.ctee\.com\.tw\/news\/20261022700075-439901$/);
});

test("推廣文字附的是文章網址：留網址、拿掉推廣文字", () => {
  const r = splitPaste("看更多新聞請下載App https://money.udn.com/money/story/5612/9087654?utm_source=app");
  assert.deepEqual(kinds(r), ["url:https://money.udn.com/money/story/5612/9087654"]);
  assert.equal(r.items[0].note, "");
});

test("LINE 匯出的聊天紀錄：一則訊息一則，去掉時間和名字", () => {
  const text = [
    "[LINE] 與投資群的聊天記錄",
    "儲存日期：2026/10/23 14:00",
    "",
    "2026/10/23（四）",
    "13:05\t王小明\thttps://news.cnyes.com/news/id/6636489",
    '13:06\t營業員\t"【永豐投顧】盤後',
    "台積電(2330)買進",
    "",
    '聯發科(2454)買進"',
    "13:07\t王小明\t謝謝",
  ].join("\r\n");
  const r = splitPaste(text);
  assert.deepEqual(kinds(r), ["url:https://news.cnyes.com/news/id/6636489", "text:【永豐投顧】盤後", "text:謝謝"]);
  assert.equal(r.items[1].text, "【永豐投顧】盤後\n台積電(2330)買進\n\n聯發科(2454)買進");
});

test("文字改成網址類型：找出第一個文章網址", () => {
  assert.deepEqual(extractUrl("下載App https://apps.apple.com/tw/app/id1 台積電 https://news.cnyes.com/news/id/1?exp=a 完"), {
    url: "https://news.cnyes.com/news/id/1",
    rawUrl: "https://news.cnyes.com/news/id/1?exp=a",
    rest: "下載App https://apps.apple.com/tw/app/id1 台積電  完",
  });
  assert.equal(extractUrl("沒有網址"), null);
});
