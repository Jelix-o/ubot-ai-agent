import type { ConversationTurn, ConversationsFile } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

export class ConversationStore {
  private cachedData?: ConversationsFile;

  constructor(private readonly filePath: string) {}

  async getTurns(groupId: string, userId: string): Promise<ConversationTurn[]> {
    const data = await this.readData();
    return data.conversations[toConversationKey(groupId, userId)] ?? [];
  }

  async appendTurn(
    groupId: string,
    userId: string,
    turn: ConversationTurn,
    maxTurns: number,
  ): Promise<void> {
    const data = await this.readData();
    const key = toConversationKey(groupId, userId);
    const turns = data.conversations[key] ?? [];
    const nextTurns = [...turns, turn].slice(-maxTurns);
    data.conversations[key] = nextTurns;
    await this.writeData(data);
  }

  async appendDialogue(
    groupId: string,
    userId: string,
    turns: ConversationTurn[],
    maxTurns: number,
  ): Promise<void> {
    const data = await this.readData();
    const key = toConversationKey(groupId, userId);
    const existingTurns = data.conversations[key] ?? [];
    data.conversations[key] = [...existingTurns, ...turns].slice(-maxTurns);
    await this.writeData(data);
  }

  async clearUser(groupId: string, userId: string): Promise<void> {
    const data = await this.readData();
    delete data.conversations[toConversationKey(groupId, userId)];
    await this.writeData(data);
  }

  async clearGroup(groupId: string): Promise<void> {
    const data = await this.readData();
    const keyPrefix = `${groupId}:`;
    for (const key of Object.keys(data.conversations)) {
      if (key === groupId || key.startsWith(keyPrefix)) {
        delete data.conversations[key];
      }
    }
    await this.writeData(data);
  }

  private async readData(): Promise<ConversationsFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeConversationsFile(await readJsonFile<ConversationsFile>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { conversations: {} };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: ConversationsFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}

function normalizeConversationsFile(data: Partial<ConversationsFile>): ConversationsFile {
  if (!data || typeof data.conversations !== "object" || data.conversations === null) {
    return { conversations: {} };
  }

  const conversations: ConversationsFile["conversations"] = {};
  for (const [key, turns] of Object.entries(data.conversations)) {
    if (Array.isArray(turns)) {
      conversations[key] = turns;
    }
  }

  return { conversations };
}

function toConversationKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}
