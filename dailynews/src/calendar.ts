// 伺服器用的休市行事曆：證交所公布的（holidays.json，npm run update-data 產生）加上
// 發起人手動補的臨時休市日（closures.json，例如颱風假）
import closures from "../public/data/closures.json";
import holidays from "../public/data/holidays.json";
import type { Calendar } from "./tradingDay";

export const calendar: Calendar = {
  years: holidays.years,
  closed: { ...holidays.closed, ...(closures.closed as Record<string, string>) },
};
