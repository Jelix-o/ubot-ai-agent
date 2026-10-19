export const DAILY_REPORT_MAX_TOP_USERS = 20;

export function normalizeDailyReportTopUserCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(DAILY_REPORT_MAX_TOP_USERS, Math.floor(value)));
}
