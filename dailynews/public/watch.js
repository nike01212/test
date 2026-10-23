// 延續性觀察要顯示哪幾檔（不碰畫面，方便測試）。
// 延續性觀察 = 這一頁清單上的個股，前一個交易日收盤漲停的（伺服器比對好，放在 watch.checks），
// 扣掉手動移出的，再加上手動加的。所以自動加的一定也在下面的清單裡。

// stocks：這一頁的清單（已經依畫面上的順序排好）；watch：/api/list 回傳的 watch
export function watchItems(stocks, watch) {
  const removed = new Set(watch.removed ?? []);
  const checks = watch.checks ?? {};
  const auto = stocks
    .filter((s) => checks[s.code] === 1 && !removed.has(s.code))
    .map((s) => ({ code: s.code, name: s.name, market: s.market, source: "auto" }));
  const shown = new Set(auto.map((s) => s.code));
  const manual = (watch.manual ?? []).filter((m) => !shown.has(m.code)).map((m) => ({ ...m, source: "manual" }));
  return [...auto, ...manual];
}

// 清單上還有幾檔沒比對過收盤（剛貼的，或排程還沒跑到）
export function uncheckedCount(stocks, watch) {
  const checks = watch.checks ?? {};
  return stocks.filter((s) => !(s.code in checks)).length;
}
