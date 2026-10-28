import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAnswers, buildMatcher, pendingKey, withoutCodes } from "../public/matcher.js";
import { buildTagger, compileKeyword, companyLabel, describeLabels, mergeChange } from "../public/tagger.js";

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

test("「接獲 NVIDIA 訂單」：英文別名不分大小寫、全形半形", () => {
  for (const text of ["緯創接獲NVIDIA訂單", "緯創接獲 Nvidia 訂單", "緯創接獲ＮＶＩＤＩＡ訂單", "緯創接獲NVDA訂單"]) {
    const [m] = analyze(text);
    assert.deepEqual(m.tags, ["新訂單"], text);
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

test("文字類給了每檔那一段的切法（sections）：那一段只有這一檔就整段算它的，有別檔、待確認、興櫃股就只看寫到它的那幾行", () => {
  const text = "- 甲公司\n報價上揚\n\n- 乙公司、丙公司\n乙擴產\n丙接獲新訂單\n\n- 丁公司\n宏偉接獲新訂單";
  const at = (word) => [text.indexOf(word), text.indexOf(word) + word.length];
  const mentions = [
    { status: "ok", code: "A", spans: [at("甲公司")] },
    { status: "ok", code: "B", spans: [at("乙公司"), at("乙擴產")] },
    { status: "pending", raw: "丙", spans: [at("丙公司")] },
    { status: "ok", code: "D", spans: [at("丁公司")] },
  ];
  const sections = [[0, text.indexOf("\n\n")], [text.indexOf("- 乙"), text.indexOf("\n\n- 丁")], [text.indexOf("- 丁"), text.length]];
  const others = [at("宏偉")]; // 興櫃股
  const tagged = tagger.tagMentions(text, mentions, { sections, others });
  assert.deepEqual(tagged.map((m) => m.tags), [["漲價"], ["擴產"], [], []]);
  // 沒給 sections（網址、圖片）照舊只看寫到它的那幾行
  assert.deepEqual(tagger.tagMentions(text, mentions).map((m) => m.tags), [[], ["擴產"], [], []]);
  // 只有一檔、也沒有興櫃股：整則都算它的；有興櫃股就不是
  const one = [{ status: "ok", code: "A", spans: [at("甲公司")] }];
  assert.deepEqual(tagger.tagMentions(text, one)[0].tags, ["漲價", "新訂單", "擴產"]);
  assert.deepEqual(tagger.tagMentions(text, one, { sections, others })[0].tags, ["漲價"]);
});

test("一則只提到一檔：整則內容都算（後面沒寫名稱的段落也算）", () => {
  const [m] = analyze("國巨(2327)9月營收創新高\n公司表示，AI伺服器訂單強勁，產能滿載，明年擴產。\n主要客戶包括蘋果、特斯拉。");
  // 「訂單強勁」講的是既有訂單，不算新訂單；「公司表示」是 6人說
  assert.deepEqual(m.tags, ["營收創高", "供不應求", "擴產", "6人說"].sort((a, b) => tagger.tagNames.indexOf(a) - tagger.tagNames.indexOf(b)));
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
  assert.deepEqual(tagger.judge("打入蘋果供應鏈").tags, []); // 沒有直接說訂單，不算新訂單；也不是轉型
  assert.deepEqual(tagger.judge("美超微伺服器出貨").partners, ["美超微（Supermicro）"]); // 不是超微（AMD）
  assert.deepEqual(tagger.judge("超微MI450").partners, ["超微（AMD）"]);
  assert.deepEqual(tagger.judge("蘋果日報報導").partners, []);
});

test("新訂單：只認明確拿到新訂單的說法", () => {
  for (const text of ["廣達拿下美系雲端大廠AI伺服器訂單", "公司取得新訂單", "客戶追加訂單", "急單湧入", "受惠轉單效應", "AI訂單湧入", "斬獲大單"]) {
    assert.ok(tagger.judge(text).tags.includes("新訂單"), text);
  }
  // 既有訂單、訂單變少、總體經濟的新訂單指數、單季營收都不算
  for (const text of ["訂單強勁", "訂單能見度看到明年", "在手訂單達500億元", "訂單下滑", "美國ISM製造業新訂單指數下滑", "新訂單減少", "最新單季營收", "尚未取得訂單", "砍單潮"]) {
    assert.ok(!tagger.judge(text).tags.includes("新訂單"), text);
  }
});

test("6人說：公司表示、董事長、總經理、財務長、總裁、執行長", () => {
  for (const text of ["公司今(23)日表示，明年營運審慎樂觀", "董事長魏哲家指出", "總經理表示", "財務長說明", "執行長受訪", "總裁致詞"]) {
    assert.deepEqual(tagger.judge(text).tags, ["6人說"], text);
  }
  assert.deepEqual(tagger.judge("央行總裁楊金龍表示").tags, []);
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
    { tags: ["新訂單", "合作", "已刪掉的標籤"], partners: ["輝達（NVIDIA）"] },
  ]);
  assert.deepEqual(r.tags, ["新訂單", "合作", "已刪掉的標籤"]);
  assert.deepEqual(r.partners, ["輝達（NVIDIA）", "特斯拉（Tesla）"]);
});

test("設定檔加新標籤，含關鍵字的內容就會貼上", () => {
  const custom = buildTagger(
    { tags: [...tagsConfig.tags, { name: "低軌衛星", keywords: ["低軌衛星", "LEO"] }] },
    companiesConfig,
  );
  const [m] = custom.tagMentions("昇達科(3491)接獲低軌衛星訂單", matcher.analyze("昇達科(3491)接獲低軌衛星訂單").mentions);
  assert.deepEqual(m.tags, ["新訂單", "低軌衛星"]);
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
  for (const name of ["漲價", "新訂單", "營收創高", "合作", "供不應求", "擴產", "轉型", "調升目標價", "6人說"]) assert.ok(names.includes(name), name);
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

test("手動加合作對象：搜尋名單（中英文、別名、代號、全形半形都可以）", () => {
  assert.equal(tagger.searchCompanies("nvidia")[0], "輝達（NVIDIA）");
  assert.equal(tagger.searchCompanies("ＮＶＤＡ")[0], "輝達（NVIDIA）");
  assert.equal(tagger.searchCompanies("輝")[0], "輝達（NVIDIA）");
  assert.equal(tagger.searchCompanies("高通")[0], "高通（Qualcomm）");
  assert.equal(tagger.searchCompanies("sony")[0], "索尼（Sony）");
  // 不自動比對的銀行、台股也搜得到，要手動加的時候可以加
  assert.equal(tagger.searchCompanies("高盛")[0], "高盛（Goldman Sachs）");
  assert.equal(tagger.searchCompanies("台積")[0], "台積電（TSMC）");
  // 開頭一樣的排在只是包含的前面；最多 8 個
  const micro = tagger.searchCompanies("micro");
  assert.deepEqual(micro.slice(0, 3), ["微軟（Microsoft）", "美光（Micron）", "微芯（Microchip）"]);
  assert.ok(micro.indexOf("美超微（Supermicro）") > 2);
  assert.ok(tagger.searchCompanies("a").length <= 8);
  assert.deepEqual(tagger.searchCompanies("  "), []);
  assert.deepEqual(tagger.searchCompanies("某某不存在的公司"), []);
});

test("打的字剛好是名單裡的公司，就用名單的顯示名稱", () => {
  assert.equal(tagger.findCompany("nvidia"), "輝達（NVIDIA）");
  assert.equal(tagger.findCompany(" Sony "), "索尼（Sony）");
  assert.equal(tagger.findCompany("輝達（NVIDIA）"), "輝達（NVIDIA）");
  assert.equal(tagger.findCompany("三星電機"), null);
  assert.equal(tagger.findCompany(""), null);
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

test("預覽按「×」拿掉的個股：只拿掉已對上的那幾檔，待確認的不動", () => {
  const mentions = [
    { status: "ok", code: "3504" },
    { status: "ok", code: "8284" },
    { status: "pending", raw: "統一", candidates: ["1216"] },
  ];
  assert.deepEqual(withoutCodes(mentions, new Set(["8284"])), [mentions[0], mentions[2]]);
  assert.deepEqual(withoutCodes(mentions, new Set(["8284", "3504"])), [mentions[2]]);
  // 待確認的沒有代號，拿掉名單裡就算有它的候選代號也不動
  assert.deepEqual(withoutCodes(mentions, new Set(["1216"])), mentions);
  assert.equal(withoutCodes(mentions, new Set()), mentions);
});

test("拿掉抓錯的個股後標籤重算：剩一檔時整則內容都算它的", () => {
  const text = "揚明光接獲車用鏡頭新訂單\n法人透過三竹的看盤軟體追蹤\n公司表示本季營收可望創新高";
  const found = matcher.analyze(text).mentions;
  assert.deepEqual(found.map((m) => m.code), ["3504", "8284"]);
  // 提到兩檔：揚明光只看提到它的那一行
  assert.deepEqual(byCode(tagger.tagMentions(text, found), "3504").tags, ["新訂單"]);
  // 拿掉三竹之後就像本來只提到揚明光：第三行的「營收創新高」「公司表示」也算它的
  const [m] = tagger.tagMentions(text, withoutCodes(found, new Set(["8284"])));
  assert.equal(m.code, "3504");
  assert.deepEqual(m.tags, ["新訂單", "營收創高", "6人說"]);
});

test("預覽裡改標籤：加的貼到每一檔、拿掉的從每一檔拿掉，依設定檔的順序", () => {
  const mentions = [
    { status: "ok", code: "3037", tags: ["擴產", "合作"], partners: ["輝達（NVIDIA）", "三星（Samsung）"] },
    { status: "pending", raw: "三星", tags: ["擴產"], partners: ["三星（Samsung）"] },
  ];
  const changed = tagger.applyChange(mentions, {
    tags: { add: ["漲價", "手機鏡頭"], remove: ["擴產"] },
    partners: { add: [], remove: ["三星（Samsung）"] },
  });
  assert.deepEqual(changed[0].tags, ["漲價", "合作", "手機鏡頭"]);
  assert.deepEqual(changed[0].partners, ["輝達（NVIDIA）"]);
  assert.deepEqual(changed[1].tags, ["漲價", "手機鏡頭"]);
  assert.deepEqual(changed[1].partners, []);
  // 原本的不會被改到
  assert.deepEqual(mentions[0].tags, ["擴產", "合作"]);
});

test("預覽裡改好幾次標籤：之前加的這次拿掉就變成拿掉，反過來也一樣", () => {
  const first = mergeChange(null, new Set(["合作", "漲價"]), ["合作", "擴產"]);
  assert.deepEqual(first, { add: ["漲價"], remove: ["擴產"] });
  const second = mergeChange(first, new Set(["合作", "擴產"]), ["合作", "漲價"]);
  assert.deepEqual(second, { add: ["擴產"], remove: ["漲價"] });
  assert.deepEqual(mergeChange(second, new Set(["合作"]), ["合作"]), second);
});

test("待確認回答「不是個股」之後標籤重算：剩一檔時整則內容都算它的", () => {
  const text = "三星宣布擴產\n欣興(3037)接獲新訂單";
  const found = matcher.analyze(text).mentions;
  const pending = found.find((m) => m.status === "pending");
  assert.ok(pending, "「三星」應該是待確認");
  assert.deepEqual(byCode(tagger.tagMentions(text, found), "3037").tags, ["新訂單"]);
  const [m] = tagger.tagMentions(text, applyAnswers(found, new Map([[pendingKey(pending), null]])));
  assert.equal(m.code, "3037");
  assert.deepEqual(m.tags, ["新訂單", "擴產"]);
});
