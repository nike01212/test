-- 2026/10/29 發起人要求代號清單自動更新：GitHub Actions 每天跑 scripts/update-data.mjs，抓到的清單
-- 傳給 POST /api/stock-data 存在這裡（只有一列，內容和 public/data/stocks.json 一樣）。
-- 網站用這一列和部署時帶的 stocks.json 裡比較新的那一份，所以更新代號清單不用重新部署
CREATE TABLE stock_data (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated TEXT NOT NULL,
  json TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
