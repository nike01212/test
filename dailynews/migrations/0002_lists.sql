-- 每一則貼進來的新聞或 memo。依 PRD 不存全文，只存標題、網址和時間
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_day TEXT NOT NULL, -- 所屬交易日 YYYY-MM-DD
  title TEXT NOT NULL,
  url TEXT, -- 第 4 步貼網址時才會有
  pasted_at INTEGER NOT NULL -- 貼入時間（Unix 秒），和所屬交易日分開記
);

CREATE INDEX idx_articles_day ON articles (trading_day);

-- 提及紀錄：一列 = 一檔個股 × 一則新聞。畫面上再以個股合併
CREATE TABLE mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_day TEXT NOT NULL,
  article_id INTEGER REFERENCES articles (id) ON DELETE CASCADE, -- 手動新增的個股沒有來源，是 NULL
  code TEXT, -- 待確認、還沒選定時是 NULL
  name TEXT,
  market TEXT, -- 上市 / 上櫃
  status TEXT NOT NULL DEFAULT 'ok', -- ok：已對上代號；pending：待確認
  raw TEXT, -- 原文裡被對到的字，待確認時顯示
  reason TEXT, -- 待確認的原因
  candidates TEXT, -- 待確認的候選代號（JSON 陣列）
  sentences TEXT NOT NULL DEFAULT '[]', -- 提到這檔的原文句子（JSON 陣列，最多 2 句）
  created_at INTEGER NOT NULL -- Unix 秒
);

CREATE INDEX idx_mentions_day_code ON mentions (trading_day, code);
CREATE INDEX idx_mentions_article ON mentions (article_id);
