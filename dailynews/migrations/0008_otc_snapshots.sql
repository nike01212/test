-- 2026/10/27 修 10/22 收盤比對失敗：即時報價系統只有最近一個交易日的資料（下一個交易日早上就換掉），
-- 櫃買中心又擋掉 Cloudflare，之後才貼進來的上櫃股就比對不到。
-- 改成排程收盤後把全部上櫃股的收盤價、漲停價存一份，之後比對上櫃股都先看這裡。

-- 上櫃收盤快照：一個交易日一列
CREATE TABLE otc_snapshots (
  trading_day TEXT PRIMARY KEY, -- 收盤的那一天
  quotes TEXT NOT NULL, -- JSON：{"3691": [109, 109], ...}，[收盤價, 漲停價]；沒有成交、沒有漲跌幅限制、查不到是 null
  count INTEGER NOT NULL, -- 查到幾檔
  source TEXT NOT NULL, -- mis：排程從即時報價系統存的；tpex：用家裡的電腦從櫃買中心補的（scripts/otc-snapshot.mjs）
  created_at INTEGER NOT NULL -- Unix 秒
);
