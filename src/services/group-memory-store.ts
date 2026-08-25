import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

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

export interface RelevantEnabledMemoryArgs {
  groupId: string;
  currentUserId: string;
  relatedUserIds?: string[];
  excludedSubjectUserIds?: string[];
  queryText?: string;
  identityTerms?: string[];
  limit?: number;
  maxChars?: number;
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
  /** 覆盖链：新事实打上被覆盖旧记忆的 id（计划 §3 L1）。 */
  supersedes?: string;
};

/** 覆盖链 + 时间衰减：检索时被 superseded 的旧记忆置信度降为 0.3（计划 §8-4）。 */
const SUPERSEDED_CONFIDENCE_DECAY = 0.3;

export class GroupMemoryStore {
  private cachedData?: GroupMemoryFile;
  private cachedVersion?: string;

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

  async listRelevantEnabled(args: RelevantEnabledMemoryArgs): Promise<GroupMemory[]> {
    const data = await this.readData();
    const limit = Math.max(1, Math.min(args.limit ?? 8, 20));
    const maxChars = Math.max(200, Math.min(args.maxChars ?? 3_200, 12_000));
    const relatedUserIds = new Set((args.relatedUserIds ?? []).filter(Boolean));
    relatedUserIds.delete(args.currentUserId);
    const excludedSubjectUserIds = new Set((args.excludedSubjectUserIds ?? []).filter(Boolean));
    const terms = buildRelevanceTerms(args.queryText, args.identityTerms);
    const supersededIds = new Set(
      data.memories
        .filter((memory) => memory.groupId === args.groupId && memory.supersededBy)
        .map((memory) => memory.supersededBy),
    );
    const prioritized = data.memories
      .filter((memory) => memory.groupId === args.groupId && memory.enabled)
      .filter((memory) => !memory.subjectUserId || !excludedSubjectUserIds.has(memory.subjectUserId))
      .map((memory) => {
        // 覆盖链 + 时间衰减（计划 §8-4）：被更新的记忆覆盖的旧记忆置信度降为 0.3。
        const decayed = supersededIds.has(memory.id)
          ? { ...memory, confidence: SUPERSEDED_CONFIDENCE_DECAY }
          : memory;
        return {
          memory: decayed,
          score: scoreRelevantMemory(decayed, args.currentUserId, relatedUserIds, terms),
        };
      })
      .sort((left, right) =>
        right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt),
      )
      .map((item) => item.memory);
    const selected: GroupMemory[] = [];
    const selectedIds = new Set<string>();
    let usedChars = 0;

    for (const memory of prioritized) {
      if (selected.length >= limit || selectedIds.has(memory.id)) {
        continue;
      }
      const remainingChars = maxChars - usedChars - memory.title.length;
      if (remainingChars <= 0) {
        continue;
      }
      const content = memory.content.slice(0, remainingChars);
      if (!content) {
        continue;
      }
      selected.push({ ...cloneMemory(memory), content });
      selectedIds.add(memory.id);
      usedChars += memory.title.length + content.length;
    }

    return selected;
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

    // 覆盖链：新事实入库时给被覆盖的旧记忆打 superseded_by 标记（不删除）。
    if (input.supersedes) {
      const superseded = data.memories.find((item) => item.id === input.supersedes);
      if (superseded) {
        superseded.supersededBy = memory.id;
        superseded.updatedAt = now;
      }
    }

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

  async removeMany(ids: string[]): Promise<number> {
    const idSet = new Set(ids);
    if (idSet.size === 0) {
      return 0;
    }
    const data = await this.readData();
    const beforeCount = data.memories.length;
    data.memories = data.memories.filter((memory) => !idSet.has(memory.id));
    const removedCount = beforeCount - data.memories.length;
    if (removedCount > 0) {
      await this.writeData(data);
    }
    return removedCount;
  }

  private async readData(): Promise<GroupMemoryFile> {
    const version = await fileVersion(this.filePath);
    if (this.cachedData && this.cachedVersion === version) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeMemoryFile(await readJsonFile<GroupMemoryFile>(this.filePath));
      this.cachedVersion = version;
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { memories: [] };
        this.cachedVersion = "missing";
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: GroupMemoryFile): Promise<void> {
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

function scoreRelevantMemory(
  memory: GroupMemory,
  currentUserId: string,
  relatedUserIds: ReadonlySet<string>,
  terms: string[],
): number {
  let score = 0;
  if (memory.subjectUserId === currentUserId) {
    score += 28;
  } else if (memory.subjectUserId && relatedUserIds.has(memory.subjectUserId)) {
    score += 24;
  }
  if (memory.type === "group_fact") {
    score += 8;
  }

  const searchable = [memory.title, memory.content, memory.evidence?.summary]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  for (const term of terms) {
    if (!searchable.includes(term)) {
      continue;
    }
    score += Math.min(72, 12 + term.length * 4);
  }
  return score;
}

function buildRelevanceTerms(queryText: string | undefined, identityTerms: string[] | undefined): string[] {
  const values = [queryText ?? "", ...(identityTerms ?? [])];
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }
    for (const token of normalized.match(/[\p{Script=Han}a-z0-9_]{2,32}/gu) ?? []) {
      if (isMeaningfulMemoryTerm(token)) {
        terms.add(token);
      }
      if (/^\p{Script=Han}+$/u.test(token)) {
        for (let size = 2; size <= Math.min(8, token.length); size += 1) {
          for (let start = 0; start <= token.length - size; start += 1) {
            const fragment = token.slice(start, start + size);
            if (isMeaningfulMemoryTerm(fragment)) {
              terms.add(fragment);
            }
          }
        }
      }
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 80);
}

function isMeaningfulMemoryTerm(value: string): boolean {
  return !new Set([
    "什么", "怎么", "为啥", "为什么", "这个", "那个", "一下", "可以", "然后", "我们", "你们", "他们", "她们", "就是", "还是", "已经", "现在", "今天", "知道", "觉得", "帮我", "会仙",
  ]).has(value);
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
    ...(typeof value.supersededBy === "string" && value.supersededBy.trim()
      ? { supersededBy: value.supersededBy.trim().slice(0, 80) }
      : {}),
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
