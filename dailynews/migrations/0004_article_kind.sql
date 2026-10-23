-- 每一則的類型、出處，以及圖片辨識出來的全文（10/23 發起人決定：圖片的內文都存下來；網址和文字仍只存擷取句）
ALTER TABLE articles ADD COLUMN kind TEXT; -- url 網址、text 文字、image 圖片；這之前貼的是 NULL（有網址就是網址，沒有就是文字）
ALTER TABLE articles ADD COLUMN source TEXT; -- 出處，例如圖片標題上面那行「B3 上市櫃 1 | 2026. 10. 22 | 工商時報」
ALTER TABLE articles ADD COLUMN body TEXT; -- 圖片辨識出來的全文
