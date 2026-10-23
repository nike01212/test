-- 第 5 步：每檔 × 每則的標籤和國際大廠合作對象（JSON 陣列）。送出前在瀏覽器裡判斷好（public/tagger.js），
-- 網址和文字不存全文，事後不能重算，所以這之前貼的都是空的
ALTER TABLE mentions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'; -- 例如 ["訂單","合作"]
ALTER TABLE mentions ADD COLUMN partners TEXT NOT NULL DEFAULT '[]'; -- 例如 ["輝達（NVIDIA）"]
