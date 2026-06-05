import type { ScheduleDateRule } from "../types.js";
import { isSmartNonWorkday, isSmartWorkday } from "./china-workday-calendar.js";

export function isScheduleDateRuleMatched(
  rule: ScheduleDateRule | undefined,
  weekdays: number[] | undefined,
  now: Date,
): boolean {
  const day = now.getDay();
  if (!rule || rule === "all") return true;
  if (rule === "workday") return isSmartWorkday(now);
  if (rule === "holiday") return isSmartNonWorkday(now);
  return (weekdays ?? []).includes(day);
}
