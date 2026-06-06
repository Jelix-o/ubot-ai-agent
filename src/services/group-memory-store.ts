import { randomUUID } from "node:crypto";

import type { GroupMemory, GroupMemoryEvidence, GroupMemoryType } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

const EVIDENCE_SUMMARY_LIMIT = 2400;
const MEMORY_CONTENT_LIMIT = 1800;

interface GroupMemoryFile {
  memories: GroupMemory[];
}

export interface GroupMemoryListPageArgs {
  groupId?: string;
  subjectUserId?: string;
  type?: GroupMemoryType;
  enabled?: boolean;
  query?: string;
  excludeProfileRecords?: boolean;
  page: number;
  pageSize: number;
}

export interface GroupMemoryListPageResult {
  items: GroupMemory[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface SubjectCount {
  userId: string;
  count: number;
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
  createdAt?: string;
  evidence?: GroupMemoryEvidence;
};

export class GroupMemoryStore {
  private cachedData?: GroupMemoryFile;

  constructor(private readonly filePath: string) {}

  async list(groupId?: string): Promise<GroupMemory[]> {
    const data = await this.readData();
    const memories = groupId ? data.memories.filter((memory) => memory.groupId === groupId) : data.memories;
    return memories.map(cloneMemory);
  }

  async get(id: string): Promise<GroupMemory | undefined> {
    const data = await this.readData();
    const memory = data.memories.find((item) => item.id === id);
    return memory ? cloneMemory(memory) : undefined;
  }

  async listPage(args: GroupMemoryListPageArgs): Promise<GroupMemoryListPageResult> {
    const data = await this.readData();
    const query = normalizeSearchQuery(args.query);
    const pageSize = Math.max(1, args.pageSize);
    const matched = data.memories
      .filter((memory) => !args.groupId || memory.groupId === args.groupId)
      .filter((memory) => !args.subjectUserId || memory.subjectUserId === args.subjectUserId)
      .filter((memory) => !args.type || memory.type === args.type)
      .filter((memory) => args.enabled === undefined || memory.enabled === args.enabled)
      .filter((memory) => !args.excludeProfileRecords || !isProfileRecordMemory(memory))
      .filter((memory) => !query || memoryMatchesQuery(memory, query))
      .sort(compareMemoriesNewestFirst);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, args.page), totalPages);
    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map(cloneMemory),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  async listEnabled(groupId: string, limit = 20): Promise<GroupMemory[]> {
    const data = await this.readData();
    return data.memories
      .filter((memory) => memory.groupId === groupId && memory.enabled)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(cloneMemory);
  }

  async countBySubject(groupId: string): Promise<SubjectCount[]> {
    const data = await this.readData();
    const counts = new Map<string, number>();
    for (const memory of data.memories) {
      if (memory.groupId !== groupId || !memory.subjectUserId) {
        continue;
      }
      counts.set(memory.subjectUserId, (counts.get(memory.subjectUserId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([userId, count]) => ({ userId, count }));
  }

  async create(input: GroupMemoryInput): Promise<GroupMemory> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const memory = normalizeMemory({
      id: randomUUID(),
      groupId: input.groupId,
      type: input.type,
      ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
      title: input.title,
      content: input.content,
      confidence: input.confidence ?? 0.7,
      source: input.source ?? "admin",
      createdAt,
      updatedAt: createdAt,
      enabled: input.enabled ?? true,
      ...(input.evidence ? { evidence: input.evidence } : {}),
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
    await writeJsonFileAtomic(this.filePath, data);
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
    ...(type === "member_profile" && value.subjectUserId && /^\d+$/.test(String(value.subjectUserId).trim())
      ? { subjectUserId: String(value.subjectUserId).trim() }
      : {}),
    title: String(value.title || "").trim().slice(0, 80),
    content: String(value.content || "").trim().slice(0, MEMORY_CONTENT_LIMIT),
    confidence,
    source: String(value.source || "admin").trim().slice(0, 80),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    enabled: value.enabled !== false,
    ...(normalizeEvidence(value.evidence) ? { evidence: normalizeEvidence(value.evidence) } : {}),
  };
}

function isProfileRecordMemory(memory: GroupMemory): boolean {
  return memory.source.startsWith("daily_profile_review:") ||
    memory.source.startsWith("profile_record:") ||
    memory.title.includes("画像总结") ||
    memory.title.includes("昨日画像") ||
    memory.title.includes("群聊画像");
}

function compareMemoriesNewestFirst(left: GroupMemory, right: GroupMemory): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id)
  );
}

function cloneMemory(memory: GroupMemory): GroupMemory {
  return {
    ...memory,
    ...(memory.evidence
      ? {
          evidence: {
            ...memory.evidence,
            speakers: memory.evidence.speakers.map((speaker) => ({ ...speaker })),
          },
        }
      : {}),
  };
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function memoryMatchesQuery(memory: GroupMemory, query: string): boolean {
  return [
    memory.id,
    memory.groupId,
    memory.type,
    memory.subjectUserId,
    memory.title,
    memory.content,
    memory.source,
    memory.evidence?.summary,
    ...(memory.evidence?.speakers.map((speaker) => `${speaker.userId} ${speaker.userName}`) ?? []),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function normalizeEvidence(value: GroupMemory["evidence"] | undefined): GroupMemoryEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const startAt = typeof value.startAt === "string" ? value.startAt.trim() : "";
  const endAt = typeof value.endAt === "string" ? value.endAt.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, EVIDENCE_SUMMARY_LIMIT) : "";
  const messageCount =
    typeof value.messageCount === "number" && Number.isFinite(value.messageCount)
      ? Math.max(0, Math.floor(value.messageCount))
      : 0;
  const speakers = Array.isArray(value.speakers)
    ? value.speakers
        .map((speaker) => ({
          userId: String(speaker?.userId ?? "").trim(),
          userName: String(speaker?.userName ?? "").trim().slice(0, 80),
        }))
        .filter((speaker) => /^\d+$/.test(speaker.userId))
        .slice(0, 20)
    : [];

  if (!startAt || !endAt || !summary) {
    return undefined;
  }

  return {
    startAt,
    endAt,
    messageCount,
    speakers,
    summary,
  };
}
