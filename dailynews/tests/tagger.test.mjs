import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMatcher } from "../public/matcher.js";
import { buildTagger, compileKeyword, companyLabel, describeLabels } from "../public/tagger.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"));
const tagsConfig = await load("tags.json");
const companiesConfig = await load("big-companies.json");
const matcher = buildMatcher(await load("stocks.json"), await load("name-rules.json"));
const tagger = buildTagger(tagsConfig, companiesConfig);

// 和網頁上一樣：先對個股，再幫每一檔貼標籤
const analyze = (text) => tagger.tagMentions(text, matcher.analyze(text).mentions);
const byCode = (mentions, code) => mentions.find((m) => m.code === code);

test("「與輝達合作」：合作標籤、合作對象顯示「輝達（NVIDIA）」", () => {
  const [m] = analyze("廣達(2382)與輝達合作開發AI伺服器");
  assert.equal(m.code, "2382");
  assert.deepEqual(m.tags, ["合作"]);
  assert.deepEqual(m.partners, ["輝達（NVIDIA）"]);
});

test("「NVIDIA 訂單」：英文別名不分大小寫、全形半形", () => {
  for (const text of ["緯創接獲NVIDIA訂單", "緯創接獲 Nvidia 訂單", "緯創接獲ＮＶＩＤＩＡ訂單", "緯創接獲NVDA訂單"]) {
    const [m] = analyze(text);
    assert.deepEqual(m.tags, ["訂單"], text);
    assert.deepEqual(m.partners, ["輝達（NVIDIA）"], text);
  }
});

test("一則提到好幾檔：每檔只看提到它的段落", () => {
  const mentions = analyze(
    [
      "【永豐投顧】評等調整",
      "台積電(2330)：維持買進，目標價上調至1,600元。",
      "聯發科（2454）調升至買進。",
      "鴻海與輝達合作，廣達、緯創同步受惠。",
    ].join("\n"),
  );
  assert.deepEqual(byCode(mentions, "2330").tags, ["調升目標價"]);
  assert.deepEqual(byCode(mentions, "2330").partners, []);
  assert.deepEqual(byCode(mentions, "2454").tags, []);
  for (const code of ["2317", "2382", "3231"]) {
    assert.deepEqual(byCode(mentions, code).tags, ["合作"], code);
    assert.deepEqual(byCode(mentions, code).partners, ["輝達（NVIDIA）"], code);
  }
});

test("一則只提到一檔：整則內容都算（後面沒寫名稱的段落也算）", () => {
  const [m] = analyze("國巨(2327)9月營收創新高\n公司表示，AI伺服器訂單強勁，產能滿載，明年擴產。\n主要客戶包括蘋果、特斯拉。");
  assert.deepEqual(m.tags, ["訂單", "營收創高", "供不應求", "擴產"].sort((a, b) => tagger.tagNames.indexOf(a) - tagger.tagNames.indexOf(b)));
  assert.deepEqual(m.partners, ["蘋果（Apple）", "特斯拉（Tesla）"]);
});

test("* 代表同一句裡隔幾個字", () => {
  assert.deepEqual(tagger.judge("9月營收35億元，創歷史新高").tags, ["營收創高"]);
  assert.deepEqual(tagger.judge("大摩調升台積電目標價至1800元").tags, ["調升目標價"]);
  assert.deepEqual(tagger.judge("目標價由1,500元上調至1,600元").tags, ["調升目標價"]);
  // 句號隔開、或隔太遠就不算
  assert.deepEqual(tagger.judge("9月營收35億元。股價創歷史新高").tags, []);
  assert.deepEqual(tagger.judge(`營收${"一".repeat(25)}新高`).tags, []);
  const re = compileKeyword("營收*新高");
  assert.ok(re.test("營收年增30%，再創新高"));
});

test("except：含有關鍵字但不是那個意思的詞不算", () => {
  assert.deepEqual(tagger.judge("合作金庫今天公布獲利").tags, []);
  assert.deepEqual(tagger.judge("合作金庫與輝達合作").tags, ["合作"]);
  assert.deepEqual(tagger.judge("現在是最佳切入點").tags, []);
  assert.deepEqual(tagger.judge("打入蘋果供應鏈").tags, ["訂單"]);
  assert.deepEqual(tagger.judge("美超微伺服器出貨").partners, ["美超微（Supermicro）"]); // 不是超微（AMD）
  assert.deepEqual(tagger.judge("超微MI450").partners, ["超微（AMD）"]);
  assert.deepEqual(tagger.judge("蘋果日報報導").partners, []);
});

test("英文別名要整個字對上", () => {
  assert.deepEqual(tagger.judge("採用Arm架構").partners, ["安謀（Arm）"]);
  assert.deepEqual(tagger.judge("ARMY").partners, []);
  assert.deepEqual(tagger.judge("Marvel 電影").partners, []);
  assert.deepEqual(tagger.judge("Marvell ASIC").partners, ["邁威爾（Marvell）"]);
  // 輝達的顯示卡也叫 RTX，不算雷神（RTX）
  assert.deepEqual(tagger.judge("RTX 5090 顯示卡").partners, []);
});

test("銀行、券商和台股不當合作對象：大摩、高盛、台積電", () => {
  const r = tagger.judge("大摩、高盛、摩根大通調升聯發科、台積電目標價");
  assert.deepEqual(r.partners, []);
  assert.deepEqual(r.tags, ["調升目標價"]);
});

test("合作對象依市值排名排，標籤依設定檔的順序", () => {
  const r = tagger.union([
    { tags: ["合作"], partners: ["特斯拉（Tesla）"] },
    { tags: ["訂單", "合作", "已刪掉的標籤"], partners: ["輝達（NVIDIA）"] },
  ]);
  assert.deepEqual(r.tags, ["訂單", "合作", "已刪掉的標籤"]);
  assert.deepEqual(r.partners, ["輝達（NVIDIA）", "特斯拉（Tesla）"]);
});

test("設定檔加新標籤，含關鍵字的內容就會貼上", () => {
  const custom = buildTagger(
    { tags: [...tagsConfig.tags, { name: "低軌衛星", keywords: ["低軌衛星", "LEO"] }] },
    companiesConfig,
  );
  const [m] = custom.tagMentions("昇達科(3491)低軌衛星訂單", matcher.analyze("昇達科(3491)低軌衛星訂單").mentions);
  assert.deepEqual(m.tags, ["訂單", "低軌衛星"]);
  assert.deepEqual(custom.judge("LEO satellite").tags, ["低軌衛星"]);
});

test("設定檔寫錯的地方略過，不會整個壞掉", () => {
  const t = buildTagger({ tags: [{ name: "漲價", keywords: "漲價" }, { keywords: ["x"] }, null, { name: "訂單", keywords: ["訂單", ""] }] }, {});
  assert.deepEqual(t.tagNames, ["訂單"]);
  assert.deepEqual(t.judge("接到訂單").partners, []);
  assert.deepEqual(buildTagger().judge("訂單"), { tags: [], partners: [] });
});

test("顯示文字", () => {
  assert.equal(companyLabel({ zh: "輝達", en: "NVIDIA" }), "輝達（NVIDIA）");
  assert.equal(companyLabel({ zh: "", en: "Netflix" }), "Netflix");
  assert.equal(describeLabels({ tags: ["訂單", "合作"], partners: ["輝達（NVIDIA）"] }), "訂單、合作；合作對象：輝達（NVIDIA）");
  assert.equal(describeLabels({ tags: [], partners: [] }), "");
});

test("標籤設定檔：每個標籤都有名稱和關鍵字，名稱不重複", () => {
  assert.ok(Array.isArray(tagsConfig._說明));
  const names = tagsConfig.tags.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of tagsConfig.tags) {
    assert.ok(t.keywords.length > 0, t.name);
    for (const w of [...t.keywords, ...(t.except ?? [])]) assert.ok(compileKeyword(w), `${t.name}：${w}`);
  }
  for (const name of ["漲價", "訂單", "營收創高", "合作", "供不應求", "擴產", "轉型", "調升目標價"]) assert.ok(names.includes(name), name);
});

test("大廠名單：前 100 名、有資料日期和來源、顯示名稱不重複", () => {
  assert.ok(Array.isArray(companiesConfig._說明));
  assert.match(companiesConfig.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(companiesConfig.source, /^https:\/\//);
  const ranks = companiesConfig.companies.map((c) => c.rank);
  assert.deepEqual(ranks, Array.from({ length: 100 }, (_, i) => i + 1));
  const labels = companiesConfig.companies.map(companyLabel);
  assert.equal(new Set(labels).size, labels.length);
  for (const c of companiesConfig.companies) {
    assert.ok(c.en, `第 ${c.rank} 名沒有英文名稱`);
    assert.ok(Array.isArray(c.aliases), c.en);
    // 不比對的要寫原因
    if (c.aliases.length === 0) assert.ok(c.note, `${c.en} 沒有別名，要在 note 寫原因`);
  }
});

test("其他知名企業：有英文名稱、顯示名稱不和前 100 名重複", () => {
  assert.ok(companiesConfig.others.length > 0);
  const labels = [...companiesConfig.companies, ...companiesConfig.others].map(companyLabel);
  assert.equal(new Set(labels).size, labels.length);
  for (const c of companiesConfig.others) {
    assert.ok(c.en, JSON.stringify(c));
    assert.ok(c.aliases.length > 0, `${c.en} 沒有別名`);
    assert.equal(c.rank, undefined, `${c.en} 不在前 100 名，不用寫排名`);
  }
});

test("高通、索尼等不在前 100 名的也對得到，常見詞裡的字不算", () => {
  assert.deepEqual(tagger.judge("搭載高通驍龍晶片").partners, ["高通（Qualcomm）"]);
  assert.deepEqual(tagger.judge("Sony 影像感測器、美超微伺服器").partners, ["索尼（Sony）", "美超微（Supermicro）"]);
  assert.deepEqual(tagger.judge("取得OpenAI訂單").partners, ["OpenAI"]);
  for (const text of ["提高通路庫存", "高通膨壓力", "其中芯片需求", "提高意願", "以中華為例", "令人聯想", "創新思維"]) {
    assert.deepEqual(tagger.judge(text).partners, [], text);
  }
  // 美超微、超微電腦不是超微（AMD）
  assert.deepEqual(tagger.judge("超微電腦").partners, ["美超微（Supermicro）"]);
  // 前 100 名排前面，其他知名企業接在後面
  assert.deepEqual(tagger.union([{ partners: ["高通（Qualcomm）", "輝達（NVIDIA）"] }]).partners, ["輝達（NVIDIA）", "高通（Qualcomm）"]);
});

test("大廠別名不會和其他大廠重複", () => {
  const seen = new Map();
  for (const c of [...companiesConfig.companies, ...companiesConfig.others]) {
    for (const a of c.aliases) {
      const key = compileKeyword(a).source;
      assert.ok(!seen.has(key), `「${a}」同時是 ${seen.get(key)} 和 ${c.en} 的別名`);
      seen.set(key, c.en);
    }
  }
});
