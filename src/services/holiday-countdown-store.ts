import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

interface HolidayCountdownStoreFile {
  lastSentDateByGroup: Record<string, string>;
}

export class HolidayCountdownStore {
  private cachedData?: HolidayCountdownStoreFile;

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
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      const data = await readJsonFile<HolidayCountdownStoreFile>(this.filePath);
      this.cachedData = {
        lastSentDateByGroup: data.lastSentDateByGroup ?? {},
      };
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = {
          lastSentDateByGroup: {},
        };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: HolidayCountdownStoreFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}
