import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import {
  BotApplication,
  type HtmlPreviewFallbackRoute,
  type MemeLibraryRuntimeService,
  type MessageTransport,
} from "./bot.js";
import { StaticHtmlOutputTruncatedError } from "./services/ai-service.js";
import type { AdminOperationLogEntry } from "./services/admin-operation-log-service.js";
import { GroupLock } from "./services/group-lock.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { HtmlPreviewError, type HtmlPreviewMetadata, type HtmlPreviewProcessResult } from "./services/html-preview-service.js";
import { loadPrivateEnterpriseRanking, type PrivateEnterpriseRanking } from "./services/private-enterprise-ranking.js";
import type { ImageGenerationRuntime } from "./services/image-generation-service.js";
import type { ConversationRoute } from "./services/conversation-context-repository.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import type {
  AiReply,
  AiIdentityContext,
  ControlledMentionDecision,
  ConversationTurn,
  GroupBotConfig,
  GroupMemory,
  KnowledgeBaseEntry,
  MessageImageInput,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  ReferencedMessage,
  RealtimeLookupResult,
  SharedConversationTopic,
  SkillDefinition,
  SystemCommandConfig,
  SystemSettings,
} from "./types.js";

class FakeTransport implements MessageTransport {
  readonly sent: Array<{ groupId: string; text: string }> = [];
  readonly images: Array<{ groupId: string; imageFile: string }> = [];
  readonly generatedImages: Array<{ groupId: string; imagePath: string }> = [];
  readonly outbound: Array<{ kind: "text" | "image"; groupId: string }> = [];
  readonly records: Array<{ groupId: string; recordFile: string }> = [];
  readonly aiRecords: Array<{ groupId: string; text: string }> = [];
  messagesById: Record<string, ReferencedMessage> = {};
  getMessageError?: Error;
  sendGroupMessageError?: Error;
  sendGroupImageError?: Error;
  private nextSentMessageId = 10_000;
  allowOpsAlertWhenSendFails = false;
  memberDirectoryByGroup: Record<string, NapcatGroupMember[]> = {
    "67890": [
      { user_id: 67890, nickname: "小王", card: "项目经理" },
      { user_id: 55667788, nickname: "老张", card: "张三" },
      { user_id: 20001, nickname: "Tester", card: "测试同学" },
    ],
  };
  healthStatus = { ok: true, detail: "测试传输层已连接" };
  imageResolutionCalls = 0;

  async sendGroupMessage(groupId: string, text: string): Promise<{ messageId: string }> {
    if (this.sendGroupMessageError && !(this.allowOpsAlertWhenSendFails && text.includes("【运维告警】"))) {
      throw this.sendGroupMessageError;
    }
    this.sent.push({ groupId, text });
    this.outbound.push({ kind: "text", groupId });
    return { messageId: String(this.nextSentMessageId++) };
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<{ messageId: string }> {
    if (this.sendGroupImageError) {
      throw this.sendGroupImageError;
    }
    this.images.push({ groupId, imageFile });
    this.outbound.push({ kind: "image", groupId });
    return { messageId: String(this.nextSentMessageId++) };
  }

  async sendGeneratedGroupImage(groupId: string, imagePath: string): Promise<{ messageId: string }> {
    this.generatedImages.push({ groupId, imagePath });
    return { messageId: String(this.nextSentMessageId++) };
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<{ messageId: string }> {
    this.records.push({ groupId, recordFile });
    return { messageId: String(this.nextSentMessageId++) };
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<{ messageId: string }> {
    this.aiRecords.push({ groupId, text });
    return { messageId: String(this.nextSentMessageId++) };
  }

  async resolveImageInputs(
    images: Array<{ url?: string; file?: string; summary?: string }>,
  ): Promise<Array<{ url?: string; file?: string; summary?: string }>> {
    this.imageResolutionCalls += 1;
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

  async listGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    return this.memberDirectoryByGroup[groupId] ?? [];
  }
}

class FakeImagePipeline {
  readonly calls: MessageImageInput[][] = [];

  async resolveForVision(images: MessageImageInput[]): Promise<Array<{ input: MessageImageInput; dataUrl: string }>> {
    this.calls.push(images.map((image) => ({ ...image })));
    return images.map((image) => ({
      input: image,
      dataUrl: image.url ?? `data:image/png;base64,${image.file ?? "resolved"}`,
    }));
  }
}

class DraftWorkerTransport extends FakeTransport {
  discardCalls = 0;

  override async sendGroupMessage(groupId: string, text: string): Promise<{ messageId: string; deliveryId: string }> {
    const receipt = await super.sendGroupMessage(groupId, text);
    return { ...receipt, deliveryId: "outbox:1" };
  }

  discardConversationDrafts(): void {
    this.discardCalls += 1;
  }
}

class FakeGroupConfigService {
  constructor(
    public groups: GroupBotConfig[],
    public superAdminUserIds: string[] = [],
    private readonly v3Runtime = false,
  ) {}

  isV3Runtime(): boolean {
    return this.v3Runtime;
  }

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

  async updateGroupConfig(groupId: string, input: Partial<GroupBotConfig>): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    Object.assign(group, input);
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
    private readonly tokenCostControl: Partial<SystemSettings["tokenCostControl"]> = {},
    private readonly onlineLookupEnabled = false,
  ) {}

  async get(): Promise<SystemSettings> {
    return {
      onlineLookupEnabled: this.onlineLookupEnabled,
      tokenCostControl: {
        dailyReportAiQuipEnabled: false,
        chatSummaryAiEnabled: false,
        scheduledReminderAiRewriteEnabled: false,
        modelHealthAutoProbeEnabled: false,
        ...this.tokenCostControl,
      },
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
  sharedTopics: Record<string, SharedConversationTopic> = {};
  sharedTopicMessageIndex: Record<string, string> = {};
  clearedGroups: string[] = [];
  clearedUsers: Array<{ groupId: string; userId: string }> = [];
  private nextTopicId = 1;

  async getTurns(groupId: string, userId: string): Promise<ConversationTurn[]> {
    return this.turnsByKey[toConversationKey(groupId, userId)] ?? [];
  }

  async appendDialogue(groupId: string, userId: string, turns: ConversationTurn[]): Promise<void> {
    const key = toConversationKey(groupId, userId);
    this.turnsByKey[key] = [...(this.turnsByKey[key] ?? []), ...turns];
  }

  async getSharedTopic(
    groupId: string,
    replyMessageId?: string,
    now = new Date(),
  ): Promise<SharedConversationTopic | undefined> {
    this.pruneSharedTopics(now);
    if (replyMessageId) {
      const topicId = this.sharedTopicMessageIndex[`${groupId}:${replyMessageId}`];
      const topic = topicId ? this.sharedTopics[topicId] : undefined;
      return topic?.groupId === groupId ? cloneSharedTopic(topic) : undefined;
    }
    return undefined;
  }

  async appendSharedDialogue(args: {
    groupId: string;
    topicId?: string;
    userId: string;
    userContent: string;
    senderCard?: string;
    senderNickname?: string;
    assistantContent: string;
    sourceMessageId?: string;
    botMessageIds?: string[];
  }): Promise<SharedConversationTopic> {
    const now = new Date().toISOString();
    const existing = args.topicId ? this.sharedTopics[args.topicId] : undefined;
    let topic: SharedConversationTopic;
    if (existing?.groupId === args.groupId) {
      topic = existing;
    } else {
      topic = {
        id: `${args.groupId}:topic-${this.nextTopicId++}`,
        groupId: args.groupId,
        createdAt: now,
        updatedAt: now,
        turns: [],
      };
    }
    topic.turns = [
      ...topic.turns,
      {
        role: "user" as const,
        content: args.userContent,
        userId: args.userId,
        ...(args.senderCard ? { senderCard: args.senderCard } : {}),
        ...(args.senderNickname ? { senderNickname: args.senderNickname } : {}),
        timestamp: now,
      },
      { role: "assistant" as const, content: args.assistantContent, timestamp: now },
    ].slice(-20);
    topic.updatedAt = now;
    this.sharedTopics[topic.id] = topic;
    for (const messageId of [args.sourceMessageId, ...(args.botMessageIds ?? [])]) {
      if (messageId) {
        this.sharedTopicMessageIndex[`${args.groupId}:${messageId}`] = topic.id;
      }
    }
    return cloneSharedTopic(topic);
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
    for (const [topicId, topic] of Object.entries(this.sharedTopics)) {
      if (topic.groupId === groupId) {
        delete this.sharedTopics[topicId];
      }
    }
    for (const key of Object.keys(this.sharedTopicMessageIndex)) {
      if (key.startsWith(`${groupId}:`)) {
        delete this.sharedTopicMessageIndex[key];
      }
    }
  }

  private pruneSharedTopics(now: Date): void {
    const cutoff = now.getTime() - 30 * 60 * 1000;
    for (const [topicId, topic] of Object.entries(this.sharedTopics)) {
      if (Date.parse(topic.updatedAt) < cutoff) {
        delete this.sharedTopics[topicId];
      }
    }
    for (const [key, topicId] of Object.entries(this.sharedTopicMessageIndex)) {
      if (!this.sharedTopics[topicId]) {
        delete this.sharedTopicMessageIndex[key];
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
    scenarioInstruction?: string;
  }> = [];
  controlledMentionCalls: Array<{
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: AiIdentityContext;
  }> = [];
  staticHtmlCalls: string[] = [];
  constructor(
    private readonly responder: () => Promise<AiReply>,
    private readonly controlledMentionResponder: () => Promise<ControlledMentionDecision> = async () => ({
      shouldMention: false,
    }),
    private readonly staticHtmlResponder: (request: string) => Promise<{ text: string; model: string }> = async () => ({
      text: '{"title":"测试页面","html":"<!doctype html><html><head><title>测试</title></head><body><main>ok</main></body></html>"}',
      model: "test-model",
    }),
  ) {}

  async generateReply(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: Array<{ url?: string; file?: string; summary?: string }>;
    identityContext?: AiIdentityContext;
    scenarioInstruction?: string;
  }): Promise<AiReply> {
    this.calls.push(args);
    return this.responder();
  }

  async generateStaticHtml(args: { request: string }): Promise<{ text: string; model: string }> {
    this.staticHtmlCalls.push(args.request);
    return this.staticHtmlResponder(args.request);
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

class FakeMemeLibraryService implements MemeLibraryRuntimeService {
  blacklistedSelections: Array<{ groupId?: string }> = [];
  claimCalls: Array<{ groupId: string; userText: string; now?: number }> = [];
  onClaim?: () => void;

  constructor(
    private readonly options: {
      blacklistedImageFile?: string;
      claimedImageFile?: string;
      claimError?: Error;
      claimReason?: "sent_candidate" | "no_match" | "policy_disabled" | "probability_miss" | "cooldown" | "asset_unavailable";
      matchedTagIds?: string[];
    } = {},
  ) {}

  async selectBlacklistedAtImage(groupId?: string): Promise<{ imageFile: string } | undefined> {
    this.blacklistedSelections.push({ groupId });
    return this.options.blacklistedImageFile ? { imageFile: this.options.blacklistedImageFile } : undefined;
  }

  async claimNormalChatImage(input: {
    groupId: string;
    userText: string;
    now?: number;
  }): ReturnType<MemeLibraryRuntimeService["claimNormalChatImage"]> {
    this.claimCalls.push({ ...input });
    this.onClaim?.();
    if (this.options.claimError) throw this.options.claimError;
    const selection = this.options.claimedImageFile ? { imageFile: this.options.claimedImageFile } : undefined;
    return {
      reason: this.options.claimReason ?? (selection ? "sent_candidate" : "no_match"),
      ...(selection ? { selection } : {}),
      matchedTagIds: [...(this.options.matchedTagIds ?? [])],
    };
  }
}

class FakeTtsService {
  calls: Array<{ text: string; skill: SkillDefinition; options?: { mode?: "speech" | "singing" } }> = [];

  constructor(
    private readonly responder: () => Promise<{
      filePath: string;
      recordFile: string;
      cleanup(): Promise<void>;
    }>,
  ) {}

  async synthesize(text: string, skill: SkillDefinition, options?: { mode?: "speech" | "singing" }): Promise<{
    filePath: string;
    recordFile: string;
    cleanup(): Promise<void>;
  }> {
    this.calls.push({ text, skill, options });
    return this.responder();
  }
}

class FakeDailyReportService {
  recorded: Array<{ groupId: string; userId: string; userName: string; text: string; timestamp?: string }> = [];
  reports: Array<{ groupId: string; now: string; useAiQuip?: boolean; members?: readonly NapcatGroupMember[] }> = [];
  marked: Array<{ groupId: string; now: string; renderedText?: string }> = [];
  delivered: Array<{ groupId: string; renderedText: string; now: string }> = [];
  summaries: Array<{ groupId: string; label: string; now: string; useAiSummary?: boolean }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly reportText = async (_groupConfig?: GroupBotConfig, _now?: Date) => "日报内容",
  ) {}

  async recordMessage(args: {
    groupId: string;
    userId: string;
    userName: string;
    text: string;
    timestamp?: string;
  }): Promise<void> {
    this.recorded.push(args);
  }

  async shouldSendScheduledReport(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  async buildReport(
    groupConfig: GroupBotConfig,
    now = new Date(),
    options: { useAiQuip?: boolean; members?: readonly NapcatGroupMember[] } = {},
  ): Promise<string> {
    this.reports.push({
      groupId: groupConfig.groupId,
      now: now.toISOString(),
      useAiQuip: options.useAiQuip,
      members: options.members,
    });
    return this.reportText(groupConfig, now);
  }

  async buildChatSummary(args: {
    groupId: string;
    request: { label: string };
    now?: Date;
    useAiSummary?: boolean;
    members?: readonly NapcatGroupMember[];
  }): Promise<string> {
    this.summaries.push({
      groupId: args.groupId,
      label: args.request.label,
      now: (args.now ?? new Date()).toISOString(),
      useAiSummary: args.useAiSummary,
    });
    return `${args.request.label}聊天总结`;
  }

  async markSent(groupId: string, now = new Date(), renderedText?: string): Promise<void> {
    this.marked.push({ groupId, now: now.toISOString(), renderedText });
  }

  async recordDeliveredReport(groupId: string, renderedText: string, now = new Date()): Promise<void> {
    this.delivered.push({ groupId, renderedText, now: now.toISOString() });
  }
}

class FakeHolidayCountdownService {
  marked: Array<{ groupId: string; now: string }> = [];
  messages: Array<{ now: string; useAiQuip?: boolean }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly messageFactory = (_now?: Date) => "节假日倒计时",
  ) {}

  async shouldSendScheduledMessage(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  buildCountdownMessage(now = new Date(), options: { useAiQuip?: boolean } = {}): string {
    this.messages.push({ now: now.toISOString(), useAiQuip: options.useAiQuip });
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
      ...(entry.operatorAccountId ? { operatorAccountId: entry.operatorAccountId } : {}),
      ...(entry.operatorUsername ? { operatorUsername: entry.operatorUsername } : {}),
      ...(entry.operatorRole ? { operatorRole: entry.operatorRole } : {}),
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
  relevantCalls: Array<{
    groupId: string;
    currentUserId: string;
    relatedUserIds?: string[];
    excludedSubjectUserIds?: string[];
    queryText?: string;
    identityTerms?: string[];
    limit?: number;
    maxChars?: number;
  }> = [];

  async list(groupId?: string): Promise<GroupMemory[]> {
    return this.memories.filter((memory) => !groupId || memory.groupId === groupId);
  }

  async listEnabled(groupId: string): Promise<GroupMemory[]> {
    return this.memories.filter((memory) => memory.groupId === groupId && memory.enabled);
  }

  async listRelevantEnabled(args: {
    groupId: string;
    currentUserId: string;
    relatedUserIds?: string[];
    excludedSubjectUserIds?: string[];
    queryText?: string;
    identityTerms?: string[];
    limit?: number;
    maxChars?: number;
  }): Promise<GroupMemory[]> {
    this.relevantCalls.push({
      ...args,
      ...(args.relatedUserIds ? { relatedUserIds: [...args.relatedUserIds] } : {}),
      ...(args.excludedSubjectUserIds ? { excludedSubjectUserIds: [...args.excludedSubjectUserIds] } : {}),
    });
    const excludedSubjectUserIds = new Set(args.excludedSubjectUserIds ?? []);
    return (await this.listEnabled(args.groupId))
      .filter((memory) => !memory.subjectUserId || !excludedSubjectUserIds.has(memory.subjectUserId))
      .slice(0, args.limit ?? 8);
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

class FakeRealtimeLookupService {
  calls: Array<{ text: string }> = [];

  constructor(private readonly result?: RealtimeLookupResult) {}

  async lookup(args: { text: string }): Promise<RealtimeLookupResult | undefined> {
    this.calls.push(args);
    return this.result;
  }
}

function cloneGroup(group: GroupBotConfig): GroupBotConfig {
  return {
    ...group,
    allowedSkillIds: [...group.allowedSkillIds],
    switcherUserIds: [...group.switcherUserIds],
    liveChatUserIds: [...group.liveChatUserIds],
    roastModeUserIds: [...(group.roastModeUserIds ?? [])],
    blacklistedUserIds: [...(group.blacklistedUserIds ?? [])],
    opsAlertsEnabled: group.opsAlertsEnabled === true,
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

function cloneSharedTopic(topic: SharedConversationTopic): SharedConversationTopic {
  return { ...topic, turns: topic.turns.map((turn) => ({ ...turn })) };
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
  messageId = 1,
): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 12345,
    group_id: groupId,
    user_id: userId,
    message_id: messageId,
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
  conversationStore?: FakeConversationStore;
  ttsService?: FakeTtsService;
  dailyReportService?: FakeDailyReportService;
  holidayCountdownService?: FakeHolidayCountdownService;
  scheduledReminderService?: ScheduledReminderService;
  adminOperationLogService?: FakeAdminOperationLogService;
  groupMemoryStore?: FakeGroupMemoryStore;
  knowledgeBaseStore?: FakeKnowledgeBaseStore;
  allowNapCatAiVoiceFallback?: boolean;
  skills?: SkillDefinition[];
  systemSettingsStore?: FakeSystemSettingsStore | SystemSettingsStore;
  realtimeLookupService?: FakeRealtimeLookupService;
  imagePipeline?: FakeImagePipeline;
  conversationContextRepository?: {
    getSourceRowId?(groupId: string, sourceMessageId: string): number | undefined;
    getCausalTurnsBeforeTurn(branchId: string, turnId: number): ConversationTurn[];
    appendAssistantTurn(input: unknown): never;
  };
  recentGroupEvidenceService?: {
    list(input: {
      groupId: string;
      beforeSourceRowId: number;
      sinceMs: number;
      excludedUserIds?: string[];
      limit?: number;
    }): NonNullable<AiIdentityContext["recentGroupEvidence"]>;
    listAmbient?(input: {
      groupId: string;
      beforeSourceRowId: number;
      lookbackMs: number;
      excludedUserIds?: string[];
      limit?: number;
    }): NonNullable<AiIdentityContext["ambientGroupContext"]>;
  };
  htmlPreviewService?: {
    enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string; request?: string }): Promise<{ page: HtmlPreviewMetadata; created: boolean }>;
    processNext(input: { id?: string; request?: string; generate: (request: string, signal?: AbortSignal) => Promise<unknown> }): Promise<HtmlPreviewProcessResult>;
    cleanup(): Promise<{ expired: number; temp: number; orphans: number }>;
  };
  htmlPreviewFallbackRoute?: HtmlPreviewFallbackRoute;
  qqAdminAuthorization?: {
    resolve(qqUserId: string, groupId: string): {
      accountId: string;
      username: string;
      role: "super_admin" | "group_admin";
      qqUserId: string;
    } | undefined;
  };
  memeLibraryService?: FakeMemeLibraryService;
  imageGenerationService?: ImageGenerationRuntime;
  privateEnterpriseRanking?: PrivateEnterpriseRanking;
}): {
  app: BotApplication;
  transport: FakeTransport;
  groupConfigService: FakeGroupConfigService;
  aiService: FakeAiService;
  conversationStore: FakeConversationStore;
  ttsService: FakeTtsService;
  dailyReportService: FakeDailyReportService;
  holidayCountdownService: FakeHolidayCountdownService;
  scheduledReminderService: ScheduledReminderService;
  adminOperationLogService: FakeAdminOperationLogService;
  groupMemoryStore: FakeGroupMemoryStore;
  knowledgeBaseStore: FakeKnowledgeBaseStore;
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
        participationMode: "mentions_and_keywords",
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
        opsAlertsEnabled: false,
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
    undefined,
    undefined,
    "https://bot.9958.uk",
    undefined,
    {
      gpt: "gpt-5.5",
      mimo: "mimo-v2.5-pro",
    },
    options?.systemSettingsStore as never,
    undefined,
    options?.realtimeLookupService as never,
    undefined,
    undefined,
    undefined,
    options?.imagePipeline as never,
    undefined,
    true,
    options?.conversationContextRepository as never,
    undefined,
    undefined,
    options?.htmlPreviewService as never,
    options?.htmlPreviewFallbackRoute,
    options?.qqAdminAuthorization,
    options?.recentGroupEvidenceService,
    options?.memeLibraryService,
    options?.imageGenerationService,
    options?.privateEnterpriseRanking,
  );

  return {
    app,
    transport,
    groupConfigService,
    aiService,
    conversationStore,
    ttsService,
    dailyReportService,
    holidayCountdownService,
    scheduledReminderService,
    adminOperationLogService,
    groupMemoryStore,
    knowledgeBaseStore,
  };
}

test("responds to mentioned group message without writing legacy personal history", async () => {
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
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
});

test("mentioned ranking questions use the shared verified dataset without calling AI", async () => {
  const { app, transport, aiService } = createApp({ privateEnterpriseRanking: loadPrivateEnterpriseRanking() });
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "腾讯在2026中国民营企业500强排名第几？" } },
  ]));
  assert.match(transport.sent[0]?.text ?? "", /第6/);
  assert.equal(aiService.calls.length, 0);
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "杭州有多少家民营企业500强？" } },
  ], 20002));
  assert.match(transport.sent[1]?.text ?? "", /总部城市尚未全部核验/);
  assert.equal(aiService.calls.length, 0);
});

test("#网页 routes an explicit page request to the durable publisher instead of normal chat", async () => {
  const calls: Array<{ request?: string; id?: string }> = [];
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string; request?: string }) {
      calls.push({ request: input.request });
      return {
        created: true,
        page: {
          id: "A".repeat(43),
          groupId: input.groupId,
          creatorUserId: input.creatorUserId,
          sourceMessageId: input.sourceMessageId,
          title: "网页预览",
          previewUrl: "https://preview.9958.uk/p/test/",
          status: "pending" as const,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1_000).toISOString(),
        },
      };
    },
    async processNext(input: { id?: string; request?: string; generate: (request: string, signal?: AbortSignal) => Promise<unknown> }) {
      calls.push({ id: input.id, request: input.request });
      await input.generate(input.request ?? "", undefined);
      return { status: "published" as const };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app, aiService, transport } = createApp({ htmlPreviewService: publisher });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 做一个待办清单" } }]));

  assert.deepEqual(calls.map((call) => call.request), ["做一个待办清单", "做一个待办清单"]);
  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
});

test("#画图 queues the generated file without invoking conversational AI", async () => {
  const prompts: string[] = [];
  const imageGenerationService: ImageGenerationRuntime = {
    async generate(input) {
      prompts.push(input.prompt);
      await input.onStarted?.();
      return {
        filePath: "D:\\managed\\generated.png",
        modelId: "image-primary",
        model: "gpt-image-test",
        fallbackUsed: false,
        mimeType: "image/png",
        byteLength: 123,
      };
    },
    async discard() {},
    async cleanup() { return 0; },
  };
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    imageGenerationEnabled: true,
  }], ["20001"]);
  const { app, transport, aiService } = createApp({ groupConfigService, imageGenerationService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#生图  海边灯塔" } }]));

  assert.deepEqual(prompts, ["海边灯塔"]);
  assert.deepEqual(transport.generatedImages, [{ groupId: "67890", imagePath: "D:\\managed\\generated.png" }]);
  assert.equal(aiService.calls.length, 0);
  assert.deepEqual(transport.sent.map((item) => item.text), ["正在生成图片，请稍候…"]);
});

test("#画图 explains missing prompts and ignores the retired per-group switch", async () => {
  let calls = 0;
  const imageGenerationService: ImageGenerationRuntime = {
    async generate(input) {
      calls += 1;
      await input.onStarted?.();
      return {
        filePath: "D:\\managed\\generated.png",
        modelId: "image-primary",
        model: "gpt-image-test",
        fallbackUsed: false,
        mimeType: "image/png",
        byteLength: 123,
      };
    },
    async discard() {},
    async cleanup() { return 0; },
  };
  const enabledGroups = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    imageGenerationEnabled: false,
  }], ["20001"]);
  const enabled = createApp({ groupConfigService: enabledGroups, imageGenerationService });
  await enabled.app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#画图" } }]));
  assert.match(enabled.transport.sent[0]?.text ?? "", /#画图 <提示词>/);
  await enabled.app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#画图 海边灯塔" } }]));
  assert.equal(calls, 1);
  assert.equal(enabled.transport.sent[1]?.text, "正在生成图片，请稍候…");
  assert.equal(enabled.transport.generatedImages.length, 1);
});

test("V3 image generation is silent for everyone except a bound super administrator", async () => {
  let calls = 0;
  const imageGenerationService: ImageGenerationRuntime = {
    async generate(input) {
      calls += 1;
      await input.onStarted?.();
      return {
        filePath: "D:\\managed\\generated.png",
        modelId: "image-primary",
        model: "gpt-image-test",
        fallbackUsed: false,
        mimeType: "image/png",
        byteLength: 123,
      };
    },
    async discard() {},
    async cleanup() { return 0; },
  };
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: [],
    liveChatUserIds: [],
    imageGenerationEnabled: false,
  }], [], true);
  const { app, transport } = createApp({
    groupConfigService,
    imageGenerationService,
    qqAdminAuthorization: {
      resolve(qqUserId) {
        if (qqUserId === "20001") return { accountId: "super", username: "root", role: "super_admin", qqUserId };
        if (qqUserId === "20002") return { accountId: "group", username: "operator", role: "group_admin", qqUserId };
        return undefined;
      },
    },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#画图 普通成员" } }], 20003));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#生图 群管理员" } }], 20002));
  assert.equal(calls, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.generatedImages.length, 0);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#画图 超级管理员" } }], 20001));
  assert.equal(calls, 1);
  assert.deepEqual(transport.sent.map((item) => item.text), ["正在生成图片，请稍候…"]);
  assert.equal(transport.generatedImages.length, 1);
});

test("#画图 reports the exact Unicode prompt overage before starting generation", async () => {
  let calls = 0;
  const imageGenerationService: ImageGenerationRuntime = {
    async generate() { calls += 1; throw new Error("must not run"); },
    async discard() {},
    async cleanup() { return 0; },
  };
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
  }], ["20001"]);
  const { app, transport } = createApp({ groupConfigService, imageGenerationService });
  await app.handleGroupMessage(createEvent([{
    type: "text",
    data: { text: `#画图 ${"😀".repeat(5_001)}` },
  }]));
  assert.equal(calls, 0);
  assert.equal(transport.sent[0]?.text, "提示词当前 5001 字，最多 5000 字，请删减 1 字");
});

test("image generation help is hidden from members and shown to super administrators", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
  }], ["20001"]);
  const { app, transport } = createApp({ groupConfigService });
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能" } }], 20002));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能 画图" } }], 20002));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能 画图" } }], 20001));
  assert.doesNotMatch(transport.sent[0]?.text ?? "", /画图|#画图|#生图/);
  assert.match(transport.sent[1]?.text ?? "", /没找到“画图”/);
  assert.match(transport.sent[2]?.text ?? "", /仅绑定超级管理员可用/);
  assert.match(transport.sent[2]?.text ?? "", /最多 5000 字/);
});

test("HTML preview sticks to the silent ds fallback after a transient GPT failure", async () => {
  const primary = new FakeAiService(
    async () => ({ text: "unused", model: "primary", skillId: "assistant" }),
    undefined,
    async () => { throw Object.assign(new Error("service unavailable"), { status: 503 }); },
  );
  const fallbackCalls: string[] = [];
  const fallback = {
    async generateStaticHtml(args: { request: string }) {
      fallbackCalls.push(args.request);
      return { text: '{"title":"鹈鹕","html":"<!doctype html><html><head><title>鹈鹕</title></head><body><main>ok</main></body></html>"}', model: "deepseek" };
    },
  };
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string }) {
      return { created: true, page: { id: "F".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId, title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() } };
    },
    async processNext(input: { request?: string; generate: (request: string) => Promise<unknown> }) {
      await input.generate(input.request ?? "");
      await input.generate(`${input.request ?? ""} repair`);
      return { status: "published" as const };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app, transport } = createApp({
    aiService: primary,
    htmlPreviewService: publisher,
    htmlPreviewFallbackRoute: { mode: "ds", label: "ds", service: fallback },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 SVG 鹈鹕骑自行车" } }]));

  assert.equal(primary.staticHtmlCalls.length, 1);
  assert.deepEqual(fallbackCalls, ["SVG 鹈鹕骑自行车", "SVG 鹈鹕骑自行车 repair"]);
  assert.equal(transport.sent.length, 0, "a successful silent fallback must not add a group notice");
});

test("HTML preview switches to the silent ds fallback after primary output truncation", async () => {
  const primary = new FakeAiService(
    async () => ({ text: "unused", model: "primary", skillId: "assistant" }),
    undefined,
    async () => { throw new StaticHtmlOutputTruncatedError("gemini", "length", 16_380, 48_000); },
  );
  const fallbackCalls: string[] = [];
  const fallback = {
    async generateStaticHtml(args: { request: string }) {
      fallbackCalls.push(args.request);
      return { text: '{"title":"凤凰","html":"<!doctype html><html><body>ok</body></html>"}', model: "deepseek" };
    },
  };
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string }) {
      return { created: true, page: { id: "T".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId, title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() } };
    },
    async processNext(input: { request?: string; generate: (request: string) => Promise<unknown> }) {
      await input.generate(input.request ?? "");
      await input.generate(`${input.request ?? ""} repair`);
      return { status: "published" as const };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app, transport } = createApp({
    aiService: primary,
    htmlPreviewService: publisher,
    htmlPreviewFallbackRoute: { mode: "ds", label: "ds", service: fallback },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 SVG 凤凰骑独轮车" } }]));

  assert.equal(primary.staticHtmlCalls.length, 1);
  assert.deepEqual(fallbackCalls, ["SVG 凤凰骑独轮车", "SVG 凤凰骑独轮车 repair"]);
  assert.equal(transport.sent.length, 0);
});

test("HTML preview reports a dedicated error when primary and fallback outputs are truncated", async () => {
  const primary = new FakeAiService(
    async () => ({ text: "unused", model: "primary", skillId: "assistant" }),
    undefined,
    async () => { throw new StaticHtmlOutputTruncatedError("gemini", "length", 16_380, 48_000); },
  );
  let observedErrorCode = "";
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string }) {
      return { created: true, page: { id: "U".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId, title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() } };
    },
    async processNext(input: { request?: string; generate: (request: string) => Promise<unknown> }) {
      try {
        await input.generate(input.request ?? "");
      } catch (error) {
        observedErrorCode = error instanceof HtmlPreviewError ? error.code : "unknown";
      }
      return { status: "failed" as const, errorCode: observedErrorCode };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app } = createApp({
    aiService: primary,
    htmlPreviewService: publisher,
    htmlPreviewFallbackRoute: {
      mode: "ds",
      label: "ds",
      service: { async generateStaticHtml() { throw new StaticHtmlOutputTruncatedError("deepseek", "max_tokens", 16_380, 47_000); } },
    },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 超复杂 SVG 动画" } }]));

  assert.equal(observedErrorCode, "html_preview_output_truncated");
});

test("HTML preview does not switch providers for a non-retryable client error", async () => {
  const primary = new FakeAiService(
    async () => ({ text: "unused", model: "primary", skillId: "assistant" }),
    undefined,
    async () => { throw Object.assign(new Error("invalid request"), { status: 400 }); },
  );
  let fallbackCalls = 0;
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string }) {
      return { created: true, page: { id: "G".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId, title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() } };
    },
    async processNext(input: { request?: string; generate: (request: string) => Promise<unknown> }) {
      await input.generate(input.request ?? "");
      return { status: "published" as const };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app } = createApp({
    aiService: primary,
    htmlPreviewService: publisher,
    htmlPreviewFallbackRoute: {
      mode: "ds",
      label: "ds",
      service: { async generateStaticHtml() { fallbackCalls += 1; return { text: "", model: "ds" }; } },
    },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 非法请求" } }]));

  assert.equal(primary.staticHtmlCalls.length, 1);
  assert.equal(fallbackCalls, 0);
});

test("HTML preview maps exhausted primary and fallback providers to provider unavailable", async () => {
  const primary = new FakeAiService(
    async () => ({ text: "unused", model: "primary", skillId: "assistant" }),
    undefined,
    async () => { throw Object.assign(new Error("pool=0"), { status: 503 }); },
  );
  let observedErrorCode = "";
  const publisher = {
    async enqueue(input: { groupId: string; creatorUserId: string; sourceMessageId: string }) {
      return { created: true, page: { id: "H".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId, title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() } };
    },
    async processNext(input: { request?: string; generate: (request: string) => Promise<unknown> }) {
      try {
        await input.generate(input.request ?? "");
      } catch (error) {
        observedErrorCode = error instanceof HtmlPreviewError ? error.code : "unknown";
      }
      return { status: "failed" as const, errorCode: observedErrorCode };
    },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app } = createApp({
    aiService: primary,
    htmlPreviewService: publisher,
    htmlPreviewFallbackRoute: {
      mode: "ds",
      label: "ds",
      service: { async generateStaticHtml() { throw Object.assign(new Error("upstream unavailable"), { status: 503 }); } },
    },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#网页 鹈鹕动画" } }]));

  assert.equal(observedErrorCode, "html_preview_provider_unavailable");
});

test("natural page generation requires an @ and explicit creation wording", async () => {
  const requests: string[] = [];
  const publisher = {
    async enqueue(input: { request?: string; groupId: string; creatorUserId: string; sourceMessageId: string }) {
      requests.push(input.request ?? "");
      return {
        created: true,
        page: {
          id: "B".repeat(43), groupId: input.groupId, creatorUserId: input.creatorUserId, sourceMessageId: input.sourceMessageId,
          title: "网页预览", previewUrl: "https://preview.9958.uk/p/test/", status: "pending" as const,
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString(),
        },
      };
    },
    async processNext() { return { status: "published" as const }; },
    async cleanup() { return { expired: 0, temp: 0, orphans: 0 }; },
  };
  const { app, aiService } = createApp({ htmlPreviewService: publisher });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "生成一个网页做展示" } }]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "生成一个网页做展示" } },
  ], 20001, 67890, 22));

  assert.deepEqual(requests, ["生成一个网页做展示"]);
  assert.equal(aiService.calls.length, 0, "explicit page generation must not fall through to normal chat");
});
test("verified reply anchors continue mentions-only conversations without an @", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    participationMode: "mentions_only",
  }]);
  const { app, transport, aiService } = createApp({ groupConfigService });
  const replyEvent = createEvent([
    { type: "reply", data: { id: "9001" } },
    { type: "text", data: { text: "why?" } },
  ], 20001, 67890, 2);

  assert.equal(
    await app.shouldRouteConversation("67890", "why?", false, { replyToBot: false }),
    false,
    "an arbitrary group-member quote must not authorize a reply",
  );
  assert.equal(
    await app.shouldRouteConversation("67890", "why?", false, { replyToBot: true }),
    true,
    "a verified bot receipt must be allowed even in mentions-only mode",
  );

  await app.handleGroupMessage(replyEvent);
  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);

  await app.handleGroupMessage(replyEvent, undefined, undefined, { allowReplyWithoutMention: true });
  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
});
test("any legacy current skill falls back to huixian", async () => {
  const huixianSkill: SkillDefinition = { ...assistantSkill, id: "huixian", name: "会仙" };
  const retiredGroupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "zxp",
    allowedSkillIds: ["zxp"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
  }]);
  const { app: retiredApp, aiService: retiredAiService } = createApp({
    groupConfigService: retiredGroupConfigService,
    skills: [huixianSkill],
  });

  await retiredApp.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " continue safely " } },
  ]));

  assert.equal(retiredAiService.calls[0]?.skill.id, "huixian");

  const unknownGroupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "missing",
    allowedSkillIds: ["missing"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
  }]);
  const { app: unknownApp, aiService: unknownAiService } = createApp({
    groupConfigService: unknownGroupConfigService,
    skills: [huixianSkill],
  });

  await unknownApp.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " this must fall back to huixian " } },
  ]));
  assert.equal(unknownAiService.calls[0]?.skill.id, "huixian");
});
test("Huixian omits in-memory group traffic when no durable ambient context source is available", async () => {
  const huixianSkill: SkillDefinition = { ...assistantSkill, id: "huixian", maxContextTurns: 16 };
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: ["99999"],
    liveChatUserIds: ["20001"],
    blacklistedUserIds: ["30004"],
    manualIdentities: [
      { userIds: ["1569671790"], names: ["季博神", "季博霸王"] },
      { userIds: ["289513186"], names: ["季博初"] },
    ],
  }]);
  const { app, aiService } = createApp({ groupConfigService, skills: [huixianSkill] });

  const firstMessage = createEvent(
    [{ type: "text", data: { text: "后端设计表逻辑还得考虑。" } }],
    1_569_671_790,
    67890,
    101,
  );
  firstMessage.sender = { user_id: 1_569_671_790, card: "空白名", nickname: "季博初" };
  await app.handleGroupMessage(firstMessage);
  await app.handleGroupMessage(createEvent([
    { type: "text", data: { text: "前端也得看审美。" } },
  ], 289_513_186, 67890, 102));
  await app.handleGroupMessage(createEvent([
    { type: "image", data: { file: "recent.gif" } },
  ], 20002, 67890, 103));
  await app.handleGroupMessage(createEvent([
    { type: "text", data: { text: "#状态" } },
  ], 20003, 67890, 104));
  await app.handleGroupMessage(createEvent([
    { type: "text", data: { text: "不应进入群聊上下文" } },
  ], 30004, 67890, 105));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "群里在聊啥" } },
  ], 30003, 67890, 106));

  assert.equal(aiService.calls.length, 1);
  const identityContext = aiService.calls[0]?.identityContext as Record<string, unknown> | undefined;
  assert.equal(Object.hasOwn(identityContext ?? {}, "recentGroupMessages"), false);
  assert.equal(Object.hasOwn(identityContext ?? {}, "ambientGroupContext"), false);
  assert.equal(aiService.calls[0]?.userInput, "群里在聊啥");
});

test("worker persistence failure discards unpublished drafts and leaves the source message retryable", async () => {
  const transport = new DraftWorkerTransport();
  const route: ConversationRoute = {
    sourceRowId: 1,
    sourceMessageId: "source-1",
    topicId: "topic-1",
    branchId: "branch-1",
    routeReason: "new-topic",
    turnId: 1,
  };
  const { app } = createApp({
    transport,
    conversationContextRepository: {
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => {
        throw new Error("sqlite busy");
      },
    },
  });

  await assert.rejects(
    app.handleGroupMessage(createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " retry me " } },
    ]), undefined, route),
    /atomically persist the causal assistant reply/,
  );
  assert.equal(transport.discardCalls, 1);
  assert.equal(transport.sent.length, 1);
});

test("Huixian keeps heavy in-memory group traffic out when no durable ambient context source is available", async () => {
  const huixianSkill: SkillDefinition = { ...assistantSkill, id: "huixian", maxContextTurns: 16 };
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
  }]);
  const { app, aiService } = createApp({ groupConfigService, skills: [huixianSkill] });

  for (let index = 1; index <= 31; index += 1) {
    await app.handleGroupMessage(createEvent([
      { type: "text", data: { text: `${index} ${"x".repeat(298)}` } },
    ], 20000 + index, 67890, index));
  }
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "总结当前话题" } },
  ], 30003, 67890, 100));

  const identityContext = aiService.calls[0]?.identityContext as Record<string, unknown> | undefined;
  assert.equal(Object.hasOwn(identityContext ?? {}, "recentGroupMessages"), false);
  assert.equal(Object.hasOwn(identityContext ?? {}, "ambientGroupContext"), false);
  assert.equal(aiService.calls[0]?.userInput, "总结当前话题");
});

test("Huixian normal replies omit runtime task context and retain adaptive detailed reply instruction", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: ["99999"],
    liveChatUserIds: ["20001"],
    liveChatDelaySeconds: 30,
    scheduledRemindersEnabled: true,
    manualIdentities: [{ userIds: ["20001"], names: ["季博神"] }],
  }]);
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(`data/test-huixian-runtime-${Date.now()}-${Math.random()}.json`),
    {} as never,
  );
  await scheduledReminderService.createTask({
    groupId: "67890",
    creatorUserId: "99999",
    request: { intervalMinutes: 30, topic: "提醒喝水" },
  });
  const huixianSkill: SkillDefinition = {
    ...assistantSkill,
    id: "huixian",
    maxContextTurns: 16,
    maxReplyCharsPerMessage: 420,
    maxTotalReplyChars: 1_200,
  };
  const { app, aiService } = createApp({
    groupConfigService,
    scheduledReminderService,
    skills: [huixianSkill],
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "帮我分析这个项目为什么总延期，并给整改方案" } },
  ]));

  const call = aiService.calls[0];
  const identityContext = call?.identityContext as Record<string, unknown> | undefined;
  assert.equal(Object.hasOwn(identityContext ?? {}, "groupRuntimeContext"), false);
  assert.doesNotMatch(JSON.stringify(identityContext ?? {}), /提醒喝水/);
  assert.match(call?.scenarioInstruction ?? "", /复杂任务/);
  assert.match(call?.scenarioInstruction ?? "", /3000 字内/);
});

test("explicit 3000-character requests use any text skill's configured long-reply budget immediately", async () => {
  const longReplySkill: SkillDefinition = {
    ...assistantSkill,
    maxReplyCharsPerMessage: 500,
    maxTotalReplyChars: 3_000,
    maxReplyMessages: 8,
    preferredMaxReplyMessages: 4,
  };
  const aiService = new FakeAiService(async () => ({
    text: "长".repeat(1_200),
    model: "test-model",
    skillId: "assistant",
  }));
  const { app, transport } = createApp({ aiService, skills: [longReplySkill, teacherSkill] });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "来个3000字的疯狂星期四文案" } },
  ]));

  assert.equal(aiService.calls.length, 1);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /显式长文本模式/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /直接输出正文/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /每条最多 500 字/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /总正文最多 3000 字/);
  assert.equal(transport.sent.length, 3);
  assert.equal(transport.sent.every((message) => message.text.length <= 500), true);
  assert.equal(transport.sent.reduce((total, message) => total + message.text.length, 0), 1_200);
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
    assert.match(status, /权限：后台账号绑定优先/);
    assert.match(status, /定时任务：已开启，1 个/);
    assert.match(status, /群聊日报：已关闭/);
    assert.match(status, /节假日倒计时：已开启，09:30/);
    assert.match(status, /黑名单：1 人/);
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
  const { app } = createApp({
    transport,
    groupConfigService,
    skills: [assistantSkill],
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [
      enabledReplyModel("reply-main"),
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#健康检查" } }], 99999));

  const health = transport.sent.at(-1)?.text ?? "";
  assert.match(health, /健康检查：群 67890/);
  assert.match(health, /NapCat：异常，反向 WebSocket 未连接/);
  assert.match(health, /系统模型配置：启用 1 个/);
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
  assert.match(transport.sent.at(-1)?.text ?? "", /运维告警：已关闭/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 开启" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.opsAlertsEnabled, true);
  assert.match(transport.sent.at(-1)?.text ?? "", /已开启当前群运维告警/);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 关闭" } }], 99999));
  assert.equal(groupConfigService.groups[0]?.opsAlertsEnabled, false);
  assert.match(transport.sent.at(-1)?.text ?? "", /已关闭当前群运维告警/);
});

test("ops alert command requires admin permission", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#告警 状态" } }], 20001));

  assert.match(transport.sent[0]?.text ?? "", /没有管理运维告警的权限/);
});

test("ops alert tick sends startup and napcat down alerts without automatic recovery alert", async () => {
  const transport = new FakeTransport();
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    opsAlertsEnabled: true,
  }]);
  const { app } = createApp({ transport, groupConfigService });
  const runOpsAlertTick = app as unknown as {
    runOpsAlertTick(options?: { now?: Date; includeStartup?: boolean }): Promise<void>;
  };

  await withMockedMemoryUsage({ total: 1000, free: 500 }, async () => {
    await runOpsAlertTick.runOpsAlertTick({
      now: new Date("2026-06-02T09:00:00.000Z"),
      includeStartup: true,
    });
    assert.match(transport.sent.at(-1)?.text ?? "", /【运维告警】服务已启动/);
    assert.doesNotMatch(transport.sent.at(-1)?.text ?? "", /\[CQ:at,qq=99999\]/);

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

test("ops alerts require an explicit group opt-in", async () => {
  const transport = new FakeTransport();
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
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
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    opsAlertsEnabled: true,
  }]);
  const { app } = createApp({ transport, groupConfigService });
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
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    opsAlertsEnabled: true,
  }]);
  const { app } = createApp({ transport, groupConfigService });
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

test("admin blacklist replies to each @ with only the meme while still recording reports", async () => {
  const { app, transport, aiService, groupConfigService, dailyReportService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#拉黑 20001" } }], 99999));
  assert.deepEqual(groupConfigService.groups[0]?.blacklistedUserIds, ["20001"]);
  assert.match(transport.sent[0]?.text ?? "", /已拉黑 20001/);
  assert.match(transport.sent[0]?.text ?? "", /@机器人将收到表情包/);

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
  assert.equal(transport.images.length, 1);
  assert.equal(transport.images[0]?.groupId, "67890");
  assert.match(transport.images[0]?.imageFile ?? "", /^base64:\/\//);
  assert.deepEqual(
    Buffer.from((transport.images[0]?.imageFile ?? "").replace(/^base64:\/\//, ""), "base64").subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(transport.records.length, 0);
  assert.equal(transport.aiRecords.length, 0);
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

test("blacklisted mentions send one meme each and never enter the transcript or model flow", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    blacklistedUserIds: ["20001"],
    dailyReportEnabled: true,
    dailyReportTime: "18:00",
    dailyReportTopUserCount: 3,
    opsAlertsEnabled: true,
  }]);
  const { app, transport, aiService, conversationStore, dailyReportService } = createApp({ groupConfigService });
  const rawApp = app as unknown as {
    liveChatService: LiveChatService;
    opsAlertState: { consecutiveSendFailures: number; sendFailureAlertActive: boolean };
  };
  const lastBotActivityBefore = rawApp.liveChatService.getLastBotActivity("67890");
  rawApp.opsAlertState.consecutiveSendFailures = 3;
  rawApp.opsAlertState.sendFailureAlertActive = true;

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 第一次 " } },
  ], 20001, 67890, 8101));
  await app.handleGroupMessage(createEvent("[CQ:at,qq=12345] 第二次", 20001, 67890, 8102));
  await app.handleGroupMessage(createEvent("@12345 第三次", 20001, 67890, 8103));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: " 不 @ " } }], 20001, 67890, 8104));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " #人格 列表" } },
  ], 20001, 67890, 8105));

  assert.equal(transport.images.length, 4);
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.records.length, 0);
  assert.equal(transport.aiRecords.length, 0);
  assert.equal(aiService.calls.length, 0);
  assert.equal(aiService.staticHtmlCalls.length, 0);
  assert.equal(rawApp.liveChatService.getLastBotActivity("67890"), lastBotActivityBefore);
  assert.deepEqual(conversationStore.turnsByKey, {});
  assert.equal(
    (app as unknown as { groupTranscriptService: { getRecentMessages(groupId: string): unknown[] } })
      .groupTranscriptService
      .getRecentMessages("67890")
      .length,
    0,
  );
  assert.equal(dailyReportService.recorded.length, 5);
});

test("blacklisted @ selects from the protected meme library without normal-chat model work", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    blacklistedUserIds: ["20001"],
    dailyReportEnabled: true,
    dailyReportTime: "18:00",
    dailyReportTopUserCount: 3,
  }]);
  const memeLibraryService = new FakeMemeLibraryService({
    blacklistedImageFile: "base64://library-blacklist-meme",
    claimedImageFile: "base64://must-not-send",
  });
  const { app, transport, aiService } = createApp({ groupConfigService, memeLibraryService });
  const rawApp = app as unknown as { liveChatService: LiveChatService };
  const activityBefore = rawApp.liveChatService.getLastBotActivity("67890");

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 第一次 " } },
  ], 20001, 67890, 9101));
  await app.handleGroupMessage(createEvent("[CQ:at,qq=12345] 第二次", 20001, 67890, 9102));

  assert.deepEqual(transport.images.map((item) => item.imageFile), [
    "base64://library-blacklist-meme",
    "base64://library-blacklist-meme",
  ]);
  assert.deepEqual(memeLibraryService.blacklistedSelections, [{ groupId: "67890" }, { groupId: "67890" }]);
  assert.equal(memeLibraryService.claimCalls.length, 0);
  assert.equal(aiService.calls.length, 0);
  assert.equal(rawApp.liveChatService.getLastBotActivity("67890"), activityBefore);
});

test("normal text replies append a locally matched meme after the text without a background model call", async () => {
  const memeLibraryService = new FakeMemeLibraryService({
    claimedImageFile: "base64://normal-chat-meme",
    matchedTagIds: ["celebrate"],
  });
  const aiService = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const { app, transport } = createApp({ aiService, memeLibraryService });
  let backgroundCalls = 0;
  app.setBackgroundLlmGate(async (task) => {
    backgroundCalls += 1;
    return task();
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 今天终于发布了 " } },
  ]));

  assert.equal(transport.sent[0]?.text, "AI reply");
  assert.deepEqual(transport.images, [{ groupId: "67890", imageFile: "base64://normal-chat-meme" }]);
  assert.deepEqual(transport.outbound.map((item) => item.kind), ["text", "image"]);
  assert.equal(backgroundCalls, 0);
  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(memeLibraryService.claimCalls, [{ groupId: "67890", userText: "今天终于发布了" }]);
});

test("image-bearing conversations never append a normal chat meme", async () => {
  const memeLibraryService = new FakeMemeLibraryService({
    claimedImageFile: "base64://must-not-send",
  });
  const aiService = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const { app, transport } = createApp({
    aiService,
    memeLibraryService,
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
      visionEnabled: true,
    }]),
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 看看这张图 " } },
    { type: "image", data: { url: "https://example.test/source.png", file: "source.png" } },
  ]));

  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
  assert.equal(transport.images.length, 0);
  assert.equal(memeLibraryService.claimCalls.length, 0);
});

test("keyword and verified reply conversations use the normal text meme path", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    participationMode: "mentions_and_keywords",
    triggerKeywords: [{ keyword: "配图关键词", enabled: true }],
  }]);
  const memeLibraryService = new FakeMemeLibraryService({
    claimedImageFile: "base64://normal-chat-meme",
    matchedTagIds: ["reaction"],
  });
  const aiService = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const { app, transport } = createApp({ groupConfigService, memeLibraryService, aiService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "配图关键词 来一张" } }]));
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "继续说" } }]),
    undefined,
    undefined,
    { allowReplyWithoutMention: true },
  );

  assert.deepEqual(transport.outbound.map((item) => item.kind), ["text", "image", "text", "image"]);
  assert.deepEqual(memeLibraryService.claimCalls.map((call) => call.userText), ["配图关键词 来一张", "继续说"]);
});

test("normal meme failures and no matching tag never disturb the completed text reply", async () => {
  const failedTransport = new FakeTransport();
  failedTransport.sendGroupImageError = new Error("image unavailable");
  failedTransport.allowOpsAlertWhenSendFails = true;
  const failedLibrary = new FakeMemeLibraryService({
    claimedImageFile: "base64://normal-chat-meme",
  });
  const failedAi = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const failed = createApp({
    transport: failedTransport,
    aiService: failedAi,
    memeLibraryService: failedLibrary,
  });
  const failedRuntime = failed.app as unknown as {
    opsAlertState: { consecutiveSendFailures: number; sendFailureAlertActive: boolean };
  };
  // Place the primary reply just before the normal send-failure alert
  // threshold. The image must not enter the ops-alert accounting path.
  failedLibrary.onClaim = () => {
    failedRuntime.opsAlertState.consecutiveSendFailures = 2;
    failedRuntime.opsAlertState.sendFailureAlertActive = false;
  };

  await failed.app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 好耶 " } },
  ]));

  assert.equal(failedTransport.sent[0]?.text, "AI reply");
  assert.equal(failedTransport.sent.length, 1);
  assert.equal(failedTransport.images.length, 0);
  assert.equal(failedLibrary.claimCalls.length, 1);
  assert.equal(failedRuntime.opsAlertState.consecutiveSendFailures, 2);
  assert.equal(failedRuntime.opsAlertState.sendFailureAlertActive, false);

  const noMatchLibrary = new FakeMemeLibraryService({
    claimReason: "no_match",
  });
  const noMatchAi = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const noMatch = createApp({ aiService: noMatchAi, memeLibraryService: noMatchLibrary });

  await noMatch.app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 好耶 " } },
  ]));

  assert.equal(noMatch.transport.sent[0]?.text, "AI reply");
  assert.equal(noMatch.transport.images.length, 0);
  assert.deepEqual(noMatchLibrary.claimCalls, [{ groupId: "67890", userText: "好耶" }]);
});

test("blacklisted blacklist commands keep command precedence and do not send the meme", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    blacklistedUserIds: ["99999", "20001"],
    dailyReportEnabled: true,
    dailyReportTime: "18:00",
    dailyReportTopUserCount: 3,
  }]);
  const { app, transport, groupConfigService: configs, dailyReportService } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " #拉黑 解除 99999" } },
  ], 99999));

  assert.deepEqual(configs.groups[0]?.blacklistedUserIds, ["20001"]);
  assert.match(transport.sent[0]?.text ?? "", /已解除拉黑 99999/);
  assert.equal(transport.images.length, 0);

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " #拉黑 20002" } },
  ], 20001));

  assert.equal(transport.images.length, 0);
  assert.equal(dailyReportService.recorded.length, 1);
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

test("limits manual identities and member profiles to the current speaker and explicit targets", async () => {
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
          names: ["测试同学"],
        },
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
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [
    {
      id: "target-memory",
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "1967410653",
      title: "小菜鸡偏好",
      content: "小菜鸡偏好前端话题。",
      confidence: 0.8,
      source: "admin",
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "unrelated-memory",
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "927345463",
      title: "渣渣辉偏好",
      content: "渣渣辉的私人偏好。",
      confidence: 0.8,
      source: "admin",
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  const { app, aiService } = createApp({ groupConfigService, groupMemoryStore });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "1967410653" } },
      { type: "text", data: { text: " 小菜鸡是谁 " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext, {
    groupId: "67890",
    currentUserId: "20001",
    currentSpeaker: {
      manualName: "测试同学",
      senderNickname: "Tester",
    },
    botUserId: "12345",
    manualIdentities: [
      {
        userIds: ["20001"],
        names: ["测试同学"],
      },
      {
        userIds: ["1967410653"],
        names: ["小菜鸡", "前端哥"],
      },
    ],
    memberProfiles: [
      {
        userId: "1967410653",
        displayName: "小菜鸡",
        aliases: ["小菜鸡", "前端哥"],
        hasManualIdentity: true,
        memoryCount: 1,
        memoryDisabled: false,
      },
      {
        userId: "20001",
        displayName: "测试同学",
        aliases: ["测试同学"],
        hasManualIdentity: true,
        memoryCount: 0,
        memoryDisabled: false,
      },
    ],
    groupMemories: [
      {
        id: "target-memory",
        groupId: "67890",
        type: "member_profile",
        subjectUserId: "1967410653",
        title: "小菜鸡偏好",
        content: "小菜鸡偏好前端话题。",
        confidence: 0.8,
        source: "admin",
        enabled: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    interactionTargets: [
      {
        userId: "1967410653",
        names: ["小菜鸡", "前端哥"],
        source: "mention",
      },
    ],
  });
});

test("does not authorize identity, memory, or controlled @ from a typed third-party QQ", async () => {
  const privateUserId = "1967410653";
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: [privateUserId], names: ["小菜鸡"] }],
  }]);
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [{
    id: "private-member-memory",
    groupId: "67890",
    type: "member_profile",
    subjectUserId: privateUserId,
    title: "小菜鸡偏好",
    content: "这条私人成员记忆不应因正文 QQ 号被注入。",
    confidence: 0.8,
    source: "admin",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }];
  const aiService = new FakeAiService(
    async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }),
    async () => ({ shouldMention: true, target: "小菜鸡" }),
  );
  const { app, transport } = createApp({ groupConfigService, groupMemoryStore, aiService });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: ` 请提醒 ${privateUserId} 看一下，不要真的 @ 他 ` } },
    ]),
  );

  const identityContext = aiService.calls[0]?.identityContext;
  assert.deepEqual(groupMemoryStore.relevantCalls[0]?.relatedUserIds, []);
  assert.deepEqual(identityContext?.manualIdentities, []);
  assert.equal(identityContext?.interactionTargets, undefined);
  assert.equal(identityContext?.memberProfiles, undefined);
  assert.equal(identityContext?.groupMemories, undefined);
  assert.equal(aiService.controlledMentionCalls.length, 0);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("injects durable group evidence only for a verified person-evaluation request", async () => {
  const evidenceCalls: Array<{ groupId: string; beforeSourceRowId: number; limit?: number }> = [];
  let ambientCalls = 0;
  const recentGroupEvidenceService = {
    list(input: { groupId: string; beforeSourceRowId: number; limit?: number }) {
      evidenceCalls.push(input);
      return [{
        role: "member" as const,
        userId: "2409332588",
        senderNickname: "飞翔的企鹅",
        text: "一切根源都是能源",
        timestamp: "2026-09-03T09:25:00.000Z",
      }];
    },
    listAmbient() {
      ambientCalls += 1;
      return [];
    },
  };
  const conversationContextRepository = {
    getSourceRowId: () => 99,
    getCausalTurnsBeforeTurn: () => [],
    appendAssistantTurn: () => { throw new Error("not used without a route"); },
  };
  const { app, aiService } = createApp({
    recentGroupEvidenceService,
    conversationContextRepository,
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "at", data: { qq: "2409332588" } },
    { type: "text", data: { text: " 根据现有聊天记录锐评一下 " } },
  ], 20001, 67890, 7001));

  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0]?.groupId, "67890");
  assert.equal(evidenceCalls[0]?.beforeSourceRowId, 99);
  assert.equal(evidenceCalls[0]?.limit, 30);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "2409332588");
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidence?.[0]?.text, "一切根源都是能源");
  assert.equal(ambientCalls, 0);

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "at", data: { qq: "2409332588" } },
    { type: "text", data: { text: " 你今天忙吗 " } },
  ], 20001, 67890, 7002));

  assert.equal(evidenceCalls.length, 1);
  assert.equal(aiService.calls[1]?.identityContext?.recentGroupEvidence, undefined);
  assert.equal(aiService.calls[1]?.identityContext?.recentGroupEvidenceRequested, undefined);
  assert.equal(ambientCalls, 1);
});

test("injects ambient group context for unquoted conversation and skips explicit replies", async () => {
  const ambientCalls: Array<{
    groupId: string;
    beforeSourceRowId: number;
    lookbackMs: number;
    excludedUserIds?: string[];
    limit?: number;
  }> = [];
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    blacklistedUserIds: ["30001"],
    memoryDisabledUserIds: ["30002"],
  }]);
  const recentGroupEvidenceService = {
    list: () => [],
    listAmbient(input: typeof ambientCalls[number]) {
      ambientCalls.push(input);
      return [{
        role: "bot" as const,
        messageId: "bot-1",
        text: "现代梗圈顶流必须是常公",
        timestamp: "2026-09-08T01:45:13.000Z",
      }];
    },
  };
  const { app, aiService } = createApp({
    groupConfigService,
    recentGroupEvidenceService,
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 常工与中正比如何 " } },
  ], 20001, 67890, 7201));

  assert.equal(ambientCalls.length, 1);
  assert.equal(ambientCalls[0]?.lookbackMs, 10 * 60 * 1_000);
  assert.equal(ambientCalls[0]?.limit, 30);
  assert.deepEqual(ambientCalls[0]?.excludedUserIds, ["30001", "30002"]);
  assert.equal(aiService.calls[0]?.identityContext?.ambientGroupContext?.[0]?.text, "现代梗圈顶流必须是常公");

  await app.handleGroupMessage(createEvent([
    { type: "reply", data: { id: "bot-1" } },
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 常公是谁 " } },
  ], 20001, 67890, 7202));

  assert.equal(ambientCalls.length, 1);
  assert.equal(aiService.calls[1]?.identityContext?.ambientGroupContext, undefined);
});

test("ambient group context can be disabled per group", async () => {
  let ambientCalls = 0;
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    ambientGroupContextEnabled: false,
  }]);
  const { app, aiService } = createApp({
    groupConfigService,
    recentGroupEvidenceService: {
      list: () => [],
      listAmbient: () => {
        ambientCalls += 1;
        return [];
      },
    },
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 常工与中正比如何 " } },
  ], 20001, 67890, 7210));

  assert.equal(ambientCalls, 0);
  assert.equal(aiService.calls[0]?.identityContext?.ambientGroupContext, undefined);
});

test("removes messages already present in causal history from ambient group context", async () => {
  const route: ConversationRoute = {
    topicId: "topic-1",
    branchId: "branch-1",
    sourceMessageId: "current",
    routeReason: "same-user-follow-up",
    sourceRowId: 99,
    parentTurnId: 2,
    turnId: 3,
  };
  const conversationContextRepository = {
    getSourceRowId: () => 99,
    getCausalTurnsBeforeTurn: () => [
      {
        id: 1,
        topicId: "topic-1",
        branchId: "branch-1",
        role: "user" as const,
        userId: "20001",
        content: "我国史上著名的微操达人",
        sourceMessageId: "member-1",
        createdAt: 1,
      },
      {
        id: 2,
        topicId: "topic-1",
        branchId: "branch-1",
        parentTurnId: 1,
        role: "assistant" as const,
        content: "现代梗圈顶流必须是常公",
        platformMessageId: "bot-1",
        createdAt: 2,
      },
    ],
    appendAssistantTurn: () => ({ id: 4 }),
  };
  const { app, aiService } = createApp({
    conversationContextRepository: conversationContextRepository as never,
    recentGroupEvidenceService: {
      list: () => [],
      listAmbient: () => [
        { role: "member", messageId: "member-1", userId: "20001", text: "duplicate member", timestamp: new Date(1).toISOString() },
        { role: "bot", messageId: "bot-1", text: "duplicate bot", timestamp: new Date(2).toISOString() },
        { role: "member", messageId: "nearby", userId: "20002", text: "nearby context", timestamp: new Date(3).toISOString() },
      ],
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 所以中正是谁 " } },
  ], 20001, 67890, Number(route.sourceMessageId) || 7301), undefined, route);

  assert.deepEqual(
    aiService.calls[0]?.identityContext?.ambientGroupContext?.map((message) => message.messageId),
    ["nearby"],
  );
});

test("unverified open-ended evaluations fall back to ordinary AI without group evidence", async () => {
  const evidenceCalls: Array<{ groupId: string; beforeSourceRowId: number }> = [];
  const { app, aiService, transport } = createApp({
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
    recentGroupEvidenceService: {
      list(input: { groupId: string; beforeSourceRowId: number }) {
        evidenceCalls.push(input);
        return [];
      },
    },
  });
  const inputs = [
    "评价一下黄帝",
    "锐评一下某历史人物",
    "点评未知成员",
    "吐槽一下甲",
    "评价一下123456",
  ];

  for (const [index, text] of inputs.entries()) {
    await app.handleGroupMessage(createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: ` ${text} ` } },
    ], 20001, 67890, 7100 + index));
  }

  assert.deepEqual(aiService.calls.map((call) => call.userInput), inputs);
  for (const call of aiService.calls) {
    assert.equal(call.identityContext?.interactionTargets, undefined);
    assert.equal(call.identityContext?.recentGroupEvidenceRequested, undefined);
    assert.equal(call.identityContext?.recentGroupEvidence, undefined);
  }
  assert.equal(evidenceCalls.length, 0);
  assert.deepEqual(transport.sent.map((sent) => sent.text), inputs.map(() => "AI reply"));
});

test("explicit group-evaluation wording still requires one verified target", async () => {
  let evidenceCalls = 0;
  const { app, aiService, transport } = createApp({
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
    recentGroupEvidenceService: {
      list() {
        evidenceCalls += 1;
        return [];
      },
    },
  });
  const inputs = [
    "根据群聊记录评价一下黄帝",
    "评价一下群友黄帝",
    "锐评本群的黄帝",
    "点评群里的黄帝",
  ];

  for (const [index, text] of inputs.entries()) {
    await app.handleGroupMessage(createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: ` ${text} ` } },
    ], 20001, 67890, 7150 + index));
  }

  assert.equal(aiService.calls.length, 0);
  assert.equal(evidenceCalls, 0);
  assert.deepEqual(
    transport.sent.map((sent) => sent.text),
    inputs.map(() => "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要评价的群友。"),
  );
});

test("injects person-evaluation evidence for a quoted group member", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9001"] = {
    messageId: "9001",
    userId: "2409332588",
    userName: "飞翔的企鹅",
    text: "原消息内容",
    images: [],
  };
  const evidenceCalls: Array<{ groupId: string; beforeSourceRowId: number }> = [];
  let ambientCalls = 0;
  const { app, aiService } = createApp({
    transport,
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
    recentGroupEvidenceService: {
      list(input: { groupId: string; beforeSourceRowId: number }) {
        evidenceCalls.push(input);
        return [{
          role: "member" as const,
          userId: "2409332588",
          text: "这是一条历史发言",
          timestamp: "2026-09-04T06:00:00.000Z",
        }];
      },
      listAmbient() {
        ambientCalls += 1;
        return [];
      },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "reply", data: { id: "9001" } },
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 评价一下他 " } },
  ], 20001, 67890, 7170));

  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0]?.groupId, "67890");
  assert.equal(evidenceCalls[0]?.beforeSourceRowId, 99);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "2409332588",
    names: ["飞翔的企鹅", "2409332588"],
    source: "reply",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "2409332588");
  assert.equal(ambientCalls, 0);
});

test("injects person-evaluation evidence for one unique saved alias without sending a platform at", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["493213481"], names: ["季博醋柚肠", "季博"] }],
  }]);
  const evidenceCalls: Array<{ groupId: string; beforeSourceRowId: number }> = [];
  const recentGroupEvidenceService = {
    list(input: { groupId: string; beforeSourceRowId: number }) {
      evidenceCalls.push(input);
      return [{
        role: "member" as const,
        userId: "493213481",
        text: "这是一条历史发言",
        timestamp: "2026-09-04T06:00:00.000Z",
      }];
    },
  };
  const aiService = new FakeAiService(async () => ({
    text: "@季博醋柚肠 这位群友很有特点",
    model: "test-model",
    skillId: "assistant",
  }));
  const { app, transport } = createApp({
    groupConfigService,
    recentGroupEvidenceService,
    aiService,
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 根据现有聊天记录锐评一下季博醋柚肠 " } },
  ], 20001, 67890, 7101));

  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0]?.groupId, "67890");
  assert.equal(evidenceCalls[0]?.beforeSourceRowId, 99);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "493213481",
    names: ["季博醋柚肠", "季博"],
    source: "alias",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "493213481");
  assert.equal(aiService.controlledMentionCalls.length, 0);
  assert.equal(transport.sent[0]?.text, "季博醋柚肠 这位群友很有特点");
  assert.doesNotMatch(transport.sent[0]?.text ?? "", /\[CQ:at|@/);
});

test("does not resolve a saved alias outside person-evaluation or local-transcript requests", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["493213481"], names: ["季博醋柚肠"] }],
  }]);
  const { app, aiService } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 季博醋柚肠今天来了吗 " } },
  ]));

  assert.equal(aiService.calls[0]?.identityContext?.interactionTargets, undefined);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, undefined);
});

test("resolves a unique saved alias for a factual request explicitly grounded in nearby chat", async () => {
  const ambientCalls: Array<{
    groupId: string;
    beforeSourceRowId: number;
    lookbackMs: number;
    excludedUserIds?: string[];
    limit?: number;
  }> = [];
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["1574084048"], names: ["Linux", "渣渣辉"] }],
  }]);
  const { app, aiService } = createApp({
    groupConfigService,
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
    recentGroupEvidenceService: {
      list() {
        throw new Error("A locally grounded transcript must use the bounded ambient reader.");
      },
      listAmbient(input) {
        ambientCalls.push(input);
        return [{
          role: "member" as const,
          userId: "1574084048",
          senderNickname: "Linux",
          text: "钱肯定不罚，就是不想去掉我的首违。",
          timestamp: "2026-09-17T03:40:22.000Z",
        }];
      },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 从以上聊天看，渣渣辉将最高接受什么处罚 " } },
  ], 1569671790, 67890, 7206));

  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "1574084048",
    names: ["Linux", "渣渣辉"],
    source: "alias",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "1574084048");
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidence?.[0]?.text, "钱肯定不罚，就是不想去掉我的首违。");
  assert.equal(ambientCalls.length, 1);
  assert.equal(ambientCalls[0]?.groupId, "67890");
  assert.equal(ambientCalls[0]?.beforeSourceRowId, 99);
  assert.equal(ambientCalls[0]?.lookbackMs, 10 * 60 * 1_000);
  assert.equal(ambientCalls[0]?.limit, 30);
});

test("does not read a local transcript when nearby group context is disabled", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    ambientGroupContextEnabled: false,
    manualIdentities: [{ userIds: ["1574084048"], names: ["Linux", "渣渣辉"] }],
  }]);
  let ambientCalls = 0;
  const { app, aiService, transport } = createApp({
    groupConfigService,
    conversationContextRepository: {
      getSourceRowId: () => 99,
      getCausalTurnsBeforeTurn: () => [],
      appendAssistantTurn: () => { throw new Error("not used without a route"); },
    },
    recentGroupEvidenceService: {
      list: () => [],
      listAmbient() {
        ambientCalls += 1;
        return [];
      },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 从以上聊天看，渣渣辉将最高接受什么处罚 " } },
  ], 1569671790, 67890, 7207));

  assert.equal(ambientCalls, 0);
  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent[0]?.text, "本群未开启近期群聊上下文，无法根据以上聊天记录回答。");
});

test("resolves a saved alias in natural person impression question '在你眼中xxx是个什么样的人'", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["289513186"], names: ["季博初"] }],
  }]);
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [{
    id: "memory-jibochu",
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "289513186",
    title: "QQ群聊画像（截至 2026-09-04）",
    content: "季博初的群聊画像正文内容。",
    confidence: 0.9,
    source: "admin",
    enabled: true,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }];
  const { app, aiService } = createApp({ groupConfigService, groupMemoryStore });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 在你眼中季博初是个什么样的人 " } },
  ], 1569671790, 67890, 7102));

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "289513186",
    names: ["季博初"],
    source: "alias",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "289513186");
  const memories = aiService.calls[0]?.identityContext?.groupMemories ?? [];
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.subjectUserId, "289513186");
});

test("resolves a saved alias in natural person question '你觉得xxx怎么样'", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["289513186"], names: ["季博初"] }],
  }]);
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [{
    id: "memory-jibochu",
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "289513186",
    title: "QQ群聊画像（截至 2026-09-04）",
    content: "季博初的群聊画像正文内容。",
    confidence: 0.9,
    source: "admin",
    enabled: true,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }];
  const { app, aiService } = createApp({ groupConfigService, groupMemoryStore });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 你觉得季博初怎么样 " } },
  ], 1569671790, 67890, 7103));

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "289513186",
    names: ["季博初"],
    source: "alias",
  }]);
  const memories = aiService.calls[0]?.identityContext?.groupMemories ?? [];
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.subjectUserId, "289513186");
});

test("resolves a saved alias in '在你的眼里，xxx是个怎样的女性' and 'xxx性格咋样'", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [{ userIds: ["994697185"], names: ["前端姐"] }],
  }]);
  const groupMemoryStore = new FakeGroupMemoryStore();
  groupMemoryStore.memories = [{
    id: "memory-qianduanjie",
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "994697185",
    title: "QQ群聊画像：前端姐（截至 2026-09-04）",
    content: "前端姐的群聊画像正文内容。",
    confidence: 0.9,
    source: "admin",
    enabled: true,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }];
  const { app, aiService } = createApp({ groupConfigService, groupMemoryStore });

  // 1. "在你的眼里，前端姐是个怎样的女性"
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 在你的眼里，前端姐是个怎样的女性 " } },
  ], 1569671790, 67890, 7104));

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "994697185",
    names: ["前端姐"],
    source: "alias",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "994697185");
  assert.equal(aiService.calls[0]?.identityContext?.groupMemories?.[0]?.subjectUserId, "994697185");

  // 2. "前端姐性格咋样"
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 前端姐性格咋样 " } },
  ], 1569671790, 67890, 7105));

  assert.equal(aiService.calls.length, 2);
  assert.deepEqual(aiService.calls[1]?.identityContext?.interactionTargets, [{
    userId: "994697185",
    names: ["前端姐"],
    source: "alias",
  }]);
  assert.equal(aiService.calls[1]?.identityContext?.recentGroupEvidenceRequested, true);
  assert.equal(aiService.calls[1]?.identityContext?.recentGroupEvidenceTargetUserId, "994697185");
  assert.equal(aiService.calls[1]?.identityContext?.groupMemories?.[0]?.subjectUserId, "994697185");
});

test("does not intercept general questions about celebrities or topics like '你觉得蔡徐坤的舞蹈怎么样'", async () => {
  const { app, aiService, transport } = createApp();

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 你觉得蔡徐坤的舞蹈怎么样 " } },
  ], 1569671790, 67890, 7106));

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.interactionTargets, undefined);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceRequested, undefined);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("prefers a real mention over a different saved alias in an evaluation request", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [
      { userIds: ["2409332588"], names: ["飞翔的企鹅"] },
      { userIds: ["493213481"], names: ["季博醋柚肠"] },
    ],
  }]);
  const { app, aiService } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "at", data: { qq: "2409332588" } },
    { type: "text", data: { text: " 锐评一下季博醋柚肠 " } },
  ]));

  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "2409332588",
    names: ["飞翔的企鹅"],
    source: "mention",
  }]);
  assert.equal(aiService.calls[0]?.identityContext?.recentGroupEvidenceTargetUserId, "2409332588");
});

test("saved-alias evaluation fails closed for collisions and multiple resolved targets", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [
      { userIds: ["10001"], names: ["同名", "甲某"] },
      { userIds: ["10002"], names: ["同名", "乙某"] },
      { userIds: ["10003"], names: ["甲", "123456"] },
    ],
  }]);
  const { app, aiService, transport } = createApp({ groupConfigService });
  const inputs = [
    "评价一下同名",
    "锐评甲某和乙某",
  ];

  for (const [index, text] of inputs.entries()) {
    await app.handleGroupMessage(createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text } },
    ], 20001, 67890, 7200 + index));
  }

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, inputs.length);
  for (const sent of transport.sent) {
    assert.equal(sent.text, "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要评价的群友。");
  }
});

test("fails closed for a multi-QQ alias but still prefers a longer unique nested alias", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [
      { userIds: ["10001", "10002"], names: ["季博醋"] },
      { userIds: ["493213481"], names: ["季博醋柚肠"] },
      { userIds: ["20001", "20002"], names: ["共享别名"] },
    ],
  }]);
  const { app, aiService, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 怎么看季博醋柚肠 " } },
  ]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 从以上聊天看，共享别名说了什么 " } },
  ], 20001, 67890, 2));

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(aiService.calls[0]?.identityContext?.interactionTargets, [{
    userId: "493213481",
    names: ["季博醋柚肠"],
    source: "alias",
  }]);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[1]?.text, "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要评价的群友。");
});

test("uses the longest nested saved alias and enforces privacy opt-out", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [
      { userIds: ["10001"], names: ["季博醋"] },
      { userIds: ["493213481"], names: ["季博醋柚肠"] },
    ],
    memoryDisabledUserIds: ["493213481"],
  }]);
  let evidenceCalls = 0;
  const { app, aiService, transport } = createApp({
    groupConfigService,
    recentGroupEvidenceService: {
      list() {
        evidenceCalls += 1;
        return [];
      },
    },
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 怎么看季博醋柚肠 " } },
  ]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(evidenceCalls, 0);
  assert.equal(transport.sent[0]?.text, "当前没有可用于回答这位群友相关问题的聊天记录。");
});

test("unrouted calls fail closed instead of reading legacy personal context", async () => {
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
  assert.equal(aiService.calls[1]?.history.length, 0);
  assert.equal(aiService.calls[2]?.history.length, 0);
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.equal(conversationStore.turnsByKey["67890:20002"], undefined);
});

test("puts successful explicitly enabled real-time lookup data in the reply context without source footer", async () => {
  const realtimeLookupService = new FakeRealtimeLookupService({
    kind: "stock",
    status: "ok",
    queriedAt: "2026-07-27T07:30:00.000Z",
    dataAt: "20260727153000",
    sources: [{ name: "Tencent Finance", url: "https://qt.gtimg.cn/q=sh000001" }],
    promptContext: "Realtime A-share data: Shanghai Composite +1.15%.",
  });
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    onlineLookupEnabled: true,
  }]);
  const { app, transport, aiService } = createApp({
    groupConfigService,
    realtimeLookupService,
    systemSettingsStore: new FakeSystemSettingsStore([], [], [], {}, true),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: "分析一下今天 A 股表现" } },
    ]),
  );

  assert.deepEqual(realtimeLookupService.calls, [{ text: "分析一下今天 A 股表现" }]);
  assert.equal(aiService.calls[0]?.identityContext?.realtimeLookup?.kind, "stock");
  assert.doesNotMatch(transport.sent.map((item) => item.text).join("\n"), /实时数据/);
  assert.doesNotMatch(transport.sent.map((item) => item.text).join("\n"), /Tencent Finance/);
});

test("does not invoke real-time lookup when its group switch is disabled", async () => {
  const realtimeLookupService = new FakeRealtimeLookupService();
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
    onlineLookupEnabled: false,
  }]);
  const { app, aiService } = createApp({ groupConfigService, realtimeLookupService });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: "杭州今天天气怎么样" } },
    ]),
  );

  assert.equal(realtimeLookupService.calls.length, 0);
  assert.equal(aiService.calls[0]?.identityContext?.realtimeLookup, undefined);
});

test("keeps shared-topic speakers separate from mentioned targets", async () => {
  const conversationStore = new FakeConversationStore();
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: [],
      liveChatUserIds: [],
      manualIdentities: [
        {
          userIds: ["1569671790"],
          names: ["季博神", "季博霸王", "超级管理员"],
        },
        {
          userIds: ["289513186"],
          names: ["季博初"],
        },
      ],
    },
  ]);
  const { app, aiService } = createApp({ conversationStore, groupConfigService });

  const jiBoShenFirst = createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "现在你有什么感觉" } },
  ], 1569671790, 67890, 101);
  jiBoShenFirst.sender = { user_id: 1569671790, nickname: "", card: "" };
  await app.handleGroupMessage(jiBoShenFirst);

  const jiBoChu = createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "我是不是他的大爷" } },
  ], 289513186, 67890, 102);
  jiBoChu.sender = { user_id: 289513186, nickname: "下雨不打伞", card: "下雨不打伞" };
  await app.handleGroupMessage(jiBoChu);

  const jiBoShenReply = createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "at", data: { qq: "289513186" } },
    { type: "text", data: { text: "他有点发情了" } },
  ], 1569671790, 67890, 103);
  jiBoShenReply.sender = { user_id: 1569671790, nickname: "", card: "" };
  await app.handleGroupMessage(jiBoShenReply);

  assert.equal(aiService.calls[1]?.history.length, 0);
  assert.equal(aiService.calls[2]?.history.length, 0);
  assert.equal(aiService.calls[2]?.history.some((turn) => turn.content.includes("季博初")), false);
  assert.deepEqual(aiService.calls[2]?.identityContext?.currentSpeaker, { manualName: "季博神" });
  assert.deepEqual(aiService.calls[2]?.identityContext?.interactionTargets, [
    { userId: "289513186", names: ["季博初"], source: "mention" },
  ]);
});

test("asks for a verified target when a person-evaluation alias is ambiguous", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: [],
      liveChatUserIds: [],
      manualIdentities: [
        { userIds: ["1569671790"], names: ["同名"] },
        { userIds: ["289513186"], names: ["同名"] },
      ],
    },
  ]);
  const { app, aiService, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "at", data: { qq: "同名" } },
    { type: "text", data: { text: "你怎么看他" } },
  ]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent[0]?.text, "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要评价的群友。");
});

test("does not join an unrelated shared topic without an explicit reply anchor", async () => {
  const conversationStore = new FakeConversationStore();
  const { app, aiService } = createApp({ conversationStore });
  const startedAt = Date.parse("2026-07-27T00:00:00.000Z");

  await withMockedNow(startedAt, async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " topic started by A" } },
      ], 20001, 67890, 101),
    );
  });
  await withMockedNow(startedAt + 5 * 60 * 1000, async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " B continues it" } },
      ], 20002, 67890, 102),
    );
  });

  assert.equal(aiService.calls[0]?.history.length, 0);
  assert.equal(aiService.calls[1]?.history.length, 0);
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.equal(conversationStore.turnsByKey["67890:20002"], undefined);
});

test("does not use legacy shared-topic anchors when no persistent route is supplied", async () => {
  const conversationStore = new FakeConversationStore();
  const { app, aiService } = createApp({ conversationStore });
  const startedAt = Date.parse("2026-07-27T00:00:00.000Z");

  await withMockedNow(startedAt, async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " original question" } },
      ], 20001, 67890, 201),
    );
  });
  await withMockedNow(startedAt + 15 * 60 * 1000, async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "reply", data: { id: "10000" } },
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " reply after fifteen minutes" } },
      ], 20002, 67890, 202),
    );
  });
  await withMockedNow(startedAt + 46 * 60 * 1000, async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " unrelated later question" } },
      ], 20003, 67890, 203),
    );
  });

  assert.equal(aiService.calls[1]?.history.length, 0);
  assert.equal(aiService.calls[2]?.history.length, 0);
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
  assert.equal(conversationStore.turnsByKey["67890:20001"], undefined);
  assert.equal(conversationStore.turnsByKey["67891:20001"], undefined);
});

test("reports that image understanding is disabled without entering the model pipeline", async () => {
  const imagePipeline = new FakeImagePipeline();
  const { app, transport, aiService } = createApp({
    imagePipeline,
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
      visionEnabled: false,
    }]),
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

  assert.equal(aiService.calls.length, 0);
  assert.equal(imagePipeline.calls.length, 0);
  assert.equal(transport.imageResolutionCalls, 0);
  assert.equal(transport.sent[0]?.text, "本群未开启图片理解，请联系群管理员在后台开启后再发送图片。");
});

test("resolves and attaches images only when vision is explicitly enabled", async () => {
  const imagePipeline = new FakeImagePipeline();
  const { app, aiService } = createApp({
    imagePipeline,
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
      visionEnabled: true,
    }]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "image", data: { url: "https://example.com/cat.png" } },
    ]),
  );

  assert.equal(imagePipeline.calls.length, 1);
  assert.equal(aiService.calls[0]?.images?.length, 1);
  assert.equal(aiService.calls[0]?.images?.[0]?.url, "https://example.com/cat.png");
});

test("uses the configured GPT vision route for images without changing the group's selected model", async () => {
  const primaryAiService = new FakeAiService(async () => ({
    text: "DeepSeek text reply",
    model: "deepseek-test",
    skillId: "assistant",
  }));
  const gptVisionAiService = new FakeAiService(async () => ({
    text: "GPT vision reply",
    model: "gpt-vision-test",
    skillId: "assistant",
  }));
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    replyModelMode: "ds",
    allowedSkillIds: ["assistant"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    participationMode: "mentions_only",
    visionEnabled: true,
  }]);
  const { app, transport } = createApp({ groupConfigService, aiService: primaryAiService });
  Object.assign(app as unknown as Record<string, unknown>, {
    getReplyAiRoute: async () => ({
      mode: "ds",
      label: "DeepSeek",
      service: primaryAiService,
      supportsVision: false,
    }),
    getReplyModelOptions: async () => [{
      mode: "gpt",
      label: "GPT",
      service: gptVisionAiService,
      supportsVision: true,
    }],
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "image", data: { url: "https://example.com/cat.png" } },
  ]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: "纯文本继续用原模型" } },
  ], 20001, 67890, 2));

  assert.equal(primaryAiService.calls.length, 1);
  assert.equal(primaryAiService.calls[0]?.images?.length, 0);
  assert.equal(gptVisionAiService.calls.length, 1);
  assert.equal(gptVisionAiService.calls[0]?.images?.length, 1);
  assert.equal(groupConfigService.groups[0]?.replyModelMode, "ds");
  assert.deepEqual(transport.sent.map((item) => item.text), ["GPT vision reply", "DeepSeek text reply"]);
});

test("reports a clear error when no configured GPT vision route is available", async () => {
  const primaryAiService = new FakeAiService(async () => ({
    text: "unexpected",
    model: "deepseek-test",
    skillId: "assistant",
  }));
  const { app, transport } = createApp({
    aiService: primaryAiService,
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      replyModelMode: "ds",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
      visionEnabled: true,
    }]),
  });
  Object.assign(app as unknown as Record<string, unknown>, {
    getReplyAiRoute: async () => ({
      mode: "ds",
      label: "DeepSeek",
      service: primaryAiService,
      supportsVision: false,
    }),
    getReplyModelOptions: async () => [],
  });

  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "image", data: { url: "https://example.com/cat.png" } },
  ]));

  assert.equal(primaryAiService.calls.length, 0);
  assert.equal(transport.sent[0]?.text, "当前图片理解模型不可用，请联系管理员检查 GPT 图片理解配置后再试。");
});

test("ignores non-mentioned messages for ai reply but still records daily stats", async () => {
  const { app, transport, aiService, dailyReportService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "normal message" } }]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(dailyReportService.recorded.length, 1);
  assert.equal(dailyReportService.recorded[0]?.text, "normal message");
});

test("daily report recording prefers group card and falls back to nickname", async () => {
  const { app, dailyReportService } = createApp();
  const withCard = createEvent([{ type: "text", data: { text: "card message" } }], 20001, 67890, 101);
  withCard.sender = { user_id: 20001, card: "群备注", nickname: "QQ昵称" };
  const nicknameOnly = createEvent([{ type: "text", data: { text: "nickname message" } }], 20002, 67890, 102);
  nicknameOnly.sender = { user_id: 20002, card: "", nickname: "备用昵称" };

  await app.handleGroupMessage(withCard);
  await app.handleGroupMessage(nicknameOnly);

  assert.equal(dailyReportService.recorded[0]?.userName, "群备注");
  assert.equal(dailyReportService.recorded[1]?.userName, "备用昵称");
});

test("daily report records ingress event time instead of delayed worker time", async () => {
  const { app, dailyReportService } = createApp();
  const event = createEvent([{ type: "text", data: { text: "历史消息" } }]);
  event.time = Date.parse("2026-08-20T10:00:00.000Z") / 1_000;

  await app.handleGroupMessage(event);

  assert.equal(dailyReportService.recorded[0]?.timestamp, "2026-08-20T10:00:00.000Z");
});

test("daily report clamps a future direct-event timestamp to receipt time", async () => {
  const { app, dailyReportService } = createApp();
  const event = createEvent([{ type: "text", data: { text: "未来时间" } }]);
  const before = Date.now();
  event.time = Math.floor((before + 60_000) / 1_000);

  await app.handleGroupMessage(event);

  const recordedAt = Date.parse(dailyReportService.recorded[0]?.timestamp ?? "");
  assert.ok(recordedAt >= before - 1_000);
  assert.ok(recordedAt <= Date.now());
});

test("repeats the same plain group text on the fourth consecutive occurrence", async () => {
  const { app, transport, aiService } = createApp({
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "selected_members",
    }]),
  });

  for (let index = 0; index < 3; index += 1) {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读这句" } }], 20001 + index));
  }

  assert.equal(transport.sent.length, 0);

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "复读这句" } }], 20004));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "复读这句");
});

test("mentions-only participation disables keyword and repeat replies", async () => {
  const { app, transport, aiService } = createApp({
    groupConfigService: new FakeGroupConfigService([{
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
      triggerKeywords: [{ keyword: "会仙", enabled: true }],
    }]),
  });

  for (let index = 0; index < 4; index += 1) {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "会仙 复读" } }], 20001 + index));
  }

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
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
  assert.equal(dailyReportService.summaries[0]?.useAiSummary, false);
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

test("skill command explains that only Huixian is enabled", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#技能 列表" } }]));

  assert.match(transport.sent[0]?.text ?? "", /会仙人格/);
  assert.match(transport.sent[0]?.text ?? "", /切换已关闭/);
});

test("skill switch commands cannot change the active persona", async () => {
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant", "teacher"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
  }]);
  const conversationStore = new FakeConversationStore();
  const { app, transport } = createApp({ groupConfigService, conversationStore });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 99999));

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "assistant");
  assert.deepEqual(conversationStore.clearedGroups, []);
  assert.match(transport.sent[0]?.text ?? "", /切换已关闭/);
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

test("shows the actual configured model name instead of a stale short name", async () => {
  const { app, transport } = createApp({
    systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [
      {
        id: "ds",
        name: "DeepSeek",
        shortName: "deepseek-v4-flash",
        baseUrl: "https://reply.example/v1",
        model: "deepseek-v4-pro",
        purpose: "reply",
        hasApiKey: true,
        enabled: true,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型状态" } }], 99999));

  assert.match(transport.sent.at(-1)?.text ?? "", /deepseek-v4-pro（ds）/);
  assert.doesNotMatch(transport.sent.at(-1)?.text ?? "", /deepseek-v4-flash/);
});

test("model commands hot-reload an externally updated model through their configured alias", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bot-model-command-shared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "system-settings.json");
  const adminStore = new SystemSettingsStore(filePath);
  const workerStore = new SystemSettingsStore(filePath);
  const updatedAt = "2026-08-13T03:40:00.000Z";
  const model = {
    id: "ds",
    name: "DeepSeek",
    shortName: "deepseek-v4-flash",
    baseUrl: "https://deepseek.example/v1",
    purpose: "reply" as const,
    apiKey: "deepseek-key",
    enabled: true,
  };

  await adminStore.update({
    models: [{ ...model, model: "deepseek-v4-flash" }],
    commands: [{
      id: "model",
      title: "模型",
      primary: "#模型",
      aliases: ["#ds"],
      permission: "group_admin",
      enabled: true,
      help: "查看或切换当前群回复模型",
      updatedAt,
    }],
  });
  assert.equal((await workerStore.getInternal()).models[0]?.model, "deepseek-v4-flash");

  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    replyModelMode: "ds",
    allowedSkillIds: ["assistant", "teacher"],
    switcherUserIds: ["99999"],
    liveChatUserIds: [],
    liveChatDelayMinutes: 5,
    dailyReportEnabled: true,
    dailyReportTime: "18:00",
    dailyReportTopUserCount: 3,
  }]);
  const { app, transport } = createApp({ groupConfigService, systemSettingsStore: workerStore });

  await adminStore.update({ models: [{ ...model, model: "deepseek-v4-pro" }] });
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#ds" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#模型" } }], 99999));

  assert.equal(transport.sent.length, 2);
  for (const sent of transport.sent) {
    assert.match(sent.text, /当前群聊回复模型：deepseek-v4-pro（ds）/);
    assert.match(sent.text, /- ds: deepseek-v4-pro（ds） \[当前\]/);
    assert.doesNotMatch(sent.text, /deepseek-v4-flash/);
  }
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

test("super admin sees the same fixed Huixian persona boundary", async () => {
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

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "assistant");
  assert.match(transport.sent[0]?.text ?? "", /会仙人格/);
});

test("retired voice and sing commands no longer invoke TTS", async () => {
  const { app, transport, aiService, ttsService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音 现在怎么做" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#唱歌 写一段" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音回复 开启" } }], 99999));

  assert.equal(ttsService.calls.length, 0);
  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.records.length, 0);
  assert.equal(transport.aiRecords.length, 0);
});

test("at-mention voice wording is ordinary text chat without TTS", async () => {
  const { app, transport, aiService, ttsService } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "普通文字回复",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 语音说 现在怎么做" } },
    ]),
  );

  assert.equal(ttsService.calls.length, 0);
  assert.equal(aiService.calls.length, 1);
  assert.equal(transport.records.length, 0);
  assert.equal(transport.sent[0]?.text, "普通文字回复");
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
            participationMode: "selected_members",
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

test("roast mode users reuse live chat timing and add one-shot scenario instruction", async () => {
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
            liveChatUserIds: [],
            roastModeUserIds: ["20001"],
            participationMode: "selected_members",
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
        aiService: new FakeAiService(async () => ({
          text: "嘴硬回击",
          model: "test-model",
          skillId: "assistant",
        })),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "你这机器人也不行啊" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "你这机器人也不行啊");
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /嘴臭模式/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /保持当前 skill/);
  assert.equal(transport.sent.at(-1)?.text, "[CQ:at,qq=20001] 嘴硬回击");
});

test("roast mode applies to explicit bot mentions", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        roastModeUserIds: ["20001"],
        liveChatDelayMinutes: 1,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    aiService: new FakeAiService(async () => ({
      text: "应激回击",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 描述得详细一点 " } },
    ], 20001),
  );

  assert.equal(aiService.calls.length, 1);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /嘴臭模式/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /本能应激/);
  assert.equal(transport.sent[0]?.text, "应激回击");
});

test("roast mode applies to keyword-triggered active conversations", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        roastModeUserIds: ["20001"],
        participationMode: "mentions_and_keywords",
        liveChatDelayMinutes: 1,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        triggerKeywords: [{ keyword: "roast-key", enabled: true }],
      },
    ]),
    aiService: new FakeAiService(async () => ({
      text: "关键词回击",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "roast-key ping" } }], 20001));

  assert.equal(aiService.calls.length, 1);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /嘴臭模式/);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /不友善/);
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=20001] 关键词回击");
});

test("roast mode does not turn admin commands into ai conversations", async () => {
  const { app, aiService, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        roastModeUserIds: ["20001"],
        liveChatDelayMinutes: 1,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#状态" } }], 20001));

  assert.equal(aiService.calls.length, 0);
  assert.match(transport.sent[0]?.text ?? "", /没有查看机器人状态的权限/);
});

test("roast mode takes precedence over normal live chat for overlapping users", async () => {
  const { app, aiService } = await withMockedNow(
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
            roastModeUserIds: ["20001"],
            participationMode: "selected_members",
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "同名单触发" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.match(aiService.calls[0]?.scenarioInstruction ?? "", /嘴臭模式/);
});

test("blacklisted roast mode users stay silent", async () => {
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
            liveChatUserIds: [],
            roastModeUserIds: ["20001"],
            blacklistedUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "黑名单里也不触发" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
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
            participationMode: "selected_members",
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
      { type: "at", data: { qq: "429462108" } },
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
      { type: "at", data: { qq: "429462108" } },
      { type: "text", data: { text: " 帮我叫一下悠米 " } },
    ]),
  );

  assert.equal(aiService.controlledMentionCalls.length, 1);
  assert.equal(transport.sent[0]?.text, "不叫，别折腾人家");
});

test("controlled mention ignores legacy personal history after cutover", async () => {
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
      { type: "at", data: { qq: "429462108" } },
      { type: "text", data: { text: " 真有急事，你帮我叫一下 " } },
    ]),
  );

  assert.equal(aiService.controlledMentionCalls[0]?.history.length, 0);
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
      participationMode: "selected_members",
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

test("keeps referenced bot text as evidence without treating the bot as an interaction target", async () => {
  const transport = new FakeTransport();
  transport.messagesById["9001"] = {
    messageId: "9001",
    userId: "12345", // bot's own QQ in the test fixture (createApp botQq)
    userName: "bot",
    text: "bot 自己发的话",
    images: [],
  };
  const { app, aiService } = createApp({ transport });

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
    userId: "12345",
    userName: "bot",
    text: "bot 自己发的话",
    images: [],
  });
  const targets = aiService.calls[0]?.identityContext?.interactionTargets ?? [];
  assert.equal(
    targets.some((target) => target.source === "reply"),
    false,
    "no interaction target may come from a self-referenced message",
  );
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
  const memeLibraryService = new FakeMemeLibraryService({
    claimedImageFile: "base64://must-not-send",
  });
  const aiService = new FakeAiService(async () => ({ text: "AI reply", model: "test-model", skillId: "assistant" }));
  const { app, groupConfigService } = createApp({ transport, aiService, memeLibraryService });
  groupConfigService.groups[0]!.visionEnabled = true;

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
  assert.equal(transport.images.length, 0);
  assert.equal(memeLibraryService.claimCalls.length, 0);
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
            participationMode: "selected_members",
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
        participationMode: "mentions_and_keywords",
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

test("keyword trigger does not authorize a third-party target from a plain-text at", async () => {
  const transport = new FakeTransport();
  transport.memberDirectoryByGroup["67890"] = [
    { user_id: 55667788, nickname: "Huanghe", card: "Huanghe" },
    { user_id: 20001, nickname: "Speaker", card: "Speaker" },
  ];
  const { app, aiService } = createApp({
    transport,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        participationMode: "mentions_and_keywords",
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        triggerKeywords: [{ keyword: "wind-key", enabled: true }],
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "@Huanghe send this wind-key update" } }], 20001),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.interactionTargets, undefined);
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=20001] AI reply");
});

test("does not invoke real-time lookup when a legacy group omits the opt-in switch", async () => {
  const realtimeLookupService = new FakeRealtimeLookupService();
  const groupConfigService = new FakeGroupConfigService([{
    groupId: "67890",
    currentSkillId: "assistant",
    allowedSkillIds: ["assistant"],
    switcherUserIds: [],
    liveChatUserIds: [],
  }]);
  const { app, aiService } = createApp({ groupConfigService, realtimeLookupService });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: "杭州今天天气怎么样" } },
    ]),
  );

  assert.equal(realtimeLookupService.calls.length, 0);
  assert.equal(aiService.calls[0]?.identityContext?.realtimeLookup, undefined);
});

test("keyword trigger mentions multiple resolved third-party targets once", async () => {
  const transport = new FakeTransport();
  transport.memberDirectoryByGroup["67890"] = [
    { user_id: 55667788, nickname: "Huanghe", card: "Huanghe" },
    { user_id: 67890, nickname: "Manager", card: "Manager" },
    { user_id: 20001, nickname: "Speaker", card: "Speaker" },
  ];
  const { app, aiService } = createApp({
    transport,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        participationMode: "mentions_and_keywords",
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        triggerKeywords: [{ keyword: "wind-key", enabled: true }],
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "55667788" } },
      { type: "at", data: { qq: "67890" } },
      { type: "text", data: { text: " @Huanghe wind-key" } },
    ], 20001),
  );

  assert.equal(aiService.calls.length, 1);
  assert.deepEqual(
    aiService.calls[0]?.identityContext?.interactionTargets
      ?.map((target) => target.userId)
      .filter((userId): userId is string => Boolean(userId)),
    ["55667788", "67890"],
  );
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=55667788] [CQ:at,qq=67890] AI reply");
});

test("keyword trigger falls back to speaker when at target is unresolved", async () => {
  const transport = new FakeTransport();
  transport.memberDirectoryByGroup["67890"] = [
    { user_id: 20001, nickname: "Speaker", card: "Speaker" },
  ];
  const { app, aiService } = createApp({
    transport,
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        participationMode: "mentions_and_keywords",
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        triggerKeywords: [{ keyword: "wind-key", enabled: true }],
      },
    ]),
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "@Unknown wind-key" } }], 20001),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.identityContext?.interactionTargets?.[0]?.userId, undefined);
  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=20001] AI reply");
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
        participationMode: "mentions_and_keywords",
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
  assert.equal(dailyReportService.marked[0]?.renderedText, "18:00 群聊日报\n今日消息 12 条");
  assert.equal(dailyReportService.reports[0]?.useAiQuip, false);
  assert.deepEqual(dailyReportService.reports[0]?.members, transport.memberDirectoryByGroup["67890"]);
});

test("manual daily report preview resolves the current group member directory", async () => {
  const dailyReportService = new FakeDailyReportService();
  const { app, transport } = createApp({ dailyReportService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 预览" } }], 99999),
  );

  assert.equal(dailyReportService.reports.length, 1);
  assert.deepEqual(dailyReportService.reports[0]?.members, transport.memberDirectoryByGroup["67890"]);
  assert.equal(dailyReportService.delivered[0]?.renderedText, "日报内容");
});

test("V3 ignores legacy QQ administrators and retires the administrator command", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [{
      groupId: "67890",
      currentSkillId: "huixian",
      allowedSkillIds: ["huixian"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
    }],
    ["99999"],
    true,
  );
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 99999));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#管理员 添加 77777" } }], 99999));

  assert.equal(groupConfigService.groups[0]?.botMuted, undefined);
  assert.equal(groupConfigService.groups[0]?.switcherUserIds.includes("77777"), false);
  assert.match(transport.sent[0]?.text ?? "", /没有让机器人闭嘴或说话的权限/);
  assert.match(transport.sent[1]?.text ?? "", /#管理员 已退休/);
});

test("V3 authorizes a QQ sender through its bound backend account while keeping #管理员 retired", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [{
      groupId: "67890",
      currentSkillId: "huixian",
      allowedSkillIds: ["huixian"],
      switcherUserIds: [],
      liveChatUserIds: [],
    }],
    [],
    true,
  );
  const { app, transport, adminOperationLogService } = createApp({
    groupConfigService,
    qqAdminAuthorization: {
      resolve(qqUserId, groupId) {
        return qqUserId === "1569671790" && groupId === "67890"
          ? { accountId: "admin-id", username: "admin", role: "super_admin", qqUserId }
          : undefined;
      },
    },
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#管理员 列表" } }], 1569671790));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#闭嘴" } }], 1569671790));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#服务器" } }], 20001));

  assert.equal(groupConfigService.groups[0]?.botMuted, true);
  assert.equal(adminOperationLogService.entries[0]?.operatorAccountId, "admin-id");
  assert.equal(adminOperationLogService.entries[0]?.operatorUsername, "admin");
  assert.match(transport.sent[0]?.text ?? "", /#管理员 已退休/);
  assert.match(transport.sent[2]?.text ?? "", /没有查看服务器状态的权限/);
});

test("creates scheduled reminder through natural bot mention and sends due reminders", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    const { app, transport } = createApp({
      aiService,
      scheduledReminderService,
      systemSettingsStore: new FakeSystemSettingsStore([], [{ keyword: "乘风", enabled: true }], [], {
        scheduledReminderAiRewriteEnabled: true,
      }),
    });

    // Use local clock constructors because reminder work hours are evaluated
    // against the process-local clock in this legacy-compatible scheduler.
    const reminderCreatedAt = new Date(2026, 4, 27, 9, 0, 0, 0);
    await withMockedNow(reminderCreatedAt.getTime(), async () => {
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
      new Date(2026, 4, 27, 9, 59, 59, 0),
    );
    assert.equal(transport.sent.length, 1);

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date(2026, 4, 27, 10, 0, 0, 0),
    );
    assert.equal(transport.sent[1]?.text, "【提醒喝水小助手】提醒：喝水");

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date(2026, 4, 28, 10, 0, 0, 0),
    );
    assert.equal(transport.sent[2]?.text, "【提醒喝水小助手】又到点了，继续喝水");
  });
});

test("scheduled reminder ai rewrite is disabled by default", async () => {
  const aiService = new FakeAiService(async () => ({
    text: "AI reply",
    model: "test-model",
    skillId: "assistant",
  }));
  await withTestScheduledReminderService(aiService, async (scheduledReminderService) => {
    await scheduledReminderService.createTask({
      groupId: "67890",
      creatorUserId: "99999",
      request: { intervalMinutes: 60, topic: "drink water" },
      now: new Date(2026, 4, 27, 9, 0, 0, 0),
    });
    const { app, transport } = createApp({
      aiService,
      scheduledReminderService,
    });

    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date(2026, 4, 27, 10, 0, 0, 0),
    );

    assert.equal(aiService.calls.length, 0);
    assert.equal(transport.sent.length, 1);
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

    const reminderCreatedAt = new Date(2026, 4, 27, 9, 0, 0, 0);
    await withMockedNow(reminderCreatedAt.getTime(), async () => {
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
      new Date(2026, 4, 27, 10, 0, 0, 0),
    );

    assert.equal(groupConfigService.groups[0]?.scheduledRemindersEnabled, false);
    assert.equal(transport.sent.filter((message) => message.groupId === "67890" && message.text.startsWith("【提醒")).length, 0);

    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#定时任务 开启" } }], 99999, 67890));
    await (app as unknown as { runScheduledReminderTick(now?: Date): Promise<void> }).runScheduledReminderTick(
      new Date(2026, 4, 27, 10, 1, 0, 0),
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
  assert.equal(holidayCountdownService.messages[0]?.useAiQuip, false);
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

test("records a member memory only through #记忆 without calling the model", async () => {
  const { app, transport, aiService, groupMemoryStore } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#记忆 我喜欢先看结论。" } }]));

  assert.equal(aiService.calls.length, 0);
  assert.match(transport.sent[0]?.text ?? "", /记下了/);
  assert.equal(groupMemoryStore.memories.length, 1);
  assert.deepEqual(
    {
      type: groupMemoryStore.memories[0]?.type,
      subjectUserId: groupMemoryStore.memories[0]?.subjectUserId,
      source: groupMemoryStore.memories[0]?.source,
    },
    { type: "member_profile", subjectUserId: "20001", source: "explicit_command" },
  );
});

test("records an @请记住 request but never stores ambient requests", async () => {
  const { app, transport, aiService, groupMemoryStore } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "请记住我不吃香菜" } }]));
  await app.handleGroupMessage(createEvent([
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 请记住我喜欢先看结论" } },
  ], 20001, 67890, 2));

  assert.equal(aiService.calls.length, 0);
  assert.equal(groupMemoryStore.memories.length, 1);
  assert.equal(groupMemoryStore.memories[0]?.source, "explicit_request");
  assert.match(transport.sent.at(-1)?.text ?? "", /记下了/);
});

