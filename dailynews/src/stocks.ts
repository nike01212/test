// 上市櫃代號清單（public/data/stocks.json，由 npm run update-data 從證交所、櫃買中心產生）。
// 比對在瀏覽器做；伺服器這邊只用來確認代號存在，並且一律用官方名稱存檔。
import data from "../public/data/stocks.json";

export interface Stock {
  code: string;
  name: string;
  market: string;
}

let byCode: Map<string, Stock> | null = null;

export function findStock(code: unknown): Stock | undefined {
  if (typeof code !== "string") return undefined;
  if (!byCode) {
    byCode = new Map();
    for (const [c, name, market] of data.stocks as [string, string, string, string[]][]) {
      byCode.set(c, { code: c, name, market });
    }
  }
  return byCode.get(code);
}

// 全部上櫃股的代號（存上櫃收盤快照用）
export function otcCodes(): string[] {
  return (data.stocks as [string, string, string, string[]][]).filter((s) => s[2] === "上櫃").map((s) => s[0]);
}
