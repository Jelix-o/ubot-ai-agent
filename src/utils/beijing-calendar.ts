/** Calendar boundaries for group reports are always Beijing time, independent of the host TZ. */
const OFFSET_MS = 8 * 60 * 60 * 1_000;

export function beijingDateKey(value: Date): string {
  return new Date(value.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingClock(value: Date): string {
  return new Date(value.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

export function beijingDayStart(value: Date, dayOffset = 0): Date {
  return new Date(Date.parse(`${beijingDateKey(value)}T00:00:00+08:00`) + dayOffset * 86_400_000);
}
