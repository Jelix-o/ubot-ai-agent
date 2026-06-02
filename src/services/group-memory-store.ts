import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { GroupMemory, GroupMemoryType } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

interface GroupMemoryFile {
  memories: GroupMemory[];
}

export type GroupMemoryInput = {
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence?: number;
  source?: string;
  enabled?: boolean;
};

export class GroupMemoryStore {
  private cachedData?: GroupMemoryFile;

  constructor(private readonly filePath: string) {}

  async list(groupId?: string): Promise<GroupMemory[]> {
    const data = await this.readData();
    const memories = groupId ? data.memories.filter((memory) => memory.groupId === groupId) : data.memories;
    return memories.map(cloneMemory);
  }

  async listEnabled(groupId: string, limit = 20): Promise<GroupMemory[]> {
    const data = await this.readData();
    return data.memories
      .filter((memory) => memory.groupId === groupId && memory.enabled)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(cloneMemory);
  }

  async create(input: GroupMemoryInput): Promise<GroupMemory> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const memory = normalizeMemory({
      id: randomUUID(),
      groupId: input.groupId,
      type: input.type,
      ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
      title: input.title,
      content: input.content,
      confidence: input.confidence ?? 0.7,
      source: input.source ?? "admin",
      createdAt: now,
      updatedAt: now,
      enabled: input.enabled ?? true,
    });

    data.memories.push(memory);
    await this.writeData(data);
    return cloneMemory(memory);
  }

  async update(id: string, patch: Partial<GroupMemoryInput> & { enabled?: boolean }): Promise<GroupMemory | undefined> {
    const data = await this.readData();
    const index = data.memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return undefined;
    }

    const current = data.memories[index]!;
    const hasSubjectUserId = Object.prototype.hasOwnProperty.call(patch, "subjectUserId");
    const updated = normalizeMemory({
      ...current,
      ...patch,
      subjectUserId: hasSubjectUserId ? patch.subjectUserId : current.subjectUserId,
      updatedAt: new Date().toISOString(),
    });
    data.memories[index] = updated;
    await this.writeData(data);
    return cloneMemory(updated);
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.readData();
    const next = data.memories.filter((memory) => memory.id !== id);
    if (next.length === data.memories.length) {
      return false;
    }

    data.memories = next;
    await this.writeData(data);
    return true;
  }

  private async readData(): Promise<GroupMemoryFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeMemoryFile(await readJsonFile<GroupMemoryFile>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { memories: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: GroupMemoryFile): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeMemoryFile(data: Partial<GroupMemoryFile>): GroupMemoryFile {
  return {
    memories: Array.isArray(data.memories)
      ? data.memories.map(normalizeMemory).filter((memory): memory is GroupMemory => Boolean(memory))
      : [],
  };
}

function normalizeMemory(value: Partial<GroupMemory>): GroupMemory {
  const type = value.type === "member_profile" ? "member_profile" : "group_fact";
  const now = new Date().toISOString();
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0.7;

  return {
    id: String(value.id || randomUUID()),
    groupId: String(value.groupId || "").trim(),
    type,
    ...(value.subjectUserId && /^\d+$/.test(String(value.subjectUserId).trim())
      ? { subjectUserId: String(value.subjectUserId).trim() }
      : {}),
    title: String(value.title || "").trim().slice(0, 80),
    content: String(value.content || "").trim().slice(0, 600),
    confidence,
    source: String(value.source || "admin").trim().slice(0, 80),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    enabled: value.enabled !== false,
  };
}

function cloneMemory(memory: GroupMemory): GroupMemory {
  return { ...memory };
}
