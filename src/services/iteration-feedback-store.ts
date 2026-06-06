import { randomUUID } from "node:crypto";

import type {
  IterationFeedbackCategory,
  IterationFeedbackFile,
  IterationFeedbackRecord,
  IterationFeedbackSource,
  IterationFeedbackStatus,
  IterationRelatedEntityType,
} from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

const MAX_FEEDBACK = 500;

export interface IterationFeedbackListArgs {
  groupId?: string;
  visibleGroupIds?: string[];
  includeAllGroups?: boolean;
  category?: IterationFeedbackCategory;
  status?: IterationFeedbackStatus;
  q?: string;
  page: number;
  pageSize: number;
}

export interface IterationFeedbackCreateInput {
  groupId: string;
  operatorUserId: string;
  source: IterationFeedbackSource;
  category?: IterationFeedbackCategory;
  title?: string;
  content: string;
  relatedEntityType?: IterationRelatedEntityType;
  relatedEntityId?: string;
}

export class IterationFeedbackStore {
  private cachedData?: IterationFeedbackFile;

  constructor(private readonly filePath: string) {}

  async listPage(args: IterationFeedbackListArgs): Promise<{
    feedback: IterationFeedbackRecord[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const data = await this.readData();
    const visibleGroupIds = args.visibleGroupIds ? new Set(args.visibleGroupIds) : undefined;
    const query = args.q?.trim().toLowerCase() ?? "";
    const pageSize = Math.max(1, Math.min(100, Math.floor(args.pageSize)));
    const matched = data.feedback
      .filter((item) => !args.groupId || item.groupId === args.groupId)
      .filter((item) => !visibleGroupIds || args.includeAllGroups === true || visibleGroupIds.has(item.groupId))
      .filter((item) => !args.category || item.category === args.category)
      .filter((item) => !args.status || item.status === args.status)
      .filter((item) => !query || feedbackMatchesQuery(item, query))
      .sort(compareNewestFirst);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.floor(args.page)), totalPages);
    const start = (page - 1) * pageSize;
    return {
      feedback: matched.slice(start, start + pageSize).map(cloneFeedback),
      pagination: { page, pageSize, total, totalPages },
    };
  }

  async list(args: { groupId?: string; status?: IterationFeedbackStatus; limit?: number } = {}): Promise<IterationFeedbackRecord[]> {
    const data = await this.readData();
    return data.feedback
      .filter((item) => !args.groupId || item.groupId === args.groupId)
      .filter((item) => !args.status || item.status === args.status)
      .sort(compareNewestFirst)
      .slice(0, Math.max(1, Math.min(args.limit ?? 100, 500)))
      .map(cloneFeedback);
  }

  async get(id: string): Promise<IterationFeedbackRecord | undefined> {
    const data = await this.readData();
    const item = data.feedback.find((feedback) => feedback.id === id);
    return item ? cloneFeedback(item) : undefined;
  }

  async create(input: IterationFeedbackCreateInput): Promise<IterationFeedbackRecord> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const content = normalizeText(input.content, 1600);
    const feedback = normalizeFeedback({
      id: randomUUID(),
      groupId: input.groupId,
      operatorUserId: input.operatorUserId,
      source: input.source,
      category: input.category ?? inferCategory(content),
      title: input.title || buildTitle(content),
      content,
      status: "open",
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      createdAt: now,
      updatedAt: now,
    });
    data.feedback.unshift(feedback);
    data.feedback = data.feedback.slice(0, MAX_FEEDBACK);
    await this.writeData(data);
    return cloneFeedback(feedback);
  }

  async updateStatus(id: string, status: IterationFeedbackStatus): Promise<IterationFeedbackRecord | undefined> {
    const data = await this.readData();
    const index = data.feedback.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const current = data.feedback[index]!;
    const next = normalizeFeedback({
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    });
    data.feedback[index] = next;
    await this.writeData(data);
    return cloneFeedback(next);
  }

  private async readData(): Promise<IterationFeedbackFile> {
    if (this.cachedData) return this.cachedData;
    try {
      this.cachedData = normalizeFile(await readJsonFile<Partial<IterationFeedbackFile>>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = { feedback: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: IterationFeedbackFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}

function normalizeFile(value: Partial<IterationFeedbackFile>): IterationFeedbackFile {
  return {
    feedback: Array.isArray(value.feedback)
      ? value.feedback.map(normalizeFeedback).filter((item): item is IterationFeedbackRecord => Boolean(item)).slice(0, MAX_FEEDBACK)
      : [],
  };
}

function normalizeFeedback(value: Partial<IterationFeedbackRecord>): IterationFeedbackRecord {
  const now = new Date().toISOString();
  const content = normalizeText(value.content, 1600);
  return {
    id: String(value.id || randomUUID()),
    groupId: normalizeId(value.groupId),
    operatorUserId: normalizeId(value.operatorUserId || "system"),
    source: value.source === "admin" ? "admin" : "qq_command",
    category: normalizeCategory(value.category),
    title: normalizeText(value.title || buildTitle(content), 100),
    content,
    status: normalizeStatus(value.status),
    ...(normalizeRelatedEntityType(value.relatedEntityType) ? { relatedEntityType: normalizeRelatedEntityType(value.relatedEntityType) } : {}),
    ...(normalizeText(value.relatedEntityId, 120) ? { relatedEntityId: normalizeText(value.relatedEntityId, 120) } : {}),
    createdAt: normalizeIso(value.createdAt) ?? now,
    updatedAt: normalizeIso(value.updatedAt) ?? now,
  };
}

function normalizeCategory(value: unknown): IterationFeedbackCategory {
  return value === "bug" ||
    value === "behavior" ||
    value === "data_quality" ||
    value === "skill" ||
    value === "model" ||
    value === "feature" ||
    value === "ops"
    ? value
    : "behavior";
}

function normalizeStatus(value: unknown): IterationFeedbackStatus {
  return value === "planned" || value === "applied" || value === "rejected" ? value : "open";
}

function normalizeRelatedEntityType(value: unknown): IterationRelatedEntityType | undefined {
  return value === "skill" ||
    value === "memory" ||
    value === "candidate" ||
    value === "knowledge" ||
    value === "profile" ||
    value === "model" ||
    value === "command" ||
    value === "ops"
    ? value
    : undefined;
}

function inferCategory(content: string): IterationFeedbackCategory {
  const text = content.toLowerCase();
  if (/bug|错误|报错|异常|失败|坏了|不对/.test(text)) return "bug";
  if (/模型|gpt|mimo|openai|回复慢|延迟/.test(text)) return "model";
  if (/记忆|画像|知识库|候选|数据/.test(text)) return "data_quality";
  if (/技能|skill|人设|语气|风格/.test(text)) return "skill";
  if (/部署|服务|服务器|端口|napcat|日志/.test(text)) return "ops";
  if (/新增|功能|希望|能不能|建议/.test(text)) return "feature";
  return "behavior";
}

function buildTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 36) || "自我迭代反馈";
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().slice(0, 80);
}

function normalizeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function feedbackMatchesQuery(item: IterationFeedbackRecord, query: string): boolean {
  return [
    item.id,
    item.groupId,
    item.operatorUserId,
    item.source,
    item.category,
    item.status,
    item.title,
    item.content,
    item.relatedEntityType,
    item.relatedEntityId,
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function compareNewestFirst(left: IterationFeedbackRecord, right: IterationFeedbackRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function cloneFeedback(item: IterationFeedbackRecord): IterationFeedbackRecord {
  return { ...item };
}
