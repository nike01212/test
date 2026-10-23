// 連續被提到幾個交易日：從這一天往前一個交易日一個交易日找，週末、休市日直接跳過（不算中斷），
// 找到某個交易日的清單裡沒有這一檔就停。手動新增的也算（多半是新聞裡有提到、只是沒對到）。

// 最多算到幾天（大約一個月）。D1 免費額度是算「讀了幾列」，每次打開清單都會算，所以不往前找太多
export const MAX_STREAK = 20;

// codes：這天清單上的代號；previousDays：這天之前的開盤日，由近到遠（tradingDay.ts 的 previousTradingDays）；
// seen：代號 → 那段日子裡有出現在清單上的日期。
// 回傳代號 → 連續天數（含這天，最少 1；等於 max 代表「max 天以上」）
export function countStreaks(
  codes: Iterable<string>,
  previousDays: string[],
  seen: Map<string, Set<string>>,
  max = MAX_STREAK,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const code of codes) {
    const days = seen.get(code);
    let n = 1;
    for (const d of previousDays) {
      if (n >= max || !days?.has(d)) break;
      n++;
    }
    out.set(code, n);
  }
  return out;
}
