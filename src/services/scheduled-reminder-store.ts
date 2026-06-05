import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScheduledReminderTask, ScheduledRemindersFile } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";
import { isScheduleDateRuleMatched } from "../utils/schedule-date-rule.js";

export class ScheduledReminderStore {
  private cachedData?: ScheduledRemindersFile;

  constructor(private readonly filePath: string) {}

  async addTask(args: {
    groupId: string;
    creatorUserId: string;
    intervalMinutes: number;
    topic: string;
    executionStartTime?: string;
    executionEndTime?: string;
    executionIntervalMinutes?: number;
    scheduledTime?: string;
    advanceMinutes?: number;
    dateRule?: ScheduledReminderTask["dateRule"];
    weekdays?: number[];
    enabled?: boolean;
    now?: Date;
  }): Promise<ScheduledReminderTask> {
    const now = args.now ?? new Date();
    const data = await this.readData();
    const schedule = normalizeReminderSchedule({
      intervalMinutes: args.intervalMinutes,
      executionStartTime: args.executionStartTime,
      executionEndTime: args.executionEndTime,
      executionIntervalMinutes: args.executionIntervalMinutes,
      scheduledTime: args.scheduledTime,
      advanceMinutes: args.advanceMinutes,
    });
    const task: ScheduledReminderTask = {
      id: createTaskId(now, data.tasks),
      groupId: args.groupId,
      creatorUserId: args.creatorUserId,
      intervalMinutes: schedule.intervalMinutes,
      topic: normalizeTopic(args.topic),
      ...(schedule.executionStartTime !== undefined ? { executionStartTime: schedule.executionStartTime } : {}),
      ...(schedule.executionEndTime !== undefined ? { executionEndTime: schedule.executionEndTime } : {}),
      ...(schedule.executionIntervalMinutes !== undefined ? { executionIntervalMinutes: schedule.executionIntervalMinutes } : {}),
      ...(schedule.scheduledTime !== undefined ? { scheduledTime: schedule.scheduledTime } : {}),
      ...(schedule.advanceMinutes !== undefined ? { advanceMinutes: schedule.advanceMinutes } : {}),
      dateRule: normalizeDateRule(args.dateRule),
      weekdays: normalizeWeekdays(args.weekdays),
      createdAt: now.toISOString(),
      nextRunAt: calculateNextRunAt({
        now,
        intervalMinutes: schedule.intervalMinutes,
        executionStartTime: schedule.executionStartTime,
        executionEndTime: schedule.executionEndTime,
        executionIntervalMinutes: schedule.executionIntervalMinutes,
        scheduledTime: schedule.scheduledTime,
        advanceMinutes: schedule.advanceMinutes,
        dateRule: args.dateRule,
        weekdays: args.weekdays,
      }).toISOString(),
      enabled: args.enabled !== false,
      recentMessages: [],
    };

    data.tasks[task.id] = task;
    await this.writeData(data);
    return task;
  }

  async listGroupTasks(groupId: string, options: { includeDisabled?: boolean } = {}): Promise<ScheduledReminderTask[]> {
    const data = await this.readData();
    return Object.values(data.tasks)
      .filter((task) => task.groupId === groupId && (options.includeDisabled || task.enabled))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
      nextRunAt?: string;
      enabled?: boolean;
      dateRule?: ScheduledReminderTask["dateRule"];
      weekdays?: number[];
    },
  ): Promise<ScheduledReminderTask | undefined> {
    const data = await this.readData();
    const task = data.tasks[taskId];
    if (!task) {
      return undefined;
    }

    const scheduleChanged = updates.intervalMinutes !== undefined
      || updates.executionStartTime !== undefined
      || updates.executionEndTime !== undefined
      || updates.executionIntervalMinutes !== undefined
      || updates.scheduledTime !== undefined
      || updates.advanceMinutes !== undefined
      || updates.dateRule !== undefined
      || updates.weekdays !== undefined;
    const schedule = normalizeReminderSchedule({
      intervalMinutes: updates.intervalMinutes ?? task.intervalMinutes,
      executionStartTime: updates.executionStartTime ?? task.executionStartTime,
      executionEndTime: updates.executionEndTime ?? task.executionEndTime,
      executionIntervalMinutes: updates.executionIntervalMinutes ?? task.executionIntervalMinutes,
      scheduledTime: updates.scheduledTime ?? task.scheduledTime,
      advanceMinutes: updates.advanceMinutes ?? task.advanceMinutes,
    });
    const updated: ScheduledReminderTask = {
      ...task,
      intervalMinutes: schedule.intervalMinutes,
      ...(schedule.executionStartTime !== undefined ? { executionStartTime: schedule.executionStartTime } : {}),
      ...(schedule.executionEndTime !== undefined ? { executionEndTime: schedule.executionEndTime } : {}),
      ...(schedule.executionIntervalMinutes !== undefined ? { executionIntervalMinutes: schedule.executionIntervalMinutes } : {}),
      ...(updates.topic !== undefined && { topic: normalizeTopic(updates.topic) }),
      ...(schedule.scheduledTime !== undefined ? { scheduledTime: schedule.scheduledTime } : {}),
      ...(schedule.advanceMinutes !== undefined ? { advanceMinutes: schedule.advanceMinutes } : {}),
      ...(updates.nextRunAt !== undefined && { nextRunAt: updates.nextRunAt }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
      ...(updates.dateRule !== undefined && { dateRule: normalizeDateRule(updates.dateRule) }),
      ...(updates.weekdays !== undefined && { weekdays: normalizeWeekdays(updates.weekdays) }),
    };
    if (scheduleChanged && updates.nextRunAt === undefined) {
      updated.nextRunAt = calculateNextRunAt({
          now: new Date(),
          intervalMinutes: schedule.intervalMinutes,
          executionStartTime: schedule.executionStartTime,
          executionEndTime: schedule.executionEndTime,
          executionIntervalMinutes: schedule.executionIntervalMinutes,
          scheduledTime: schedule.scheduledTime,
          advanceMinutes: schedule.advanceMinutes,
          dateRule: updated.dateRule,
          weekdays: updated.weekdays,
        }).toISOString();
    }
    data.tasks[taskId] = updated;
    await this.writeData(data);
    return updated;
  }

  async removeGroupTask(groupId: string, taskId: string): Promise<boolean> {
    const data = await this.readData();
    const task = data.tasks[taskId];
    if (!task || task.groupId !== groupId) {
      return false;
    }

    delete data.tasks[taskId];
    await this.writeData(data);
    return true;
  }

  async getDueTasks(now = new Date()): Promise<ScheduledReminderTask[]> {
    const data = await this.readData();
    const nowMs = now.getTime();
    return Object.values(data.tasks)
      .filter((task) => task.enabled && new Date(task.nextRunAt).getTime() <= nowMs)
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
  }

  async markSent(taskId: string, message: string, now = new Date()): Promise<ScheduledReminderTask | undefined> {
    const data = await this.readData();
    const task = data.tasks[taskId];
    if (!task) {
      return undefined;
    }

    const nextRunAt = task.scheduledTime
      ? calculateNextRunAt({
          now: new Date(now.getTime() + 60 * 1000),
          intervalMinutes: task.intervalMinutes,
          executionStartTime: task.executionStartTime,
          executionEndTime: task.executionEndTime,
          executionIntervalMinutes: task.executionIntervalMinutes,
          scheduledTime: task.scheduledTime,
          advanceMinutes: task.advanceMinutes,
          dateRule: task.dateRule,
          weekdays: task.weekdays,
        }).toISOString()
      : !task.executionStartTime
        ? calculateIntervalNextRunAt(task, now).toISOString()
      : calculateNextRunAt({
          now: new Date(now.getTime() + 60 * 1000),
          intervalMinutes: task.intervalMinutes,
          executionStartTime: task.executionStartTime,
          executionEndTime: task.executionEndTime,
          executionIntervalMinutes: task.executionIntervalMinutes,
          dateRule: task.dateRule,
          weekdays: task.weekdays,
        }).toISOString();

    const updated: ScheduledReminderTask = {
      ...task,
      nextRunAt,
      recentMessages: [...(task.recentMessages ?? []), message].slice(-5),
    };
    data.tasks[taskId] = updated;
    await this.writeData(data);
    return updated;
  }

  private async readData(): Promise<ScheduledRemindersFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeScheduledRemindersFile(
        await readJsonFile<ScheduledRemindersFile>(this.filePath),
      );
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { tasks: {} };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: ScheduledRemindersFile): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeScheduledRemindersFile(data: Partial<ScheduledRemindersFile>): ScheduledRemindersFile {
  if (!data || typeof data.tasks !== "object" || data.tasks === null) {
    return { tasks: {} };
  }

  const tasks: ScheduledRemindersFile["tasks"] = {};
  for (const [taskId, task] of Object.entries(data.tasks)) {
    if (
      task &&
      typeof task === "object" &&
      typeof task.groupId === "string" &&
      typeof task.creatorUserId === "string" &&
      Number.isFinite(task.intervalMinutes) &&
      typeof task.topic === "string" &&
      typeof task.createdAt === "string" &&
      typeof task.nextRunAt === "string"
    ) {
        const schedule = normalizeReminderSchedule({
          intervalMinutes: task.intervalMinutes,
          executionStartTime: task.executionStartTime,
          executionEndTime: task.executionEndTime,
          executionIntervalMinutes: task.executionIntervalMinutes,
          scheduledTime: task.scheduledTime,
          advanceMinutes: task.advanceMinutes,
        });
        tasks[taskId] = {
          ...task,
          id: task.id || taskId,
          intervalMinutes: schedule.intervalMinutes,
          ...(schedule.executionStartTime !== undefined ? { executionStartTime: schedule.executionStartTime } : {}),
          ...(schedule.executionEndTime !== undefined ? { executionEndTime: schedule.executionEndTime } : {}),
          ...(schedule.executionIntervalMinutes !== undefined ? { executionIntervalMinutes: schedule.executionIntervalMinutes } : {}),
          ...(schedule.scheduledTime ? { scheduledTime: schedule.scheduledTime } : {}),
          ...(schedule.advanceMinutes !== undefined ? { advanceMinutes: schedule.advanceMinutes } : {}),
          dateRule: normalizeDateRule(task.dateRule),
          weekdays: normalizeWeekdays(task.weekdays),
          enabled: task.enabled !== false,
          recentMessages: Array.isArray(task.recentMessages) ? task.recentMessages : [],
        };
    }
  }

  return { tasks };
}

function createTaskId(now: Date, tasks: Record<string, ScheduledReminderTask>): string {
  const base = `rem-${toCompactTimestamp(now)}`;
  let id = base;
  let index = 1;
  while (tasks[id]) {
    index += 1;
    id = `${base}-${index}`;
  }
  return id;
}

function toCompactTimestamp(now: Date): string {
  return [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
    `${now.getHours()}`.padStart(2, "0"),
    `${now.getMinutes()}`.padStart(2, "0"),
    `${now.getSeconds()}`.padStart(2, "0"),
  ].join("");
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, " ").trim().slice(0, 80);
}

function normalizeDateRule(value: unknown): NonNullable<ScheduledReminderTask["dateRule"]> {
  return value === "workday" || value === "holiday" || value === "custom" ? value : "all";
}

function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeAdvanceMinutes(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return Math.min(parsed, 24 * 60);
}

function normalizeExecutionIntervalMinutes(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return normalizeIntervalMinutes(fallback);
  return normalizeIntervalMinutes(parsed);
}

function normalizeIntervalMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return 60;
  return Math.max(1, Math.min(24 * 60, parsed));
}

function normalizeReminderSchedule(args: {
  intervalMinutes: unknown;
  executionStartTime?: unknown;
  executionEndTime?: unknown;
  executionIntervalMinutes?: unknown;
  scheduledTime?: unknown;
  advanceMinutes?: unknown;
}): {
  intervalMinutes: number;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  advanceMinutes?: number;
} {
  const scheduledTime = normalizeTime(args.scheduledTime);
  const advanceMinutes = normalizeAdvanceMinutes(args.advanceMinutes);
  const intervalMinutes = normalizeIntervalMinutes(args.intervalMinutes);
  const hasWindow = args.executionStartTime !== undefined ||
    args.executionEndTime !== undefined ||
    args.executionIntervalMinutes !== undefined ||
    scheduledTime !== undefined;
  if (!hasWindow) {
    return { intervalMinutes };
  }
  const legacyStart = scheduledTime
    ? shiftTimeByMinutes(scheduledTime, -(advanceMinutes ?? 0))
    : undefined;
  const executionStartTime = normalizeTime(args.executionStartTime) ?? legacyStart ?? "09:00";
  const executionEndTime = normalizeTime(args.executionEndTime) ?? scheduledTime ?? executionStartTime;
  const executionIntervalMinutes = normalizeExecutionIntervalMinutes(args.executionIntervalMinutes, intervalMinutes);
  return {
    intervalMinutes: executionIntervalMinutes,
    executionStartTime,
    executionEndTime,
    executionIntervalMinutes,
    ...(scheduledTime ? { scheduledTime } : {}),
    ...(advanceMinutes !== undefined ? { advanceMinutes } : {}),
  };
}

function normalizeWeekdays(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)))
    .sort((left, right) => left - right);
}

function calculateNextRunAt(args: {
  now: Date;
  intervalMinutes: number;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  advanceMinutes?: number;
  dateRule?: ScheduledReminderTask["dateRule"];
  weekdays?: number[];
}): Date {
  const schedule = normalizeReminderSchedule(args);
  if (!schedule.executionStartTime) {
    return new Date(args.now.getTime() + normalizeIntervalMinutes(args.intervalMinutes) * 60 * 1000);
  }
  const intervalMinutes = schedule.executionIntervalMinutes ?? normalizeIntervalMinutes(args.intervalMinutes);
  const startMinutes = timeToMinutes(schedule.executionStartTime);
  const endMinutes = Math.max(startMinutes, timeToMinutes(schedule.executionEndTime ?? schedule.executionStartTime));

  for (let offset = 0; offset < 370; offset += 1) {
    const day = new Date(args.now);
    day.setDate(day.getDate() + offset);
    day.setHours(0, 0, 0, 0);
    if (!isDateRuleMatched(args.dateRule, args.weekdays, day)) {
      continue;
    }

    for (let slot = startMinutes; slot <= endMinutes; slot += intervalMinutes) {
      const candidate = new Date(day);
      candidate.setHours(Math.floor(slot / 60), slot % 60, 0, 0);
      if (candidate > args.now) {
        return candidate;
      }
    }
  }

  return new Date(args.now.getTime() + normalizeIntervalMinutes(args.intervalMinutes) * 60 * 1000);
}

function calculateIntervalNextRunAt(task: ScheduledReminderTask, now: Date): Date {
  const intervalMs = task.intervalMinutes * 60 * 1000;
  const previousNextRunMs = new Date(task.nextRunAt).getTime();
  const baseMs = Number.isFinite(previousNextRunMs) && previousNextRunMs > now.getTime()
    ? previousNextRunMs
    : now.getTime();
  return new Date(baseMs + intervalMs);
}

function isDateRuleMatched(ruleValue: ScheduledReminderTask["dateRule"], weekdays: number[] | undefined, date: Date): boolean {
  const rule = normalizeDateRule(ruleValue);
  return isScheduleDateRuleMatched(rule, normalizeWeekdays(weekdays), date);
}

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function shiftTimeByMinutes(value: string, minutes: number): string {
  const total = Math.max(0, Math.min(24 * 60 - 1, timeToMinutes(value) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
