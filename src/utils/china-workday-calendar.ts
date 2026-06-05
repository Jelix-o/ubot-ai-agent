const OFF_DAY_KEYS = new Set([
  // 2025 State Council General Office holiday arrangement.
  "2025-01-01",
  "2025-01-28",
  "2025-01-29",
  "2025-01-30",
  "2025-01-31",
  "2025-02-01",
  "2025-02-02",
  "2025-02-03",
  "2025-02-04",
  "2025-04-04",
  "2025-04-05",
  "2025-04-06",
  "2025-05-01",
  "2025-05-02",
  "2025-05-03",
  "2025-05-04",
  "2025-05-05",
  "2025-05-31",
  "2025-06-01",
  "2025-06-02",
  "2025-10-01",
  "2025-10-02",
  "2025-10-03",
  "2025-10-04",
  "2025-10-05",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",

  // 2026 State Council General Office holiday arrangement.
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);

const ADJUSTED_WORKDAY_KEYS = new Set([
  // 2025 State Council General Office holiday arrangement.
  "2025-01-26",
  "2025-02-08",
  "2025-04-27",
  "2025-09-28",
  "2025-10-11",

  // 2026 State Council General Office holiday arrangement.
  "2026-01-04",
  "2026-02-14",
  "2026-02-28",
  "2026-05-09",
  "2026-09-20",
  "2026-10-10",
]);

export function isChinaStatutoryHoliday(date: Date): boolean {
  return OFF_DAY_KEYS.has(toLocalDateKey(date));
}

export function isChinaAdjustedWorkday(date: Date): boolean {
  return ADJUSTED_WORKDAY_KEYS.has(toLocalDateKey(date));
}

export function isSmartWorkday(date: Date): boolean {
  if (isChinaAdjustedWorkday(date)) return true;
  if (isChinaStatutoryHoliday(date)) return false;
  return isWeekday(date);
}

export function isSmartNonWorkday(date: Date): boolean {
  return !isSmartWorkday(date);
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function toLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}
