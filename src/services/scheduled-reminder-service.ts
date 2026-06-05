import type { ScheduledReminderTask } from "../types.js";
import { isSmartWorkday } from "../utils/china-workday-calendar.js";
import { isScheduleDateRuleMatched } from "../utils/schedule-date-rule.js";
import type { AiService } from "./ai-service.js";
import { ScheduledReminderStore } from "./scheduled-reminder-store.js";

type ScheduledReminderAiService = Partial<Pick<AiService, "generateScheduledReminderText">>;

export interface ReminderCreateRequest {
  intervalMinutes: number;
  topic: string;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  advanceMinutes?: number;
  dateRule?: ScheduledReminderTask["dateRule"];
  weekdays?: number[];
}

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;

export class ScheduledReminderService {
  constructor(
    private readonly store: ScheduledReminderStore,
    private readonly aiService: ScheduledReminderAiService,
  ) {}

  parseCreateRequest(input: string): ReminderCreateRequest | undefined {
    const text = normalizeInput(input);
    if (!/(?:设置|添加|创建|新建).{0,8}定时任务/.test(text) && !/^定时任务\s*(?:添加|设置|创建|新建)/.test(text)) {
      return undefined;
    }

    const intervalMinutes = parseIntervalMinutes(text);
    if (!intervalMinutes) {
      return undefined;
    }

    const topic = extractTopic(text);
    if (!topic) {
      return undefined;
    }

    return {
      intervalMinutes,
      topic,
    };
  }

  parseModifyRequest(input: string): { taskId: string; request: ReminderCreateRequest } | undefined {
    const text = normalizeInput(input);
    const match = text.match(/^(?:修改\s+)?(\S+)\s+(.+)$/);
    if (!match) {
      return undefined;
    }

    const taskId = match[1]!.trim();
    const rest = match[2]!.trim();

    const intervalMinutes = parseIntervalMinutes(rest);
    if (!intervalMinutes) {
      return undefined;
    }

    const topic = extractTopic(rest);
    if (!topic) {
      return undefined;
    }

    return { taskId, request: { intervalMinutes, topic } };
  }

  async createTask(args: {
    groupId: string;
    creatorUserId: string;
    request: ReminderCreateRequest;
    enabled?: boolean;
    now?: Date;
  }): Promise<ScheduledReminderTask> {
    return this.store.addTask({
      groupId: args.groupId,
      creatorUserId: args.creatorUserId,
      intervalMinutes: args.request.intervalMinutes,
      topic: args.request.topic,
      executionStartTime: args.request.executionStartTime,
      executionEndTime: args.request.executionEndTime,
      executionIntervalMinutes: args.request.executionIntervalMinutes,
      scheduledTime: args.request.scheduledTime,
      advanceMinutes: args.request.advanceMinutes,
      dateRule: args.request.dateRule,
      weekdays: args.request.weekdays,
      enabled: args.enabled,
      now: args.now,
    });
  }

  async listGroupTasks(groupId: string, options: { includeDisabled?: boolean } = {}): Promise<ScheduledReminderTask[]> {
    return this.store.listGroupTasks(groupId, options);
  }

  async removeGroupTask(groupId: string, taskId: string): Promise<boolean> {
    return this.store.removeGroupTask(groupId, taskId);
  }

  async getDueTasks(now = new Date()): Promise<ScheduledReminderTask[]> {
    return (await this.store.getDueTasks(now)).filter((task) => task.executionStartTime || task.scheduledTime || isDateRuleMatched(task, now));
  }

  async buildReminderMessage(task: ScheduledReminderTask): Promise<string> {
    const prefix = buildReminderPrefix(task.topic);
    const recentBodies = (task.recentMessages ?? [])
      .map((message) => stripReminderPrefix(message, task.topic))
      .filter(Boolean);
    const message = await this.aiService.generateScheduledReminderText?.({
      topic: task.topic,
      groupId: task.groupId,
      intervalMinutes: task.intervalMinutes,
      recentMessages: recentBodies,
    });

    const body = normalizeReminderMessage(message, task.topic) || buildFallbackReminderBody(task);
    return normalizeReminderMessageWithPrefix(`${prefix}${body}`, task.topic);
  }

  async markSent(taskId: string, message: string, now = new Date()): Promise<void> {
    const task = await this.store.markSent(taskId, message, now);
    if (task && !task.executionStartTime && !task.scheduledTime) {
      const nextRun = new Date(task.nextRunAt);
      const adjusted = adjustToWorkHours(nextRun);
      if (adjusted.getTime() !== nextRun.getTime()) {
        await this.store.updateTask(taskId, { nextRunAt: adjusted.toISOString() });
      }
    }
  }

  async updateTask(
    taskId: string,
    updates: {
      intervalMinutes?: number;
      topic?: string;
      executionStartTime?: string;
      executionEndTime?: string;
      executionIntervalMinutes?: number;
      scheduledTime?: string;
      advanceMinutes?: number;
      enabled?: boolean;
      dateRule?: ScheduledReminderTask["dateRule"];
      weekdays?: number[];
    },
  ): Promise<ScheduledReminderTask | undefined> {
    const hasRangeScheduleUpdate = updates.executionStartTime !== undefined ||
      updates.executionEndTime !== undefined ||
      updates.executionIntervalMinutes !== undefined ||
      updates.scheduledTime !== undefined ||
      updates.advanceMinutes !== undefined ||
      updates.dateRule !== undefined ||
      updates.weekdays !== undefined;
    const nextRunAt = !hasRangeScheduleUpdate && updates.intervalMinutes
      ? adjustToWorkHours(new Date(Date.now() + updates.intervalMinutes * 60 * 1000)).toISOString()
      : undefined;
    return this.store.updateTask(taskId, { ...updates, nextRunAt });
  }
}

function isDateRuleMatched(task: ScheduledReminderTask, now: Date): boolean {
  return isScheduleDateRuleMatched(task.dateRule, task.weekdays, now);
}

export function formatIntervalLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 小时" : `${hours} 小时`;
  }

  return `${minutes} 分钟`;
}

export function isWithinWorkHours(date: Date): boolean {
  if (!isSmartWorkday(date)) {
    return false;
  }
  const hour = date.getHours();
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

export function adjustToWorkHours(date: Date): Date {
  if (isWithinWorkHours(date)) {
    return date;
  }

  const result = new Date(date);
  result.setHours(WORK_START_HOUR, 0, 0, 0);

  if (result <= date || !isWithinWorkHours(result)) {
    do {
      result.setDate(result.getDate() + 1);
    } while (!isSmartWorkday(result));
    result.setHours(WORK_START_HOUR, 0, 0, 0);
  }

  return result;
}

function normalizeInput(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function parseIntervalMinutes(text: string): number | undefined {
  const normalized = text.replace(/\s+/g, "");
  const halfHourMatched = /半小时|半个小时/.test(normalized);
  if (halfHourMatched) {
    return 30;
  }

  const everyHourMatched = /每小时|每个小时/.test(normalized);
  if (everyHourMatched) {
    return 60;
  }

  const minuteMatch = normalized.match(/(?:每|间隔|每隔)?([一二两三四五六七八九十\d]+)分钟/);
  if (minuteMatch) {
    return clampInterval(parseChineseNumber(minuteMatch[1]));
  }

  const hourMatch = normalized.match(/(?:每|间隔|每隔)?([一二两三四五六七八九十\d]+)(?:个)?小时/);
  if (hourMatch) {
    const hours = parseChineseNumber(hourMatch[1]);
    return clampInterval(hours ? hours * 60 : undefined);
  }

  return undefined;
}

function extractTopic(text: string): string | undefined {
  const normalized = normalizeInput(text);
  const remindMatch = normalized.match(/提醒(?:一下)?(?:群友|大家|所有人|全群|我们|我)?(.+)$/);
  const topic = remindMatch?.[1]?.trim()
    .replace(/^(?:去|要|该|记得|别忘了)\s*/, "")
    .replace(/[。.!！?？]+$/g, "")
    .trim();

  if (topic) {
    return topic.slice(0, 80);
  }

  const quotedMatch = normalized.match(/[“"']([^“”"']{1,80})[”"']/);
  return quotedMatch?.[1]?.trim();
}

function parseChineseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const digitMap: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (value === "十") {
    return 10;
  }

  const tenParts = value.split("十");
  if (tenParts.length === 2) {
    const tens = tenParts[0] ? digitMap[tenParts[0]] : 1;
    const ones = tenParts[1] ? digitMap[tenParts[1]] : 0;
    if (tens !== undefined && ones !== undefined) {
      return tens * 10 + ones;
    }
  }

  return digitMap[value];
}

function clampInterval(minutes: number | undefined): number | undefined {
  if (!minutes || !Number.isFinite(minutes)) {
    return undefined;
  }

  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

function normalizeReminderMessage(message: string | null | undefined, topic: string): string | undefined {
  const text = stripReminderPrefix(message, topic).slice(0, 120);
  return text || undefined;
}

function stripReminderPrefix(message: string | null | undefined, topic: string): string {
  const prefix = buildReminderPrefix(topic);
  let text = message
    ?.replace(/\s+/g, " ")
    .replace(/^["“”'「『]+|["“”'」』]+$/g, "")
    .trim() ?? "";

  while (text.startsWith(prefix)) {
    text = text.slice(prefix.length).trim();
    text = text.replace(/^[:：,，.。;；\s]+/, "").trim();
  }

  return text;
}

function normalizeReminderMessageWithPrefix(message: string, topic: string): string {
  const prefix = buildReminderPrefix(topic);
  const body = stripReminderPrefix(message, topic);
  return `${prefix}${body}`;
}

function buildReminderPrefix(topic: string): string {
  return `【提醒${topic}小助手】`;
}

function buildFallbackReminderBody(task: ScheduledReminderTask): string {
  const variants = [
    `到点了，群友们记得${task.topic}`,
    `提醒一下大家，该${task.topic}了`,
    `别光顾着聊天，大家${task.topic}安排上`,
    `群友们，定时敲一下：记得${task.topic}`,
    `各位，手头方便的话现在${task.topic}`,
    `小提醒来了，大家抽个空${task.topic}`,
    `该给自己续点状态了，大家${task.topic}`,
    `群友们先停一秒，记得${task.topic}`,
    `到提醒时间了，大家别忘了${task.topic}`,
    `顺手提醒一下，能${task.topic}的现在安排一下`,
    `各位别硬扛，先${task.topic}再继续聊`,
    `时间到了，给大家提个醒：${task.topic}`,
  ];
  const index = (task.recentMessages?.length ?? 0) % variants.length;
  return variants[index]!;
}
