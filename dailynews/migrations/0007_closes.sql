-- 第 6 步改版（2026/10/23 發起人說明需求）：延續性觀察是「這一頁新聞清單裡的個股，前一個交易日收盤漲停的」，
-- 不是「前一頁清單裡漲停的帶到下一頁」。改成存每一檔在前一個交易日的收盤比對結果，清單頁直接拿來對。

-- 收盤比對結果：清單上的個股在某個交易日的收盤價和漲停價。hit = 1 是收盤漲停，這些也就是每日漲停紀錄，一直保留
CREATE TABLE closes (
  trading_day TEXT NOT NULL, -- 收盤的那一天（清單所屬交易日的前一個交易日）
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL, -- 上市 / 上櫃
  close REAL, -- 收盤價；那天沒有成交是 NULL
  limit_up REAL, -- 漲停價；沒有漲跌幅限制是 NULL
  hit INTEGER NOT NULL, -- 1：收盤漲停
  checked_at INTEGER NOT NULL, -- Unix 秒
  PRIMARY KEY (trading_day, code)
);

-- 舊的做法（前一頁清單漲停的帶到下一頁）留下的資料不再用：
-- limit_ups 改由 closes 的 hit = 1 代替，清空但先不刪表格（部署新程式前的那幾秒，舊程式還會讀它）；
-- 續看清單自動加的那幾列，現在由清單頁直接算，watchlist 只留手動加的和手動移出的
DELETE FROM limit_ups;
DELETE FROM watchlist WHERE source = 'auto' AND removed = 0;
