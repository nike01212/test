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

// 2026/10/28 發起人從 LINE 電腦版選好幾則訊息複製的（時間 名字 訊息，空白隔開）
const LINE_COPY = [
  "14:40 凱文D 〈焦點股〉Lumentum、Coherent大漲 眾達-KY領軍光通訊族群紅光滿面",
  "https://news.cnyes.com/news/id/6639382?utm_campaign=share_button&utm_medium=news_article&utm_source=cnyesnewsapp",
  "「 全球財經 盡在鉅亨App：https://reurl.cc/QLk750 」",
  "15:18 瞌睡俠 https://money.udn.com/money/story/5612/9840827?from=ednappsharing",
  "15:19 瞌睡俠 https://money.udn.com/money/story/5612/9842307?from=ednappsharing",
  "15:55 凱文D https://money.udn.com/money/story/5710/9842408?from=ednappsharing",
  "15:56 凱文D https://money.udn.com/money/story/5710/9842382?from=ednappsharing",
  "15:57 凱文D https://money.udn.com/money/story/11074/9842352?from=ednappsharing",
  "15:58 I’m 九孔 C已收回訊息",
  "16:07 SS-C https://news.mtkstock.com.tw/html/1/20261028/1A590AE5-A4D2-F111-BFB7-ECEBB895092F.html",
  "16:07 SS-C https://news.mtkstock.com.tw/html/1/20261028/16590AE5-A4D2-F111-BFB7-ECEBB895092F.html",
  "18:43 CSY-D已收回訊息",
  "18:45 可愛小p-C https://money.udn.com/money/story/5710/9842854?from=ednappsharing",
  "18:47 CSY-D 〈聯電法說〉追加32億美元資本支出 三年內AI營收占比衝25%",
  "https://news.cnyes.com/news/id/6639659?utm_campaign=share_button&utm_medium=news_article&utm_source=cnyesnewsapp",
  "「 全球財經 盡在鉅亨App：https://reurl.cc/QLk750 」",
  "18:47 CSY-D 〈譜瑞法說〉布局高階AI傳輸邁向收割 多款ASIC與超高速銅纜明年放量",
  "https://news.cnyes.com/news/id/6639628?utm_campaign=share_button&utm_medium=news_article&utm_source=cnyesnewsapp",
  "「 全球財經 盡在鉅亨App：https://reurl.cc/QLk750 」",
  "18:48 CSY-D 〈精測法說〉獨拿次世代TPU測試介面估明年Q1出貨 美系電動車、低軌衛星訂單迎收割期",
  "https://news.cnyes.com/news/id/6639570?utm_campaign=share_button&utm_medium=news_article&utm_source=cnyesnewsapp",
  "「 全球財經 盡在鉅亨App：https://reurl.cc/QLk750 」",
];
const LINE_COPY_URLS = [
  "https://news.cnyes.com/news/id/6639382",
  "https://money.udn.com/money/story/5612/9840827",
  "https://money.udn.com/money/story/5612/9842307",
  "https://money.udn.com/money/story/5710/9842408",
  "https://money.udn.com/money/story/5710/9842382",
  "https://money.udn.com/money/story/11074/9842352",
  "https://news.mtkstock.com.tw/html/1/20261028/1A590AE5-A4D2-F111-BFB7-ECEBB895092F.html",
  "https://news.mtkstock.com.tw/html/1/20261028/16590AE5-A4D2-F111-BFB7-ECEBB895092F.html",
  "https://money.udn.com/money/story/5710/9842854",
  "https://news.cnyes.com/news/id/6639659",
  "https://news.cnyes.com/news/id/6639628",
  "https://news.cnyes.com/news/id/6639570",
];

test("LINE 選好幾則複製：一個網址一則，時間和名字拿掉，已收回的略過", () => {
  const r = splitPaste(LINE_COPY.join("\n"));
  assert.deepEqual(r.items.map((i) => i.type), Array(12).fill("url"));
  assert.deepEqual(r.items.map((i) => i.url), LINE_COPY_URLS);
  assert.deepEqual(
    r.items.map((i) => i.note),
    [
      "〈焦點股〉Lumentum、Coherent大漲 眾達-KY領軍光通訊族群紅光滿面",
      ...Array(8).fill(""),
      "〈聯電法說〉追加32億美元資本支出 三年內AI營收占比衝25%",
      "〈譜瑞法說〉布局高階AI傳輸邁向收割 多款ASIC與超高速銅纜明年放量",
      "〈精測法說〉獨拿次世代TPU測試介面估明年Q1出貨 美系電動車、低軌衛星訂單迎收割期",
    ],
  );
  // 4 行鉅亨 App 推廣（連到 reurl.cc）拿掉；2 則已收回的訊息略過
  assert.deepEqual([r.promo, r.duplicates, r.noUrl], [4, 0, 2]);
});

test("LINE 選好幾則複製：時間、名字、訊息中間是 Tab 也一樣", () => {
  const tabbed = LINE_COPY.map((l) => {
    const m = /^(\d{1,2}:\d{2}) (I’m 九孔 C|\S+?)(?: |(?=已收回訊息))(.*)$/.exec(l);
    return m ? `${m[1]}\t${m[2]}\t${m[3]}` : l;
  });
  assert.equal(tabbed[0], "14:40\t凱文D\t〈焦點股〉Lumentum、Coherent大漲 眾達-KY領軍光通訊族群紅光滿面");
  const r = splitPaste(tabbed.join("\r\n"));
  assert.deepEqual(r.items.map((i) => i.url), LINE_COPY_URLS);
  assert.equal(r.items[9].note, "〈聯電法說〉追加32億美元資本支出 三年內AI營收占比衝25%");
  assert.deepEqual([r.promo, r.noUrl], [4, 2]);
});

test("LINE 選好幾則複製：同一篇好幾個人分享只留一則", () => {
  const r = splitPaste(
    [
      "15:18 瞌睡俠 https://money.udn.com/money/story/5612/9840827?from=ednappsharing",
      "15:30 凱文D https://money.udn.com/money/story/5612/9840827",
      "16:02 SS-C 〈台積電〉同一篇",
      "https://money.udn.com/money/story/5612/9840827?utm_source=line&from=edn_maintab_index",
      "16:10 可愛小p-C https://money.udn.com/money/story/5612/9840827?from=ednappsharing",
    ].join("\n"),
  );
  assert.deepEqual(kinds(r), ["url:https://money.udn.com/money/story/5612/9840827"]);
  assert.equal(r.duplicates, 3);
});

test("LINE 選好幾則複製：沒有網址的訊息不管有沒有寫到個股都略過；名字有空白也拿得掉", () => {
  const r = splitPaste(
    [
      "15:58 I’m 九孔 C已收回訊息",
      "19:02 I’m 九孔 C 鴻海漲停",
      "19:03 凱文D 台積電(2330)法說重點：",
      "1. 第4季營收優於預期",
      "2. 明年資本支出上修",
      "19:04 瞌睡俠 謝謝分享",
      "19:05 I’m 九孔 C 〈熱門股〉國巨漲價",
      "https://news.cnyes.com/news/id/6639382",
      "19:06 瞌睡俠 [貼圖]",
    ].join("\n"),
  );
  assert.deepEqual(kinds(r), ["url:https://news.cnyes.com/news/id/6639382"]);
  // 「I’m 九孔 C」從「已收回訊息」那行認得，整個名字拿掉
  assert.equal(r.items[0].note, "〈熱門股〉國巨漲價");
  assert.equal(r.noUrl, 5);
});

test("LINE 選好幾則複製：訊息裡的字很長也照樣是網址，說明是那些字", () => {
  const long = "國巨(2327)法說重點，".repeat(20);
  const r = splitPaste(`20:01 凱文D ${long}\nhttps://news.cnyes.com/news/id/6639382\n20:02 凱文D https://money.udn.com/money/story/5612/9840827`);
  assert.deepEqual(r.items.map((i) => i.type), ["url", "url"]);
  assert.equal(r.items[0].note, long.trim());
});

test("不是 LINE 複製的照舊：memo 裡的行事曆、只有一行時間開頭、沒有網址", () => {
  // 第一行是標題，不是「時間 名字」：照一般的拆法，時間開頭的行原樣留著（不會把「鴻海(2317)」當成名字拿掉）
  const memo = "今日法說會\n09:30 台積電(2330) https://investor.tsmc.com/a\n14:00 鴻海(2317)\n15:00 聯發科(2454)";
  const r = splitPaste(memo);
  assert.deepEqual(kinds(r), ["url:https://investor.tsmc.com/a"]);
  assert.equal(r.items[0].note, "今日法說會\n09:30 台積電(2330)\n14:00 鴻海(2317)\n15:00 聯發科(2454)");
  assert.equal(r.noUrl, 0);
  // 第一行是時間開頭，但沒有網址：整段是一則 memo，時間和字都留著
  const schedule = "09:30 台積電(2330)法說\n14:00 鴻海(2317)股東會";
  assert.deepEqual(splitPaste(schedule).items, [{ type: "text", text: schedule }]);
  // 只複製一則 LINE 訊息（只有一行時間開頭）：照一般的拆法，鉅亨的推廣行一樣拿掉
  const one = splitPaste(LINE_COPY.slice(0, 3).join("\n"));
  assert.deepEqual(kinds(one), ["url:https://news.cnyes.com/news/id/6639382"]);
  assert.equal(one.promo, 1);
});

test("文字改成網址類型：找出第一個文章網址", () => {
  assert.deepEqual(extractUrl("下載App https://apps.apple.com/tw/app/id1 台積電 https://news.cnyes.com/news/id/1?exp=a 完"), {
    url: "https://news.cnyes.com/news/id/1",
    rawUrl: "https://news.cnyes.com/news/id/1?exp=a",
    rest: "下載App https://apps.apple.com/tw/app/id1 台積電  完",
  });
  assert.equal(extractUrl("沒有網址"), null);
});
