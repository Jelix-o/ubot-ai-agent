import type { GroupBotConfig } from "../types.js";
import { isScheduleDateRuleMatched } from "../utils/schedule-date-rule.js";
import type { AiService } from "./ai-service.js";
import { HolidayCountdownStore } from "./holiday-countdown-store.js";

type HolidayCountdownAiService = Pick<AiService, "generateBroadcastQuip">;

type HolidayDefinition = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  daysOff: number;
  source: "official";
  note?: string;
};

const HOLIDAY_DEFINITIONS: HolidayDefinition[] = [
  // Official 2026 arrangements from the State Council General Office notice.
  { id: "2026-new-year", name: "元旦", startDate: "2026-01-01", endDate: "2026-01-03", daysOff: 3, source: "official" },
  { id: "2026-spring-festival", name: "春节", startDate: "2026-02-15", endDate: "2026-02-23", daysOff: 9, source: "official" },
  { id: "2026-qingming", name: "清明节", startDate: "2026-04-04", endDate: "2026-04-06", daysOff: 3, source: "official" },
  { id: "2026-labour-day", name: "劳动节", startDate: "2026-05-01", endDate: "2026-05-05", daysOff: 5, source: "official" },
  { id: "2026-dragon-boat", name: "端午节", startDate: "2026-06-19", endDate: "2026-06-21", daysOff: 3, source: "official" },
  { id: "2026-mid-autumn", name: "中秋节", startDate: "2026-09-25", endDate: "2026-09-27", daysOff: 3, source: "official" },
  { id: "2026-national-day", name: "国庆节", startDate: "2026-10-01", endDate: "2026-10-07", daysOff: 7, source: "official" },
];

export class HolidayCountdownService {
  constructor(
    private readonly store: HolidayCountdownStore,
    private readonly aiService: HolidayCountdownAiService,
  ) {}

  async shouldSendScheduledMessage(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    if (groupConfig.holidayCountdownEnabled === false) {
      return false;
    }
    if (!isScheduleDateRuleMatched(groupConfig.holidayCountdownDateRule, groupConfig.holidayCountdownWeekdays, now)) {
      return false;
    }

    const todayKey = toLocalDateKey(now);
    const lastSentDate = await this.store.getLastSentDate(groupConfig.groupId);
    if (lastSentDate === todayKey) {
      return false;
    }

    return isScheduledMinute(now, parseScheduleMinute(groupConfig.holidayCountdownTime));
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    await this.store.markSent(groupId, toLocalDateKey(now));
  }

  async buildCountdownMessage(now = new Date()): Promise<string> {
    const header = buildBroadcastHeader(now);
    const quip = await this.aiService.generateBroadcastQuip("holiday_morning");
    const countdownLines = buildHolidayCountdownLines(now);

    return [
      header,
      `上班了，该摸鱼了，${quip}`,
      ...countdownLines,
    ].join("\n");
  }
}

function getUpcomingHolidays(now: Date, limit: number): HolidayDefinition[] {
  const todayKey = toLocalDateKey(now);

  return HOLIDAY_DEFINITIONS
    .filter((holiday) => holiday.endDate >= todayKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.name.localeCompare(right.name, "zh-Hans-CN"))
    .slice(0, limit);
}

function buildHolidayCountdownLines(now: Date): string[] {
  const today = startOfDay(now);
  const lines = [formatDistanceLine("周六", getNextSaturday(now), today)];
  const holidays = getUpcomingHolidays(now, 5);

  for (const holiday of holidays) {
    lines.push(
      formatDistanceLine(holiday.name, startOfDay(new Date(`${holiday.startDate}T00:00:00`)), today),
    );
  }

  return lines;
}

function parseScheduleMinute(value: string | undefined): number {
  const normalized = (value ?? "09:00").trim();
  const matched = normalized.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!matched) {
    return 9 * 60;
  }

  return Number(matched[1]) * 60 + Number(matched[2]);
}

function isScheduledMinute(now: Date, scheduleMinute: number): boolean {
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  return currentMinute === scheduleMinute;
}

function toLocalDateKey(value: Date): string {
  return [
    value.getFullYear(),
    `${value.getMonth() + 1}`.padStart(2, "0"),
    `${value.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function formatClockTime(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildBroadcastHeader(now: Date): string {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()]!;
  return `${now.getFullYear()}年${`${now.getMonth() + 1}`.padStart(2, "0")}月${`${now.getDate()}`.padStart(2, "0")}日 ${formatClockTime(now)} 星期${weekday} ${resolveTimePeriod(now)}好，摸鱼人`;
}

function resolveTimePeriod(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) {
    return "早上";
  }
  if (hour < 14) {
    return "中午";
  }
  if (hour < 18) {
    return "下午";
  }
  return "晚上";
}

function formatDistanceLine(label: string, targetDate: Date, today: Date): string {
  const diffDays = Math.max(
    0,
    Math.round((targetDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
  );
  return `距『${label}』还有${diffDays}天`;
}

function getNextSaturday(now: Date): Date {
  const today = startOfDay(now);
  const day = today.getDay();
  const daysUntilSaturday = ((6 - day + 7) % 7) || 7;
  return new Date(today.getTime() + daysUntilSaturday * 24 * 60 * 60 * 1000);
}

function isLikelyWorkday(now: Date): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return false;
  }

  const todayKey = toLocalDateKey(now);
  return !HOLIDAY_DEFINITIONS.some(
    (holiday) => todayKey >= holiday.startDate && todayKey <= holiday.endDate,
  );
}
