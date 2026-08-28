import { stat } from "node:fs/promises";

import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export interface DailyReportMessageRecord {
  groupId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

/** Rendered reports are durable results; their raw message inputs are not. */
export interface DailyReportOutputRecord {
  groupId: string;
  dayKey: string;
  renderedText: string;
  sentAt: string;
}

interface DailyReportStoreFile {
  days: Record<string, Record<string, DailyReportMessageRecord[]>>;
  lastSentDateByGroup: Record<string, string>;
  reportOutputsByGroup: Record<string, Record<string, DailyReportOutputRecord>>;
}

const MAX_STORED_DAYS = 7;

export class DailyReportStore {
  private cachedData?: DailyReportStoreFile;
  private cachedVersion?: string;

  constructor(
    private readonly filePath: string,
    private readonly v3State?: V3StateRepository,
  ) {}

  async appendMessage(record: DailyReportMessageRecord): Promise<void> {
    const dayKey = toLocalDateKey(record.timestamp);
    const nextRecord: DailyReportMessageRecord = {
      ...record,
      text: record.text.trim().slice(0, 300),
      userName: record.userName.trim().slice(0, 60) || record.userId,
    };
    if (this.v3State) {
      this.v3State.appendDailyReportMessage({ ...nextRecord, dayKey });
      return;
    }
    const data = await this.readData();

    if (!data.days[dayKey]) {
      data.days[dayKey] = {};
    }
    if (!data.days[dayKey]![record.groupId]) {
      data.days[dayKey]![record.groupId] = [];
    }

    data.days[dayKey]![record.groupId]!.push(nextRecord);
    pruneStoreDays(data);
    await this.writeData(data);
  }

  async getMessages(groupId: string, dayKey: string): Promise<DailyReportMessageRecord[]> {
    if (this.v3State) {
      return this.v3State.getDailyReportMessages(groupId, dayKey).map(({ dayKey: _dayKey, ...record }) => record);
    }
    const data = await this.readData();
    return data.days[dayKey]?.[groupId] ?? [];
  }

  async getLastSentDate(groupId: string): Promise<string | undefined> {
    if (this.v3State) return this.v3State.getDailyReportLastSent(groupId);
    const data = await this.readData();
    return data.lastSentDateByGroup[groupId];
  }

  async getReportOutput(groupId: string, dayKey: string): Promise<DailyReportOutputRecord | undefined> {
    if (this.v3State) {
      const output = this.v3State.getDailyReportOutput(groupId, dayKey);
      return output ? { ...output } : undefined;
    }
    const data = await this.readData();
    const output = data.reportOutputsByGroup[groupId]?.[dayKey];
    return output ? { ...output } : undefined;
  }

  async saveReportOutput(record: DailyReportOutputRecord): Promise<void> {
    const output = normalizeOutputRecord(record);
    if (this.v3State) {
      this.v3State.saveDailyReportOutput(output);
      return;
    }
    const data = await this.readData();
    data.reportOutputsByGroup[output.groupId] ??= {};
    data.reportOutputsByGroup[output.groupId]![output.dayKey] = output;
    await this.writeData(data);
  }

  async markSent(
    groupId: string,
    dayKey: string,
    renderedText?: string,
    sentAt = new Date(),
  ): Promise<void> {
    if (this.v3State) {
      this.v3State.markDailyReportSent(groupId, dayKey, sentAt.getTime(), renderedText);
      return;
    }
    const data = await this.readData();
    data.lastSentDateByGroup[groupId] = dayKey;
    if (renderedText !== undefined) {
      const output = normalizeOutputRecord({
        groupId,
        dayKey,
        renderedText,
        sentAt: sentAt.toISOString(),
      });
      data.reportOutputsByGroup[groupId] ??= {};
      data.reportOutputsByGroup[groupId]![dayKey] = output;
    }
    pruneStoreDays(data);
    await this.writeData(data);
  }

  async clearAll(): Promise<void> {
    if (this.v3State) {
      this.v3State.clearDailyReportMessages();
      return;
    }
    const data = await this.readData();
    data.days = {};
    await this.writeData(data);
  }

  private async readData(): Promise<DailyReportStoreFile> {
    const version = await fileVersion(this.filePath);
    if (this.cachedData && this.cachedVersion === version) {
      return this.cachedData;
    }

    try {
      const data = await readJsonFile<DailyReportStoreFile>(this.filePath);
      this.cachedData = {
        days: data.days ?? {},
        lastSentDateByGroup: data.lastSentDateByGroup ?? {},
        reportOutputsByGroup: data.reportOutputsByGroup ?? {},
      };
      this.cachedVersion = version;
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = {
          days: {},
          lastSentDateByGroup: {},
          reportOutputsByGroup: {},
        };
        this.cachedVersion = "missing";
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: DailyReportStoreFile): Promise<void> {
    await writeJsonFileAtomic(this.filePath, data);
    this.cachedData = data;
    this.cachedVersion = await fileVersion(this.filePath);
  }
}

async function fileVersion(filePath: string): Promise<string> {
  try {
    const metadata = await stat(filePath);
    return `${metadata.mtimeMs}:${metadata.size}`;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") return "missing";
    throw error;
  }
}

function pruneStoreDays(data: DailyReportStoreFile): void {
  const dayKeys = Object.keys(data.days).sort();
  const removable = dayKeys.slice(0, Math.max(0, dayKeys.length - MAX_STORED_DAYS));

  for (const dayKey of removable) {
    delete data.days[dayKey];
  }
}

function toLocalDateKey(value: string): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function normalizeOutputRecord(record: DailyReportOutputRecord): DailyReportOutputRecord {
  if (!record.renderedText.trim()) {
    throw new Error("daily_report_output_empty");
  }
  if (!record.groupId.trim() || !record.dayKey.trim()) {
    throw new Error("daily_report_output_invalid_key");
  }
  return {
    groupId: record.groupId,
    dayKey: record.dayKey,
    renderedText: record.renderedText,
    sentAt: new Date(record.sentAt).toISOString(),
  };
}
