import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAnswers, buildMatcher, pendingKey, withoutCodes } from "../public/matcher.js";
import { sections, withPassages } from "../public/passage.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const matcher = buildMatcher(await load("stocks.json"), await load("name-rules.json"));

// 和網頁上一樣：先對個股，再切每一檔的那一段
const passages = (text) => withPassages(text, matcher.analyze(text).mentions);
const passageOf = (mentions, code) => mentions.find((m) => m.code === code)?.passage;

// 2026/10/27 發起人給的外電整理（項目之間空一行，TPCA 那一項底下有三段）
const GUOJU = [
  "- 2327國巨: 美系重申正向",
  "美系大行預期3Q 毛利率40.4%、OPM 29.1%，高出市場共識。展望4Q，預期漲價與AI需求預期持續推動營收成長及利潤率擴張。在即將到來的法說會上，券商會關注非AI市場的需求能見度，還有各產品漲價及供需狀況，重申正向。",
].join("\n");
const ACCTON = ["- 2345智邦: 美系重申正向", "將辦理現金增資，美系大行表示稀釋幅度最高2%，影響可控。重申正向。"].join("\n");
const CHROMA = [
  "- 2360致茂：美系重申正向",
  "美系大行預期半導體及光子技術業務持續帶動2H26成長；預期明年有將是強勁成長的一年。預期3Q毛利率60.5%，季持平；OPM季增至39.3%。重申正向。",
].join("\n");
const TPCA = [
  "- TPCA 2026:",
  "美系大行表示CCL是否會用PTFE會在明年中決定，在此同時也在試其他方法如氫樹脂（HC）基材、HC＋PTFE混合材料，以及苯並環丁烯（BCB）基材的CCL。",
  "",
  "此外，觀察薄型E-glass仍是短缺，將既有產線轉換為LDK1／2及T-glass玻纖布，以滿足強勁的AI需求。",
  "",
  "最後看到ABF的壓合設備交期至少兩年，意即全新建廠的ABF載板產能，最早只能從2029年開始逐步放量。明年載板尺寸又放大，券商持續正向看待載板產業。總結：券商對覆蓋裡的台燿、台光電、金居、欣興、南電、金像電等持正向看法不變。",
].join("\n");
const MEMO = ["早安！10/27 外電綜合整理", GUOJU, ACCTON, CHROMA, TPCA].join("\n\n");

test("外電整理：每檔留自己那一項，開頭的問候不算任何一檔", () => {
  const mentions = passages(MEMO);
  assert.equal(passageOf(mentions, "2327"), GUOJU);
  assert.equal(passageOf(mentions, "2345"), ACCTON);
  assert.equal(passageOf(mentions, "2360"), CHROMA);
  // 「- TPCA 2026:」底下空行隔開的三段都算同一項，總結提到的 6 檔都留整項
  for (const code of ["6274", "2383", "8358", "3037", "8046", "2368"]) assert.equal(passageOf(mentions, code), TPCA, code);
  assert.ok(mentions.every((m) => !m.passage.includes("早安")));
});

test("沒有空行、一行一檔的 memo：一行算一段", () => {
  const mentions = passages(["【永豐投顧】評等調整", "緯創(3231)：調升目標價至150元", "聯發科（2454）調升至買進"].join("\n"));
  assert.equal(passageOf(mentions, "3231"), "緯創(3231)：調升目標價至150元");
  assert.equal(passageOf(mentions, "2454"), "聯發科（2454）調升至買進");
});

test("沒有項目符號：空一行隔開的段落各算一段", () => {
  const mentions = passages(["國巨(2327)：美系重申正向", "預期漲價", "", "智邦(2345)：現金增資", "影響可控"].join("\n"));
  assert.equal(passageOf(mentions, "2327"), "國巨(2327)：美系重申正向\n預期漲價");
  assert.equal(passageOf(mentions, "2345"), "智邦(2345)：現金增資\n影響可控");
});

test("段落裡的小項目不拆開：空行隔開時只看段落開頭的符號", () => {
  const mentions = passages(["國巨(2327)：美系重申正向", "- 毛利率優於預期", "- 預期漲價", "", "智邦(2345)：現金增資", "- 影響可控"].join("\n"));
  assert.equal(passageOf(mentions, "2327"), "國巨(2327)：美系重申正向\n- 毛利率優於預期\n- 預期漲價");
  assert.equal(passageOf(mentions, "2345"), "智邦(2345)：現金增資\n- 影響可控");
});

test("好幾種符號：用最先出現的那種切，底下的小項目跟著上面那項", () => {
  const mentions = passages(["【國巨】美系重申正向", "• 毛利率優於預期", "• 預期漲價", "【智邦】現金增資", "• 影響可控"].join("\n"));
  assert.equal(passageOf(mentions, "2327"), "【國巨】美系重申正向\n• 毛利率優於預期\n• 預期漲價");
  assert.equal(passageOf(mentions, "2345"), "【智邦】現金增資\n• 影響可控");
});

test("編號的項目：1. 2. 開頭；小數（1.5億）不算編號", () => {
  const mentions = passages(["1. 國巨(2327)：重申正向", "1.5億元的訂單", "2. 智邦(2345)：現金增資"].join("\n"));
  assert.equal(passageOf(mentions, "2327"), "1. 國巨(2327)：重申正向\n1.5億元的訂單");
  assert.equal(passageOf(mentions, "2345"), "2. 智邦(2345)：現金增資");
});

test("一檔出現在好幾項：依原文順序接起來", () => {
  const mentions = passages(["- 國巨(2327)：重申正向", "- 智邦(2345)：現金增資", "- 被動元件：國巨、華新科同步受惠"].join("\n"));
  assert.equal(passageOf(mentions, "2327"), "- 國巨(2327)：重申正向\n\n- 被動元件：國巨、華新科同步受惠");
  assert.equal(passageOf(mentions, "2345"), "- 智邦(2345)：現金增資");
});

test("只提到一檔：整則都算它的", () => {
  const text = ["早安！10/27 外電綜合整理", "", GUOJU].join("\n");
  const [m] = passages(text);
  assert.equal(m.code, "2327");
  assert.equal(m.passage, text);
});

test("拿掉抓錯的、回答待確認之後再切：剩一檔就整則算它的，回答成某一檔也有那一段", () => {
  const text = ["- 國巨(2327)：重申正向", "- 法人透過三竹的看盤軟體追蹤"].join("\n");
  const [m] = withPassages(text, withoutCodes(matcher.analyze(text).mentions, new Set(["8284"])));
  assert.equal(m.code, "2327");
  assert.equal(m.passage, text);

  const memo = ["- 統一今年營收創高", "- 國巨(2327)：重申正向"].join("\n");
  const mentions = matcher.analyze(memo).mentions;
  const pending = mentions.find((m) => m.status === "pending");
  const answered = withPassages(memo, applyAnswers(mentions, new Map([[pendingKey(pending), "1216"]])));
  assert.equal(passageOf(answered, "1216"), "- 統一今年營收創高");
  assert.equal(passageOf(answered, "2327"), "- 國巨(2327)：重申正向");
});

test("切段的位置對得回原文（Windows 換行、前後空白行）", () => {
  const text = "\n\n- 國巨(2327)：重申正向\r\n  說明\n\n- 智邦(2345)：增資\n\n";
  for (const [s, e] of sections(text)) assert.ok(text.slice(s, e).trim().length > 0);
  const mentions = passages(text);
  assert.equal(passageOf(mentions, "2327"), "- 國巨(2327)：重申正向\r\n  說明");
  assert.equal(passageOf(mentions, "2345"), "- 智邦(2345)：增資");
});
