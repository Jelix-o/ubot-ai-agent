import assert from "node:assert/strict";
import os from "node:os";
import { rm } from "node:fs/promises";
import test from "node:test";

import { BotApplication, type MessageTransport } from "./bot.js";
import type { AdminOperationLogEntry } from "./services/admin-operation-log-service.js";
import { GroupLock } from "./services/group-lock.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { ProfileRecordStore } from "./services/profile-record-store.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import type {
  AiReply,
  AiIdentityContext,
  ControlledMentionDecision,
  ConversationTurn,
  GroupBotConfig,
  GroupMemory,
  GroupMemoryCandidate,
  KnowledgeBaseEntry,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  ReferencedMessage,
  SkillDefinition,
  SystemCommandConfig,
  SystemSettings,
} from "./types.js";

class FakeTransport implements MessageTransport {
  readonly sent: Array<{ groupId: string; text: string }> = [];
  readonly records: Array<{ groupId: string; recordFile: string }> = [];
  readonly aiRecords: Array<{ groupId: string; text: string }> = [];
  messagesById: Record<string, ReferencedMessage> = {};
  getMessageError?: Error;
  sendGroupMessageError?: Error;
  allowOpsAlertWhenSendFails = false;
  memberDirectoryByGroup: Record<string, NapcatGroupMember[]> = {
    "67890": [
      { user_id: 67890, nickname: "小王", card: "项目经理" },
      { user_id: 55667788, nickname: "老张", card: "张三" },
      { user_id: 20001, nickname: "Tester", card: "测试同学" },
    ],
  };
  healthStatus = { ok: true, detail: "测试传输层已连接" };

  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    if (this.sendGroupMessageError && !(this.allowOpsAlertWhenSendFails && text.includes("【运维告警】"))) {
      throw this.sendGroupMessageError;
    }
    this.sent.push({ groupId, text });
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<void> {
    this.records.push({ groupId, recordFile });
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<void> {
    this.aiRecords.push({ groupId, text });
  }

  async resolveImageInputs(
    images: Array<{ url?: string; file?: string; summary?: string }>,
  ): Promise<Array<{ url?: string; file?: string; summary?: string }>> {
    return images.map((image) =>
      image.url
        ? image
        : image.file
          ? {
              ...image,
              url: `https://resolved.example/${image.file}.png`,
            }
          : image,
    );
  }

  async resolveMentionTargets(groupId: string, candidates: string[]): Promise<string[]> {
    return resolveMentionTargetsFromMembers(this.memberDirectoryByGroup[groupId] ?? [], candidates);
  }

  async resolveMemberIdentities(
    groupId: string,
    candidates: string[],
  ): Promise<Array<{ userId: string; names: string[] }>> {
    const members = this.memberDirectoryByGroup[groupId] ?? [];
    const userIds = new Set(resolveMentionTargetsFromMembers(members, candidates));
    return members
      .filter((member) => userIds.has(String(member.user_id)))
      .map((member) => ({
        userId: String(member.user_id),
        names: [member.card?.trim(), member.nickname?.trim(), String(member.user_id)].filter(
          (name): name is string => Boolean(name),
        ),
      }));
  }

  async getMessage(messageId: string): Promise<ReferencedMessage | undefined> {
    if (this.getMessageError) {
      throw this.getMessageError;
    }
    return this.messagesById[messageId];
  }

  async getHealthStatus(): Promise<{ ok: boolean; detail: string }> {
    return this.healthStatus;
  }
}

class FakeGroupConfigService {
  constructor(
    public groups: GroupBotConfig[],
    public superAdminUserIds: string[] = [],
  ) {}

  async getAll(): Promise<GroupBotConfig[]> {
    return this.groups.map((group) => cloneGroup(group));
  }

  async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
    const group = this.groups.find((item) => item.groupId === groupId);
    return group ? cloneGroup(group) : undefined;
  }

  async updateCurrentSkill(groupId: string, skillId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.currentSkillId = skillId;
    return cloneGroup(group);
  }

  async updateReplyModelMode(groupId: string, mode: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.replyModelMode = mode;
    return cloneGroup(group);
  }

  async addLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatUserIds = Array.from(new Set([...group.liveChatUserIds, userId]));
    return cloneGroup(group);
  }

  async removeLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatUserIds = group.liveChatUserIds.filter((item) => item !== userId);
    return cloneGroup(group);
  }

  async updateLiveChatDelay(groupId: string, delayMinutes: number): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatDelayMinutes = delayMinutes;
    return cloneGroup(group);
  }

  async updateLiveChatDelaySeconds(groupId: string, delaySeconds: number): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatDelaySeconds = delaySeconds;
    return cloneGroup(group);
  }

  async updateDailyReportEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.dailyReportEnabled = enabled;
    return cloneGroup(group);
  }

  async updateDailyReportTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.dailyReportTime = time;
    return cloneGroup(group);
  }

  async updateHolidayCountdownEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.holidayCountdownEnabled = enabled;
    return cloneGroup(group);
  }

  async updateHolidayCountdownTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.holidayCountdownTime = time;
    return cloneGroup(group);
  }

  async updateBotMuted(groupId: string, muted: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.botMuted = muted;
    return cloneGroup(group);
  }

  async updateScheduledRemindersEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.scheduledRemindersEnabled = enabled;
    return cloneGroup(group);
  }

  async updateOpsAlertsEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.opsAlertsEnabled = enabled;
    return cloneGroup(group);
  }

  async addBlacklistedUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.blacklistedUserIds = Array.from(new Set([...(group.blacklistedUserIds ?? []), userId]));
    return cloneGroup(group);
  }

  async removeBlacklistedUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.blacklistedUserIds = (group.blacklistedUserIds ?? []).filter((item) => item !== userId);
    return cloneGroup(group);
  }

  async getSuperAdminUserIds(): Promise<string[]> {
    return [...this.superAdminUserIds];
  }

  async isSuperAdmin(userId: string): Promise<boolean> {
    return this.superAdminUserIds.includes(userId);
  }

  async addAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.switcherUserIds = Array.from(new Set([...group.switcherUserIds, userId]));
    return cloneGroup(group);
  }

  async removeAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.switcherUserIds = group.switcherUserIds.filter((item) => item !== userId);
    return cloneGroup(group);
  }

  private requireGroup(groupId: string): GroupBotConfig {
    const group = this.groups.find((item) => item.groupId === groupId);
    if (!group) {
      throw new Error("Group not found");
    }
    return group;
  }
}

class FakeSystemSettingsStore {
  constructor(
    private readonly commands: SystemCommandConfig[] = [],
    private readonly defaultTriggerKeywords: SystemSettings["defaultTriggerKeywords"] = [{ keyword: "乘风", enabled: true }],
    private readonly models: SystemSettings["models"] = [],
    private readonly profileShortSummaryMaxChars = 140,
    private readonly scheduler: Partial<Pick<SystemSettings, "dailyProfileReviewEnabled" | "dailyProfileReviewTime" | "memoryDedupEnabled" | "memoryDedupTime">> = {},
  ) {}

  async get(): Promise<SystemSettings> {
    return {
      profileSummaryMaxChars: 1800,
      profileShortSummaryMaxChars: this.profileShortSummaryMaxChars,
      dailyProfileReviewEnabled: this.scheduler.dailyProfileReviewEnabled ?? true,
      dailyProfileReviewTime: this.scheduler.dailyProfileReviewTime ?? "00:00",
      memoryDedupEnabled: this.scheduler.memoryDedupEnabled ?? true,
      memoryDedupTime: this.scheduler.memoryDedupTime ?? "23:00",
      defaultTriggerKeywords: this.defaultTriggerKeywords,
      models: this.models,
      selectedModelIds: {},
      commands: this.commands,
      updatedAt: new Date().toISOString(),
    };
  }

  async getInternal(): Promise<SystemSettings> {
    return this.get();
  }
}

class FakeSkillService {
  constructor(private readonly skills: SkillDefinition[]) {}

  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    return this.skills.find((skill) => skill.id === skillId);
  }
}

class FakeConversationStore {
  turnsByKey: Record<string, ConversationTurn[]> = {};
  clearedGroups: string[] = [];
  clearedUsers: Array<{ groupId: string; userId: string }> = [];

  async getTurns(groupId: string, userId: string): Promise<ConversationTurn[]> {
    return this.turnsByKey[toConversationKey(groupId, userId)] ?? [];
  }

  async appendDialogue(groupId: string, userId: string, turns: ConversationTurn[]): Promise<void> {
    const key = toConversationKey(groupId, userId);
    this.turnsByKey[key] = [...(this.turnsByKey[key] ?? []), ...turns];
  }

  async clearUser(groupId: string, userId: string): Promise<void> {
    this.clearedUsers.push({ groupId, userId });
    delete this.turnsByKey[toConversationKey(groupId, userId)];
  }

  async clearGroup(groupId: string): Promise<void> {
    this.clearedGroups.push(groupId);
    const prefix = `${groupId}:`;
    for (const key of Object.keys(this.turnsByKey)) {
      if (key === groupId || key.startsWith(prefix)) {
        delete this.turnsByKey[key];
      }
    }
  }
}

class FakeAiService {
  calls: Array<{
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: Array<{ url?: string; file?: string; summary?: string }>;
    identityContext?: AiIdentityContext;
  }> = [];
  controlledMentionCalls: Array<{
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: AiIdentityContext;
  }> = [];
  healthOk = true;
  healthCalls = 0;

  constructor(
    private readonly responder: () => Promise<AiReply>,
    private readonly controlledMentionResponder: () => Promise<ControlledMentionDecision> = async () => ({
      shouldMention: false,
    }),
  ) {}

  async generateReply(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: Array<{ url?: string; file?: string; summary?: string }>;
    identityContext?: AiIdentityContext;
  }): Promise<AiReply> {
    this.calls.push(args);
    return this.responder();
  }

  async checkHealth(): Promise<{
    ok: boolean;
    detail: string;
    model: string;
    baseUrl: string;
    checkedAt: string;
    latencyMs: number;
    cached: boolean;
  }> {
    this.healthCalls += 1;
    return {
      ok: this.healthOk,
      detail: this.healthOk ? "profile ok" : "profile down",
      model: "profile-model",
      baseUrl: "https://profile.example/v1",
      checkedAt: "2026-06-03T00:00:00.000Z",
      latencyMs: 10,
      cached: false,
    };
  }

  async evaluateControlledMention(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: AiIdentityContext;
  }): Promise<ControlledMentionDecision> {
    this.controlledMentionCalls.push(args);
    return this.controlledMentionResponder();
  }

  async generateDailyReportInsights(): Promise<null> {
    return null;
  }

  async generateChatPeriodSummary(): Promise<string | null> {
    return null;
  }

  async generateScheduledReminderText(args: {
    topic: string;
    groupId: string;
    intervalMinutes: number;
    recentMessages?: string[];
  }): Promise<string | null> {
    return args.recentMessages?.length ? `又到点了，继续${args.topic}` : `提醒：${args.topic}`;
  }
}

class FakeTtsService {
  calls: Array<{ text: string; skill: SkillDefinition }> = [];

  constructor(
    private readonly responder: () => Promise<{
      filePath: string;
      recordFile: string;
      cleanup(): Promise<void>;
    }>,
  ) {}

  async synthesize(text: string, skill: SkillDefinition): Promise<{
    filePath: string;
    recordFile: string;
    cleanup(): Promise<void>;
  }> {
    this.calls.push({ text, skill });
    return this.responder();
  }
}

class FakeDailyReportService {
  recorded: Array<{ groupId: string; userId: string; userName: string; text: string }> = [];
  reports: Array<{ groupId: string; now: string }> = [];
  marked: Array<{ groupId: string; now: string }> = [];
  summaries: Array<{ groupId: string; label: string; now: string }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly reportText = async (_groupConfig?: GroupBotConfig, _now?: Date) => "日报内容",
  ) {}

  async recordMessage(args: {
    groupId: string;
    userId: string;
    userName: string;
    text: string;
  }): Promise<void> {
    this.recorded.push(args);
  }

  async shouldSendScheduledReport(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  async buildReport(groupConfig: GroupBotConfig, now = new Date()): Promise<string> {
    this.reports.push({ groupId: groupConfig.groupId, now: now.toISOString() });
    return this.reportText(groupConfig, now);
  }

  async buildChatSummary(args: {
    groupId: string;
    request: { label: string };
    now?: Date;
  }): Promise<string> {
    this.summaries.push({
      groupId: args.groupId,
      label: args.request.label,
      now: (args.now ?? new Date()).toISOString(),
    });
    return `${args.request.label}聊天总结`;
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    this.marked.push({ groupId, now: now.toISOString() });
  }
}

class FakeHolidayCountdownService {
  marked: Array<{ groupId: string; now: string }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly messageFactory = (_now?: Date) => "节假日倒计时",
  ) {}

  async shouldSendScheduledMessage(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  buildCountdownMessage(now = new Date()): string {
    return this.messageFactory(now);
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    this.marked.push({ groupId, now: now.toISOString() });
  }
}

class FakeAdminOperationLogService {
  entries: AdminOperationLogEntry[] = [];

  async record(entry: Omit<AdminOperationLogEntry, "timestamp"> & { timestamp?: string }): Promise<void> {
    this.entries.push({
      timestamp: entry.timestamp ?? new Date().toISOString(),
      groupId: entry.groupId,
      operatorUserId: entry.operatorUserId,
      action: entry.action,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }

  async listRecent(groupId: string, limit = 10): Promise<AdminOperationLogEntry[]> {
    return this.entries
      .filter((entry) => entry.groupId === groupId)
      .slice(-limit)
      .reverse();
  }
}

class FakeGroupMemoryStore {
  memories: GroupMemory[] = [];

  async list(groupId?: string): Promise<GroupMemory[]> {
    return this.memories.filter((memory) => !groupId || memory.groupId === groupId);
  }

  async listEnabled(groupId: string): Promise<GroupMemory[]> {
    return this.memories.filter((memory) => memory.groupId === groupId && memory.enabled);
  }

  async create(input: Omit<GroupMemory, "id" | "createdAt" | "updatedAt">): Promise<GroupMemory> {
    const now = new Date().toISOString();
    const memory: GroupMemory = {
      id: `memory-${this.memories.length + 1}`,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.memories.push(memory);
    return memory;
  }
}

class FakeDailyProfileReviewService {
  dailySummaries = new Map<string, GroupMemory>();
  overallSummary: string | null = "整体画像总结";
  getOrCreateCalls: Array<{ groupId: string; userId: string; dateKey: string }> = [];
  overallCalls: Array<{ groupId: string; userId: string }> = [];
  reviewCalls: Array<{ groupId: string; dateKey: string }> = [];

  async reviewGroup(args: { groupConfig: GroupBotConfig; dateKey: string }): Promise<{ reviewedDate: string; createdCount: number; createdSummaries: GroupMemory[] }> {
    this.reviewCalls.push({ groupId: args.groupConfig.groupId, dateKey: args.dateKey });
    const now = new Date().toISOString();
    return {
      reviewedDate: args.dateKey,
      createdCount: 1,
      createdSummaries: [{
        id: `daily-profile-${args.dateKey}`,
        groupId: args.groupConfig.groupId,
        type: "member_profile",
        subjectUserId: "20001",
        title: `${args.dateKey} 昨日画像总结`,
        content: "Tester 昨日新增画像总结",
        source: `daily_profile_review:${args.dateKey}`,
        confidence: 0.8,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }],
    };
  }

  async getOrCreateYesterdaySummary(args: { groupConfig: GroupBotConfig; userId: string; dateKey: string }): Promise<GroupMemory | undefined> {
    this.getOrCreateCalls.push({ groupId: args.groupConfig.groupId, userId: args.userId, dateKey: args.dateKey });
    return this.dailySummaries.get(`${args.groupConfig.groupId}:${args.userId}:${args.dateKey}`);
  }

  async summarizeOverallProfile(args: { groupConfig: GroupBotConfig; userId: string }): Promise<string | null> {
    this.overallCalls.push({ groupId: args.groupConfig.groupId, userId: args.userId });
    return this.overallSummary;
  }
}

class FakeKnowledgeBaseStore {
  entries: KnowledgeBaseEntry[] = [];
  queries: Array<{ groupId: string; query: string }> = [];

  async list(groupId?: string): Promise<KnowledgeBaseEntry[]> {
    return this.entries.filter((entry) => !groupId || entry.groupId === groupId);
  }

  async search(groupId: string, query: string): Promise<Array<{ entry: KnowledgeBaseEntry; score: number }>> {
    this.queries.push({ groupId, query });
    return this.entries
      .filter((entry) => entry.groupId === groupId && entry.enabled)
      .map((entry) => ({ entry, score: 10 }));
  }
}

class FakeGroupMemoryCandidateService {
  queued: Array<{ groupId: string; userId: string; userName: string; text: string; timestamp: string }> = [];
  candidates: GroupMemoryCandidate[] = [];
  flushAllCalls = 0;
  flushAllGroupIds: string[] | undefined;

  queueMessage(message: { groupId: string; userId: string; userName: string; text: string; timestamp: string }): void {
    this.queued.push(message);
  }

  async flushAll(groupIds?: string[]): Promise<Array<{ groupId: string; messageCount: number; candidateCount: number; autoApprovedCount: number; pendingCount: number }>> {
    this.flushAllCalls += 1;
    this.flushAllGroupIds = groupIds;
    return [];
  }

  async list(): Promise<GroupMemoryCandidate[]> {
    return this.candidates;
  }
}

const assistantSkill: SkillDefinition = {
  id: "assistant",
  name: "assistant",
  systemPrompt: "you are an assistant",
  styleRules: ["short answer"],
  knowledge: ["qq group chat"],
  temperature: 0.7,
  maxContextTurns: 12,
};

const teacherSkill: SkillDefinition = {
  ...assistantSkill,
  id: "teacher",
  name: "teacher",
};

function enabledReplyModel(id = "reply-pro"): SystemSettings["models"][number] {
  return {
    id,
    name: "Reply Pro",
    shortName: id,
    baseUrl: "https://reply.example/v1",
    model: `${id}-model`,
    purpose: "reply",
    apiKey: `${id}-key`,
    hasApiKey: true,
    enabled: true,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function cloneGroup(group: GroupBotConfig): GroupBotConfig {
  return {
    ...group,
    allowedSkillIds: [...group.allowedSkillIds],
    switcherUserIds: [...group.switcherUserIds],
    liveChatUserIds: [...group.liveChatUserIds],
    blacklistedUserIds: [...(group.blacklistedUserIds ?? [])],
    opsAlertsEnabled: group.opsAlertsEnabled !== false,
    manualIdentities: group.manualIdentities?.map((identity) => ({
      ...identity,
      userIds: [...identity.userIds],
      names: [...identity.names],
    })),
  };
}

function toConversationKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

async function withMockedNow<T>(value: number, run: () => Promise<T>): Promise<T> {
  const OriginalDate = Date;
  class MockDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(value);
      } else {
        super(...(args as [string | number | Date]));
      }
    }

    static now(): number {
      return value;
    }
  }
  globalThis.Date = MockDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

async function withMockedMemoryUsage<T>(args: { total: number; free: number }, run: () => Promise<T>): Promise<T> {
  const mutableOs = os as unknown as {
    totalmem(): number;
    freemem(): number;
  };
  const originalTotalmem = mutableOs.totalmem;
  const originalFreemem = mutableOs.freemem;
  mutableOs.totalmem = () => args.total;
  mutableOs.freemem = () => args.free;
  try {
    return await run();
  } finally {
    mutableOs.totalmem = originalTotalmem;
    mutableOs.freemem = originalFreemem;
  }
}

async function withTestScheduledReminderService<T>(
  aiService: FakeAiService,
  run: (service: ScheduledReminderService) => Promise<T>,
): Promise<T> {
  const filePath = `data/test-scheduled-reminders-${Date.now()}-${Math.random()}.json`;
  try {
    return await run(new ScheduledReminderService(new ScheduledReminderStore(filePath), aiService as never));
  } finally {
    await rm(filePath, { force: true });
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(predicate(), true);
}

function createEvent(
  message: NapcatGroupMessageEvent["message"],
  userId = 20001,
  groupId = 67890,
): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 12345,
    group_id: groupId,
    user_id: userId,
    message_id: 1,
    raw_message: "",
    message,
    sender: {
      user_id: userId,
      nickname: "Tester",
      role: "member",
    },
  };
}

function createApp(options?: {
  groupConfigService?: FakeGroupConfigService;
  transport?: FakeTransport;
  aiService?: FakeAiService;
  profileAiService?: FakeAiService;
  conversationStore?: FakeConversationStore;
  ttsService?: FakeTtsService;
  dailyReportService?: FakeDailyReportService;
  holidayCountdownService?: FakeHolidayCountdownService;
  scheduledReminderService?: ScheduledReminderService;
  adminOperationLogService?: FakeAdminOperationLogService;
  groupMemoryStore?: FakeGroupMemoryStore;
  knowledgeBaseStore?: FakeKnowledgeBaseStore;
  groupMemoryCandidateService?: FakeGroupMemoryCandidateService;
  dailyProfileReviewService?: FakeDailyProfileReviewService;
  profileRecordStore?: ProfileRecordStore;
  allowNapCatAiVoiceFallback?: boolean;
  skills?: SkillDefinition[];
  systemSettingsStore?: FakeSystemSettingsStore;
}): {
  app: BotApplication;
  transport: FakeTransport;
  groupConfigService: FakeGroupConfigService;
  aiService: FakeAiService;
  profileAiService?: FakeAiService;
  conversationStore: FakeConversationStore;
  ttsService: FakeTtsService;
  dailyReportService: FakeDailyReportService;
  holidayCountdownService: FakeHolidayCountdownService;
  scheduledReminderService: ScheduledReminderService;
  adminOperationLogService: FakeAdminOperationLogService;
  groupMemoryStore: FakeGroupMemoryStore;
  knowledgeBaseStore: FakeKnowledgeBaseStore;
  groupMemoryCandidateService: FakeGroupMemoryCandidateService;
  dailyProfileReviewService: FakeDailyProfileReviewService;
  profileRecordStore: ProfileRecordStore;
} {
  const transport = options?.transport ?? new FakeTransport();
  const groupConfigService =
    options?.groupConfigService ??
    new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ]);
  const conversationStore = options?.conversationStore ?? new FakeConversationStore();
  const aiService =
    options?.aiService ??
    new FakeAiService(async () => ({
      text: "AI reply",
      model: "test-model",
      skillId: "assistant",
    }));
  const profileAiService = options?.profileAiService;
  const ttsService =
    options?.ttsService ??
    new FakeTtsService(async () => ({
      filePath: "tts.wav",
      recordFile: "base64://dHRz",
      async cleanup() {},
    }));
  const dailyReportService =
    options?.dailyReportService ?? new FakeDailyReportService(async () => false);
  const holidayCountdownService =
    options?.holidayCountdownService ?? new FakeHolidayCountdownService(async () => false);
  const scheduledReminderService =
    options?.scheduledReminderService ??
    new ScheduledReminderService(
      new ScheduledReminderStore(`data/test-scheduled-reminders-${Date.now()}-${Math.random()}.json`),
      aiService as never,
    );
  const adminOperationLogService = options?.adminOperationLogService ?? new FakeAdminOperationLogService();
  const groupMemoryStore = options?.groupMemoryStore ?? new FakeGroupMemoryStore();
  const knowledgeBaseStore = options?.knowledgeBaseStore ?? new FakeKnowledgeBaseStore();
  const groupMemoryCandidateService =
    options?.groupMemoryCandidateService ?? new FakeGroupMemoryCandidateService();
  const dailyProfileReviewService =
    options?.dailyProfileReviewService ?? new FakeDailyProfileReviewService();
  const profileRecordStore =
    options?.profileRecordStore ?? new ProfileRecordStore(`data/test-profile-records-${Date.now()}-${Math.random()}.json`);

  const app = new BotApplication(
    transport,
    groupConfigService as never,
    new FakeSkillService(options?.skills ?? [assistantSkill, teacherSkill]) as never,
    conversationStore as never,
    aiService as never,
    ttsService as never,
    dailyReportService as never,
    holidayCountdownService as never,
    scheduledReminderService,
    adminOperationLogService as never,
    new GroupLock(),
    new LiveChatService(),
    "12345",
    options?.allowNapCatAiVoiceFallback ?? false,
    groupMemoryStore as never,
    knowledgeBaseStore as never,
    groupMemoryCandidateService as never,
    dailyProfileReviewService as never,
    "https://bot.9958.uk",
    profileAiService as never,
    {
      gpt: "gpt-5.5",
      mimo: "mimo-v2.5-pro",
    },
    options?.systemSettingsStore as never,
    profileRecordStore,
  );

  return {
    app,
    transport,
    groupConfigService,
    aiService,
    profileAiService,
    conversationStore,
    ttsService,
    dailyReportService,
    holidayCountdownService,
    scheduledReminderService,
    adminOperationLogService,
    groupMemoryStore,
    knowledgeBaseStore,
    groupMemoryCandidateService,
    dailyProfileReviewService,
    profileRecordStore,
  };
}

test("responds to mentioned group message and stores dialogue", async () => {
  const { app, transport, aiService, conversationStore } = createApp();

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " summarize this " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "summarize this");
  assert.equal(transport.sent[0]?.text, "AI reply");
  assert.equal(conversationStore.turnsByKey["67890:20001"]?.length, 2);
});

test("admin mute suppresses normal replies until unmuted", async () => {
  const { app, transport, aiService, groupConfigService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.botMuted, true);
  assert.match(transport.sent[0]?.text ?? "", /已闭嘴/);

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好 " } },
    ]),
  );
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读" } }], 20002));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读" } }], 20003));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读" } }], 20004));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读" } }], 20005));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读" } }], 20006));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 1);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#说话" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.botMuted, false);

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent.at(-1)?.text, "AI reply");
});

test("mute command requires admin permission", async () => {
  const { app, transport, groupConfigService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 20001));

  assert.equal(groupConfigService.groups[0]?.botMuted, undefined);
  assert.match(transport.sent[0]?.text ?? "", /没有/);
});

test("admin status command summarizes current group controls", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const groupConfigService = new FakeGroupConfigService(
      [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant", "teacher"],
          switcherUserIds: ["99999"],
          liveChatUserIds: ["20001", "20002"],
          liveChatDelaySeconds: 45,
          liveChatDelayMinutes: 5,
          dailyReportEnabled: false,
          dailyReportTime: "18:00",
          dailyReportTopUserCount: 3,
          holidayCountdownEnabled: true,
          holidayCountdownTime: "09:30",
          scheduledRemindersEnabled: true,
          botMuted: true,
          blacklistedUserIds: ["30001"],
        },
      ],
      ["1569671790"],
    );
    const { app, transport } = createApp({ groupConfigService, scheduledReminderService });

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 添加 每小时提醒群友喝水" } }], 99999));
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 99999));

    const status = transport.sent.at(-1)?.text ?? "";
    assert.match(status, /机器人状态：群 67890/);
    assert.match(status, /说话：已闭嘴/);
    assert.match(status, /当前技能：assistant（assistant）/);
    assert.match(status, /实时对话：2 人，倒计时 45 秒/);
    assert.match(status, /定时任务：已开启，1 个/);
    assert.match(status, /群聊日报：已关闭/);
    assert.match(status, /节假日倒计时：已开启，09:30/);
    assert.match(status, /黑名单：1 人/);
    assert.match(status, /管理员：本群 1 人，超级 1 人/);
  });
});

test("status command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有查看机器人状态的权限/);
});

test("admin health command summarizes transport and local configuration", async () => {
  const transport = new FakeTransport();
  transport.healthStatus = { ok: false, detail: "反向 WebSocket 未连接" };
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "missing",
      allowedSkillIds: ["assistant", "missing"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      holidayCountdownEnabled: false,
      scheduledRemindersEnabled: true,
      blacklistedUserIds: ["30001"],
    },
  ]);
  const { app } = createApp({ transport, groupConfigService, skills: [assistantSkill] });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#健康检查" } }], 99999));

  const health = transport.sent.at(-1)?.text ?? "";
  assert.match(health, /健康检查：群 67890/);
  assert.match(health, /NapCat：异常，反向 WebSocket 未连接/);
  assert.match(health, /当前技能：异常，找不到 missing/);
  assert.match(health, /允许技能：异常，缺失 missing/);
  assert.match(health, /定时任务：总开关已开启，0 个/);
  assert.match(health, /节假日倒计时：已关闭/);
});

test("health command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#健康" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有查看机器人健康检查的权限/);
});

test("operation log command lists recent admin operations while muted", async () => {
  const { app, transport, adminOperationLogService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#操作日志" } }], 99999));

  const logMessage = transport.sent.at(-1)?.text ?? "";
  assert.equal(adminOperationLogService.entries.length, 1);
  assert.match(logMessage, /最近管理员操作：/);
  assert.match(logMessage, /99999 闭嘴/);
});

test("operation log command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#操作日志" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有查看机器人操作日志的权限/);
});

test("admin server command reports runtime details while muted", async () => {
  const transport = new FakeTransport();
  transport.healthStatus = { ok: true, detail: "测试传输层已连接" };
  const { app } = createApp({ transport });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#服务器" } }], 99999));

  const status = transport.sent.at(-1)?.text ?? "";
  assert.match(status, /服务器状态：/);
  assert.match(status, /主机：/);
  assert.match(status, /Node：/);
  assert.match(status, /进程运行：/);
  assert.match(status, /系统运行：/);
  assert.match(status, /CPU：/);
  assert.match(status, /内存：/);
  assert.match(status, /进程内存：/);
  assert.match(status, /工作目录：/);
  assert.match(status, /NapCat：正常，测试传输层已连接/);
});

test("server command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#服务器" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有查看服务器状态的权限/);
});

test("admin ops alert command manages current group setting while muted", async () => {
  const { app, transport, groupConfigService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 状态" } }], 99999));
  assert.match(transport.sent.at(-1)?.text ?? "", /运维告警：已开启/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 关闭" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.opsAlertsEnabled, false);
  assert.match(transport.sent.at(-1)?.text ?? "", /已关闭当前群运维告警/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 开启" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.opsAlertsEnabled, true);
  assert.match(transport.sent.at(-1)?.text ?? "", /已开启当前群运维告警/);
});

test("ops alert command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 状态" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有管理运维告警的权限/);
});

test("ops alert tick sends startup and napcat down alerts without automatic recovery alert", async () => {
  const transport = new FakeTransport();
  const { app } = createApp({ transport });
  const runOpsAlertTick = app as unknown as {
    runOpsAlertTick(options?: { now?: Date; includeStartup?: boolean }): Promise<void>;
  };

  await withMockedMemoryUsage({ total: 1000, free: 500 }, async () => {
    await runOpsAlertTick.runOpsAlertTick({
      now: new Date("2026-06-02T09:00:00.000Z"),
      includeStartup: true,
    });
    assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】服务已启动/);
    assert.match(transport.sent.at(-1)?.text ?? "", /\[CQ:at,qq=99999\]/);

    transport.healthStatus = { ok: false, detail: "反向 WebSocket 未连接" };
    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:01:00.000Z") });
    assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】NapCat 连接异常/);

    const countAfterDown = transport.sent.length;
    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:02:00.000Z") });
    assert.equal(transport.sent.length, countAfterDown);

    transport.healthStatus = { ok: true, detail: "反向 WebSocket 已连接" };
    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:03:00.000Z") });
    assert.equal(transport.sent.length, countAfterDown);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 状态" } }], 99999));
    assert.match(transport.sent.at(-1)?.text ?? "", /NapCat：正常，反向 WebSocket 已连接/);
  });
});

test("ops alert disabled groups do not receive automatic alerts", async () => {
  const transport = new FakeTransport();
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      opsAlertsEnabled: false,
    },
  ]);
  const { app } = createApp({ transport, groupConfigService });

  await (app as unknown as {
    runOpsAlertTick(options?: { now?: Date; includeStartup?: boolean }): Promise<void>;
  }).runOpsAlertTick({
    now: new Date("2026-06-02T09:00:00.000Z"),
    includeStartup: true,
  });

  assert.equal(transport.sent.length, 0);
});

test("ops alert sends failure alert after consecutive send failures and recovery on success", async () => {
  const transport = new FakeTransport();
  transport.allowOpsAlertWhenSendFails = true;
  const { app } = createApp({ transport });
  transport.sendGroupMessageError = new Error("send failed");

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 99999)),
      /send failed/,
    );
  }

  assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】消息发送连续失败 3 次/);

  transport.sendGroupMessageError = undefined;
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 99999));

  assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】消息发送已恢复/);
});

test("ops alert tick sends memory high alert and allows another alert after recovery", async () => {
  const originalMemoryUsage = process.memoryUsage;
  const mutableOs = os as unknown as {
    totalmem(): number;
    freemem(): number;
  };
  const originalOsTotalmem = mutableOs.totalmem;
  const originalOsFreemem = mutableOs.freemem;
  const transport = new FakeTransport();
  const { app } = createApp({ transport });
  const runOpsAlertTick = app as unknown as {
    runOpsAlertTick(options?: { now?: Date }): Promise<void>;
  };

  try {
    mutableOs.totalmem = () => 1000;
    mutableOs.freemem = () => 100;
    process.memoryUsage = (() => ({
      rss: 100,
      heapTotal: 100,
      heapUsed: 50,
      external: 0,
      arrayBuffers: 0,
    })) as typeof process.memoryUsage;

    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:00:00.000Z") });
    assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】内存占用偏高/);

    mutableOs.freemem = () => 300;
    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:01:00.000Z") });

    mutableOs.freemem = () => 100;
    await runOpsAlertTick.runOpsAlertTick({ now: new Date("2026-06-02T09:11:00.000Z") });
    assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】内存占用偏高/);
  } finally {
    process.memoryUsage = originalMemoryUsage;
    mutableOs.totalmem = originalOsTotalmem;
    mutableOs.freemem = originalOsFreemem;
  }
});

test("admin blacklist suppresses replies until unblocked while still recording reports", async () => {
  const { app, transport, aiService, groupConfigService, dailyReportService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 20001" } }], 99999));
  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, ["20001"]);
  assert.match(transport.sent[0]?.text ?? "", /已拉黑 20001/);

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好 " } },
    ], 20001),
  );
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音 你好" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "普通消息" } }], 20001));
  for (let index = 0; index < 4; index += 1) {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读这句" } }], 20001));
  }

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 1);
  assert.equal(dailyReportService.recorded.length, 7);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 解除 20001" } }], 99999));
  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, []);

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好 " } },
    ], 20001),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent.at(-1)?.text, "AI reply");
});

test("blacklist command requires admin and blacklisted non-admin commands stay silent", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
      blacklistedUserIds: ["20001"],
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 20002" } }], 20003));
  assert.match(transport.sent[0]?.text ?? "", /没有/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 解除 20001" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 20001));

  assert.equal(transport.sent.length, 1);
  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, ["20001"]);
});

test("blacklisted admin can unblock self but cannot run other commands while blocked", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
      blacklistedUserIds: ["99999"],
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 20001" } }], 99999));
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, ["99999"]);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 解除 99999" } }], 99999));

  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, []);
  assert.match(transport.sent[0]?.text ?? "", /已解除拉黑 99999/);
});

test("handles up to ten same-group bot conversations concurrently and queues later messages", async () => {
  const releases = Array.from({ length: 11 }, () => deferred());
  let started = 0;
  let active = 0;
  let maxActive = 0;
  const { app, transport, aiService } = createApp({
    aiService: new FakeAiService(async () => {
      const index = started;
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await releases[index]?.promise;
      active -= 1;
      return {
        text: `AI reply ${index + 1}`,
        model: "test-model",
        skillId: "assistant",
      };
    }),
  });

  const tasks = Array.from({ length: 11 }, (_, index) =>
    app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: ` 并发消息${index + 1}` } },
      ], 20001 + index),
    ),
  );

  await waitFor(() => started === 10);
  assert.equal(maxActive, 10);
  assert.equal(transport.sent.some((message) => message.text.includes("我还在处理上一条消息")), false);
  assert.equal(aiService.calls.length, 10);

  releases[0]?.resolve();
  await waitFor(() => started === 11);
  assert.equal(aiService.calls.length, 11);

  for (const release of releases.slice(1)) {
    release.resolve();
  }
  await Promise.all(tasks);

  assert.equal(transport.sent.length, 11);
  assert.equal(transport.sent.some((message) => message.text.includes("我还在处理上一条消息")), false);
  assert.equal(maxActive, 10);
});

test("passes group manual identity memory to ai replies", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      manualIdentities: [
        {
          userIds: ["1967410653"],
          names: ["小菜鸡", "前端哥"],
        },
        {
          userIds: ["927345463", "1551925371"],
          names: ["渣渣辉"],
        },
      ],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
    },
  ]);
  const { app, aiService } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 小菜鸡是谁 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext, {
    groupId: "67890",
    currentUserId: "20001",
    botUserId: "12345",
    manualIdentities: [
      {
        userIds: ["1967410653"],
        names: ["小菜鸡", "前端哥"],
      },
      {
        userIds: ["927345463", "1551925371"],
        names: ["渣渣辉"],
      },
    ],
  });
});

test("keeps conversation history isolated per user in the same group", async () => {
  const conversationStore = new FakeConversationStore();
  const { app, aiService } = createApp({ conversationStore });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " A 第一轮 " } },
    ], 20001),
  );
  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " A 第二轮 " } },
    ], 20001),
  );
  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " B 第一轮 " } },
    ], 20002),
  );

  assert.equal(aiService.calls[0]?.history.length, 0);
  assert.equal(aiService.calls[1]?.history.length, 2);
  assert.equal(aiService.calls[1]?.history[0]?.content, "A 第一轮");
  assert.equal(aiService.calls[2]?.history.length, 0);
  assert.equal(conversationStore.turnsByKey["67890:20001"]?.length, 4);
  assert.equal(conversationStore.turnsByKey["67890:20002"]?.length, 2);
});

test("keeps conversation history isolated for the same user across groups", async () => {
  const conversationStore = new FakeConversationStore();
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
    {
      groupId: "67891",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, aiService } = createApp({ conversationStore, groupConfigService });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " group one " } },
    ], 20001, 67890),
  );
  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " group two " } },
    ], 20001, 67891),
  );

  assert.equal(aiService.calls[0]?.history.length, 0);
  assert.equal(aiService.calls[1]?.history.length, 0);
  assert.equal(conversationStore.turnsByKey["67890:20001"]?.length, 2);
  assert.equal(conversationStore.turnsByKey["67891:20001"]?.length, 2);
});

test("responds to mentioned image message and passes image urls to ai service", async () => {
  const { app, transport, aiService } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "看到了，是一张测试图片",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "image", data: { url: "https://example.com/cat.png" } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "[图片消息]");
  assert.equal(aiService.calls[0]?.images?.length, 1);
  assert.equal(aiService.calls[0]?.images?.[0]?.url, "https://example.com/cat.png");
  assert.equal(transport.sent[0]?.text, "看到了，是一张测试图片");
});

test("ignores non-mentioned messages for ai reply but still records daily stats", async () => {
  const { app, transport, aiService, dailyReportService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "normal message" } }]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(dailyReportService.recorded.length, 1);
  assert.equal(dailyReportService.recorded[0]?.text, "normal message");
});

test("repeats the same plain group text on the fourth consecutive occurrence", async () => {
  const { app, transport, aiService } = createApp();

  for (let index = 0; index < 3; index += 1) {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读这句" } }], 20001 + index));
  }

  assert.equal(transport.sent.length, 0);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读这句" } }], 20004));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "复读这句");
});

test("repeat trigger resets on different text and ignores bot mentions", async () => {
  const { app, transport, aiService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "A" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "A" } }], 20002));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "B" } }], 20003));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "A" } }], 20004));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "A" } }], 20005));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "A" } }], 20006));
  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " A" } },
    ], 20007),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("builds chat summary from stored records when mentioned with time range request", async () => {
  const { app, transport, aiService, dailyReportService } = createApp();

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: "总结上午聊天信息" } },
    ]),
  );

  assert.equal(aiService.calls.length, 0);
  assert.equal(dailyReportService.recorded.length, 0);
  assert.equal(dailyReportService.summaries.length, 1);
  assert.equal(dailyReportService.summaries[0]?.label, "上午");
  assert.equal(transport.sent[0]?.text, "上午聊天总结");
});

test("muted bot still allows chat summary and report reminder commands", async () => {
  const { app, transport, aiService, dailyReportService } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
        botMuted: true,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 总结上面消息 " } },
    ]),
  );
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#日报 状态" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#节假日 状态" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 状态" } }], 99999));

  assert.equal(aiService.calls.length, 0);
  assert.equal(dailyReportService.summaries.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /总结/);
  assert.match(transport.sent[1]?.text ?? "", /群聊日报/);
  assert.match(transport.sent[2]?.text ?? "", /节假日倒计时/);
  assert.match(transport.sent[3]?.text ?? "", /定时任务总开关/);
});

test("lists available skills", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#技能 列表" } }]));

  assert.match(transport.sent[0]?.text ?? "", /assistant/);
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("shows feature list through help command", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能" } }]));

  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
  assert.match(transport.sent[0]?.text ?? "", /#技能 列表/);
  assert.match(transport.sent[0]?.text ?? "", /#管理员 列表/);
});

test("help aliases support 查看 and 列表 suffixes", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#帮助 查看" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#命令 列表" } }]));

  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
  assert.match(transport.sent[1]?.text ?? "", /系统功能总览/);
  assert.equal(transport.sent.length, 2);
});

test("help command supports category query", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能 技能" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#帮助 管理员" } }]));

  assert.match(transport.sent[0]?.text ?? "", /帮助分类：技能/);
  assert.match(transport.sent[0]?.text ?? "", /#技能 切换 <skillId>/);
  assert.match(transport.sent[1]?.text ?? "", /帮助分类：管理员/);
  assert.match(transport.sent[1]?.text ?? "", /#管理员 添加 <QQ号>/);
});

test("help command reports unknown category and falls back to overview", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#命令 火箭" } }]));

  assert.match(transport.sent[0]?.text ?? "", /没找到“火箭”这个帮助分类/);
  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
});

test("denies unauthorized skill switch", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 10000),
  );

  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /权限/);
});

test("switches skill for authorized user and clears context", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const conversationStore = new FakeConversationStore();
  const { app, transport } = createApp({
    groupConfigService,
    conversationStore,
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "teacher");
  assert.deepEqual(conversationStore.clearedGroups, ["67890"]);
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("denies unauthorized reply model switch", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#模型 切换 mimo" } }], 10000),
  );

  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /权限/);
});

test("switches enabled configured reply model for authorized user", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [enabledReplyModel()]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#模型 切换 reply-pro" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.replyModelMode, "reply-pro");
  assert.match(transport.sent[0]?.text ?? "", /reply-pro/);
});

test("supports compact reply model commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [enabledReplyModel()]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#模型切换 reply-pro" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#模型状态" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.replyModelMode, "reply-pro");
  assert.match(transport.sent[0]?.text ?? "", /已切换群聊回复模型/);
  assert.match(transport.sent[1]?.text ?? "", /当前群聊回复模型/);
  assert.match(transport.sent[1]?.text ?? "", /reply-pro/);
});

test("uses configured command primary and aliases at runtime", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "model",
        title: "模型",
        primary: "#模式",
        aliases: ["#模型选择"],
        permission: "group_admin",
        enabled: true,
        help: "查看或切换当前群回复模型",
        updatedAt: new Date().toISOString(),
      },
    ], [{ keyword: "乘风", enabled: true }], [enabledReplyModel()]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模式切换 reply-pro" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型选择状态" } }], 99999));

  assert.equal(groupConfigService.groups[0]?.replyModelMode, "reply-pro");
  assert.match(transport.sent[0]?.text ?? "", /已切换群聊回复模型/);
  assert.match(transport.sent[1]?.text ?? "", /当前群聊回复模型/);
});

test("disabled configured command does not fall back to built-in prefix", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "model",
        title: "模型",
        primary: "#模式",
        aliases: [],
        permission: "group_admin",
        enabled: false,
        help: "查看或切换当前群回复模型",
        updatedAt: new Date().toISOString(),
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型切换 mimo" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模式切换 mimo" } }], 99999));

  assert.equal(groupConfigService.groups[0]?.replyModelMode, undefined);
  assert.equal(transport.sent.length, 0);
});

test("disabled conversation command disables built-in clear alias", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey[toConversationKey("67890", "20001")] = [{
    role: "user",
    content: "hello",
    groupId: "67890",
    timestamp: new Date().toISOString(),
  }];
  const { app, transport } = createApp({
    conversationStore,
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "conversation",
        title: "对话",
        primary: "#上下文",
        aliases: ["#清上下文"],
        permission: "member",
        enabled: false,
        help: "清空或管理当前群对话上下文",
        updatedAt: new Date().toISOString(),
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#clear" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#上下文 清空" } }], 20001));

  assert.deepEqual(conversationStore.clearedUsers, []);
  assert.equal(transport.sent.length, 0);
});

test("runtime mute command supports configured primary and alias", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "mute",
        title: "静默模式",
        primary: "#安静",
        aliases: ["#恢复"],
        permission: "group_admin",
        enabled: true,
        help: "让机器人进入或退出静默模式",
        updatedAt: new Date().toISOString(),
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#安静" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.botMuted, true);
  assert.match(transport.sent.at(-1)?.text ?? "", /机器人已闭嘴/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#恢复" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.botMuted, false);
  assert.match(transport.sent.at(-1)?.text ?? "", /机器人已恢复说话/);
});

test("disabled runtime mute command does not fall back to built-in prefixes", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "mute",
        title: "静默模式",
        primary: "#安静",
        aliases: ["#恢复"],
        permission: "group_admin",
        enabled: false,
        help: "让机器人进入或退出静默模式",
        updatedAt: new Date().toISOString(),
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#安静" } }], 99999));

  assert.equal(groupConfigService.groups[0]?.botMuted, undefined);
  assert.equal(transport.sent.length, 0);
});

test("uses system default trigger keywords when group has no trigger keyword override", async () => {
  const { app, transport, aiService } = createApp({
    systemSettingsStore: new FakeSystemSettingsStore([], [
      { keyword: "小U", enabled: true },
      { keyword: "禁用词", enabled: false },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "小U 今天有什么安排" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "禁用词 不应该触发" } }], 20001));

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "小U 今天有什么安排");
  assert.equal(transport.sent.length, 1);
});

test("falls back to environment reply model when legacy group reply model is not configured", async () => {
  const gptAiService = new FakeAiService(async () => ({
    text: "GPT reply",
    model: "gpt-5.5",
    skillId: "assistant",
  }));
  const mimoAiService = new FakeAiService(async () => ({
    text: "Mimo reply",
    model: "mimo-v2.5-pro",
    skillId: "assistant",
  }));
  const { app, transport } = createApp({
    aiService: gptAiService,
    profileAiService: mimoAiService,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        replyModelMode: "mimo",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " hello " } },
    ]),
  );

  assert.equal(gptAiService.calls.length, 1);
  assert.equal(mimoAiService.calls.length, 0);
  assert.equal(transport.sent[0]?.text, "GPT reply");
});

test("shows configured reply model in model status list", async () => {
  const { app, transport } = createApp({
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [
      {
        id: "reply-runtime",
        name: "自定义回复模型",
        shortName: "reply-pro",
        baseUrl: "https://reply.example/v1",
        model: "reply-runtime-model",
        purpose: "reply",
        hasApiKey: true,
        enabled: true,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型状态" } }], 99999));

  assert.match(transport.sent.at(-1)?.text ?? "", /reply-pro（reply-runtime）/);
});

test("allows enabled configured reply model in switch list", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
    },
  ]);
  const { app, transport } = createApp({
    groupConfigService,
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [
      {
        id: "reply-pro",
        name: "自定义回复模型",
        shortName: "reply-pro",
        baseUrl: "https://reply.example/v1",
        model: "reply-runtime-model",
        purpose: "reply",
        hasApiKey: true,
        enabled: true,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型状态" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型切换 reply-pro" } }], 99999));

  assert.match(transport.sent[0]?.text ?? "", /reply-pro/);
  assert.equal(groupConfigService.groups[0]?.replyModelMode, "reply-pro");
  assert.match(transport.sent[1]?.text ?? "", /reply-pro/);
});

test("does not use profile model as reply fallback when environment reply model fails", async () => {
  const gptAiService = new FakeAiService(async () => {
    throw new Error("gpt unavailable");
  });
  const mimoAiService = new FakeAiService(async () => ({
    text: "Mimo fallback reply",
    model: "mimo-v2.5-pro",
    skillId: "assistant",
  }));
  const { app, transport } = createApp({
    aiService: gptAiService,
    profileAiService: mimoAiService,
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " hello " } },
    ]),
  );

  assert.equal(gptAiService.calls.length, 1);
  assert.equal(mimoAiService.calls.length, 0);
  assert.match(transport.sent[0]?.text ?? "", /思考超时/);
});

test("falls back to environment reply model when legacy mimo mode fails to match enabled reply models", async () => {
  const gptAiService = new FakeAiService(async () => ({
    text: "GPT fallback reply",
    model: "gpt-5.5",
    skillId: "assistant",
  }));
  const mimoAiService = new FakeAiService(async () => {
    throw new Error("mimo unavailable");
  });
  const { app, transport } = createApp({
    aiService: gptAiService,
    profileAiService: mimoAiService,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        replyModelMode: "mimo",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " hello " } },
    ]),
  );

  assert.equal(mimoAiService.calls.length, 0);
  assert.equal(gptAiService.calls.length, 1);
  assert.equal(transport.sent[0]?.text, "GPT fallback reply");
});

test("conversation clear command clears own context for normal users", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20001"] = [
    {
      groupId: "67890",
      role: "user",
      content: "old",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#对话 清空" } }], 20001));

  assert.deepEqual(conversationStore.clearedUsers, [{ groupId: "67890", userId: "20001" }]);
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.match(transport.sent[0]?.text ?? "", /已清空你/);
});

test("conversation clear command lets admins clear a target user or the whole group", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20001"] = [
    {
      groupId: "67890",
      role: "user",
      content: "user history",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
  ];
  conversationStore.turnsByKey["67890:20002"] = [
    {
      groupId: "67890",
      role: "user",
      content: "other history",
      userId: "20002",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#对话 清空 20001" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#对话 清空 全部" } }], 99999));

  assert.deepEqual(conversationStore.clearedUsers, [{ groupId: "67890", userId: "20001" }]);
  assert.deepEqual(conversationStore.clearedGroups, ["67890"]);
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.equal(conversationStore.turnsByKey["67890:20002"], undefined);
  assert.match(transport.sent[0]?.text ?? "", /20001/);
  assert.match(transport.sent[1]?.text ?? "", /全部成员/);
});

test("#clear command lets admins clear all current-group contexts", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20001"] = [
    {
      groupId: "67890",
      role: "user",
      content: "user history",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
  ];
  conversationStore.turnsByKey["67890:20002"] = [
    {
      groupId: "67890",
      role: "user",
      content: "other history",
      userId: "20002",
      timestamp: new Date().toISOString(),
    },
  ];
  conversationStore.turnsByKey["67891:20001"] = [
    {
      groupId: "67891",
      role: "user",
      content: "other group history",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#clear" } }], 99999));

  assert.deepEqual(conversationStore.clearedGroups, ["67890"]);
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.equal(conversationStore.turnsByKey["67890:20002"], undefined);
  assert.equal(conversationStore.turnsByKey["67891:20001"]?.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /全部成员/);
});

test("#clear command denies non-admin users", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20001"] = [
    {
      groupId: "67890",
      role: "user",
      content: "user history",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#clear" } }], 20001));

  assert.equal(conversationStore.clearedGroups.length, 0);
  assert.equal(conversationStore.turnsByKey["67890:20001"]?.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /权限/);
});

test("conversation clear command lets admins clear a mentioned user", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20002"] = [
    {
      groupId: "67890",
      role: "user",
      content: "mentioned user history",
      userId: "20002",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(
    createEvent([
      { type: "text", data: { text: "#对话 清空 " } },
      { type: "at", data: { qq: "20002" } },
    ], 99999),
  );

  assert.deepEqual(conversationStore.clearedUsers, [{ groupId: "67890", userId: "20002" }]);
  assert.equal(conversationStore.turnsByKey["67890:20002"], undefined);
  assert.match(transport.sent[0]?.text ?? "", /20002/);
});

test("conversation clear command denies non-admin attempts to clear another user", async () => {
  const conversationStore = new FakeConversationStore();
  const { app, transport } = createApp({ conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#对话 清空 20002" } }], 20001));

  assert.equal(conversationStore.clearedUsers.length, 0);
  assert.equal(conversationStore.clearedGroups.length, 0);
  assert.match(transport.sent[0]?.text ?? "", /权限/);
});

test("super admin can add and remove group admins, while normal admin cannot", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ],
    ["88888"],
  );
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 添加 77777" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 添加 77777" } }], 88888),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 列表" } }], 77777),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 移除 77777" } }], 88888),
  );

  assert.match(transport.sent[0]?.text ?? "", /没有管理管理员的权限/);
  assert.match(transport.sent[1]?.text ?? "", /已将 77777 设为本群管理员/);
  assert.match(transport.sent[2]?.text ?? "", /本群管理员/);
  assert.match(transport.sent[2]?.text ?? "", /超级管理员：88888/);
  assert.match(transport.sent[3]?.text ?? "", /已移除管理员 77777/);
});

test("super admin can use admin-only commands without being in group admin list", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ],
    ["88888"],
  );
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 88888),
  );

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "teacher");
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("sends voice reply for voice command", async () => {
  const { app, transport, aiService, ttsService } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "这事可以做",
      model: "test-model",
      skillId: "assistant",
    })),
    ttsService: new FakeTtsService(async () => ({
      filePath: "D:/tmp/voice.wav",
      recordFile: "base64://dm9pY2U=",
      async cleanup() {},
    })),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音 现在怎么做" } }]));

  assert.equal(aiService.calls[0]?.userInput, "现在怎么做");
  assert.equal(ttsService.calls[0]?.text, "这事可以做");
  assert.equal(transport.records[0]?.recordFile, "base64://dm9pY2U=");
  assert.equal(transport.sent.length, 0);
});

test("disabled voice command also blocks at-mention voice wording", async () => {
  const { app, transport, aiService, ttsService } = createApp({
    systemSettingsStore: new FakeSystemSettingsStore([
      {
        id: "voice",
        title: "语音",
        primary: "#语音",
        aliases: [],
        permission: "member",
        enabled: false,
        help: "生成语音回复",
        updatedAt: new Date().toISOString(),
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 语音说 现在怎么做" } },
    ]),
  );

  assert.equal(aiService.calls.length, 0);
  assert.equal(ttsService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.records.length, 0);
});

test("falls back to text when both tts and ai voice fail", async () => {
  const transport = new FakeTransport();
  transport.sendGroupAiRecord = async () => {
    throw new Error("ai voice failed");
  };

  const { app } = createApp({
    transport,
    aiService: new FakeAiService(async () => ({
      text: "先说结论，可以做",
      model: "test-model",
      skillId: "assistant",
    })),
    ttsService: new FakeTtsService(async () => {
      throw new Error("tts failed");
    }),
    allowNapCatAiVoiceFallback: true,
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 语音说 这事怎么做 " } },
    ]),
  );

  assert.equal(transport.records.length, 0);
  assert.equal(transport.aiRecords.length, 0);
  assert.equal(transport.sent[0]?.text, "语音发送失败，我先用文字回复你");
  assert.match(transport.sent[1]?.text ?? "", /先说结论/);
});

test("group voice reply switch blocks voice command without affecting text replies", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      voiceReplyEnabled: false,
    },
  ]);
  const { app, transport, aiService, ttsService } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音 现在怎么做" } }]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 正常问一句" } },
  ]));

  assert.equal(ttsService.calls.length, 0);
  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "正常问一句");
  assert.equal(transport.records.length, 0);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("manages live chat users through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 添加 1569671790" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 列表" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 移除 1569671790" } }], 99999),
  );

  assert.deepEqual(groupConfigService.groups[0]?.liveChatUserIds, []);
  assert.match(transport.sent[0]?.text ?? "", /1569671790/);
  assert.match(transport.sent[1]?.text ?? "", /1569671790/);
  assert.match(transport.sent[2]?.text ?? "", /移除/);
});

test("buffers tracked users and replies during live chat tick when bot stayed silent", async () => {
  const { app, aiService, transport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
        aiService: new FakeAiService(async () => ({
          text: "我接一句",
          model: "test-model",
          skillId: "assistant",
        })),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "第一句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:00:30.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "第二句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "1. 第一句\n2. 第二句");
  assert.equal(transport.sent.at(-1)?.text, "[CQ:at,qq=20001] 我接一句");
});

test("live chat only mentions the tracked speaker when their message mentions someone else", async () => {
  const { app, aiService, transport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
        aiService: new FakeAiService(async () => ({
          text: "我接一句",
          model: "test-model",
          skillId: "assistant",
        })),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "55667788" } },
        { type: "text", data: { text: " 你看这个 " } },
      ], 20001),
    );
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "@55667788 你看这个");
  assert.equal(transport.sent.at(-1)?.text, "[CQ:at,qq=20001] 我接一句");
});

test("suppresses live chat tick when bot already spoke in the same window", async () => {
  const { app, aiService, transport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "我先发一句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:00:30.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: "正常问一句" } },
      ]),
    );
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "正常问一句");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("updates live chat delay through command", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 间隔 2" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 列表" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.liveChatDelayMinutes, 2);
  assert.match(transport.sent[0]?.text ?? "", /2 分钟/);
  assert.match(transport.sent[1]?.text ?? "", /2 分钟/);
});

test("does not auto-mention third-party members from explicit bot conversations", async () => {
  const { app, transport } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "我替你带到了",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "67890" } },
      { type: "text", data: { text: " 你和他说今天别迟到" } },
    ]),
  );

  assert.equal(transport.sent[0]?.text, "我替你带到了");
});

test("does not auto-mention qq numbers from explicit bot conversations", async () => {
  const { app, transport } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "收到，我去说",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你和 55667788 说，他昨天把群文件删了" } },
    ]),
  );

  assert.equal(transport.sent[0]?.text, "收到，我去说");
});

test("sanitizes third-party mention echoes from explicit bot conversations", async () => {
  const { app, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["55667788"],
            names: ["飞哥", "群主"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(async () => ({
      text: "[CQ:at,qq=55667788] @飞哥 @55667788 怎么说",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "55667788" } },
      { type: "text", data: { text: " 给我个管理 " } },
    ]),
  );

  assert.equal(transport.sent[0]?.text, "飞哥 飞哥 飞哥 怎么说");
  assert.equal(transport.sent[0]?.text.includes("[CQ:at,qq=55667788]"), false);
  assert.equal(transport.sent[0]?.text.includes("@55667788"), false);
  assert.equal(transport.sent[0]?.text.includes("@飞哥"), false);
});

test("uses manual identity names for newly configured third-party mentions", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "866209871",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["3554621866"],
            names: ["达文西"],
          },
          {
            userIds: ["1569671790"],
            names: ["季博霸王", "超级管理员"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(async () => ({
      text: "[CQ:at,qq=3554621866] @达文西 收到",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "3554621866" } },
      { type: "text", data: { text: " 看下这个 " } },
    ], 20001, 866209871),
  );

  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [
    {
      userId: "3554621866",
      names: ["达文西"],
      source: "mention",
    },
  ]);
  assert.equal(transport.sent[0]?.text, "达文西 达文西 收到");
  assert.equal(transport.sent[0]?.text.includes("[CQ:at,qq=3554621866]"), false);
  assert.equal(transport.sent[0]?.text.includes("@达文西"), false);
});

test("controlled mention prefixes a configured manual identity when ai agrees", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["429462108"],
            names: ["悠米"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(
      async () => ({
        text: "行吧，我帮你叫一下悠米",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: true,
        target: "悠米",
      }),
    ),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 帮我叫一下悠米 " } },
    ]),
  );

  assert.equal(aiService.controlledMentionCalls.length, 1);
  assert.equal(aiService.controlledMentionCalls[0]?.assistantReply, "行吧，我帮你叫一下悠米");
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=429462108] 行吧，我帮你叫一下悠米");
});

test("controlled mention does not prefix when ai refuses", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["429462108"],
            names: ["悠米"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(
      async () => ({
        text: "不叫，别折腾人家",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: false,
        target: "悠米",
      }),
    ),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 帮我叫一下悠米 " } },
    ]),
  );

  assert.equal(aiService.controlledMentionCalls.length, 1);
  assert.equal(transport.sent[0]?.text, "不叫，别折腾人家");
});

test("controlled mention can use conversation history after persuasion", async () => {
  const conversationStore = new FakeConversationStore();
  conversationStore.turnsByKey["67890:20001"] = [
    {
      groupId: "67890",
      role: "user",
      content: "帮我叫一下悠米",
      userId: "20001",
      timestamp: new Date().toISOString(),
    },
    {
      groupId: "67890",
      role: "assistant",
      content: "先别叫，没必要",
      timestamp: new Date().toISOString(),
    },
  ];
  const { app, aiService, transport } = createApp({
    conversationStore,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["429462108"],
            names: ["悠米"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(
      async () => ({
        text: "行，被你说服了，我叫悠米",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: true,
        target: "悠米",
      }),
    ),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 真有急事，你帮我叫一下 " } },
    ]),
  );

  assert.equal(aiService.controlledMentionCalls[0]?.history.length, 2);
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=429462108] 行，被你说服了，我叫悠米");
});

test("controlled mention ignores unconfigured and ambiguous targets", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      manualIdentities: [
        {
          userIds: ["10001"],
          names: ["小张"],
        },
        {
          userIds: ["10002"],
          names: ["小张"],
        },
      ],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const ambiguous = createApp({
    groupConfigService,
    aiService: new FakeAiService(
      async () => ({
        text: "我叫小张",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: true,
        target: "小张",
      }),
    ),
  });

  await ambiguous.app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 叫小张 " } },
    ]),
  );

  const unconfigured = createApp({
    groupConfigService,
    aiService: new FakeAiService(
      async () => ({
        text: "我叫老王",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: true,
        target: "老王",
      }),
    ),
  });

  await unconfigured.app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 叫老王 " } },
    ]),
  );

  assert.equal(ambiguous.transport.sent[0]?.text, "我叫小张");
  assert.equal(unconfigured.transport.sent[0]?.text, "我叫老王");
});

test("controlled mention stays disabled for active triggers and existing mention prefixes", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "866209871",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: ["20001"],
      liveChatDelayMinutes: 1,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      manualIdentities: [
        {
          userIds: ["429462108"],
          names: ["悠米"],
        },
      ],
    },
  ]);
  const { app, aiService, transport } = createApp({
    groupConfigService,
    aiService: new FakeAiService(
      async () => ({
        text: "我叫悠米",
        model: "test-model",
        skillId: "assistant",
      }),
      async () => ({
        shouldMention: true,
        target: "悠米",
      }),
    ),
  });

  await withMockedNow(Date.parse("2026-05-26T06:00:00.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([{ type: "text", data: { text: "乘风帮我叫悠米" } }], 20001, 866209871),
    );
  });
  await withMockedNow(Date.parse("2026-05-26T06:02:00.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([{ type: "text", data: { text: "帮我叫悠米" } }], 20001, 866209871),
    );
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.controlledMentionCalls.length, 0);
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=20001] 我叫悠米");
  assert.equal(transport.sent[1]?.text, "[CQ:at,qq=20001] 我叫悠米");
});

test("falls back to group member names before raw qq for numeric mentions", async () => {
  const { app, aiService } = createApp();

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "55667788" } },
      { type: "text", data: { text: " 你问问他 " } },
    ]),
  );

  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [
    {
      userId: "55667788",
      names: ["张三", "老张", "55667788"],
      source: "mention",
    },
  ]);
});

test("falls back to raw qq when neither manual identity nor member name is known", async () => {
  const transport = new FakeTransport();
  transport.memberDirectoryByGroup["67890"] = [];
  const { app, aiService } = createApp({ transport });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "99887766" } },
      { type: "text", data: { text: " 你问问他 " } },
    ]),
  );

  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [
    {
      userId: "99887766",
      names: ["99887766"],
      source: "mention",
    },
  ]);
});

test("passes referenced message context to explicit bot conversations", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9001"] = {
    messageId: "9001",
    userId: "1418509802",
    userName: "群名片鸡哥",
    text: "原消息内容",
    images: [],
  };
  const { app, aiService } = createApp({
    transport,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        manualIdentities: [
          {
            userIds: ["1418509802"],
            names: ["鸡哥"],
          },
        ],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "reply", data: { id: "9001" } },
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 这句话什么意思 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext?.replyContext, {
    messageId: "9001",
    userId: "1418509802",
    userName: "鸡哥",
    text: "原消息内容",
    images: [],
  });
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [
    {
      userId: "1418509802",
      names: ["鸡哥"],
      source: "reply",
    },
  ]);
});

test("passes referenced message images to explicit bot conversations", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9002"] = {
    messageId: "9002",
    userId: "1418509802",
    userName: "鸡哥",
    text: "看看这张图",
    images: [
      {
        file: "ref-image-001.image",
        summary: "[图片]",
      },
    ],
  };
  const { app, aiService } = createApp({ transport });

  await app.handleGroupMessage(
    createEvent([
      { type: "reply", data: { id: "9002" } },
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 这图里是什么 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.replyContext?.text, "看看这张图 [图片 1 张]");
  assert.equal(aiService.calls[0]?.images?.length, 1);
  assert.equal(aiService.calls[0]?.images?.[0]?.url, "https://resolved.example/ref-image-001.image.png");
});

test("ordinary referenced messages do not trigger ai replies by themselves", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9001"] = {
    messageId: "9001",
    userId: "1418509802",
    userName: "鸡哥",
    text: "原消息内容",
    images: [],
  };
  const { app, aiService } = createApp({ transport });

  await app.handleGroupMessage(
    createEvent([
      { type: "reply", data: { id: "9001" } },
      { type: "text", data: { text: " 普通回复 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 0);
});

test("referenced message lookup failure does not block explicit replies", async () => {
  const transport = new FakeTransport();
  transport.getMessageError = new Error("get_msg failed");
  const { app, aiService, transport: usedTransport } = createApp({ transport });

  await app.handleGroupMessage(
    createEvent([
      { type: "reply", data: { id: "9001" } },
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 继续回复 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.replyContext, undefined);
  assert.equal(usedTransport.sent[0]?.text, "AI reply");
});

test("passes referenced message context to live chat replies", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9001"] = {
    messageId: "9001",
    userId: "1418509802",
    userName: "鸡哥",
    text: "原消息内容",
    images: [],
  };
  const { app, aiService, transport: usedTransport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        transport,
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "reply", data: { id: "9001" } },
        { type: "text", data: { text: " 那这个呢 " } },
      ], 20001),
    );
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.replyContext?.text, "原消息内容");
  assert.equal(aiService.calls[0]?.identityContext?.interactionTargets?.[0]?.userId, "1418509802");
  assert.match(usedTransport.sent.at(-1)?.text ?? "", /^\[CQ:at,qq=20001\]/);
});

test("chengfeng keyword triggers active conversation only in configured group and mentions speaker", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "866209871",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "乘风今天在不在" } }], 20001, 866209871),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "乘风今天在不在" } }], 20001, 67890),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "乘风今天在不在");
  assert.match(transport.sent[0]?.text ?? "", /^\[CQ:at,qq=20001\] AI reply/);
});

test("chengfeng keyword triggers repeatedly for the same speaker without cooldown", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "866209871",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "乘风来一下" } }], 20001, 866209871),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "乘风再来一下" } }], 20001, 866209871),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "乘风我也问一下" } }], 20002, 866209871),
  );

  assert.equal(aiService.calls.length, 3);
  assert.deepEqual(
    transport.sent.map((item) => item.text),
    [
      "[CQ:at,qq=20001] AI reply",
      "[CQ:at,qq=20001] AI reply",
      "[CQ:at,qq=20002] AI reply",
    ],
  );
});

test("chengfeng keyword does not double-trigger explicit bot conversations", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "866209871",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 乘风怎么说 " } },
    ], 20001, 866209871),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("manages daily report settings through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 时间 19:30" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 关闭" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 状态" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.dailyReportTime, "19:30");
  assert.equal(groupConfigService.groups[0]?.dailyReportEnabled, false);
  assert.match(transport.sent[0]?.text ?? "", /19:30/);
  assert.match(transport.sent[1]?.text ?? "", /关闭/);
  assert.match(transport.sent[2]?.text ?? "", /19:30/);
});

test("sends scheduled daily report once tick condition is met", async () => {
  const dailyReportService = new FakeDailyReportService(
    async () => true,
    async () => "18:00 群聊日报\n今日消息 12 条",
  );
  const { app, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    dailyReportService,
  });

  await (app as unknown as { runDailyReportTick(now?: Date): Promise<void> }).runDailyReportTick(
    new Date("2026-04-15T10:00:00.000Z"),
  );

  assert.equal(transport.sent.at(-1)?.text, "18:00 群聊日报\n今日消息 12 条");
  assert.equal(dailyReportService.marked.length, 1);
});

test("creates scheduled reminder through natural bot mention and sends due reminders", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const { app, transport } = createApp({ aiService, scheduledReminderService });

    await withMockedNow(Date.parse("2026-05-27T01:00:00.000Z"), async () => {
      await app.handleGroupMessage(
        createEvent([
          { type: "at", data: { qq: "12345" } },
          { type: "text", data: { text: " 设置定时任务一个小时提醒群友喝水 " } },
        ]),
      );
    });

    assert.match(transport.sent[0]?.text ?? "", /^已设置定时任务 rem-/);
    assert.match(transport.sent[0]?.text ?? "", /每 1 小时 提醒群友喝水/);

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T01:59:59.000Z"),
    );
    assert.equal(transport.sent.length, 1);

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T02:00:00.000Z"),
    );
    assert.equal(transport.sent[1]?.text, "【提醒喝水小助手】提醒：喝水");

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T03:00:00.000Z"),
    );
    assert.equal(transport.sent[2]?.text, "【提醒喝水小助手】又到点了，继续喝水");
  });
});

test("disabled scheduled reminder command blocks natural bot mention creation", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const { app, transport } = createApp({
      aiService,
      scheduledReminderService,
      systemSettingsStore: new FakeSystemSettingsStore([
        {
          id: "scheduled_reminder",
          title: "定时任务",
          primary: "#定时任务",
          aliases: [],
          permission: "group_admin",
          enabled: false,
          help: "管理群定时任务",
          updatedAt: new Date().toISOString(),
        },
      ]),
    });

    await withMockedNow(Date.parse("2026-05-27T01:00:00.000Z"), async () => {
      await app.handleGroupMessage(
        createEvent([
          { type: "at", data: { qq: "12345" } },
          { type: "text", data: { text: " 设置定时任务一个小时提醒群友喝水 " } },
        ]),
      );
    });

    assert.equal(transport.sent.length, 0);
    assert.equal((await scheduledReminderService.listGroupTasks("67890")).length, 0);
  });
});

test("manages scheduled reminder list and delete commands", async () => {
  const aiService = new FakeAiService(async () => ({
      text: "AI reply",
      model: "test-model",
      skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const { app, transport } = createApp({ scheduledReminderService });

    await withMockedNow(Date.parse("2026-05-27T10:00:00.000Z"), async () => {
      await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 添加 每小时提醒群友喝水" } }]));
    });
    const taskId = transport.sent[0]?.text.match(/(rem-\d+(?:-\d+)?)/)?.[1];
    assert.ok(taskId);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 列表" } }]));
    assert.match(transport.sent[1]?.text ?? "", new RegExp(taskId));
    assert.match(transport.sent[1]?.text ?? "", /喝水/);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: `#定时任务 删除 ${taskId}` } }]));
    assert.equal(transport.sent[2]?.text, `已删除定时任务 ${taskId}`);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 列表" } }]));
    assert.match(transport.sent[3]?.text ?? "", /定时任务总开关：已开启/);
    assert.match(transport.sent[3]?.text ?? "", /当前群还没有定时任务/);
  });
});

test("scheduled reminder group switch pauses and resumes due tasks", async () => {
  const aiService = new FakeAiService(async () => ({
      text: "AI reply",
      model: "test-model",
      skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const groupConfigService = new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
      {
        groupId: "67891",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ]);
    const { app, transport } = createApp({ groupConfigService, scheduledReminderService });

    await withMockedNow(Date.parse("2026-05-27T01:00:00.000Z"), async () => {
      await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 添加 每小时提醒群友喝水" } }], 99999, 67890));
    });
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 关闭" } }], 99999, 67890));

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T02:00:00.000Z"),
    );

    assert.equal(groupConfigService.groups[0]?.scheduledRemindersEnabled, false);
    assert.equal(transport.sent.filter((message) => message.groupId === "67890" && message.text.startsWith("【提醒")).length, 0);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 开启" } }], 99999, 67890));
    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T02:01:00.000Z"),
    );

    assert.equal(groupConfigService.groups[0]?.scheduledRemindersEnabled, true);
    assert.equal(transport.sent.filter((message) => message.groupId === "67890" && message.text.startsWith("【提醒")).length, 1);
  });
});

test("manages holiday countdown settings through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 时间 08:30" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 关闭" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 状态" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.holidayCountdownTime, "08:30");
  assert.equal(groupConfigService.groups[0]?.holidayCountdownEnabled, false);
  assert.match(transport.sent[0]?.text ?? "", /08:30/);
  assert.match(transport.sent[1]?.text ?? "", /关闭/);
  assert.match(transport.sent[2]?.text ?? "", /节假日倒计时/);
});

test("sends scheduled holiday countdown once tick condition is met", async () => {
  const holidayCountdownService = new FakeHolidayCountdownService(
    async () => true,
    () => "节假日倒计时\n1. 劳动节：还有 16 天",
  );
  const { app, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ]),
    holidayCountdownService,
  });

  await (
    app as unknown as { runHolidayCountdownTick(now?: Date): Promise<void> }
  ).runHolidayCountdownTick(new Date("2026-04-15T01:00:00.000Z"));

  assert.equal(transport.sent.at(-1)?.text, "节假日倒计时\n1. 劳动节：还有 16 天");
  assert.equal(holidayCountdownService.marked.length, 1);
});

test("injects approved group memory and keyword knowledge into AI replies", async () => {
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [
    {
      id: "mem-1",
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Tester 偏好",
      content: "Tester 喜欢简短回答。",
      confidence: 0.8,
      source: "admin",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      enabled: true,
    },
  ];
  const knowledgeBaseStore = new FakeKnowledgeBaseStore();
  knowledgeBaseStore.entries = [
    {
      id: "faq-1",
      groupId: "67890",
      title: "报销规则",
      question: "怎么报销",
      answer: "先贴发票，再找管理员登记。",
      keywords: ["报销"],
      enabled: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];
  const { app, aiService } = createApp({ groupMemoryStore, knowledgeBaseStore });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 我要报销" } },
    ]),
  );

  assert.equal(aiService.calls[0]?.identityContext?.groupMemories?.[0]?.content, "Tester 喜欢简短回答。");
  assert.equal(aiService.calls[0]?.identityContext?.knowledgeHits?.[0]?.answer, "先贴发票，再找管理员登记。");
  assert.match(knowledgeBaseStore.queries[0]?.query ?? "", /我要报销/);
});

test("queues ordinary messages for memory candidates but skips commands", async () => {
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const { app } = createApp({ groupMemoryCandidateService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "我以后喜欢简短回答" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 99999));

  assert.equal(groupMemoryCandidateService.queued.length, 1);
  assert.equal(groupMemoryCandidateService.queued[0]?.text, "我以后喜欢简短回答");
});

test("disabled group ignores replies reports and memory collection", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      enabled: false,
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: ["20001"],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      triggerKeywords: [{ keyword: "乘风", enabled: true }],
    },
  ]);
  const dailyReportService = new FakeDailyReportService();
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const { app, transport, aiService } = createApp({
    groupConfigService,
    dailyReportService,
    groupMemoryCandidateService,
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 正常问一句" } },
  ]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "乘风 今天在吗" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "普通聊天要进日报和记忆吗" } }]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(dailyReportService.recorded.length, 0);
  assert.equal(groupMemoryCandidateService.queued.length, 0);
});

test("disabled group is excluded from automatic reports reminders alerts and memory flush", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  const dailyReportService = new FakeDailyReportService(
    async () => true,
    async () => "daily report should not send",
  );
  const holidayCountdownService = new FakeHolidayCountdownService(
    async () => true,
    () => "holiday countdown should not send",
  );
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const transport = new FakeTransport();
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const groupConfigService = new FakeGroupConfigService([
      {
        groupId: "67890",
        enabled: false,
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
        scheduledRemindersEnabled: true,
        opsAlertsEnabled: true,
      },
    ]);
    await scheduledReminderService.createTask({
      groupId: "67890",
      creatorUserId: "99999",
      request: { intervalMinutes: 60, topic: "hidden group reminder" },
      now: new Date("2026-05-27T01:00:00.000Z"),
    });
    const { app } = createApp({
      transport,
      groupConfigService,
      aiService,
      dailyReportService,
      holidayCountdownService,
      scheduledReminderService,
      groupMemoryCandidateService,
    });

    await (app as unknown as { runDailyReportTick(now?: Date): Promise<void> }).runDailyReportTick(
      new Date("2026-05-27T02:00:00.000Z"),
    );
    await (app as unknown as { runHolidayCountdownTick(now?: Date): Promise<void> }).runHolidayCountdownTick(
      new Date("2026-05-27T02:00:00.000Z"),
    );
    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date("2026-05-27T02:00:00.000Z"),
    );
    await (app as unknown as { runOpsAlertTick(options?: { now?: Date; includeStartup?: boolean }): Promise<void> }).runOpsAlertTick({
      now: new Date("2026-05-27T02:00:00.000Z"),
      includeStartup: true,
    });
    await (app as unknown as { runMemoryCandidateFlushTick(): Promise<void> }).runMemoryCandidateFlushTick();

    assert.equal(transport.sent.length, 0);
    assert.equal(dailyReportService.reports.length, 0);
    assert.equal(dailyReportService.marked.length, 0);
    assert.equal(holidayCountdownService.marked.length, 0);
    assert.equal(groupMemoryCandidateService.flushAllCalls, 1);
    assert.deepEqual(groupMemoryCandidateService.flushAllGroupIds, []);
  });
});

test("disabled member memory collection still allows reports and replies", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      memoryDisabledUserIds: ["20001"],
    },
  ]);
  const dailyReportService = new FakeDailyReportService();
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const { app, transport, aiService } = createApp({
    groupConfigService,
    dailyReportService,
    groupMemoryCandidateService,
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "我以后喜欢简短回答" } }]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 正常问一句" } },
  ]));

  assert.equal(groupMemoryCandidateService.queued.length, 0);
  assert.equal(dailyReportService.recorded.length, 2);
  assert.equal(dailyReportService.recorded[0]?.text, "我以后喜欢简短回答");
  assert.equal(dailyReportService.recorded[1]?.text, "正常问一句");
  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "正常问一句");
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("periodically flushes queued memory candidate messages", async () => {
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const { app } = createApp({ groupMemoryCandidateService });

  await (app as unknown as { runMemoryCandidateFlushTick(): Promise<void> }).runMemoryCandidateFlushTick();

  assert.equal(groupMemoryCandidateService.flushAllCalls, 1);
  assert.deepEqual(groupMemoryCandidateService.flushAllGroupIds, ["67890"]);
});

test("memory candidate flush excludes disabled groups", async () => {
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      enabled: false,
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
    },
    {
      groupId: "24680",
      enabled: true,
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
    },
  ]);
  const { app } = createApp({ groupConfigService, groupMemoryCandidateService });

  await (app as unknown as { runMemoryCandidateFlushTick(): Promise<void> }).runMemoryCandidateFlushTick();

  assert.deepEqual(groupMemoryCandidateService.flushAllGroupIds, ["24680"]);
});

test("skips memory candidate flush when profile AI is unhealthy", async () => {
  const groupMemoryCandidateService = new FakeGroupMemoryCandidateService();
  const profileAiService = new FakeAiService(async () => ({
    text: "profile reply",
    model: "profile-model",
    skillId: "assistant",
  }));
  profileAiService.healthOk = false;
  const { app, aiService } = createApp({ groupMemoryCandidateService, profileAiService });

  await (app as unknown as { runMemoryCandidateFlushTick(): Promise<void> }).runMemoryCandidateFlushTick();

  assert.equal(profileAiService.healthCalls, 1);
  assert.equal(groupMemoryCandidateService.flushAllCalls, 0);
  assert.equal(aiService.calls.length, 0);
});

test("profile commands allow self and admin queries with member aliases", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      manualIdentities: [
        {
          userIds: ["20001"],
          names: ["Tester"],
          note: "测试同学",
        },
      ],
    },
  ]);
  const dailyProfileReviewService = new FakeDailyProfileReviewService();
  dailyProfileReviewService.dailySummaries.set("67890:20001:2026-06-01", {
    id: "m1",
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "20001",
    title: "2026-06-01 昨日画像总结",
    content: "Tester 昨日新增画像总结",
    confidence: 0.8,
    source: "daily_profile_review:2026-06-01",
    createdAt: "2026-06-02T00:01:00.000Z",
    updatedAt: "2026-06-02T00:01:00.000Z",
    enabled: true,
  });
  const { app, transport, profileRecordStore } = createApp({ groupConfigService, dailyProfileReviewService });

  await withMockedNow(Date.parse("2026-06-02T00:10:00+08:00"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#昨日画像" } }], 20001));
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#群聊画像 测试同学" } }], 99999));
  });

  assert.match(transport.sent[0]?.text ?? "", /Tester 昨日新增画像总结/);
  assert.match(transport.sent[1]?.text ?? "", /整体画像总结/);
  assert.match(transport.sent[0]?.text ?? "", /完整昨日画像：https:\/\/bot\.9958\.uk\/profile\/[A-Za-z0-9_-]{32,}/);
  assert.match(transport.sent[1]?.text ?? "", /完整群聊画像：https:\/\/bot\.9958\.uk\/profile\/[A-Za-z0-9_-]{32,}/);
  assert.doesNotMatch(transport.sent[0]?.text ?? "", /view=members/);
  assert.doesNotMatch(transport.sent[1]?.text ?? "", /view=members/);
  const yesterdayToken = (transport.sent[0]?.text ?? "").match(/\/profile\/([A-Za-z0-9_-]{32,})/)?.[1];
  const overallToken = (transport.sent[1]?.text ?? "").match(/\/profile\/([A-Za-z0-9_-]{32,})/)?.[1];
  assert.ok(yesterdayToken);
  assert.ok(overallToken);
  assert.equal((await profileRecordStore.getByShareToken(yesterdayToken))?.summary, "Tester 昨日新增画像总结");
  assert.equal((await profileRecordStore.getByShareToken(overallToken))?.summary, "整体画像总结");
  assert.equal(dailyProfileReviewService.getOrCreateCalls[0]?.userId, "20001");
  assert.equal(dailyProfileReviewService.overallCalls[0]?.userId, "20001");
});

test("profile commands honor configured short summary limit", async () => {
  const dailyProfileReviewService = new FakeDailyProfileReviewService();
  dailyProfileReviewService.overallSummary = "第一句展示群聊画像重点。第二句包含更多工作偏好和聊天习惯。第三句应该被短摘要配置裁掉。";
  const { app, transport } = createApp({
    dailyProfileReviewService,
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [], 40),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#群聊画像" } }], 20001));

  const text = transport.sent[0]?.text ?? "";
  assert.match(text, /第一句展示群聊画像重点。/);
  assert.doesNotMatch(text, /第三句应该被短摘要配置裁掉/);
});

test("profile commands allow any member to query others and report ambiguous targets", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      manualIdentities: [
        { userIds: ["20001"], names: ["张三"], note: "项目经理" },
        { userIds: ["20002"], names: ["张三二号"], note: "项目助理" },
      ],
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#群聊画像 20002" } }], 20001));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#群聊画像 项目" } }], 99999));

  assert.match(transport.sent[0]?.text ?? "", /整体画像总结/);
  assert.match(transport.sent[1]?.text ?? "", /匹配到多个人/);
});

test("daily profile review tick runs at Hong Kong midnight", async () => {
  const dailyProfileReviewService = new FakeDailyProfileReviewService();
  const { app, profileRecordStore } = createApp({ dailyProfileReviewService });

  await (app as unknown as { runDailyProfileReviewTick(now?: Date): Promise<void> }).runDailyProfileReviewTick(
    new Date("2026-06-01T23:59:00+08:00"),
  );
  await (app as unknown as { runDailyProfileReviewTick(now?: Date): Promise<void> }).runDailyProfileReviewTick(
    new Date("2026-06-02T00:00:10+08:00"),
  );

  assert.equal(dailyProfileReviewService.reviewCalls.length, 1);
  assert.equal(dailyProfileReviewService.reviewCalls[0]?.dateKey, "2026-06-01");
  const records = await profileRecordStore.listPage({ groupId: "67890", userId: "20001", type: "yesterday", page: 1, pageSize: 10 });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0]?.summary, "Tester 昨日新增画像总结");
  assert.equal(records.items[0]?.createdBy, "daily_profile_review");
  assert.match(records.items[0]?.shareToken ?? "", /^[A-Za-z0-9_-]{32,}$/);
});

test("daily profile review tick follows system schedule settings", async () => {
  const dailyProfileReviewService = new FakeDailyProfileReviewService();
  const { app } = createApp({
    dailyProfileReviewService,
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [], 140, {
      dailyProfileReviewTime: "01:30",
    }),
  });

  await (app as unknown as { runDailyProfileReviewTick(now?: Date): Promise<void> }).runDailyProfileReviewTick(
    new Date("2026-06-02T00:00:10+08:00"),
  );
  await (app as unknown as { runDailyProfileReviewTick(now?: Date): Promise<void> }).runDailyProfileReviewTick(
    new Date("2026-06-02T01:30:10+08:00"),
  );

  assert.equal(dailyProfileReviewService.reviewCalls.length, 1);
  assert.equal(dailyProfileReviewService.reviewCalls[0]?.dateKey, "2026-06-01");
});
