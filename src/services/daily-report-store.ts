import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

export interface DailyReportMessageRecord {
  groupId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

interface DailyReportStoreFile {
  days: Record<string, Record<string, DailyReportMessageRecord[]>>;
  lastSentDateByGroup: Record<string, string>;
}

const MAX_STORED_DAYS = 7;

export class DailyReportStore {
  private cachedData?: DailyReportStoreFile;

  constructor(private readonly filePath: string) {}

  async appendMessage(record: DailyReportMessageRecord): Promise<void> {
    const data = await this.readData();
    const dayKey = toLocalDateKey(record.timestamp);
    const nextRecord: DailyReportMessageRecord = {
      ...record,
      text: record.text.trim().slice(0, 300),
      userName: record.userName.trim().slice(0, 60) || record.userId,
    };

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
    const data = await this.readData();
    return data.days[dayKey]?.[groupId] ?? [];
  }

  async getLastSentDate(groupId: string): Promise<string | undefined> {
    const data = await this.readData();
    return data.lastSentDateByGroup[groupId];
  }

  async markSent(groupId: string, dayKey: string): Promise<void> {
    const data = await this.readData();
    data.lastSentDateByGroup[groupId] = dayKey;
    pruneStoreDays(data);
    await this.writeData(data);
  }

  private async readData(): Promise<DailyReportStoreFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      const data = await readJsonFile<DailyReportStoreFile>(this.filePath);
      this.cachedData = {
        days: data.days ?? {},
        lastSentDateByGroup: data.lastSentDateByGroup ?? {},
      };
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = {
          days: {},
          lastSentDateByGroup: {},
        };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: DailyReportStoreFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
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
