-- 2026/10/27 發起人要求：貼上的 memo（文字類）送出後，每檔保留跟它有關的那一段（public/passage.js 切的），
-- 清單上看得到完整內容，不只提到它的 2 句。網址、圖片和這之前貼的是 NULL（圖片的全文照舊存在 articles.body）
ALTER TABLE mentions ADD COLUMN passage TEXT;
