import { randomUUID } from "node:crypto";

import type { KnowledgeBaseEntry } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

interface KnowledgeBaseFile {
  entries: KnowledgeBaseEntry[];
}

export interface KnowledgeBaseListPageArgs {
  groupId?: string;
  query?: string;
  page: number;
  pageSize: number;
}

export interface KnowledgeBaseListPageResult {
  items: KnowledgeBaseEntry[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export type KnowledgeBaseEntryInput = {
  groupId: string;
  title: string;
  question: string;
  answer: string;
  keywords?: string[];
  enabled?: boolean;
};

export interface KnowledgeBaseSearchHit {
  entry: KnowledgeBaseEntry;
  score: number;
}

export interface KnowledgeBaseDuplicateMatch {
  entry: KnowledgeBaseEntry;
  field: "question" | "title";
}

export class KnowledgeBaseStore {
  private cachedData?: KnowledgeBaseFile;

  constructor(private readonly filePath: string) {}

  async list(groupId?: string): Promise<KnowledgeBaseEntry[]> {
    const data = await this.readData();
    return data.entries
      .filter((entry) => !groupId || entry.groupId === groupId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneEntry);
  }

  async get(id: string): Promise<KnowledgeBaseEntry | undefined> {
    const data = await this.readData();
    const entry = data.entries.find((item) => item.id === id);
    return entry ? cloneEntry(entry) : undefined;
  }

  async listPage(args: KnowledgeBaseListPageArgs): Promise<KnowledgeBaseListPageResult> {
    const data = await this.readData();
    const query = normalizeListQuery(args.query);
    const pageSize = Math.max(1, args.pageSize);
    const matched = data.entries
      .filter((entry) => !args.groupId || entry.groupId === args.groupId)
      .filter((entry) => !query || knowledgeEntryMatchesQuery(entry, query))
      .sort(compareEntriesNewestFirst);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, args.page), totalPages);
    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map(cloneEntry),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  async create(input: KnowledgeBaseEntryInput): Promise<KnowledgeBaseEntry> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const entry = normalizeEntry({
      id: randomUUID(),
      groupId: input.groupId,
      title: input.title,
      question: input.question,
      answer: input.answer,
      keywords: input.keywords ?? [],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
    data.entries.push(entry);
    await this.writeData(data);
    return cloneEntry(entry);
  }

  async findDuplicate(input: Pick<KnowledgeBaseEntryInput, "groupId" | "title" | "question">): Promise<KnowledgeBaseDuplicateMatch | undefined> {
    const data = await this.readData();
    const questionKey = normalizeDuplicateText(input.question);
    const titleKey = normalizeDuplicateText(input.title);
    for (const entry of data.entries) {
      if (entry.groupId !== input.groupId) {
        continue;
      }
      if (questionKey && normalizeDuplicateText(entry.question) === questionKey) {
        return { entry: cloneEntry(entry), field: "question" };
      }
      if (titleKey && normalizeDuplicateText(entry.title) === titleKey) {
        return { entry: cloneEntry(entry), field: "title" };
      }
    }
    return undefined;
  }

  async update(id: string, patch: Partial<KnowledgeBaseEntryInput>): Promise<KnowledgeBaseEntry | undefined> {
    const data = await this.readData();
    const index = data.entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return undefined;
    }

    const current = data.entries[index]!;
    const updated = normalizeEntry({
      ...current,
      ...patch,
      keywords: patch.keywords === undefined ? current.keywords : patch.keywords,
      updatedAt: new Date().toISOString(),
    });
    data.entries[index] = updated;
    await this.writeData(data);
    return cloneEntry(updated);
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.readData();
    const next = data.entries.filter((entry) => entry.id !== id);
    if (next.length === data.entries.length) {
      return false;
    }
    data.entries = next;
    await this.writeData(data);
    return true;
  }

  async search(groupId: string, query: string, limit = 3): Promise<KnowledgeBaseSearchHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    const data = await this.readData();
    return data.entries
      .filter((entry) => entry.groupId === groupId && entry.enabled)
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((hit) => hit.score >= 2)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
      .slice(0, limit)
      .map((hit) => ({ entry: cloneEntry(hit.entry), score: hit.score }));
  }

  private async readData(): Promise<KnowledgeBaseFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeKnowledgeBaseFile(await readJsonFile<KnowledgeBaseFile>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { entries: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: KnowledgeBaseFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}

export function tokenizeKnowledgeText(value: string): string[] {
  return tokenize(value);
}

function normalizeKnowledgeBaseFile(data: Partial<KnowledgeBaseFile>): KnowledgeBaseFile {
  return {
    entries: Array.isArray(data.entries)
      ? data.entries.map(normalizeEntry).filter((entry): entry is KnowledgeBaseEntry => Boolean(entry))
      : [],
  };
}

function normalizeEntry(value: Partial<KnowledgeBaseEntry>): KnowledgeBaseEntry {
  const now = new Date().toISOString();
  return {
    id: String(value.id || randomUUID()),
    groupId: String(value.groupId || "").trim(),
    title: String(value.title || "").trim().slice(0, 100),
    question: String(value.question || "").trim().slice(0, 300),
    answer: String(value.answer || "").trim().slice(0, 1200),
    keywords: normalizeKeywords(value.keywords),
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeKeywords(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .flatMap((keyword) => String(keyword).split(/[,\s，、]+/))
        .map((keyword) => keyword.trim())
        .filter(Boolean)
        .slice(0, 30),
    ),
  );
}

function scoreEntry(entry: KnowledgeBaseEntry, tokens: string[]): number {
  const title = normalizeSearchText(entry.title);
  const question = normalizeSearchText(entry.question);
  const answer = normalizeSearchText(entry.answer);
  const keywords = entry.keywords.map(normalizeSearchText);
  let score = 0;

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 5;
    }
    if (question.includes(token)) {
      score += 4;
    }
    if (keywords.some((keyword) => keyword.includes(token) || token.includes(keyword))) {
      score += 6;
    }
    if (answer.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function tokenize(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const asciiTokens = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const cjkTokens = Array.from(normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g))
    .flatMap((match) => buildCjkTokens(match[0] ?? ""));
  return Array.from(new Set([...asciiTokens, ...cjkTokens])).slice(0, 40);
}

function buildCjkTokens(text: string): string[] {
  if (text.length <= 6) {
    return [text];
  }

  const tokens: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    tokens.push(text.slice(index, index + 2));
  }
  return tokens;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeListQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeDuplicateText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()[\]【】<>《》\-_\/\\|`~@#$%^&*+=]/g, "")
    .trim();
}

function knowledgeEntryMatchesQuery(entry: KnowledgeBaseEntry, query: string): boolean {
  return [
    entry.id,
    entry.groupId,
    entry.title,
    entry.question,
    entry.answer,
    entry.keywords.join(" "),
    entry.enabled ? "enabled 启用" : "disabled 停用",
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function compareEntriesNewestFirst(left: KnowledgeBaseEntry, right: KnowledgeBaseEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function cloneEntry(entry: KnowledgeBaseEntry): KnowledgeBaseEntry {
  return {
    ...entry,
    keywords: [...entry.keywords],
  };
}
