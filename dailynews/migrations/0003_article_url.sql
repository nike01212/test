-- 同一篇新聞（網址清掉追蹤參數之後一樣）在同一個交易日只能有一則；沒有網址的文字、圖片不受限制
CREATE UNIQUE INDEX idx_articles_day_url ON articles (trading_day, url) WHERE url IS NOT NULL;
