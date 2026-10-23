-- 第 6 步：收盤漲停續看清單與連續被提到統計

-- 每個交易日的收盤比對做了沒有（一天一列）。排程收盤後跑，資料還沒公布就晚一點再試
CREATE TABLE closing_runs (
  trading_day TEXT PRIMARY KEY, -- 比對的是哪一天的收盤
  status TEXT NOT NULL, -- done 完成；waiting 交易所資料還沒公布；error 出錯（例如連不到交易所）
  checked INTEGER NOT NULL DEFAULT 0, -- 比對了幾檔
  hits INTEGER NOT NULL DEFAULT 0, -- 其中收盤漲停幾檔
  message TEXT, -- 給人看的說明
  updated_at INTEGER NOT NULL -- Unix 秒
);

-- 每日漲停紀錄：當天清單（和續看清單）裡收盤漲停的個股。一直保留，之後可以做「漲停後隔天續漲」的統計
CREATE TABLE limit_ups (
  trading_day TEXT NOT NULL, -- 收盤漲停的那一天
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL, -- 上市 / 上櫃
  close REAL NOT NULL, -- 收盤價（就是漲停價）
  source TEXT NOT NULL, -- list：在當天清單裡；watch：只在當天的續看清單裡（續看的又漲停）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trading_day, code)
);

-- 續看清單：哪一天開盤要續看哪些個股。auto 是前一個交易日收盤漲停自動加的，manual 是手動加的
CREATE TABLE watchlist (
  for_day TEXT NOT NULL, -- 哪一天開盤用（和清單的所屬交易日同一個意思）
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  source TEXT NOT NULL, -- auto / manual
  limit_day TEXT, -- auto 的話，是哪一天收盤漲停
  removed INTEGER NOT NULL DEFAULT 0, -- 1：手動移出了。留著這一列，重新比對時才不會又自動加回來
  created_at INTEGER NOT NULL,
  PRIMARY KEY (for_day, code)
);

-- 算「連續被提到幾天」時，依代號找前幾個交易日有沒有被提到
CREATE INDEX idx_mentions_code_day ON mentions (code, trading_day);
