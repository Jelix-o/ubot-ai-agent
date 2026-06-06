import { logWarn } from "../logger.js";
import type { GroupBotConfig, GroupMemberProfile, GroupMemory } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import type { AiService } from "./ai-service.js";
import { buildSubjectLabel } from "./member-profile-service.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const REVIEW_SOURCE_PREFIX = "daily_profile_review:";
const REVIEW_CONFIDENCE = 0.8;

interface DailyProfileReviewFile {
  reviewedDatesByGroup: Record<string, string[]>;
}

export interface DailyProfileReviewResult {
  reviewedDate: string;
  createdCount: number;
  createdSummaries: GroupMemory[];
}

export interface MemberProfileSummaryResult {
  summary: string;
  generatedAt: string;
  memoryCount: number;
  cached: boolean;
}

export class DailyProfileReviewService {
  private cachedData?: DailyProfileReviewFile;

  constructor(
    private readonly filePath: string,
    private readonly memoryStore: GroupMemoryStore,
    private readonly aiService: Pick<AiService, "summarizeDailyMemberProfile" | "summarizeOverallMemberProfile">,
  ) {}

  async shouldRunGroupReview(groupId: string, dateKey: string): Promise<boolean> {
    const data = await this.readData();
    return !(data.reviewedDatesByGroup[groupId] ?? []).includes(dateKey);
  }

  async reviewGroup(args: {
    groupConfig: GroupBotConfig;
    dateKey: string;
    members?: GroupMemberProfile[];
  }): Promise<DailyProfileReviewResult> {
    const groupId = args.groupConfig.groupId;
    if (!(await this.shouldRunGroupReview(groupId, args.dateKey))) {
      return { reviewedDate: args.dateKey, createdCount: 0, createdSummaries: [] };
    }

    const createdSummaries = await this.createDailySummaries({
      groupConfig: args.groupConfig,
      dateKey: args.dateKey,
      members: args.members ?? [],
    });
    await this.markReviewed(groupId, args.dateKey);
    return { reviewedDate: args.dateKey, createdCount: createdSummaries.length, createdSummaries };
  }

  async getOrCreateYesterdaySummary(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    dateKey: string;
    members?: GroupMemberProfile[];
  }): Promise<GroupMemory | undefined> {
    const existing = await this.findDailySummary(args.groupConfig.groupId, args.userId, args.dateKey);
    if (existing) {
      return existing;
    }

    return this.createDailySummary({
      groupConfig: args.groupConfig,
      userId: args.userId,
      dateKey: args.dateKey,
      members: args.members ?? [],
    });
  }

  async summarizeOverallProfile(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    members?: GroupMemberProfile[];
  }): Promise<string | null> {
    const result = await this.summarizeOverallProfileDetail(args);
    return result?.summary ?? null;
  }

  async summarizeOverallProfileDetail(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    members?: GroupMemberProfile[];
  }): Promise<MemberProfileSummaryResult | null> {
    const memories = await this.listUsableMemberProfileMemories(args.groupConfig.groupId, args.userId);
    if (memories.length === 0) {
      return null;
    }

    const summary = await this.aiService.summarizeOverallMemberProfile({
      groupId: args.groupConfig.groupId,
      userId: args.userId,
      displayName: buildSubjectLabel(args.groupConfig, args.userId, args.members ?? [], "member_profile").label,
      memories: memories.map(toProfileMemoryInput),
    });
    return summary
      ? {
          summary,
          generatedAt: new Date().toISOString(),
          memoryCount: memories.length,
          cached: false,
        }
      : null;
  }

  async getYesterdaySummaryDetail(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    dateKey: string;
    members?: GroupMemberProfile[];
  }): Promise<MemberProfileSummaryResult | null> {
    const summary = await this.getOrCreateYesterdaySummary(args);
    if (!summary) {
      return null;
    }
    const sourceMemories = (await this.memoryStore.list(args.groupConfig.groupId))
      .filter((memory) => isNewDailyMemberProfile(memory, args.dateKey) && memory.subjectUserId === args.userId);
    return {
      summary: summary.content,
      generatedAt: summary.updatedAt,
      memoryCount: sourceMemories.length,
      cached: summary.createdAt !== summary.updatedAt || Boolean(summary.id),
    };
  }

  private async createDailySummaries(args: {
    groupConfig: GroupBotConfig;
    dateKey: string;
    members: GroupMemberProfile[];
  }): Promise<GroupMemory[]> {
    const memories = await this.memoryStore.list(args.groupConfig.groupId);
    const userIds = Array.from(new Set(
      memories
        .filter((memory) => isNewDailyMemberProfile(memory, args.dateKey))
        .map((memory) => memory.subjectUserId!)
    ));

    const createdSummaries: GroupMemory[] = [];
    for (const userId of userIds) {
      try {
        const created = await this.createDailySummary({
          groupConfig: args.groupConfig,
          userId,
          dateKey: args.dateKey,
          members: args.members,
          allMemories: memories,
        });
        if (created) {
          createdSummaries.push(created);
        }
      } catch (error) {
        logWarn("Daily profile review failed for member.", {
          groupId: args.groupConfig.groupId,
          userId,
          dateKey: args.dateKey,
          error: (error as Error).message,
        });
      }
    }
    return createdSummaries;
  }

  private async createDailySummary(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    dateKey: string;
    members: GroupMemberProfile[];
    allMemories?: GroupMemory[];
  }): Promise<GroupMemory | undefined> {
    const existing = await this.findDailySummary(args.groupConfig.groupId, args.userId, args.dateKey);
    if (existing) {
      return existing;
    }

    const memories = (args.allMemories ?? await this.memoryStore.list(args.groupConfig.groupId))
      .filter((memory) => isNewDailyMemberProfile(memory, args.dateKey) && memory.subjectUserId === args.userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (memories.length === 0) {
      return undefined;
    }

    const label = buildSubjectLabel(args.groupConfig, args.userId, args.members, "member_profile").label;
    const summary = await this.aiService.summarizeDailyMemberProfile({
      groupId: args.groupConfig.groupId,
      userId: args.userId,
      displayName: label,
      dateKey: args.dateKey,
      memories: memories.map(toProfileMemoryInput),
    });
    if (!summary) {
      return undefined;
    }

    return this.memoryStore.create({
      groupId: args.groupConfig.groupId,
      type: "member_profile",
      subjectUserId: args.userId,
      title: `${args.dateKey} 昨日画像总结`,
      content: summary,
      confidence: REVIEW_CONFIDENCE,
      source: `${REVIEW_SOURCE_PREFIX}${args.dateKey}`,
      enabled: true,
    });
  }

  private async findDailySummary(groupId: string, userId: string, dateKey: string): Promise<GroupMemory | undefined> {
    const source = `${REVIEW_SOURCE_PREFIX}${dateKey}`;
    return (await this.memoryStore.list(groupId)).find((memory) =>
      memory.type === "member_profile" &&
      memory.subjectUserId === userId &&
      memory.source === source &&
      memory.enabled
    );
  }

  private async listUsableMemberProfileMemories(groupId: string, userId: string): Promise<GroupMemory[]> {
    return (await this.memoryStore.list(groupId))
      .filter((memory) => isUsableMemberProfile(memory, userId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async markReviewed(groupId: string, dateKey: string): Promise<void> {
    const data = await this.readData();
    const dates = data.reviewedDatesByGroup[groupId] ?? [];
    data.reviewedDatesByGroup[groupId] = Array.from(new Set([...dates, dateKey])).sort();
    await this.writeData(data);
  }

  private async readData(): Promise<DailyProfileReviewFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      const data = await readJsonFile<DailyProfileReviewFile>(this.filePath);
      this.cachedData = {
        reviewedDatesByGroup: data.reviewedDatesByGroup ?? {},
      };
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { reviewedDatesByGroup: {} };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: DailyProfileReviewFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}

export function getYesterdayDateKey(now = new Date()): string {
  const parts = getLocalDateParts(now);
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 1));
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function isNewDailyMemberProfile(memory: GroupMemory, dateKey: string): boolean {
  return isUsableMemberProfile(memory, memory.subjectUserId) &&
    !memory.source.startsWith(REVIEW_SOURCE_PREFIX) &&
    toLocalDateKey(memory.createdAt) === dateKey;
}

function isUsableMemberProfile(memory: GroupMemory, userId: string | undefined): boolean {
  return memory.type === "member_profile" &&
    Boolean(memory.subjectUserId) &&
    memory.subjectUserId === userId &&
    memory.enabled;
}

function toProfileMemoryInput(memory: GroupMemory): { title: string; content: string; createdAt: string; confidence: number } {
  return {
    title: memory.title,
    content: memory.content,
    createdAt: memory.createdAt,
    confidence: memory.confidence,
  };
}

function toLocalDateKey(value: string): string {
  const date = new Date(value);
  const parts = getLocalDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLocalDateParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}
