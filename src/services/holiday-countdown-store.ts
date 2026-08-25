import { stat } from "node:fs/promises";

import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

interface HolidayCountdownStoreFile {
  lastSentDateByGroup: Record<string, string>;
}

export class HolidayCountdownStore {
  private cachedData?: HolidayCountdownStoreFile;
  private cachedVersion?: string;

  constructor(private readonly filePath: string) {}

  async getLastSentDate(groupId: string): Promise<string | undefined> {
    const data = await this.readData();
    return data.lastSentDateByGroup[groupId];
  }

  async markSent(groupId: string, dayKey: string): Promise<void> {
    const data = await this.readData();
    data.lastSentDateByGroup[groupId] = dayKey;
    await this.writeData(data);
  }

  private async readData(): Promise<HolidayCountdownStoreFile> {
    const version = await fileVersion(this.filePath);
    if (this.cachedData && this.cachedVersion === version) {
      return this.cachedData;
    }

    try {
      const data = await readJsonFile<HolidayCountdownStoreFile>(this.filePath);
      this.cachedData = {
        lastSentDateByGroup: data.lastSentDateByGroup ?? {},
      };
      this.cachedVersion = version;
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = {
          lastSentDateByGroup: {},
        };
        this.cachedVersion = "missing";
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: HolidayCountdownStoreFile): Promise<void> {
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
