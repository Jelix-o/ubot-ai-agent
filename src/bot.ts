import { ReplyModelRouter, effectiveReplyModelId } from "./services/reply-model-router.js";
import { permissionAtLeast } from "./services/command-permissions.js";
import { withModelOperation } from "./services/model-telemetry.js";
import { BT_COMMAND_PRIMARY, BT_COMMAND_ALIASES, matchBtCommand, isSystemCommandText, type BtCommandMatch } from "./services/command-prefixes.js";
import { BtSearchError, parseBtSearchRequest, type BtSearchRuntime } from "./services/bt-search-service.js";
import { btHelp, btEmptyResultMessage, escapeBtText, renderBtForwardNodes } from "./services/bt-search-renderer.js";
import { BT_FORWARD_FALLBACK_TEXT, sendForwardOrFallback, type ForwardMessageNode } from "./forward-message.js";
import { NapCatActionOutcomeUnknownError } from "./napcat-action-errors.js";
import os from "node:os";

import { logError, logInfo, logWarn } from "./logger.js";
import {
  getAiProviderFailureDetails,
  isRetryableAiProviderFailure,
  KnowledgeToolUnavailableError,
  StaticHtmlOutputTruncatedError,
  type AiToolRuntime,
} from "./services/ai-service.js";
import { ConfiguredAiService, type RuntimeAiService } from "./services/configured-ai-service.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type {
  ConversationContextTurn,
  ConversationContextRepository,
  ConversationRoute,
} from "./services/conversation-context-repository.js";
import type { ConversationContextRouter, ConversationRouteInput } from "./services/conversation-context-router.js";
import {
  ContextResolver,
  hasReadableReference,
  isBareOpinionRequest,
  isMediaReference,
  isDirectedFollowUp,
  resolveContextByRules,
  selectDiscussionClusterAroundMessage,
} from "./services/context-resolver.js";
import {
  ConversationReplyEnvelopeError,
  emptyConversationState,
  hasConversationReplyEnvelopeMarker,
  selectConversationEvidence,
  type ReplyPlan,
} from "./services/conversation-state.js";
import { ReplyPolicyService } from "./services/reply-policy-service.js";
import type { DailyReportService } from "./services/daily-report-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import { GroupLock } from "./services/group-lock.js";
import {
  ExplicitMemoryService,
  parseExplicitMemoryRequest,
  stripExplicitMemoryLead,
} from "./services/explicit-memory-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { AtmosphereSummarizer } from "./services/atmosphere-summarizer.js";
import { ImagePipelineError, type ImagePipeline } from "./services/image-pipeline.js";
import type { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { terminalFaqMessages } from "./services/knowledge-query-tools.js";
import {
  KnowledgeSourceBindingStore,
  type KnowledgeSourceId,
} from "./services/knowledge-source-binding-store.js";
import {
  classifyPrivateEnterpriseRankingRequest,
  type PrivateEnterpriseRanking,
} from "./services/private-enterprise-ranking.js";
import { GroupTranscriptService } from "./services/group-transcript-service.js";
import type { BufferedMessage, LiveChatService } from "./services/live-chat-service.js";
import { buildGroupMemberProfiles } from "./services/member-profile-service.js";
import {
  isDeicticImagePersonQuestion,
  isExplicitImagePersonQuestion,
  parseMemberIdentityQuery,
  resolveMemberIdentityQuery,
  isMemberIdentityQuerySyntax,
  isSavedIdentityComparisonSyntax,
  refreshIdentityDirectory,
} from "./services/member-identity-query.js";
import type { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { formatIntervalLabel, isWithinWorkHours } from "./services/scheduled-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { CharacterProfileService } from "./services/character-profile-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import {
  HTML_PREVIEW_FAILURE_MESSAGE,
  HtmlPreviewError,
  parseHtmlPreviewRequest,
  type HtmlPreviewService,
  type ParsedHtmlPreviewRequest,
} from "./services/html-preview-service.js";
import { detectRealtimeIntent, formatRealtimeLookupFooter } from "./services/realtime-lookup-service.js";
import type { RealtimeLookupService } from "./services/realtime-lookup-service.js";
import type { RecentGroupEvidenceService } from "./services/recent-group-evidence-service.js";
import { getBlacklistedAtMemeImageFile } from "./services/blacklisted-at-meme.js";
import {
  countImagePromptCharacters,
  IMAGE_GENERATION_MAX_PROMPT_CHARS,
  ImageGenerationError,
  type ImageGenerationRuntime,
} from "./services/image-generation-service.js";
import {
  ImagePreviewArchiveError,
  type ImagePreviewArchiveService,
} from "./services/image-preview-archive-service.js";
import type {
  ProviderCapabilityFeature,
  ProviderProtocol,
  RuntimeCapabilityPolicy,
  V3RuntimeCapability,
} from "./services/capability-policy-service.js";
import { GroupParticipationService } from "./services/group-participation-service.js";
import { BOT_MAINTENANCE_INTERVALS, MaintenanceScheduler } from "./services/maintenance-scheduler.js";
import type { ParticipationDecision } from "./services/participation-policy.js";
import type { QqAdminAuthorization } from "./services/qq-admin-authorization-service.js";
import type {
  AiInteractionTarget,
  AiIdentityContext,
  AiReply,
  AiReplyContext,
  ControlledMentionDecision,
  ConversationTurn,
  GroupMemberIdentity,
  GroupBotConfig,
  MessageImageInput,
  NapcatGroupInfo,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  ReplyModelMode,
  RealtimeLookupResult,
  ReferencedMessage,
  SkillDefinition,
  SystemCommandConfig,
  TokenCostControlSettings,
} from "./types.js";
import { parseChatSummaryRequest } from "./utils/chat-summary-request.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import { formatReplyMessages } from "./utils/reply-format.js";
import {
  buildExplicitReplyLengthInstruction,
  buildExplicitReplyLengthPlan,
  resolveReplyLengthIntent,
} from "./utils/reply-length.js";
import { classifyUpstreamFailure } from "./utils/upstream-failure.js";
import { withTimeout } from "./utils/with-timeout.js";

const MODEL_PREFIX = "#模型";
const CONVERSATION_PREFIX = "#对话";
const LIVE_CHAT_PREFIX = "#实时对话";
const DAILY_REPORT_PREFIX = "#日报";
const HOLIDAY_COUNTDOWN_PREFIX = "#节假日";
const SCHEDULED_REMINDER_PREFIX = "#定时任务";
const ADMIN_PREFIX = "#管理员";
const MUTE_COMMAND = "#闭嘴";
const UNMUTE_COMMAND = "#说话";
const CLEAR_GROUP_CONTEXT_COMMAND = "#clear";
const BLACKLIST_PREFIX = "#拉黑";
const STATUS_PREFIX = "#状态";
const HEALTH_PREFIX = "#健康检查";
const SHORT_HEALTH_PREFIX = "#健康";
const OPERATION_LOG_PREFIX = "#操作日志";
const SERVER_PREFIX = "#服务器";
const OPS_ALERT_PREFIX = "#告警";
const MEMORY_PREFIX = "#记忆";
const KNOWLEDGE_PREFIX = "#知识库";
const HTML_PREVIEW_PREFIX = "#网页";
const IMAGE_GENERATION_PREFIX = "#画图";
const HELP_PREFIXES = ["#功能", "#帮助", "#命令"];
const MULTI_MESSAGE_DELAY_MS = 1000;
const REPEAT_THRESHOLD = 4;
const AMBIENT_GROUP_CONTEXT_LOOKBACK_MS = 10 * 60 * 1_000;
const AMBIENT_GROUP_CONTEXT_MESSAGE_LIMIT = 60;
// `prepareConversationRoute` and `handleConversation` both need the quoted
// payload. Keep one verified recovery available across that single inbound
// path, without turning remote quote reads into durable state.
const RECOVERED_REPLY_CONTEXT_TTL_MS = 30 * 1_000;
const MAX_RECOVERED_REPLY_CONTEXTS = 128;
const KNOWLEDGE_CONTINUATION_WINDOW_MS = 10 * 60 * 1_000;
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const OPS_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const SEND_FAILURE_ALERT_THRESHOLD = 3;
const MEMORY_PERCENT_ALERT_THRESHOLD = 85;
const MEMORY_PERCENT_RECOVERY_THRESHOLD = 75;
const PROCESS_RSS_ALERT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TOKEN_COST_CONTROL: TokenCostControlSettings = {
  dailyReportAiQuipEnabled: false,
  chatSummaryAiEnabled: false,
  scheduledReminderAiRewriteEnabled: false,
  modelHealthAutoProbeEnabled: false,
};

const MSG_AI_FAIL = "我刚刚思考超时了，请稍后再试一次";
const MSG_CONVERSATION_NO_PERMISSION = "你没有清理其他人对话上下文的权限";
const MSG_LIVE_CHAT_NO_PERMISSION = "你没有管理实时对话的权限";
const MSG_INVALID_QQ = "请提供有效的 QQ 号";
const MSG_DAILY_REPORT_NO_PERMISSION = "你没有管理群聊日报的权限";
const MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION = "你没有管理节假日倒计时的权限";
const MSG_SCHEDULED_REMINDER_NO_PERMISSION = "你没有管理定时任务总开关的权限";
const MSG_ADMIN_RETIRED = "#管理员 已退休；后台账号绑定和 QQ 群角色会自动决定群内权限";
const MSG_ADMIN_NO_PERMISSION = "你没有管理管理员的权限";
const MSG_MUTE_NO_PERMISSION = "你没有让机器人闭嘴或说话的权限";
const MSG_BLACKLIST_NO_PERMISSION = "你没有管理机器人黑名单的权限";
const MSG_STATUS_NO_PERMISSION = "你没有查看机器人状态的权限";
const MSG_HEALTH_NO_PERMISSION = "你没有查看机器人健康检查的权限";
const MSG_OPERATION_LOG_NO_PERMISSION = "你没有查看机器人操作日志的权限";
const MSG_SERVER_NO_PERMISSION = "你没有查看服务器状态的权限";
const MSG_OPS_ALERT_NO_PERMISSION = "你没有管理运维告警的权限";
const MSG_MEMBER_PROFILE_UNAVAILABLE = "当前没有可用于回答这位群友相关问题的已保存资料。";
const MSG_QUOTED_MESSAGE_UNAVAILABLE = "这条引用我没读到，重新引用一下那条消息？";
const MSG_UNAUTHORIZED_CYBER_REFUSAL = "这类入侵或破解行为不能帮。想学安全可以聊账号安全、防护方案，或在有授权的靶场里练习。";
const MSG_IMAGE_SELECTION_REQUIRED = "你说的是哪张图？引用一下那条图片消息";
const MSG_REPLY_ENVELOPE_INVALID = "刚才那条没生成完整，别理它，重新问一句？";

const RUNTIME_COMMAND_SPECS = {
  bt_search: { builtinPrefix: BT_COMMAND_PRIMARY, builtinAliases: BT_COMMAND_ALIASES },
  blacklist: { builtinPrefix: BLACKLIST_PREFIX, builtinAliases: [] },
  conversation: { builtinPrefix: CONVERSATION_PREFIX, builtinAliases: [CLEAR_GROUP_CONTEXT_COMMAND] },
  daily_report: { builtinPrefix: DAILY_REPORT_PREFIX, builtinAliases: [] },
  health: { builtinPrefix: HEALTH_PREFIX, builtinAliases: [SHORT_HEALTH_PREFIX] },
  help: { builtinPrefix: HELP_PREFIXES[0]!, builtinAliases: HELP_PREFIXES.slice(1) },
  holiday_countdown: { builtinPrefix: HOLIDAY_COUNTDOWN_PREFIX, builtinAliases: [] },
  knowledge: { builtinPrefix: KNOWLEDGE_PREFIX, builtinAliases: [] },
  html_preview: { builtinPrefix: HTML_PREVIEW_PREFIX, builtinAliases: ["#html"] },
  image_generation: { builtinPrefix: IMAGE_GENERATION_PREFIX, builtinAliases: ["#生图"] },
  live_chat: { builtinPrefix: LIVE_CHAT_PREFIX, builtinAliases: [] },
  memory: { builtinPrefix: MEMORY_PREFIX, builtinAliases: [] },
  model: { builtinPrefix: MODEL_PREFIX, builtinAliases: [] },
  mute: { builtinPrefix: MUTE_COMMAND, builtinAliases: [UNMUTE_COMMAND] },
  operation_log: { builtinPrefix: OPERATION_LOG_PREFIX, builtinAliases: [] },
  ops_alert: { builtinPrefix: OPS_ALERT_PREFIX, builtinAliases: [] },
  scheduled_reminder: { builtinPrefix: SCHEDULED_REMINDER_PREFIX, builtinAliases: [] },
  server: { builtinPrefix: SERVER_PREFIX, builtinAliases: [] },
  status: { builtinPrefix: STATUS_PREFIX, builtinAliases: [] },
} as const;

type RuntimeCommandId = keyof typeof RUNTIME_COMMAND_SPECS;

interface RuntimeCommandMatch {
  rewrittenText: string;
  matchedPrefix: string;
  suffix: string;
}

interface KnowledgeContinuationSession {
  source: KnowledgeSourceId;
  query: string;
  reply: string;
  updatedAt: number;
  branchId?: string;
}

interface ReplyAiRoute {
  mode: ReplyModelMode;
  label: string;
  service: Pick<RuntimeAiService, "generateReply" | "generateStaticHtml">;
  supportsVision: boolean;
}

interface ReplyModelOption {
  mode: ReplyModelMode;
  label: string;
  service: Pick<RuntimeAiService, "generateReply" | "generateStaticHtml">;
  supportsVision: boolean;
}

interface ReplyAiResult {
  reply: AiReply;
  usedMode: ReplyModelMode;
  fallbackUsed: boolean;
  visionFallback: boolean;
}

interface ReplyGenerationArgs {
  skill: SkillDefinition;
  history: ConversationTurn[];
  userInput: string;
  images?: MessageImageInput[];
  identityContext?: AiIdentityContext;
  scenarioInstruction?: string;
  toolRuntime?: AiToolRuntime;
  signal?: AbortSignal;
}

export interface HtmlPreviewFallbackRoute {
  mode: ReplyModelMode;
  label: string;
  service: Pick<RuntimeAiService, "generateStaticHtml">;
}

/**
 * Static page generation must use the same worker-side concurrency and
 * circuit-breaker boundary as conversational requests. Unlike a reply call,
 * it has no useful degraded payload, so failures intentionally propagate to
 * the preview publication service for its fixed failure handling.
 */
export type BackgroundLlmGate = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

class VisionFallbackUnavailableError extends Error {
  constructor(modelLabel: string) {
    super(`No configured GPT vision route is available for image input while ${modelLabel} is selected.`);
    this.name = "VisionFallbackUnavailableError";
  }
}

class ImageInputUnavailableError extends Error {
  constructor() {
    super("The image could not be read into a model-ready format.");
    this.name = "ImageInputUnavailableError";
  }
}

class CausalContextPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Failed to atomically persist the causal assistant reply", { cause });
    this.name = "CausalContextPersistenceError";
  }
}

export interface TransportHealthStatus {
  ok: boolean;
  detail: string;
}

export interface MessageRecallPolicy {
  afterMs: number;
  deadlineMs: number;
}

export interface ForwardAutoRecallOptions {
  autoRecall?: MessageRecallPolicy;
}

export interface MessageTransport {
  sendGroupMessage(groupId: string, text: string, options?: { replyToMessageId?: string }): Promise<void | MessageReceipt>;
  sendGroupForwardMessage?(groupId: string, nodes: ForwardMessageNode[], options?: ForwardAutoRecallOptions): Promise<void | MessageReceipt>;
  /** Persists a recall after a direct transport receives a real platform receipt. */
  scheduleMessageRecall?(groupId: string, platformMessageId: string, policy: MessageRecallPolicy): Promise<void> | void;
  deleteMessage?(messageId: string): Promise<void>;
  sendGroupImage(groupId: string, imageFile: string): Promise<void | MessageReceipt>;
  /** Queues a worker-local generated image for ingress delivery and cleanup. */
  sendGeneratedGroupImage?(groupId: string, imagePath: string): Promise<void | MessageReceipt>;
  resolveImageInputs?(images: MessageImageInput[]): Promise<MessageImageInput[]>;
  listGroupMembers?(groupId: string, options?: { refresh?: boolean }): Promise<NapcatGroupMember[]>;
  listGroups?(): Promise<NapcatGroupInfo[]>;
  resolveMentionTargets?(groupId: string, candidates: string[]): Promise<string[]>;
  resolveMemberIdentities?(groupId: string, candidates: string[]): Promise<GroupMemberIdentity[]>;
  getMessage?(messageId: string): Promise<ReferencedMessage | undefined>;
  getHealthStatus?(): Promise<TransportHealthStatus>;
}

export interface MessageReceipt {
  /** Durable internal delivery id, for example outbox:42. */
  deliveryId?: string;
  /** Real QQ/NapCat message id. */
  platformMessageId?: string;
  /** @deprecated Use platformMessageId. Kept for third-party transports during rollout. */
  messageId?: string;
}

interface MessageInteractionContext {
  interactionTargets: AiInteractionTarget[];
  /**
   * Free-form candidate tokens from the source message. They are deliberately
   * kept out of interactionTargets: they may clean a literal `@` echo from an
   * LLM reply, but can never authorize person-specific context or an outbound
   * platform mention.
   */
  plainTextMentionCandidates?: string[];
  replyContext?: AiReplyContext;
  sourceMessageId?: string;
  replyMessageId?: string;
  senderCard?: string;
  senderNickname?: string;
}

interface ConversationOptions {
  allowControlledMention?: boolean;
  /** Explicit normal text paths only; live chat, commands and voice omit this. */
  allowNormalChatMeme?: boolean;
  scenarioInstruction?: string;
}

/**
 * The bot deliberately sees only selection operations. Library persistence,
 * probability, cooldowns and file validation remain owned by the meme service.
 */
export interface MemeLibraryRuntimeService {
  selectBlacklistedAtImage(groupId?: string): Promise<MemeImageSelection | undefined>;
  claimNormalChatImage(input: {
    groupId: string;
    userText: string;
    now?: number;
  }): Promise<MemeNormalChatClaimResult>;
}

export interface MemeImageSelection {
  imageFile: string;
}

export type MemeNormalChatClaimReason =
  | "sent_candidate"
  | "no_match"
  | "policy_disabled"
  | "probability_miss"
  | "cooldown"
  | "asset_unavailable";

export interface MemeNormalChatClaimResult {
  reason: MemeNormalChatClaimReason;
  selection?: MemeImageSelection;
  matchedTagIds: string[];
}

/**
 * The bot only clears and flushes conversation context. Keeping this
 * dependency narrow lets the V3 SQLite adapter replace the retired JSON store
 * without exposing either storage implementation to orchestration logic.
 */
export interface ConversationRuntimeStore {
  clearUser(groupId: string, userId: string): Promise<void>;
  clearGroup(groupId: string): Promise<void>;
  flush(): Promise<void>;
}

interface HandleGroupMessageOptions {
  /**
   * Granted only by the worker after its receipt-table check has established
   * that the incoming reply quotes one of this bot's own group messages.
   */
  allowReplyWithoutMention?: boolean;
}

type OpsAlertType = "startup" | "napcat-down" | "memory-high" | "send-failure" | "send-recovered";

interface OpsAlertRuntimeState {
  startupSent: boolean;
  lastTransportOk?: boolean;
  memoryAlertActive: boolean;
  consecutiveSendFailures: number;
  sendFailureAlertActive: boolean;
  lastAlertAtByType: Map<OpsAlertType, number>;
  lastAlertSummary?: string;
}

export class BotApplication {
  private readonly participationService: GroupParticipationService;
  private readonly maintenanceScheduler: MaintenanceScheduler;
  private readonly explicitMemoryService?: ExplicitMemoryService;
  private backgroundLlmGate?: BackgroundLlmGate;
  private replyRouter?: ReplyModelRouter;
  private readonly groupRepeatStates = new Map<string, { text: string; count: number; lastTimestamp: number }>();
  private readonly knowledgeContinuationSessions = new Map<string, KnowledgeContinuationSession>();
  private readonly knowledgeLatestMessages = new Map<string, string>();
  private readonly recoveredReplyContexts = new Map<string, { context: AiReplyContext; expiresAt: number }>();
  private readonly identityQueryLock = new GroupLock(1);
  private readonly opsAlertState: OpsAlertRuntimeState = {
    startupSent: false,
    memoryAlertActive: false,
    consecutiveSendFailures: 0,
    sendFailureAlertActive: false,
    lastAlertAtByType: new Map(),
  };

  constructor(
    private readonly transport: MessageTransport,
    private readonly groupConfigService: GroupConfigService,
    private readonly skillService: Pick<SkillService | CharacterProfileService, "getSkill">,
    private readonly conversationStore: ConversationRuntimeStore,
    private readonly aiService: RuntimeAiService,
    _retiredSpeechService: unknown,
    private readonly dailyReportService: DailyReportService,
    private readonly holidayCountdownService: HolidayCountdownService,
    private readonly scheduledReminderService: ScheduledReminderService,
    private readonly adminOperationLogService: AdminOperationLogService,
    private readonly groupLock: GroupLock,
    private readonly liveChatService: LiveChatService,
    private readonly botQq: string,
    _retiredSpeechFallback = false,
    private readonly groupMemoryStore?: GroupMemoryStore,
    private readonly knowledgeBaseStore?: KnowledgeBaseStore,
    // Retired V1/V2 constructor slots remain so external embeddings do not
    // silently shift subsequent dependencies. V3 never invokes them.
    _retiredCandidateService?: unknown,
    _retiredProfileService?: unknown,
    private readonly adminPublicBaseUrl?: string,
    _retiredProfileAiService?: unknown,
    private readonly replyModelLabels: Partial<Record<ReplyModelMode, string>> = {},
    private readonly systemSettingsStore?: SystemSettingsStore,
    _retiredProfileRecordStore?: unknown,
    private readonly realtimeLookupService?: Pick<RealtimeLookupService, "lookup">,
    private readonly groupTranscriptService = new GroupTranscriptService(),
    private readonly atmosphereSummarizer?: Pick<AtmosphereSummarizer, "getSummary" | "summarizeNow">,
    private llmGate?: (task: () => Promise<AiReply>, signal?: AbortSignal) => Promise<AiReply>,
    private readonly imagePipeline?: Pick<ImagePipeline, "resolveForVision">,
    private cancelledReplyHook?: () => void,
    private startupAlertsEnabled = true,
    private readonly conversationContextRepository?: ConversationContextRepository,
    private readonly conversationContextRouter?: ConversationContextRouter,
    /** Present for V3 composition; omitted only by pre-cutover compatibility embeddings. */
    private readonly capabilityPolicy?: RuntimeCapabilityPolicy,
    /** Durable static HTML publisher, absent only in older compatibility embeddings. */
    private readonly htmlPreviewService?: Pick<HtmlPreviewService, "enqueue" | "processNext" | "cleanup">,
    /** Strictly bound fallback; it must never resolve back to the primary model. */
    private readonly htmlPreviewFallbackRoute?: HtmlPreviewFallbackRoute,
    /** V3 bridge from a QQ sender to an authenticated administrator account. */
    private readonly qqAdminAuthorization?: QqAdminAuthorization,
    /** Read-only, bounded access to the durable recent group transcript. */
    private readonly recentGroupEvidenceService?: Pick<RecentGroupEvidenceService, "list"> &
      Partial<Pick<RecentGroupEvidenceService, "listAmbient">>,
    /** Optional during the V3 library rollout so legacy embeddings remain valid. */
    private readonly memeLibraryService?: MemeLibraryRuntimeService,
    /** Text-to-image generation is V3-only and absent in compatibility embeddings. */
    private readonly imageGenerationService?: ImageGenerationRuntime,
    private readonly privateEnterpriseRanking?: PrivateEnterpriseRanking,
    private readonly knowledgeSourceBindingStore = new KnowledgeSourceBindingStore(),
    private readonly btSearchService?: BtSearchRuntime,
    /** Private successful-image archive, absent only for compatibility embeddings. */
    private readonly imagePreviewArchiveService?: Pick<ImagePreviewArchiveService, "archive" | "cleanup">,
  ) {
    this.participationService = new GroupParticipationService(
      this.groupConfigService,
      this.systemSettingsStore,
    );
    this.maintenanceScheduler = new MaintenanceScheduler({
      jobs: [
        { id: "live-chat", intervalMs: BOT_MAINTENANCE_INTERVALS.liveChat, run: () => this.runLiveChatTick() },
        { id: "daily-report", intervalMs: BOT_MAINTENANCE_INTERVALS.dailyReport, run: () => this.runDailyReportTick() },
        { id: "holiday-countdown", intervalMs: BOT_MAINTENANCE_INTERVALS.holidayCountdown, run: () => this.runHolidayCountdownTick() },
        { id: "scheduled-reminder", intervalMs: BOT_MAINTENANCE_INTERVALS.scheduledReminder, run: () => this.runScheduledReminderTick() },
        { id: "ops-alert", intervalMs: BOT_MAINTENANCE_INTERVALS.opsAlert, run: () => this.runOpsAlertTick() },
        { id: "daily-report-cleanup", intervalMs: BOT_MAINTENANCE_INTERVALS.dailyReportCleanup, run: () => this.runDailyReportCleanupTick() },
        { id: "html-preview-cleanup", intervalMs: 60 * 60 * 1_000, run: () => this.runHtmlPreviewCleanupTick() },
        { id: "image-generation-cleanup", intervalMs: 60 * 60 * 1_000, run: () => this.runImageGenerationCleanupTick() },
        { id: "image-preview-cleanup", intervalMs: 60 * 60 * 1_000, run: () => this.runImagePreviewCleanupTick() },
      ],
      pollIntervalMs: BOT_MAINTENANCE_INTERVALS.poll,
    });
    if (this.groupMemoryStore) {
      this.explicitMemoryService = new ExplicitMemoryService(this.groupMemoryStore);
    }
  }

  start(): void {
    if (!this.maintenanceScheduler.start()) {
      return;
    }

    if (this.startupAlertsEnabled !== false) {
      void this.runOpsAlertTick({ includeStartup: true });
    }
  }

  async stop(): Promise<void> {
    this.maintenanceScheduler.stop();
    await this.btSearchService?.stop?.();
    await this.conversationStore.flush();
  }

  private async getRuntimeCommands(): Promise<SystemCommandConfig[]> {
    return readRuntimeCommands(this.systemSettingsStore);
  }

  async getBtCommand(text: string): Promise<BtCommandMatch | undefined> {
    return matchBtCommand(text, await this.getRuntimeCommands());
  }

  async isSystemCommand(text: string): Promise<boolean> {
    return isSystemCommandText(text, await this.getRuntimeCommands());
  }

  /**
   * Kept public for the Worker key selector so an explicit page request gets
   * the dedicated per-group FIFO queue before generic participation routing.
   */
  async getHtmlPreviewRequest(text: string, hasAtBot: boolean): Promise<ParsedHtmlPreviewRequest | undefined> {
    const commands = await this.getRuntimeCommands();
    const command = matchRuntimeCommand(text, commands, "html_preview");
    if (command?.suffix.trim()) {
      return { request: command.suffix.trim(), source: "command" };
    }
    // A disabled runtime command remains disabled. Do not let the pure parser
    // reinterpret its literal `#网页` spelling as a natural-language request.
    if (isSystemCommandText(text, commands)) {
      return undefined;
    }
    return parseHtmlPreviewRequest(text, hasAtBot);
  }

  private async getTokenCostControl(): Promise<TokenCostControlSettings> {
    if (!this.systemSettingsStore) {
      return DEFAULT_TOKEN_COST_CONTROL;
    }
    try {
      return (await this.systemSettingsStore.get()).tokenCostControl;
    } catch (error) {
      logWarn("Failed to read token cost control settings; using conservative defaults.", {
        error: (error as Error).message,
      });
      return DEFAULT_TOKEN_COST_CONTROL;
    }
  }

  async handleGroupMessage(
    event: NapcatGroupMessageEvent,
    signal?: AbortSignal,
    conversationRoute?: ConversationRoute,
    options: HandleGroupMessageOptions = {},
  ): Promise<void> { return withModelOperation("reply", String(event.group_id), async () => {
    const groupId = String(event.group_id);
    const userId = String(event.user_id);

    if (userId === this.botQq || event.user_id === event.self_id) {
      return;
    }

    const groupConfig = await this.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      logInfo("Ignored message from unconfigured group.", { groupId, userId });
      return;
    }
    if (groupConfig.enabled === false) {
      logInfo("Ignored message from disabled group.", { groupId, userId });
      return;
    }

    if (
      (typeof event.message === "string" && event.message.trim() === "") ||
      (Array.isArray(event.message) && event.message.length === 0)
    ) {
      return;
    }

    const parsedMessage = parseGroupMessage(event.message, this.botQq);
    const commandText = extractCommandText(event.message);
    const runtimeCommands = await this.getRuntimeCommands();
    const knowledgeSessionKey = knowledgeContinuationKey(groupId, userId);
    this.knowledgeLatestMessages.delete(knowledgeSessionKey);
    this.knowledgeLatestMessages.set(knowledgeSessionKey, String(event.message_id));
    for (const [key, session] of this.knowledgeContinuationSessions) {
      if (Date.now() - session.updatedAt >= KNOWLEDGE_CONTINUATION_WINDOW_MS) this.knowledgeContinuationSessions.delete(key);
    }
    if (this.knowledgeLatestMessages.size > 2_000) {
      const oldestKey = this.knowledgeLatestMessages.keys().next().value!;
      this.knowledgeLatestMessages.delete(oldestKey);
      this.knowledgeContinuationSessions.delete(oldestKey);
    }
    const rankingSourceCommand = this.knowledgeSourceBindingStore.get("private_enterprise_ranking");
    const groupFaqSourceCommand = this.knowledgeSourceBindingStore.get("group_faq", groupId);
    const rankingSourceCommandMatch = matchCommandPrefix(commandText, [rankingSourceCommand], rankingSourceCommand);
    const groupFaqSourceCommandMatch = matchCommandPrefix(commandText, [groupFaqSourceCommand], groupFaqSourceCommand);
    const previousKnowledgeSession = this.knowledgeContinuationSessions.get(knowledgeSessionKey);
    const incomingText = parsedMessage.text.trim();
    const explicitKnowledgeSource = classifyPrivateEnterpriseRankingRequest(incomingText) === "explicit" ||
      isExplicitGroupFaqLookup(incomingText);
    const triggeredReply = parsedMessage.hasAtBot || options.allowReplyWithoutMention === true;
    const canContinueKnowledge = Boolean(previousKnowledgeSession &&
      Date.now() - previousKnowledgeSession.updatedAt < KNOWLEDGE_CONTINUATION_WINDOW_MS &&
      triggeredReply && !isSystemCommandText(commandText, runtimeCommands) &&
      (!parsedMessage.replyMessageId || Boolean(previousKnowledgeSession.branchId &&
        previousKnowledgeSession.branchId === conversationRoute?.branchId)) &&
      isKnowledgeContinuation(previousKnowledgeSession, incomingText));
    if (rankingSourceCommandMatch || groupFaqSourceCommandMatch || explicitKnowledgeSource || !canContinueKnowledge) {
      this.knowledgeContinuationSessions.delete(knowledgeSessionKey);
    }

    // Recognize denied and disabled commands before any chat or evidence path.
    const configuredCommand = runtimeCommands.find(command => matchCommandPrefix(commandText, [command.primary, ...command.aliases], command.primary));
    if (configuredCommand && !this.isBlacklistedUser(groupConfig, userId)) {
      if (!configuredCommand.enabled) return;
      const match = matchCommandPrefix(commandText, [configuredCommand.primary, ...configuredCommand.aliases], configuredCommand.primary)!;
      const modelRead = configuredCommand.id === "model" && /^(?:状态|列表)?$/.test(match.suffix.trim());
      if (!modelRead && !(await this.canUseRuntimeCommand(configuredCommand, groupConfig, event))) {
        if (!groupConfig.botMuted) await this.sendText(groupId, "你没有使用这条指令的权限");
        return;
      }
    }

    const btCommand = matchBtCommand(commandText, runtimeCommands);
    if (btCommand) {
      if (btCommand.enabled && groupConfig.botMuted !== true && !this.isBlacklistedUser(groupConfig, userId)) {
        await this.handleBtSearchCommand(groupConfig, btCommand, signal);
      }
      return;
    }

    const blacklistCommand = matchRuntimeCommand(commandText, runtimeCommands, "blacklist");
    if (blacklistCommand) {
      const handled = await this.handleBlacklistCommand(groupConfig, event, blacklistCommand.rewrittenText);
      if (handled) {
        return;
      }
      // A blacklisted member's blacklist-management command remains silent.
      // It must not fall through into the general mention-triggered image path.
      if (this.isBlacklistedUser(groupConfig, userId)) {
        await this.recordDailyReportMessage(groupConfig, event, parsedMessage);
        return;
      }
    }

    if (this.isBlacklistedUser(groupConfig, userId)) {
      await this.recordDailyReportMessage(groupConfig, event, parsedMessage);
      if (parsedMessage.hasAtBot) {
        await this.maybeSendBlacklistedAtMeme(groupId);
      }
      return;
    }

    if (isRetiredPersonaCommand(commandText)) {
      await this.sendText(groupId, "会仙人格是唯一固定角色；人格市场已退休，角色切换已关闭。");
      return;
    }

    this.recordGroupTranscriptMessage(groupConfig, event, parsedMessage, commandText, runtimeCommands);

    const muteCommand = matchRuntimeCommand(commandText, runtimeCommands, "mute");
    if (muteCommand) {
      await this.handleMuteCommand(groupConfig, event, muteCommand.rewrittenText);
      return;
    }

    const statusCommand = matchRuntimeCommand(commandText, runtimeCommands, "status");
    if (statusCommand) {
      await this.handleStatusCommand(groupConfig, event);
      return;
    }

    const healthCommand = matchRuntimeCommand(commandText, runtimeCommands, "health");
    if (healthCommand) {
      await this.handleHealthCommand(groupConfig, event);
      return;
    }

    const operationLogCommand = matchRuntimeCommand(commandText, runtimeCommands, "operation_log");
    if (operationLogCommand) {
      await this.handleOperationLogCommand(groupConfig, event);
      return;
    }

    const serverCommand = matchRuntimeCommand(commandText, runtimeCommands, "server");
    if (serverCommand) {
      await this.handleServerCommand(groupConfig, event);
      return;
    }

    const memoryCommand = matchRuntimeCommand(commandText, runtimeCommands, "memory");
    if (memoryCommand) {
      if (!this.isCapabilityEnabled("explicit_memory")) {
        await this.rejectCapability(groupId, "explicit_memory");
        return;
      }
      await this.handleMemoryCommand(groupConfig, event, memoryCommand.rewrittenText);
      return;
    }

    const knowledgeCommand = matchRuntimeCommand(commandText, runtimeCommands, "knowledge");
    if (knowledgeCommand) {
      if (!this.isCapabilityEnabled("knowledge")) {
        await this.rejectCapability(groupId, "knowledge");
        return;
      }
      await this.handleKnowledgeStatusCommand(groupConfig, event);
      return;
    }

    const selectedKnowledgeCommand = rankingSourceCommandMatch
      ? { source: "private_enterprise_ranking" as const, query: rankingSourceCommandMatch.suffix }
      : groupFaqSourceCommandMatch
        ? { source: "group_faq" as const, query: groupFaqSourceCommandMatch.suffix }
        : undefined;
    if (selectedKnowledgeCommand) {
      if (!this.isCapabilityEnabled("knowledge")) {
        await this.rejectCapability(groupId, "knowledge");
        return;
      }
      await this.handleSelectedKnowledgeCommand(groupConfig, event, selectedKnowledgeCommand.source, selectedKnowledgeCommand.query);
      return;
    }

    const opsAlertCommand = matchRuntimeCommand(commandText, runtimeCommands, "ops_alert");
    if (opsAlertCommand) {
      await this.handleOpsAlertCommand(groupConfig, event, opsAlertCommand.rewrittenText);
      return;
    }

    if (groupConfig.botMuted === true) {
      const dailyReportCommand = matchRuntimeCommand(commandText, runtimeCommands, "daily_report");
      if (dailyReportCommand) {
        if (!this.isCapabilityEnabled("daily_reports")) {
          await this.rejectCapability(groupId, "daily_reports");
          return;
        }
        await this.handleDailyReportCommand(groupConfig, event, dailyReportCommand.rewrittenText);
        return;
      }

      const holidayCountdownCommand = matchRuntimeCommand(commandText, runtimeCommands, "holiday_countdown");
      if (holidayCountdownCommand) {
        if (!this.isCapabilityEnabled("holiday_countdown")) {
          await this.rejectCapability(groupId, "holiday_countdown");
          return;
        }
        await this.handleHolidayCountdownCommand(groupConfig, event, holidayCountdownCommand.rewrittenText);
        return;
      }

      const scheduledReminderCommand = matchRuntimeCommand(commandText, runtimeCommands, "scheduled_reminder");
      if (scheduledReminderCommand) {
        if (!this.isCapabilityEnabled("scheduled_reminders")) {
          await this.rejectCapability(groupId, "scheduled_reminders");
          return;
        }
        await this.handleScheduledReminderCommand(groupConfig, event, scheduledReminderCommand.rewrittenText);
        return;
      }

      await this.recordDailyReportMessage(groupConfig, event, parsedMessage);
      const chatSummaryRequest = parsedMessage.hasAtBot
        ? parseChatSummaryRequest(parsedMessage.text, new Date())
        : null;
      if (chatSummaryRequest) {
        if (!this.isCapabilityEnabled("daily_reports")) {
          await this.rejectCapability(groupId, "daily_reports");
          return;
        }
        await this.groupLock.run(groupId, async () => {
          const tokenCostControl = await this.getTokenCostControl();
          const summary = await this.dailyReportService.buildChatSummary({
            groupId,
            request: chatSummaryRequest,
            now: new Date(),
            useAiSummary: tokenCostControl.chatSummaryAiEnabled,
            members: await this.safeListGroupMembers(groupId),
          });
          await this.sendText(groupId, summary);
        });
      }
      return;
    }

    const liveChatCommand = matchRuntimeCommand(commandText, runtimeCommands, "live_chat");
    if (liveChatCommand) {
      if (!this.isCapabilityEnabled("conversation")) {
        await this.rejectCapability(groupId, "conversation");
        return;
      }
      await this.handleLiveChatCommand(groupConfig, event, liveChatCommand.rewrittenText);
      return;
    }

    const helpCommand = matchRuntimeCommand(commandText, runtimeCommands, "help");
    if (helpCommand) {
      await this.handleHelpCommand(groupConfig, event, helpCommand.rewrittenText, runtimeCommands);
      return;
    }

    // This is intentionally not a configurable runtime command. V3 retires
    // QQ-number administration even if an old command setting survived a
    // pre-cutover JSON file.
    const adminCommand = matchCommandPrefix(commandText, [ADMIN_PREFIX], ADMIN_PREFIX);
    if (adminCommand) {
      if (this.usesV3AdminAuthority()) {
        await this.sendText(groupId, MSG_ADMIN_RETIRED);
      } else {
        await this.handleLegacyAdminCommand(groupConfig, event, adminCommand.rewrittenText);
      }
      return;
    }

    const conversationCommand = matchRuntimeCommand(commandText, runtimeCommands, "conversation");
    if (conversationCommand) {
      if (conversationCommand.matchedPrefix === CLEAR_GROUP_CONTEXT_COMMAND) {
        await this.handleClearGroupContextCommand(groupConfig, event);
      } else {
        await this.handleConversationCommand(groupConfig, event, conversationCommand.rewrittenText);
      }
      return;
    }

    const modelCommand = matchRuntimeCommand(commandText, runtimeCommands, "model");
    if (modelCommand) {
      await this.handleModelCommand(groupConfig, event, modelCommand.rewrittenText);
      return;
    }

    const dailyReportCommand = matchRuntimeCommand(commandText, runtimeCommands, "daily_report");
    if (dailyReportCommand) {
      if (!this.isCapabilityEnabled("daily_reports")) {
        await this.rejectCapability(groupId, "daily_reports");
        return;
      }
      await this.handleDailyReportCommand(groupConfig, event, dailyReportCommand.rewrittenText);
      return;
    }

    const holidayCountdownCommand = matchRuntimeCommand(commandText, runtimeCommands, "holiday_countdown");
    if (holidayCountdownCommand) {
      if (!this.isCapabilityEnabled("holiday_countdown")) {
        await this.rejectCapability(groupId, "holiday_countdown");
        return;
      }
      await this.handleHolidayCountdownCommand(groupConfig, event, holidayCountdownCommand.rewrittenText);
      return;
    }

    const scheduledReminderCommand = matchRuntimeCommand(commandText, runtimeCommands, "scheduled_reminder");
    if (scheduledReminderCommand) {
      if (!this.isCapabilityEnabled("scheduled_reminders")) {
        await this.rejectCapability(groupId, "scheduled_reminders");
        return;
      }
      await this.handleScheduledReminderCommand(groupConfig, event, scheduledReminderCommand.rewrittenText);
      return;
    }

    const htmlPreviewCommand = matchRuntimeCommand(commandText, runtimeCommands, "html_preview");
    if (htmlPreviewCommand) {
      const request = htmlPreviewCommand.suffix.trim();
      if (!request) {
        await this.sendText(groupId, `网页命令格式：${runtimeCommandPrimary(runtimeCommands, "html_preview")} <需求>`);
        return;
      }
      await this.handleHtmlPreviewRequest(groupConfig, event, { request, source: "command" }, signal);
      return;
    }

    const imageGenerationCommand = matchRuntimeCommand(commandText, runtimeCommands, "image_generation");
    if (imageGenerationCommand) {
      await this.handleImageGenerationCommand(groupConfig, event, imageGenerationCommand.suffix, signal);
      return;
    }

    const naturalHtmlPreviewRequest = isSystemCommandText(commandText, runtimeCommands)
      ? undefined
      : parseHtmlPreviewRequest(parsedMessage.text, parsedMessage.hasAtBot);
    if (naturalHtmlPreviewRequest?.source === "natural") {
      await this.handleHtmlPreviewRequest(groupConfig, event, naturalHtmlPreviewRequest, signal);
      return;
    }

    const repeatText = extractRepeatableText(event.message, this.botQq);
    if (allowsSelectedMemberParticipation(groupConfig) && repeatText && this.checkAndTriggerRepeat(groupId, repeatText)) {
      logInfo("Triggered repeat message.", { groupId, userId, text: repeatText });
      await this.sendText(groupId, repeatText);
      return;
    }

    const messageContext = await this.buildMessageInteractionContext(
      groupConfig,
      parsedMessage,
      String(event.message_id),
      event.sender?.card,
      event.sender?.nickname,
    );
    // Random reactions are intentionally limited to messages that are text
    // only. A vision turn can already return or discuss an image; appending an
    // unrelated meme there makes the response noisy and breaks the normal
    // text-conversation scope of the library.
    const allowNormalChatMeme =
      parsedMessage.text.trim().length > 0 &&
      parsedMessage.images.length === 0 &&
      (messageContext.replyContext?.images?.length ?? 0) === 0;
    const chatSummaryRequest = parsedMessage.hasAtBot
      ? parseChatSummaryRequest(parsedMessage.text, new Date())
      : null;

    if (chatSummaryRequest) {
      const reportCommand = runtimeCommands.find(command => command.id === "daily_report");
      if (reportCommand && !(await this.canUseRuntimeCommand(reportCommand, groupConfig, event))) return;
      if (!this.isCapabilityEnabled("daily_reports")) {
        await this.rejectCapability(groupId, "daily_reports");
        return;
      }
      await this.groupLock.run(groupId, async () => {
        const tokenCostControl = await this.getTokenCostControl();
        const summary = await this.dailyReportService.buildChatSummary({
          groupId,
          request: chatSummaryRequest,
          now: new Date(),
          useAiSummary: tokenCostControl.chatSummaryAiEnabled,
          members: await this.safeListGroupMembers(groupId),
        });
        await this.sendText(groupId, summary);
      });
      return;
    }

    if (parsedMessage.hasAtBot) {
      const reminderRequest = this.scheduledReminderService.parseCreateRequest(parsedMessage.text);
      if (reminderRequest) {
        if (!this.isCapabilityEnabled("scheduled_reminders")) {
          await this.rejectCapability(groupId, "scheduled_reminders");
          return;
        }
        if (!isRuntimeCommandEnabled(runtimeCommands, "scheduled_reminder")) {
          logInfo("Ignored natural scheduled reminder command because runtime command is disabled.", { groupId, userId });
          return;
        }
        const reminderCommand = runtimeCommands.find(command => command.id === "scheduled_reminder");
        if (reminderCommand && !(await this.canUseRuntimeCommand(reminderCommand, groupConfig, event))) { await this.sendText(groupId, "你没有设置定时任务的权限"); return; }
        const task = await this.scheduledReminderService.createTask({
          groupId,
          creatorUserId: userId,
          request: reminderRequest,
          now: new Date(),
        });
        await this.sendText(
          groupId,
          `已设置定时任务 ${task.id}：每 ${formatIntervalLabel(task.intervalMinutes)} 提醒群友${task.topic}`,
        );
        return;
      }
    }

    await this.recordDailyReportMessage(groupConfig, event, parsedMessage);

    const explicitMemoryRequest = parseExplicitMemoryRequest(parsedMessage.text);
    if (
      explicitMemoryRequest &&
      (parsedMessage.hasAtBot || options.allowReplyWithoutMention === true)
    ) {
      const memoryCommand = runtimeCommands.find(command => command.id === "memory");
      if (memoryCommand && !(await this.canUseRuntimeCommand(memoryCommand, groupConfig, event))) return;
      if (!this.isCapabilityEnabled("explicit_memory")) {
        await this.rejectCapability(groupId, "explicit_memory");
        return;
      }
      await this.handleExplicitMemoryRequest(groupConfig, event, explicitMemoryRequest);
      return;
    }

    const conversationPolicy = runtimeCommands.find(command => command.id === "conversation");
    if (conversationPolicy && !(await this.canUseRuntimeCommand(conversationPolicy, groupConfig, event))) return;
    if (await this.participationService.shouldTriggerKeyword(groupConfig, parsedMessage.text, parsedMessage.hasAtBot, commandText)) {
      const keywordMentionUserIds = this.resolveKeywordReplyMentionUserIds(
        userId,
        messageContext,
      );
      await this.groupLock.run(groupId, async () => {
        await this.handleConversation(
          groupConfig,
          userId,
          parsedMessage.text,
          parsedMessage.images,
          resolveDefaultReplyMode(),
          keywordMentionUserIds,
          messageContext,
          { allowNormalChatMeme },
          conversationRoute,
          signal,
        );
      });
      return;
    }

    if (allowsSelectedMemberParticipation(groupConfig) && this.isLiveChatUser(groupConfig, userId) && shouldBufferActiveChatMessage(parsedMessage, commandText)) {
      this.liveChatService.addMessage(groupId, userId, parsedMessage.text, Date.now(), messageContext);
    }

    if (
      (!parsedMessage.hasAtBot && options.allowReplyWithoutMention !== true) ||
      (!parsedMessage.text && parsedMessage.images.length === 0)
    ) {
      logInfo("Ignored message because bot was not mentioned or content empty.", {
        groupId,
        userId,
        hasAtBot: parsedMessage.hasAtBot,
        allowReplyWithoutMention: options.allowReplyWithoutMention === true,
        textLength: parsedMessage.text.length,
        imageCount: parsedMessage.images.length,
      });
      return;
    }

    await this.groupLock.run(groupId, async () => {
      await this.handleConversation(
        groupConfig,
        userId,
        parsedMessage.text,
        parsedMessage.images,
        resolveDefaultReplyMode(),
        [],
        messageContext,
        {
          allowControlledMention: parsedMessage.hasAtBot,
          allowNormalChatMeme,
        },
        conversationRoute,
        signal,
      );
    });

}); }

  async getPublicTransportHealthStatus(): Promise<TransportHealthStatus> {
    return this.getTransportHealthStatus();
  }

  getBotQq(): string {
    return this.botQq;
  }

  /** Legacy embeddings have no V3 policy object; V3 composition always does. */
  private isCapabilityEnabled(capability: V3RuntimeCapability): boolean {
    return this.capabilityPolicy?.isEnabled(capability) ?? true;
  }

  private async rejectCapability(groupId: string, capability: V3RuntimeCapability): Promise<void> {
    logInfo("Skipped disabled V3 capability.", { groupId, capability });
    await this.sendText(groupId, "该功能当前未启用，请联系管理员处理。");
  }

  private isProviderFeatureEnabled(protocol: ProviderProtocol, feature: ProviderCapabilityFeature): boolean {
    return this.capabilityPolicy?.isProviderFeatureEnabled(protocol, feature) ?? true;
  }

  /**
   * Gives ingress/worker one explainable decision for every inbound message.
   * This is deliberately conservative in its first version: it preserves the
   * existing reply contract while making future natural participation auditable.
   */
  async getParticipationDecision(
    groupId: string,
    text: string,
    hasAtBot: boolean,
    options: { hasImages?: boolean; replyToBot?: boolean; userId?: string } = {},
  ): Promise<ParticipationDecision> {
    const decision = await this.participationService.decide(groupId, text, hasAtBot, options);
    if (decision.action === "observe" && options.userId && isDirectedFollowUp(text) && this.isCapabilityEnabled("conversation")) {
      const group = await this.groupConfigService.getGroup(groupId);
      const active = this.conversationContextRepository?.getActiveRoute(groupId, options.userId);
      if (group && group.enabled !== false && !group.botMuted && !(group.blacklistedUserIds ?? []).includes(options.userId) &&
        active && Date.now() - active.updatedAt >= 0 && Date.now() - active.updatedAt <= 120_000) {
        const turns = this.conversationContextRepository!.getCausalTurns(active.branchId, active.headTurnId);
        if (turns.some(turn => turn.role === "assistant" && this.conversationContextRepository!.orchestration.deliveredText(turn.id, turn.content, turn.deliveryId))) return { ...decision, action: "reply", reason: "directed_follow_up", score: 0.95, signals: { ...decision.signals, directedFollowUp: true } };
      }
    }
    if (decision.action === "reply" && !this.isCapabilityEnabled("conversation")) {
      return {
        ...decision,
        action: "observe",
        reason: "ambient_observation",
        score: 0,
        signals: { ...decision.signals, capabilityConversation: false },
      };
    }
    return decision;
  }

  /** Resolve context before selecting a serial queue; retries reuse the stored decision. */
  async prepareConversationRoute(input: ConversationRouteInput, signal?: AbortSignal): Promise<ConversationRoute | undefined> {
    const repository = this.conversationContextRepository;
    if (!repository || !this.conversationContextRouter) return undefined;
    const existing = repository.getRouteBySourceRowId(input.sourceRowId);
    if (existing) return existing;
    const group = await this.groupConfigService.getGroup(input.groupId);
    if (!group || group.enabled === false || !this.isCapabilityEnabled("conversation") || (group.blacklistedUserIds ?? []).includes(input.userId)) return undefined;
    const store = repository.orchestration;
    if (!store || isMemberProfileQueryRequest(input.text)) return this.conversationContextRouter.resolve(input);
    const now = store.sourceReceivedAt(input.sourceRowId) ?? input.nowMs ?? Date.now();
    const excluded = [...(group.blacklistedUserIds ?? []), ...(group.memoryDisabledUserIds ?? [])];
    // Resolve the explicit quote before the identity shortcut can discard it.
    let reference = input.replyToMessageId ? store.reference(input.groupId, input.replyToMessageId, input.sourceRowId, excluded) : undefined;
    if (input.replyToMessageId && !hasReadableReference(reference)) {
      const recovered = await this.resolveReplyContext(group, input.replyToMessageId);
      if (recovered) reference = {
        messageId: recovered.messageId,
        ...(recovered.userId ? { userId: recovered.userId } : {}),
        ...(recovered.userName ? { userName: recovered.userName } : {}),
        text: recovered.text, images: recovered.images ?? [],
      };
    }
    const explicitImagePersonQuestion = isExplicitImagePersonQuestion(input.text);
    const deicticImagePersonQuestion = isDeicticImagePersonQuestion(input.text);
    // Only an explicit visual phrase can recover a prior image by proximity.
    // A bare "他是谁" still needs an image on this message or its quote; an
    // unrelated recent photo must not steal an ordinary member lookup.
    const recentImageCandidates = explicitImagePersonQuestion && !input.replyToMessageId && !excluded.includes(input.userId)
      ? store.recentMedia(input.groupId, input.userId, input.sourceRowId, now)
      : [];
    // Identity questions are normally deterministic lookups. A visually
    // deictic question needs its image anchor first: otherwise "这是哪位" can
    // be reduced to the fake member name "这" before vision sees the image.
    const deferIdentityForImage = explicitImagePersonQuestion ||
      (deicticImagePersonQuestion && (
        Boolean(input.hasImages) || Boolean(input.replyToMessageId)
      ));
    if ((isMemberIdentityQuerySyntax(input.text) || isSavedIdentityComparisonSyntax(input.text, group)) && !deferIdentityForImage) {
      return this.conversationContextRouter.resolve({ ...input, resolvedContext: { newTopic: true } });
    }
    const contextEnabled = group.ambientGroupContextEnabled !== false;
    const candidates = store.listCandidates(input.groupId, input.sourceRowId, now, excluded)
      .filter(candidate => contextEnabled || candidate.ownerUserId === input.userId);
    let messages: NonNullable<AiIdentityContext["ambientGroupContext"]> = [];
    if (contextEnabled) {
      try {
        messages = this.recentGroupEvidenceService?.listAmbient?.({
          groupId: input.groupId, beforeSourceRowId: input.sourceRowId, lookbackMs: 10 * 60_000, excludedUserIds: excluded, limit: 60,
        }) ?? [];
      } catch (error) {
        logWarn("Context candidate read failed closed.", { groupId: input.groupId, sourceRowId: input.sourceRowId, error: summarizeAiError(error) });
      }
    }
    const bareOpinionRequest = isBareOpinionRequest(input.text);
    const contextInput = () => ({
      userId: input.userId,
      text: input.text,
      hasImages: Boolean(input.hasImages),
      replyToMessageId: input.replyToMessageId,
      reference,
      candidates,
      messages,
    });
    const needsSemanticContext = !/^(?:你好|嗨|在吗|早|晚安|谢谢|好的)[!！?？。\s]*$/u.test(input.text.trim()) &&
      !bareOpinionRequest &&
      (!input.replyToMessageId || hasReadableReference(reference)) &&
      (candidates.length > 0 || Boolean(reference) || /(?:上面|刚才|这个|那个|所以|看图|展开|继续)/u.test(input.text));
    const resolver = new ContextResolver(this.aiService.resolveConversationContext && needsSemanticContext ? async (instruction, data, resolverSignal) => {
      const router = await this.getReplyRouter();
      if (router) {
        const session = await router.begin(group, "auxiliary", { signal: resolverSignal, gate: this.backgroundLlmGate });
        return (await session.run((service, routedSignal) => service.resolveConversationContext?.({ instruction, data, signal: routedSignal }) ?? Promise.resolve(""))).value;
      }
      const execute = () => this.aiService.resolveConversationContext!({ instruction, data, signal: resolverSignal });
      return this.backgroundLlmGate ? this.backgroundLlmGate(execute, resolverSignal) : execute();
    } : undefined);
    let resolution = resolveContextByRules(contextInput());
    try {
      resolution = await resolver.resolve(contextInput(), signal);
      if (resolution.needsMoreContext && contextEnabled && this.recentGroupEvidenceService?.listAmbient) {
        messages = this.recentGroupEvidenceService.listAmbient({ groupId: input.groupId, beforeSourceRowId: input.sourceRowId, lookbackMs: 60 * 60_000, excludedUserIds: excluded, limit: 200 });
        resolution = {
          ...(bareOpinionRequest
            ? resolveContextByRules(contextInput())
            : await resolver.resolve(contextInput(), signal)),
          expandedContext: true,
        };
      }
    } catch (error) {
      signal?.throwIfAborted();
      logWarn("Context resolution fell back to bounded rules.", { groupId: input.groupId, sourceRowId: input.sourceRowId, error: summarizeAiError(error) });
    }
    if (input.replyToMessageId && !hasReadableReference(reference)) {
      resolution = {
        ...resolution,
        selectedMessageIds: [],
        needsMoreContext: true,
        clarification: MSG_QUOTED_MESSAGE_UNAVAILABLE,
        anchor: { kind: "none", messageIds: [] },
      };
    }
    let recentClusterRoute = resolution.anchor?.kind === "recent_cluster" && !resolution.clarification
      ? resolveRecentClusterRoute(repository, input.groupId, input.userId, resolution.selectedMessageIds)
      : undefined;
    if (recentClusterRoute) {
        resolution = {
          ...resolution,
          topicCandidateId: recentClusterRoute.branchId,
          anchor: { ...resolution.anchor!, topicCandidateId: recentClusterRoute.branchId },
        };
    }
    const mediaReference = isMediaReference(input.text, {
      includeDeictic: deicticImagePersonQuestion && (Boolean(input.hasImages) || Boolean(input.replyToMessageId)),
    });
    if (!input.hasImages && mediaReference && !excluded.includes(input.userId)) {
      const media = input.replyToMessageId
        ? store.mediaByIds(input.groupId, [input.replyToMessageId], input.sourceRowId, excluded)
        : recentImageCandidates.length ? recentImageCandidates : store.recentMedia(input.groupId, input.userId, input.sourceRowId, now);
      if (media.length === 1) {
        resolution.mediaSourceMessageIds = [media[0].sourceMessageId];
        resolution.intent = "image";
        resolution.relation = "supplement";
        resolution.clarification = undefined;
        if (!input.replyToMessageId && media[0].branchId) resolution.topicCandidateId = media[0].branchId;
      } else if (media.length > 1) {
        resolution.intent = "image";
        resolution.relation = "supplement";
        resolution.clarification = MSG_IMAGE_SELECTION_REQUIRED;
      }
    }
    if (bareOpinionRequest && !hasReadableReference(reference) && resolution.selectedMessageIds.length === 0 && !resolution.clarification) {
      resolution.clarification = contextEnabled ? "你是说刚才哪件事？我这边没读到上一段讨论" : "本群没开启近期群聊上下文，把要我评价的那段引用一下？";
    } else if (!bareOpinionRequest && (resolution.intent === "opinion" || /(?:你来说说|你怎么看|你觉得呢|评评理|结合群聊|根据上面)/u.test(input.text)) &&
      !messages.length && !candidates.length && !input.replyToMessageId) {
      resolution.clarification = contextEnabled ? "你指的是刚才哪件事？我这边没读到对应的讨论" : "本群没开启近期群聊上下文，把要我评价的那段引用一下？";
    }
    if (resolution.needsMoreContext && !resolution.clarification && !hasReadableReference(reference)) {
      const titles = [...new Set(candidates.map(item => item.title.trim()).filter(Boolean))].slice(0, 2);
      resolution.clarification = bareOpinionRequest
        ? "你是说刚才哪件事？我这边没读到上一段讨论"
        : titles.length === 2 ? `你是说“${titles[0].slice(0, 25)}”那段，还是“${titles[1].slice(0, 25)}”那段？` : "你指的是哪条讨论？引用一下对应消息";
    }
    resolution = store.saveResolution(input.sourceRowId, input.groupId, input.userId, resolution);
    let candidate = candidates.find(item => item.id === resolution.topicCandidateId);
    if (!candidate && resolution.mediaSourceMessageIds.length && resolution.topicCandidateId) {
      const branch = repository.getBranch(resolution.topicCandidateId);
      if (branch?.groupId === input.groupId && branch.ownerUserId === input.userId) {
        candidate = { id: branch.branchId, topicId: branch.topicId, ownerUserId: branch.ownerUserId, title: "图片", lastUserInput: "", lastReply: "", updatedAt: branch.updatedAt };
      }
    }
    const useResolution = resolution.source === "model" || resolution.mediaSourceMessageIds.length > 0 ||
      resolution.anchor?.kind === "recent_cluster" || resolution.anchor?.kind === "explicit_follow_up";
    // Keep the route, state branch and selected ambient evidence on the same
    // anchor. A current participant gets a sibling branch in the shared topic;
    // the original author continues their exact causal branch.
    if (resolution.anchor?.kind !== "recent_cluster" || resolution.clarification) recentClusterRoute = undefined;
    const target = recentClusterRoute ?? (candidate && !resolution.clarification
      ? {
          topicId: candidate.topicId,
          ...(candidate.ownerUserId === input.userId ? { branchId: candidate.id } : {}),
        }
      : { newTopic: true });
    const route = this.conversationContextRouter.resolve({ ...input, ...(useResolution && !input.replyToMessageId ? { resolvedContext: target } : {}) });
    store.registerTask(route, input.groupId, input.userId, resolution.relation);
    logInfo("Conversation context planned.", { groupId: input.groupId, sourceRowId: input.sourceRowId, topicId: route.topicId, branchId: route.branchId,
      intent: resolution.intent, relation: resolution.relation, source: resolution.source, anchor: resolution.anchor?.kind, expanded: resolution.expandedContext === true,
      selectedMessageIds: resolution.selectedMessageIds, mediaSourceMessageIds: resolution.mediaSourceMessageIds, clarification: Boolean(resolution.clarification) });
    return route;
  }

  /** Read-only trigger check used by a legacy ingress before it persists a route. */
  async shouldRouteConversation(
    groupId: string,
    text: string,
    hasAtBot: boolean,
    options: { hasImages?: boolean; replyToBot?: boolean; userId?: string } = {},
  ): Promise<boolean> {
    const decision = await this.getParticipationDecision(groupId, text, hasAtBot, options);
    return decision.action === "reply";
  }

  /** Injects the LLM gate (semaphore + circuit breaker) into the reply path. */
  setLlmGate(gate: (task: () => Promise<AiReply>, signal?: AbortSignal) => Promise<AiReply>): void {
    this.llmGate = gate;
  }

  /** Injects the worker's shared LLM gate for non-conversation model work. */
  setBackgroundLlmGate(gate: BackgroundLlmGate): void {
    this.backgroundLlmGate = gate;
  }

  private async runLiveChatTick(): Promise<void> {
    if (!this.isCapabilityEnabled("conversation")) {
      return;
    }
    const now = Date.now();

    try {
      const groups = await this.getEnabledGroupConfigs();

      for (const groupConfig of groups) {
        // 闭嘴时实时对话不触发（生产事故：botMuted 只拦了 @ 消息，
        // 实时对话 tick 绕过闭嘴导致乱回复）。
        if (groupConfig.botMuted === true) {
          continue;
        }
        if (!allowsSelectedMemberParticipation(groupConfig)) {
          continue;
        }
        const trackedUserIds = getActiveChatUserIds(groupConfig);
        if (trackedUserIds.length === 0) {
          continue;
        }

        const groupId = groupConfig.groupId;
        const delaySeconds = getLiveChatDelaySeconds(groupConfig);
        const delayMs = delaySeconds * 1000;
        const lastBotActivity = this.liveChatService.getLastBotActivity(groupId);
        const idleDeadline = lastBotActivity + delayMs;

        if (now < idleDeadline) {
          continue;
        }

        const consumeSinceLastBotMessage = () => {
          for (const trackedUserId of trackedUserIds) {
            this.liveChatService.discardMessagesBefore(groupId, trackedUserId, lastBotActivity);
          }
        };

        const consumeWindow = () => {
          for (const trackedUserId of trackedUserIds) {
            this.liveChatService.discardMessagesBefore(groupId, trackedUserId, now);
          }
        };

        const candidate = this.liveChatService.getWindowCandidate(
          groupId,
          trackedUserIds,
          lastBotActivity,
          now,
        );

        if (!candidate) {
          consumeSinceLastBotMessage();
          continue;
        }

        if (this.liveChatService.hasBotActivityBetween(groupId, lastBotActivity + 1, now)) {
          logInfo("Skipped live chat because bot already spoke during countdown.", {
            groupId,
            lastBotActivity: new Date(lastBotActivity).toISOString(),
            now: new Date(now).toISOString(),
          });
          consumeSinceLastBotMessage();
          continue;
        }

        try {
          await this.groupLock.run(groupId, async () => {
            await this.handleConversation(
              groupConfig,
              candidate.userId,
              formatBufferedMessages(candidate.messages),
              [],
              resolveDefaultReplyMode(),
              [candidate.userId],
              buildBufferedInteractionContext(candidate.messages),
            );
          });
          logInfo("Sent live chat reply.", {
            groupId,
            userId: candidate.userId,
            messageCount: candidate.messages.length,
            delaySeconds,
          });
        } catch (error) {
          logError("Live chat tick failed.", {
            groupId,
            userId: candidate.userId,
            error: (error as Error).message,
          });
        } finally {
          consumeWindow();
        }
      }
    } catch (error) {
      logError("Live chat scheduler failed.", {
        error: (error as Error).message,
      });
    }
  }

  private async runDailyReportTick(now = new Date()): Promise<void> {
    if (!this.isCapabilityEnabled("daily_reports")) {
      return;
    }
    try {
      const groups = await this.getEnabledGroupConfigs();
      const tokenCostControl = await this.getTokenCostControl();

      for (const groupConfig of groups) {
        if (!(await this.dailyReportService.shouldSendScheduledReport(groupConfig, now))) {
          continue;
        }

        try {
          await this.groupLock.run(groupConfig.groupId, async () => {
            const report = await this.dailyReportService.buildReport(groupConfig, now, {
              useAiQuip: tokenCostControl.dailyReportAiQuipEnabled,
              members: await this.safeListGroupMembers(groupConfig.groupId),
            });
            await this.sendText(groupConfig.groupId, report);
            await this.dailyReportService.markSent(groupConfig.groupId, now, report);
          });
          logInfo("Sent daily group report.", {
            groupId: groupConfig.groupId,
            time: formatClockTime(now),
          });
        } catch (error) {
          logError("Daily report tick failed.", {
            groupId: groupConfig.groupId,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logError("Daily report scheduler failed.", {
        error: (error as Error).message,
      });
    }
  }

  private async runHolidayCountdownTick(now = new Date()): Promise<void> {
    if (!this.isCapabilityEnabled("holiday_countdown")) {
      return;
    }
    try {
      const groups = await this.getEnabledGroupConfigs();
      const tokenCostControl = await this.getTokenCostControl();

      for (const groupConfig of groups) {
        if (!(await this.holidayCountdownService.shouldSendScheduledMessage(groupConfig, now))) {
          continue;
        }

        try {
          await this.groupLock.run(groupConfig.groupId, async () => {
            const message = await this.holidayCountdownService.buildCountdownMessage(now, {
              useAiQuip: tokenCostControl.dailyReportAiQuipEnabled,
            });
            await this.sendText(groupConfig.groupId, message);
            await this.holidayCountdownService.markSent(groupConfig.groupId, now);
          });
          logInfo("Sent holiday countdown.", {
            groupId: groupConfig.groupId,
            time: formatClockTime(now),
          });
        } catch (error) {
          logError("Holiday countdown tick failed.", {
            groupId: groupConfig.groupId,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logError("Holiday countdown scheduler failed.", {
        error: (error as Error).message,
      });
    }
  }

  private async runScheduledReminderTick(now = new Date()): Promise<void> {
    if (!this.isCapabilityEnabled("scheduled_reminders")) {
      return;
    }
    if (!isWithinWorkHours(now)) {
      return;
    }

    try {
      const groups = await this.getEnabledGroupConfigs();
      const tokenCostControl = await this.getTokenCostControl();
      const groupsById = new Map(groups.map((group) => [group.groupId, group]));
      const dueTasks = await this.scheduledReminderService.getDueTasks(now);
      for (const task of dueTasks) {
        const groupConfig = groupsById.get(task.groupId);
        if (!groupConfig || groupConfig.enabled === false || groupConfig.scheduledRemindersEnabled === false) {
          continue;
        }

        try {
          await this.groupLock.run(task.groupId, async () => {
            const message = await this.scheduledReminderService.buildReminderMessage(task, {
              useAiRewrite: tokenCostControl.scheduledReminderAiRewriteEnabled,
            });
            await this.sendText(task.groupId, message);
            await this.scheduledReminderService.markSent(task.id, message, now);
          });
          logInfo("Sent scheduled reminder.", {
            groupId: task.groupId,
            taskId: task.id,
            intervalMinutes: task.intervalMinutes,
          });
        } catch (error) {
          logError("Scheduled reminder tick failed.", {
            groupId: task.groupId,
            taskId: task.id,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logError("Scheduled reminder scheduler failed.", {
        error: (error as Error).message,
      });
    }
  }

  private async runDailyReportCleanupTick(now = new Date()): Promise<void> {
    const hours = now.getHours();
    const minutes = now.getMinutes();
    if (hours !== 0 || minutes !== 0) {
      return;
    }
    try {
      await this.dailyReportService.clearStore();
      logInfo("Daily report store cleared at midnight.");
    } catch (error) {
      logWarn("Failed to clear daily report store.", {
        error: (error as Error).message,
      });
    }
  }

  private async runHtmlPreviewCleanupTick(): Promise<void> {
    if (!this.htmlPreviewService) {
      return;
    }
    try {
      const result = await this.htmlPreviewService.cleanup();
      if (result.expired || result.temp || result.orphans) {
        logInfo("Cleaned generated HTML previews.", result);
      }
    } catch (error) {
      logWarn("Failed to clean generated HTML previews.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runImageGenerationCleanupTick(): Promise<void> {
    if (!this.imageGenerationService) return;
    try {
      const removed = await this.imageGenerationService.cleanup();
      if (removed > 0) logInfo("Cleaned orphaned generated images.", { removed });
    } catch (error) {
      logWarn("Failed to clean generated image files.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runImagePreviewCleanupTick(): Promise<void> {
    if (!this.imagePreviewArchiveService) return;
    try {
      const result = await this.imagePreviewArchiveService.cleanup();
      if (result.expired || result.orphans) {
        logInfo("Cleaned private generated-image previews.", result);
      }
    } catch (error) {
      logWarn("Failed to clean private generated-image previews.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBtSearchCommand(groupConfig: GroupBotConfig, command: BtCommandMatch, signal?: AbortSignal): Promise<void> {
    const groupId = groupConfig.groupId;
    // Every segment is excluded from later conversation evidence.
    const send = (message: string, compactHeader = false) => this.sendText(groupId, `【BT 搜索】${compactHeader ? " " : "\n"}${message}`);
    if (!this.isCapabilityEnabled("bt_search")) {
      await send("BT 搜索功能未启用");
      return;
    }
    let progressTimer: NodeJS.Timeout | undefined;
    let progressSend: Promise<void> | undefined;
    let finished = false;
    const finishProgress = async () => {
      finished = true;
      clearTimeout(progressTimer);
      await progressSend;
    };
    try {
      const request = parseBtSearchRequest(command.suffix);
      if (!request) { await send(escapeBtText(btHelp(command.primary, /(?:^|\s)(?:--help|-h)(?:\s|$)/u.test(command.suffix))), true); return; }
      if (!this.btSearchService) { await send("BT 搜索暂不可用，请稍后再试"); return; }
      const result = await this.btSearchService.search(request, {
        signal,
        onStarted: async () => {
          progressTimer = setTimeout(() => {
            if (finished || signal?.aborted) return;
            progressSend = send(request.fast ? "正在快速搜索 BT 资源…" : "正在搜索 BT 资源，完整搜索最多约 3 分钟…")
              .then(() => undefined)
              .catch(() => { logWarn("BT progress message could not be sent.", { groupId }); });
          }, 5_000);
          progressTimer.unref();
        },
      });
      await finishProgress();
      if (signal?.aborted) return;
      if (result.items.length || request.json || request.full || request.debug) {
        const autoRecall: ForwardAutoRecallOptions | undefined = result.resolvedType === "adult" && result.items.length > 0
          ? { autoRecall: { afterMs: 90_000, deadlineMs: 105_000 } }
          : undefined;
        const delivery = await sendForwardOrFallback(this.transport, groupId, renderBtForwardNodes(result, request, this.botQq), BT_FORWARD_FALLBACK_TEXT, autoRecall);
        const platformMessageId = delivery.receipt?.platformMessageId ?? delivery.receipt?.messageId;
        if (delivery.kind === "forward" && autoRecall?.autoRecall && platformMessageId?.trim() && this.transport.scheduleMessageRecall) {
          try {
            await this.transport.scheduleMessageRecall(groupId, platformMessageId, autoRecall.autoRecall);
          } catch (error) {
            logWarn("BT adult card recall could not be scheduled after delivery.", {
              groupId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.liveChatService.recordBotActivity(groupId);
        await this.handleSendSuccessRecovery();
      } else {
        await send(btEmptyResultMessage(result));
      }
      logInfo("BT search completed.", { groupId, type: result.resolvedType, resultCount: result.items.length, durationMs: result.durationMs, fromCache: result.fromCache });
    } catch (error) {
      await finishProgress();
      if (signal?.aborted || (error instanceof BtSearchError && error.code === "cancelled")) return;
      // A dispatched card may already exist. Do not append an error bubble or resend it.
      if (error instanceof NapCatActionOutcomeUnknownError) {
        logWarn("BT forward delivery outcome is unknown.", { groupId });
        return;
      }
      if (error instanceof BtSearchError && error.code === "invalid_arguments") {
        await send(escapeBtText(`${error.message}\n\n${btHelp(command.primary)}`));
        return;
      }
      const message = error instanceof BtSearchError && error.code === "busy" ? "BT 搜索繁忙，请稍后再试" :
        error instanceof BtSearchError && error.code === "timeout" ? "BT 搜索超时，请换个来源或加 --fast 后重试" : "BT 搜索失败，请稍后再试";
      logWarn("BT search failed.", { groupId, errorCode: error instanceof BtSearchError ? error.code : "unknown" });
      await send(message);
    } finally {
      await finishProgress();
    }
  }

  private async handleImageGenerationCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    rawPrompt: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    if (!this.isCapabilityEnabled("image_generation")) {
      await this.rejectCapability(groupId, "image_generation");
      return;
    }
    const prompt = rawPrompt.trim();
    if (!prompt) {
      const commands = await this.getRuntimeCommands();
      await this.sendText(groupId, `画图命令格式：${runtimeCommandPrimary(commands, "image_generation")} <提示词>`);
      return;
    }
    const promptCharacters = countImagePromptCharacters(prompt);
    if (promptCharacters > IMAGE_GENERATION_MAX_PROMPT_CHARS) {
      await this.sendText(
        groupId,
        `提示词当前 ${promptCharacters} 字，最多 ${IMAGE_GENERATION_MAX_PROMPT_CHARS} 字，请删减 ${promptCharacters - IMAGE_GENERATION_MAX_PROMPT_CHARS} 字`,
      );
      return;
    }
    if (!this.imageGenerationService || !this.transport.sendGeneratedGroupImage) {
      await this.sendText(groupId, "图片生成暂不可用，请稍后再试");
      return;
    }

    let stagedFile: string | undefined;
    try {
      const generated = await this.imageGenerationService.generate({
        groupId,
        userId,
        prompt,
        signal,
        onStarted: async () => {
          await this.sendText(groupId, "正在生成图片，请稍候…");
        },
      });
      stagedFile = generated.filePath;
      if (this.imagePreviewArchiveService) {
        try {
          await this.imagePreviewArchiveService.archive({
            groupId,
            creatorUserId: userId,
            sourceMessageId: String(event.message_id),
            prompt,
            filePath: generated.filePath,
            modelId: generated.modelId,
            model: generated.model,
            fallbackUsed: generated.fallbackUsed,
            mimeType: generated.mimeType,
            byteSize: generated.byteLength,
          });
        } catch (archiveError) {
          // Preview retention must never block delivery of an otherwise valid
          // generated image. Keep the log metadata-only: prompts stay private.
          logWarn("Private generated-image archive failed; continuing QQ delivery.", {
            groupId,
            userId,
            errorCode: archiveError instanceof ImagePreviewArchiveError
              ? archiveError.code
              : archiveError instanceof Error ? archiveError.name : "unknown",
          });
        }
      }
      await this.transport.sendGeneratedGroupImage(groupId, generated.filePath);
      stagedFile = undefined;
      logInfo("Generated image queued for group delivery.", {
        groupId,
        userId,
        modelId: generated.modelId,
        fallbackUsed: generated.fallbackUsed,
        byteLength: generated.byteLength,
      });
    } catch (error) {
      if (stagedFile) await this.imageGenerationService.discard(stagedFile);
      if (signal?.aborted) return;
      if (error instanceof ImageGenerationError) {
        if (error.code === "cooldown") {
          await this.sendText(groupId, `图片生成冷却中，请 ${error.retryAfterSeconds ?? 1} 秒后再试`);
          return;
        }
        if (error.code === "prompt_too_long") {
          const characters = countImagePromptCharacters(prompt);
          await this.sendText(
            groupId,
            `提示词当前 ${characters} 字，最多 ${IMAGE_GENERATION_MAX_PROMPT_CHARS} 字，请删减 ${Math.max(1, characters - IMAGE_GENERATION_MAX_PROMPT_CHARS)} 字`,
          );
          return;
        }
      }
      logWarn("Image generation request failed.", {
        groupId,
        userId,
        errorCode: error instanceof ImageGenerationError ? error.code : "unknown",
        errorName: error instanceof Error ? error.name : typeof error,
        ...(error instanceof ImageGenerationError ? error.diagnostics : {}),
      });
      await this.sendText(groupId, error instanceof ImageGenerationError && error.code === "content_blocked"
        ? "本次图片未通过上游内容审核，请调整描述后重试"
        : "图片生成失败，请稍后再试");
    }
  }

  private async handleHtmlPreviewRequest(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    request: ParsedHtmlPreviewRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const htmlCommand = (await this.getRuntimeCommands()).find(command => command.id === "html_preview");
    if (htmlCommand && !(await this.canUseRuntimeCommand(htmlCommand, groupConfig, event))) { await this.sendText(groupId, "你没有使用网页生成的权限"); return; }
    if (!this.isCapabilityEnabled("html_preview")) {
      await this.rejectCapability(groupId, "html_preview");
      return;
    }
    if (groupConfig.htmlPreviewEnabled === false) {
      await this.sendText(groupId, "本群网页预览功能已关闭");
      return;
    }
    if (!this.htmlPreviewService) {
      logWarn("HTML preview request received without a publisher service.", { groupId });
      await this.sendText(groupId, HTML_PREVIEW_FAILURE_MESSAGE);
      return;
    }

    try {
      const queued = await this.htmlPreviewService.enqueue({
        groupId,
        creatorUserId: String(event.user_id),
        sourceMessageId: String(event.message_id),
        request: request.request,
      });
      const route = await this.getReplyAiRoute(groupConfig);
      let generationRoute: HtmlPreviewFallbackRoute = route;
      let generationModel: string | undefined;
      let fallbackUsed = false;
      const routedSession = await (await this.getReplyRouter())?.begin(groupConfig, "html", { signal, gate: this.backgroundLlmGate });
      const result = await this.htmlPreviewService.processNext({
        maxGenerationAttempts: routedSession ? 20 : 2,
        id: queued.page.id,
        request: request.request,
        signal,
        generate: async (pageRequest, pageSignal) => {
          const requestSignal = pageSignal ?? signal;
          if (routedSession) {
            const routed = await routedSession.run((service, attemptSignal) => service.generateStaticHtml({ request: pageRequest, signal: attemptSignal }), requestSignal);
            generationRoute = { ...route, mode: routed.modelId }; fallbackUsed ||= routed.fallbackUsed;
            generationModel = routed.value.model;
            return routed.value;
          }
          const call = () => generationRoute.service.generateStaticHtml({ request: pageRequest, signal: requestSignal });
          try {
            return await (this.backgroundLlmGate ? this.backgroundLlmGate(call, requestSignal) : call());
          } catch (error) {
            const fallback = this.htmlPreviewFallbackRoute;
            const outputTruncated = error instanceof StaticHtmlOutputTruncatedError;
            if (!outputTruncated && !isRetryableAiProviderFailure(error, requestSignal)) throw error;
            if (fallbackUsed || !fallback || fallback.mode === generationRoute.mode) {
              throw new HtmlPreviewError(outputTruncated ? "html_preview_output_truncated" : "html_preview_provider_unavailable");
            }
            const primaryFailure = outputTruncated ? undefined : getAiProviderFailureDetails(error);
            logWarn("HTML preview primary generation failed; switching to fallback model.", {
              groupId,
              sourceMessageId: String(event.message_id),
              primaryMode: generationRoute.mode,
              fallbackMode: fallback.mode,
              failureKind: outputTruncated ? "output_truncated" : primaryFailure!.kind,
              ...(primaryFailure?.statusCode === undefined ? {} : { statusCode: primaryFailure.statusCode }),
              errorName: error instanceof Error ? error.name : typeof error,
              ...(outputTruncated ? {
                finishReason: error.finishReason,
                completionTokens: error.completionTokens,
                outputChars: error.outputChars,
              } : {}),
            });
            generationRoute = fallback;
            fallbackUsed = true;
            const fallbackCall = () => generationRoute.service.generateStaticHtml({ request: pageRequest, signal: requestSignal });
            try {
              return await (this.backgroundLlmGate ? this.backgroundLlmGate(fallbackCall, requestSignal) : fallbackCall());
            } catch (fallbackError) {
              const fallbackOutputTruncated = fallbackError instanceof StaticHtmlOutputTruncatedError;
              if (fallbackOutputTruncated) {
                logWarn("HTML preview fallback output was truncated.", {
                  groupId,
                  sourceMessageId: String(event.message_id),
                  fallbackMode: fallback.mode,
                  finishReason: fallbackError.finishReason,
                  completionTokens: fallbackError.completionTokens,
                  outputChars: fallbackError.outputChars,
                });
                throw new HtmlPreviewError("html_preview_output_truncated");
              }
              if (isRetryableAiProviderFailure(fallbackError, requestSignal)) {
                const fallbackFailure = getAiProviderFailureDetails(fallbackError);
                logWarn("HTML preview fallback model is unavailable.", {
                  groupId,
                  sourceMessageId: String(event.message_id),
                  fallbackMode: fallback.mode,
                  failureKind: fallbackFailure.kind,
                  ...(fallbackFailure.statusCode === undefined ? {} : { statusCode: fallbackFailure.statusCode }),
                  errorName: fallbackFailure.errorName,
                });
                throw new HtmlPreviewError("html_preview_provider_unavailable");
              }
              throw fallbackError;
            }
          }
        },
      });
      logInfo("Handled HTML preview request.", {
        groupId,
        sourceMessageId: String(event.message_id),
        source: request.source,
        created: queued.created,
        status: result.status,
        pageId: queued.page.id,
        generationMode: generationRoute.mode,
        ...(generationModel ? { model: generationModel } : {}),
        fallbackUsed,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.failureStage ? { failureStage: result.failureStage } : {}),
      });
    } catch (error) {
      if (signal?.aborted) return;
      logError("HTML preview generation could not be queued.", {
        groupId,
        sourceMessageId: String(event.message_id),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendText(groupId, HTML_PREVIEW_FAILURE_MESSAGE);
    }
  }

  private async runOpsAlertTick(options: { now?: Date; includeStartup?: boolean } = {}): Promise<void> {
    const now = options.now ?? new Date();

    try {
      const [groups, transportHealth] = await Promise.all([
        this.getEnabledGroupConfigs(),
        this.getTransportHealthStatus(),
      ]);
      const enabledGroups = groups.filter((group) => group.opsAlertsEnabled === true);

      if (options.includeStartup && !this.opsAlertState.startupSent) {
        this.opsAlertState.startupSent = true;
        await this.sendOpsAlertToGroups({
          groups: enabledGroups,
          type: "startup",
          now,
          message: `服务已启动，进程 PID ${process.pid}，Node ${process.version}`,
        });
      }

      if (
        this.opsAlertState.lastTransportOk !== undefined &&
        this.opsAlertState.lastTransportOk !== transportHealth.ok &&
        !transportHealth.ok
      ) {
        await this.sendOpsAlertToGroups({
          groups: enabledGroups,
          type: "napcat-down",
          now,
          message: `NapCat 连接异常：${transportHealth.detail}`,
        });
      }
      this.opsAlertState.lastTransportOk = transportHealth.ok;

      const memory = getMemoryStatus();
      const rss = process.memoryUsage().rss;
      const memoryHigh = memory.percent >= MEMORY_PERCENT_ALERT_THRESHOLD || rss >= PROCESS_RSS_ALERT_BYTES;
      if (memoryHigh && !this.opsAlertState.memoryAlertActive) {
        this.opsAlertState.memoryAlertActive = true;
        await this.sendOpsAlertToGroups({
          groups: enabledGroups,
          type: "memory-high",
          now,
          message: `内存占用偏高：系统 ${formatBytes(memory.used)} / ${formatBytes(memory.total)}（${memory.percent}%），进程 RSS ${formatBytes(rss)}`,
        });
      } else if (!memoryHigh && this.opsAlertState.memoryAlertActive && memory.percent <= MEMORY_PERCENT_RECOVERY_THRESHOLD) {
        this.opsAlertState.memoryAlertActive = false;
      }
    } catch (error) {
      logError("Ops alert scheduler failed.", {
        error: (error as Error).message,
      });
    }
  }

  private async handleLiveChatCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_LIVE_CHAT_NO_PERMISSION);
      return;
    }

    if (
      normalized === LIVE_CHAT_PREFIX ||
      normalized === `${LIVE_CHAT_PREFIX} 列表` ||
      normalized === `${LIVE_CHAT_PREFIX} 查看`
    ) {
      const liveUsers = groupConfig.liveChatUserIds;
      const delayLabel = formatLiveChatDelay(groupConfig);
      await this.sendText(
        groupId,
        liveUsers.length > 0
          ? `当前已开启实时对话的 QQ：${liveUsers.join("、")}\n当前倒计时：${delayLabel}`
          : `当前还没有开启实时对话的 QQ\n当前倒计时：${delayLabel}`,
      );
      return;
    }

    const addRegex = new RegExp(`^${escapeRegex(LIVE_CHAT_PREFIX)}\\s*添加\\s+(.+)$`);
    const removeRegex = new RegExp(`^${escapeRegex(LIVE_CHAT_PREFIX)}\\s*移除\\s+(.+)$`);
    const delayRegex = new RegExp(`^${escapeRegex(LIVE_CHAT_PREFIX)}\\s*(?:间隔|倒计时|时间)\\s+(.+)$`);

    const addMatch = normalized.match(addRegex);
    if (addMatch) {
      const targetQq = addMatch[1].trim().replace(/\D/g, "");
      if (!targetQq) {
        await this.sendText(groupId, MSG_INVALID_QQ);
        return;
      }

      const updatedGroup = await this.groupConfigService.addLiveChatUser(groupId, targetQq);
      await this.logAdminOperation(groupId, userId, "实时对话添加", targetQq);
      await this.sendText(
        groupId,
        `已将 ${targetQq} 加入实时对话名单，机器人会在安静 ${formatLiveChatDelay(groupConfig)} 后再尝试主动接话`,
      );
      logInfo("Added live chat user.", {
        groupId,
        targetQq,
        adminId: userId,
        totalLiveUsers: updatedGroup.liveChatUserIds?.length ?? 0,
      });
      return;
    }

    const removeMatch = normalized.match(removeRegex);
    if (removeMatch) {
      const targetQq = removeMatch[1].trim().replace(/\D/g, "");
      if (!targetQq) {
        await this.sendText(groupId, MSG_INVALID_QQ);
        return;
      }

      const updatedGroup = await this.groupConfigService.removeLiveChatUser(groupId, targetQq);
      this.liveChatService.discardMessagesBefore(groupId, targetQq, Number.POSITIVE_INFINITY);
      await this.logAdminOperation(groupId, userId, "实时对话移除", targetQq);
      await this.sendText(groupId, `已将 ${targetQq} 从实时对话名单移除`);
      logInfo("Removed live chat user.", {
        groupId,
        targetQq,
        adminId: userId,
        totalLiveUsers: updatedGroup.liveChatUserIds?.length ?? 0,
      });
      return;
    }

    const delayMatch = normalized.match(delayRegex);
    if (delayMatch) {
      const parsedDelay = parseLiveChatDelay(delayMatch[1]);
      if (!parsedDelay) {
        await this.sendText(groupId, "请提供有效的间隔，例如 30秒、30s 或 1分钟");
        return;
      }

      const updatedGroup =
        parsedDelay.unit === "seconds"
          ? await this.groupConfigService.updateLiveChatDelaySeconds(groupId, parsedDelay.value)
          : await this.groupConfigService.updateLiveChatDelay(groupId, parsedDelay.value);
      await this.sendText(
        groupId,
        `已将实时对话倒计时改为 ${formatLiveChatDelay(updatedGroup)}，之后会从机器人最后一次发言后开始计时`,
      );
      await this.logAdminOperation(groupId, userId, "实时对话间隔", undefined, formatLiveChatDelay(updatedGroup));
      logInfo("Updated live chat delay.", {
        groupId,
        adminId: userId,
        delaySeconds: getLiveChatDelaySeconds(updatedGroup),
      });
      return;
    }

    await this.sendText(
      groupId,
      [
        "实时对话命令格式：",
        `${LIVE_CHAT_PREFIX} 列表`,
        `${LIVE_CHAT_PREFIX} 添加 <QQ号>`,
        `${LIVE_CHAT_PREFIX} 移除 <QQ号>`,
        `${LIVE_CHAT_PREFIX} 间隔 <秒数|分钟>`,
      ].join("\n"),
    );
  }

  private async handleMuteCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_MUTE_NO_PERMISSION);
      return;
    }

    if (commandText === MUTE_COMMAND) {
      await this.groupConfigService.updateBotMuted(groupId, true);
      await this.logAdminOperation(groupId, userId, "闭嘴", undefined, "机器人进入静默模式");
      await this.sendText(groupId, "机器人已闭嘴，只保留总结、日报、节假日和定时任务能力");
      return;
    }

    await this.groupConfigService.updateBotMuted(groupId, false);
    await this.logAdminOperation(groupId, userId, "说话", undefined, "机器人恢复正常回复");
    await this.sendText(groupId, "机器人已恢复说话");
  }

  private async handleStatusCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_STATUS_NO_PERMISSION);
      return;
    }

    const [currentSkill, scheduledTasks] = await Promise.all([
      this.skillService.getSkill(groupConfig.currentSkillId),
      this.scheduledReminderService.listGroupTasks(groupId),
    ]);
    const liveUsers = groupConfig.liveChatUserIds;
    const blacklistedUsers = groupConfig.blacklistedUserIds ?? [];

    await this.sendText(
      groupId,
      [
        `机器人状态：群 ${groupId}`,
        `说话：${groupConfig.botMuted === true ? "已闭嘴" : "正常"}`,
        `当前技能：${groupConfig.currentSkillId}${currentSkill ? `（${currentSkill.name}）` : "（未找到配置）"}`,
        `实时对话：${liveUsers.length > 0 ? `${liveUsers.length} 人，倒计时 ${formatLiveChatDelay(groupConfig)}` : `未开启，倒计时 ${formatLiveChatDelay(groupConfig)}`}`,
        `定时任务：${groupConfig.scheduledRemindersEnabled === false ? "已关闭" : "已开启"}，${scheduledTasks.length} 个`,
        `群聊日报：${groupConfig.dailyReportEnabled === false ? "已关闭" : `已开启，${groupConfig.dailyReportTime ?? "17:59"}`}`,
        `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : `已开启，${groupConfig.holidayCountdownTime ?? "09:00"}`}`,
        `黑名单：${blacklistedUsers.length > 0 ? `${blacklistedUsers.length} 人` : "无"}`,
        "权限：后台账号绑定优先；未绑定时按群主或群管理员身份授权",
      ].join("\n"),
    );
  }

  private async handleHealthCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_HEALTH_NO_PERMISSION);
      return;
    }

    const [currentSkill, allowedSkills, scheduledTasks, transportHealth] = await Promise.all([
      this.skillService.getSkill(groupConfig.currentSkillId),
      Promise.all(groupConfig.allowedSkillIds.map((skillId) => this.skillService.getSkill(skillId))),
      this.scheduledReminderService.listGroupTasks(groupId),
      this.getTransportHealthStatus(),
    ]);
    const modelSummary = await this.getSystemModelSummary();
    const missingAllowedSkillIds = groupConfig.allowedSkillIds.filter((_, index) => !allowedSkills[index]);
    const nextTask = scheduledTasks
      .filter((task) => task.enabled !== false)
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0];

    await this.sendText(
      groupId,
      [
        `健康检查：群 ${groupId}`,
        `NapCat：${transportHealth.ok ? "正常" : "异常"}，${transportHealth.detail}`,
        modelSummary ? `系统模型配置：${modelSummary}` : "系统模型配置：未启用后台模型配置",
        `当前技能：${currentSkill ? `正常（${currentSkill.id} / ${currentSkill.name}）` : `异常，找不到 ${groupConfig.currentSkillId}`}`,
        `允许技能：${missingAllowedSkillIds.length === 0 ? `正常（${groupConfig.allowedSkillIds.length} 个）` : `异常，缺失 ${missingAllowedSkillIds.join("、")}`}`,
        `定时任务：${groupConfig.scheduledRemindersEnabled === false ? "总开关已关闭" : "总开关已开启"}，${scheduledTasks.length} 个${nextTask ? `，下次 ${formatLocalDateTime(new Date(nextTask.nextRunAt))}` : ""}`,
        `群聊日报：${groupConfig.dailyReportEnabled === false ? "已关闭" : `已开启，${groupConfig.dailyReportTime ?? "17:59"}`}`,
        `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : `已开启，${groupConfig.holidayCountdownTime ?? "09:00"}`}`,
        `黑名单：${(groupConfig.blacklistedUserIds ?? []).length} 人；权限由后台绑定或当前群管理身份决定`,
      ].join("\n"),
    );
  }

  private async getSystemModelSummary(): Promise<string | undefined> {
    if (!this.systemSettingsStore) {
      return undefined;
    }
    try {
      const settings = await this.systemSettingsStore.getInternal();
      const enabled = settings.models.filter((model) => model.enabled);
      const missingKeys = enabled.filter((model) => !model.hasApiKey || !model.apiKey?.trim()).length;
      const byPurpose = enabled.reduce<Partial<Record<string, number>>>((result, model) => {
        result[model.purpose] = (result[model.purpose] ?? 0) + 1;
        return result;
      }, {});
      const parts = Object.entries(byPurpose)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([purpose, count]) => `${formatModelPurpose(purpose)} ${count}`);
      return [
        `启用 ${enabled.length} 个`,
        parts.length > 0 ? parts.join("，") : "无可用模型",
        missingKeys > 0 ? `${missingKeys} 个缺少 Key` : "",
      ].filter(Boolean).join("，");
    } catch (error) {
      return `读取失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async handleOperationLogCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_OPERATION_LOG_NO_PERMISSION);
      return;
    }

    const entries = await this.adminOperationLogService.listRecent(groupId, 10);
    if (entries.length === 0) {
      await this.sendText(groupId, "当前群还没有管理员操作日志");
      return;
    }

    await this.sendText(
      groupId,
      [
        "最近管理员操作：",
        ...entries.map((entry) =>
          [
            formatLocalDateTime(new Date(entry.timestamp)),
            entry.operatorUserId,
            entry.action,
            entry.target ? `目标 ${entry.target}` : "",
            entry.detail ?? "",
          ].filter(Boolean).join(" "),
        ),
      ].join("\n"),
    );
  }

  private async handleServerCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_SERVER_NO_PERMISSION);
      return;
    }

    const transportHealth = await this.getTransportHealthStatus();
    const memory = getMemoryStatus();
    const processMemory = process.memoryUsage();
    const loadAverage = os.loadavg();

    await this.sendText(
      groupId,
      [
        "服务器状态：",
        `主机：${os.hostname()}（${os.platform()} ${os.release()} ${os.arch()}）`,
        `Node：${process.version}，PID ${process.pid}`,
        `进程运行：${formatDuration(process.uptime())}`,
        `系统运行：${formatDuration(os.uptime())}`,
        `CPU：${os.cpus().length} 核，负载 ${loadAverage.map((value) => value.toFixed(2)).join(" / ")}`,
        `内存：${formatBytes(memory.used)} / ${formatBytes(memory.total)}（${memory.percent}%）`,
        `进程内存：RSS ${formatBytes(processMemory.rss)}，Heap ${formatBytes(processMemory.heapUsed)} / ${formatBytes(processMemory.heapTotal)}`,
        `工作目录：${process.cwd()}`,
        `NapCat：${transportHealth.ok ? "正常" : "异常"}，${transportHealth.detail}`,
      ].join("\n"),
    );
  }

  private async handleOpsAlertCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_OPS_ALERT_NO_PERMISSION);
      return;
    }

    if (
      normalized === OPS_ALERT_PREFIX ||
      normalized === `${OPS_ALERT_PREFIX} 状态` ||
      normalized === `${OPS_ALERT_PREFIX} 查看`
    ) {
      const transportHealth = await this.getTransportHealthStatus();
      const memory = getMemoryStatus();
      await this.sendText(
        groupId,
        [
          `运维告警：${groupConfig.opsAlertsEnabled === true ? "已开启" : "已关闭"}`,
          `NapCat：${transportHealth.ok ? "正常" : "异常"}，${transportHealth.detail}`,
          `内存：${formatBytes(memory.used)} / ${formatBytes(memory.total)}（${memory.percent}%）`,
          `发送失败：连续 ${this.opsAlertState.consecutiveSendFailures} 次${this.opsAlertState.sendFailureAlertActive ? "，已告警" : ""}`,
          `最近告警：${this.opsAlertState.lastAlertSummary ?? "暂无"}`,
        ].join("\n"),
      );
      return;
    }

    if (normalized === `${OPS_ALERT_PREFIX} 开启` || normalized === `${OPS_ALERT_PREFIX} 关闭`) {
      const enabled = normalized === `${OPS_ALERT_PREFIX} 开启`;
      const updated = await this.groupConfigService.updateOpsAlertsEnabled(groupId, enabled);
      await this.logAdminOperation(groupId, userId, enabled ? "告警开启" : "告警关闭");
      await this.sendText(groupId, updated.opsAlertsEnabled === true ? "已开启当前群运维告警" : "已关闭当前群运维告警");
      return;
    }

    await this.sendText(
      groupId,
      [
        "告警命令格式：",
        `${OPS_ALERT_PREFIX} 状态`,
        `${OPS_ALERT_PREFIX} 开启`,
        `${OPS_ALERT_PREFIX} 关闭`,
      ].join("\n"),
    );
  }

  private async handleBlacklistCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<boolean> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    const unblockMatch = normalized.match(new RegExp(`^${escapeRegex(BLACKLIST_PREFIX)}\\s+解除\\s+(.+)$`));
    const addMatch = normalized.match(new RegExp(`^${escapeRegex(BLACKLIST_PREFIX)}\\s+(.+)$`));

    if (!unblockMatch && !addMatch) {
      if (this.isBlacklistedUser(groupConfig, userId)) {
        return false;
      }

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
        await this.sendText(groupId, MSG_BLACKLIST_NO_PERMISSION);
        return true;
      }

      await this.sendText(
        groupId,
        [
          "拉黑命令格式：",
          `${BLACKLIST_PREFIX} <QQ号>`,
          `${BLACKLIST_PREFIX} 解除 <QQ号>`,
        ].join("\n"),
      );
      return true;
    }

    const isAdmin = await this.isAdmin(groupConfig, userId, event.sender?.role);
    if (!isAdmin) {
      if (this.isBlacklistedUser(groupConfig, userId)) {
        return false;
      }

      await this.sendText(groupId, MSG_BLACKLIST_NO_PERMISSION);
      return true;
    }

    const targetInput = unblockMatch?.[1] ?? addMatch?.[1] ?? "";
    const targetQq = extractQqFromInput(targetInput);
    if (!targetQq) {
      await this.sendText(groupId, MSG_INVALID_QQ);
      return true;
    }

    if (this.isBlacklistedUser(groupConfig, userId) && (!unblockMatch || targetQq !== userId)) {
      return false;
    }

    if (unblockMatch) {
      await this.groupConfigService.removeBlacklistedUser(groupId, targetQq);
      await this.logAdminOperation(groupId, userId, "解除拉黑", targetQq);
      await this.sendText(groupId, `已解除拉黑 ${targetQq}`);
      return true;
    }

    await this.groupConfigService.addBlacklistedUser(groupId, targetQq);
    await this.logAdminOperation(groupId, userId, "拉黑", targetQq);
    await this.sendText(groupId, `已拉黑 ${targetQq}，之后 @机器人将收到表情包`);
    return true;
  }

  private async handleDailyReportCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!this.isCapabilityEnabled("daily_reports")) {
      await this.rejectCapability(groupId, "daily_reports");
      return;
    }

    if (
      normalized === DAILY_REPORT_PREFIX ||
      normalized === `${DAILY_REPORT_PREFIX} 状态` ||
      normalized === `${DAILY_REPORT_PREFIX} 查看`
    ) {
      await this.sendText(
        groupId,
        `群聊日报：${groupConfig.dailyReportEnabled === false ? "已关闭" : "已开启"}\n发送时间：${
          groupConfig.dailyReportTime ?? "17:59"
        }（工作日）\n统计前列人数：${groupConfig.dailyReportTopUserCount ?? 5}`,
      );
      return;
    }

    const manualRegex = new RegExp(`^${escapeRegex(DAILY_REPORT_PREFIX)}\\s*(?:发送|预览)$`);
    if (manualRegex.test(normalized)) {
    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
        await this.sendText(groupId, MSG_DAILY_REPORT_NO_PERMISSION);
        return;
      }

      await this.groupLock.run(groupId, async () => {
        const tokenCostControl = await this.getTokenCostControl();
        const report = await this.dailyReportService.buildReport(groupConfig, new Date(), {
          useAiQuip: tokenCostControl.dailyReportAiQuipEnabled,
          members: await this.safeListGroupMembers(groupId),
        });
        await this.sendText(groupId, report);
        await this.dailyReportService.recordDeliveredReport(groupId, report);
      });
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_DAILY_REPORT_NO_PERMISSION);
      return;
    }

    if (normalized === `${DAILY_REPORT_PREFIX} 开启`) {
      const updated = await this.groupConfigService.updateDailyReportEnabled(groupId, true);
      await this.logAdminOperation(groupId, userId, "日报开启", undefined, updated.dailyReportTime ?? "17:59");
      await this.sendText(groupId, `已开启群聊日报，工作日 ${updated.dailyReportTime ?? "17:59"} 自动发送`);
      return;
    }

    if (normalized === `${DAILY_REPORT_PREFIX} 关闭`) {
      await this.groupConfigService.updateDailyReportEnabled(groupId, false);
      await this.logAdminOperation(groupId, userId, "日报关闭");
      await this.sendText(groupId, "已关闭群聊日报");
      return;
    }

    const timeMatch = normalized.match(
      new RegExp(`^${escapeRegex(DAILY_REPORT_PREFIX)}\\s*时间\\s+([01]?\\d|2[0-3]):([0-5]\\d)$`),
    );
    if (timeMatch) {
      const time = `${timeMatch[1]}:${timeMatch[2]}`;
      const updated = await this.groupConfigService.updateDailyReportTime(groupId, time);
      await this.logAdminOperation(groupId, userId, "日报时间", undefined, updated.dailyReportTime);
      await this.sendText(groupId, `已将群聊日报时间改为工作日 ${updated.dailyReportTime}`);
      return;
    }

    await this.sendText(
      groupId,
      [
        "日报命令格式：",
        `${DAILY_REPORT_PREFIX} 状态`,
        `${DAILY_REPORT_PREFIX} 发送`,
        `${DAILY_REPORT_PREFIX} 开启`,
        `${DAILY_REPORT_PREFIX} 关闭`,
        `${DAILY_REPORT_PREFIX} 时间 <HH:mm>`,
      ].join("\n"),
    );
  }

  private async handleHolidayCountdownCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!this.isCapabilityEnabled("holiday_countdown")) {
      await this.rejectCapability(groupId, "holiday_countdown");
      return;
    }

    if (
      normalized === HOLIDAY_COUNTDOWN_PREFIX ||
      normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 查看` ||
      normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 状态`
    ) {
      const tokenCostControl = await this.getTokenCostControl();
      const preview = await this.holidayCountdownService.buildCountdownMessage(new Date(), {
        useAiQuip: tokenCostControl.dailyReportAiQuipEnabled,
      });
      const status = `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : "已开启"}\n发送时间：${
        groupConfig.holidayCountdownTime ?? "09:00"
      }`;
      await this.sendText(groupId, `${status}\n\n${preview}`);
      return;
    }

    const manualRegex = new RegExp(`^${escapeRegex(HOLIDAY_COUNTDOWN_PREFIX)}\\s*(?:发送|预览)$`);
    if (manualRegex.test(normalized)) {
    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
        await this.sendText(groupId, MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION);
        return;
      }

      await this.groupLock.run(groupId, async () => {
        const tokenCostControl = await this.getTokenCostControl();
        const message = await this.holidayCountdownService.buildCountdownMessage(new Date(), {
          useAiQuip: tokenCostControl.dailyReportAiQuipEnabled,
        });
        await this.sendText(groupId, message);
      });
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION);
      return;
    }

    if (normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 开启`) {
      const updated = await this.groupConfigService.updateHolidayCountdownEnabled(groupId, true);
      await this.logAdminOperation(groupId, userId, "节假日开启", undefined, updated.holidayCountdownTime ?? "09:00");
      await this.sendText(
        groupId,
        `已开启节假日倒计时，每天 ${updated.holidayCountdownTime ?? "09:00"} 自动发送`,
      );
      return;
    }

    if (normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 关闭`) {
      await this.groupConfigService.updateHolidayCountdownEnabled(groupId, false);
      await this.logAdminOperation(groupId, userId, "节假日关闭");
      await this.sendText(groupId, "已关闭节假日倒计时");
      return;
    }

    const timeMatch = normalized.match(
      new RegExp(`^${escapeRegex(HOLIDAY_COUNTDOWN_PREFIX)}\\s*时间\\s+([01]?\\d|2[0-3]):([0-5]\\d)$`),
    );
    if (timeMatch) {
      const time = `${timeMatch[1]}:${timeMatch[2]}`;
      const updated = await this.groupConfigService.updateHolidayCountdownTime(groupId, time);
      await this.logAdminOperation(groupId, userId, "节假日时间", undefined, updated.holidayCountdownTime);
      await this.sendText(groupId, `已将节假日倒计时时间改为每天 ${updated.holidayCountdownTime}`);
      return;
    }

    await this.sendText(
      groupId,
      [
        "节假日命令格式：",
        `${HOLIDAY_COUNTDOWN_PREFIX}`,
        `${HOLIDAY_COUNTDOWN_PREFIX} 发送`,
        `${HOLIDAY_COUNTDOWN_PREFIX} 开启`,
        `${HOLIDAY_COUNTDOWN_PREFIX} 关闭`,
        `${HOLIDAY_COUNTDOWN_PREFIX} 时间 <HH:mm>`,
      ].join("\n"),
    );
  }

  private async handleScheduledReminderCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!this.isCapabilityEnabled("scheduled_reminders")) {
      await this.rejectCapability(groupId, "scheduled_reminders");
      return;
    }

    if (
      normalized === `${SCHEDULED_REMINDER_PREFIX} 状态` ||
      normalized === `${SCHEDULED_REMINDER_PREFIX} 开启` ||
      normalized === `${SCHEDULED_REMINDER_PREFIX} 关闭`
    ) {
      if (normalized === `${SCHEDULED_REMINDER_PREFIX} 状态`) {
        await this.sendText(
          groupId,
          `定时任务总开关：${groupConfig.scheduledRemindersEnabled === false ? "已关闭" : "已开启"}`,
        );
        return;
      }

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
        await this.sendText(groupId, MSG_SCHEDULED_REMINDER_NO_PERMISSION);
        return;
      }

      const enabled = normalized === `${SCHEDULED_REMINDER_PREFIX} 开启`;
      await this.groupConfigService.updateScheduledRemindersEnabled(groupId, enabled);
      await this.logAdminOperation(groupId, userId, enabled ? "定时任务开启" : "定时任务关闭");
      await this.sendText(groupId, enabled ? "已开启当前群定时任务" : "已关闭当前群定时任务，已有任务不会删除");
      return;
    }

    if (
      normalized === SCHEDULED_REMINDER_PREFIX ||
      normalized === `${SCHEDULED_REMINDER_PREFIX} 列表` ||
      normalized === `${SCHEDULED_REMINDER_PREFIX} 查看`
    ) {
      const tasks = await this.scheduledReminderService.listGroupTasks(groupId);
      const statusLine = `定时任务总开关：${groupConfig.scheduledRemindersEnabled === false ? "已关闭" : "已开启"}`;
      if (tasks.length === 0) {
        await this.sendText(groupId, `${statusLine}\n当前群还没有定时任务`);
        return;
      }

      await this.sendText(
        groupId,
        [
          statusLine,
          "当前群定时任务：",
          ...tasks.map((task) =>
            `${task.id}：每 ${formatIntervalLabel(task.intervalMinutes)} 提醒群友${task.topic}，下次 ${formatLocalDateTime(new Date(task.nextRunAt))}`,
          ),
        ].join("\n"),
      );
      return;
    }

    const deleteMatch = normalized.match(new RegExp(`^${escapeRegex(SCHEDULED_REMINDER_PREFIX)}\\s*(?:删除|移除|取消)\\s+(.+)$`));
    if (deleteMatch) {
      const taskId = deleteMatch[1]?.trim();
      if (!taskId) {
        await this.sendText(groupId, "请提供要删除的定时任务 ID");
        return;
      }

      const removed = await this.scheduledReminderService.removeGroupTask(groupId, taskId);
      if (removed) {
        await this.logAdminOperation(groupId, userId, "定时任务删除", taskId);
      }
      await this.sendText(groupId, removed ? `已删除定时任务 ${taskId}` : `没找到定时任务 ${taskId}`);
      return;
    }

    const modifyMatch = normalized.match(new RegExp(`^${escapeRegex(SCHEDULED_REMINDER_PREFIX)}\\s*修改\\s+(.+)$`));
    if (modifyMatch) {
      const modifyRequest = this.scheduledReminderService.parseModifyRequest(modifyMatch[1]!);
      if (!modifyRequest) {
        await this.sendText(
          groupId,
          [
            "定时任务修改格式：",
            `${SCHEDULED_REMINDER_PREFIX} 修改 <任务ID> 每30分钟提醒群友喝水`,
          ].join("\n"),
        );
        return;
      }

      const existing = (await this.scheduledReminderService.listGroupTasks(groupId)).find(
        (task) => task.id === modifyRequest.taskId,
      );
      if (!existing) {
        await this.sendText(groupId, `没找到定时任务 ${modifyRequest.taskId}`);
        return;
      }

      const updated = await this.scheduledReminderService.updateTask(modifyRequest.taskId, {
        intervalMinutes: modifyRequest.request.intervalMinutes,
        topic: modifyRequest.request.topic,
      });
      if (!updated) {
        await this.sendText(groupId, `修改定时任务 ${modifyRequest.taskId} 失败`);
        return;
      }

      await this.sendText(
        groupId,
        `已修改定时任务 ${updated.id}：每 ${formatIntervalLabel(updated.intervalMinutes)} 提醒群友${updated.topic}`,
      );
      await this.logAdminOperation(
        groupId,
        userId,
        "定时任务修改",
        updated.id,
        `每 ${formatIntervalLabel(updated.intervalMinutes)} 提醒群友${updated.topic}`,
      );
      return;
    }

    const normalizedCreateText = normalized.replace(
      new RegExp(`^${escapeRegex(SCHEDULED_REMINDER_PREFIX)}\\s*(?:添加|设置|创建|新建)?\\s*`),
      "设置定时任务",
    );
    const request = this.scheduledReminderService.parseCreateRequest(normalizedCreateText);
    if (request) {
      const task = await this.scheduledReminderService.createTask({
        groupId,
        creatorUserId: userId,
        request,
        now: new Date(),
      });
      await this.sendText(
        groupId,
        `已设置定时任务 ${task.id}：每 ${formatIntervalLabel(task.intervalMinutes)} 提醒群友${task.topic}`,
      );
      await this.logAdminOperation(
        groupId,
        userId,
        "定时任务添加",
        task.id,
        `每 ${formatIntervalLabel(task.intervalMinutes)} 提醒群友${task.topic}`,
      );
      return;
    }

    await this.sendText(
      groupId,
      [
        "定时任务命令格式：",
        `${SCHEDULED_REMINDER_PREFIX} 列表`,
        `${SCHEDULED_REMINDER_PREFIX} 添加 每小时提醒群友喝水`,
        `${SCHEDULED_REMINDER_PREFIX} 修改 <任务ID> 每30分钟提醒群友喝水`,
        `${SCHEDULED_REMINDER_PREFIX} 删除 <任务ID>`,
        `${SCHEDULED_REMINDER_PREFIX} 状态 / 开启 / 关闭`,
        "也可以直接 @机器人 设置定时任务一个小时提醒群友喝水",
        "注意：定时任务仅在工作日 9:00-18:00 范围内触发",
      ].join("\n"),
    );
  }

  private async handleHelpCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
    runtimeCommands: SystemCommandConfig[],
  ): Promise<void> {
    const visible: SystemCommandConfig[] = [];
    for (const command of runtimeCommands) if (command.id === "model" && command.enabled || await this.canUseRuntimeCommand(command, groupConfig, event)) visible.push(command);
    const imageCommand = runtimeCommands.find(command => command.id === "image_generation");
    const includeImageGeneration = !imageCommand || visible.some(command => command.id === "image_generation");
    await this.sendText(
      groupConfig.groupId,
      buildFeatureListMessage(commandText, visible, includeImageGeneration, new Set(runtimeCommands.filter(command => !visible.includes(command)).map(command => command.id))),
    );
  }

  /** Pre-cutover compatibility only. V3 routes all admin authority to SQLite accounts. */
  private async handleLegacyAdminCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();
    const isAdmin = await this.isAdmin(groupConfig, userId, event.sender?.role);
    const isSuperAdmin = await this.groupConfigService.isSuperAdmin(userId);

    if (!isAdmin) {
      await this.sendText(groupId, MSG_ADMIN_NO_PERMISSION);
      return;
    }

    if (
      normalized === ADMIN_PREFIX ||
      normalized === `${ADMIN_PREFIX} 列表` ||
      normalized === `${ADMIN_PREFIX} 查看`
    ) {
      const superAdminUserIds = await this.groupConfigService.getSuperAdminUserIds();
      const groupAdmins = groupConfig.switcherUserIds;
      await this.sendText(
        groupId,
        [
          `本群管理员：${groupAdmins.length > 0 ? groupAdmins.join("、") : "暂无"}`,
          `超级管理员：${superAdminUserIds.length > 0 ? superAdminUserIds.join("、") : "暂无"}`,
          "说明：普通管理员可用全部系统指令，但不能添加或移除管理员；超级管理员可管理管理员",
        ].join("\n"),
      );
      return;
    }

    const addMatch = normalized.match(new RegExp(`^${escapeRegex(ADMIN_PREFIX)}\\s*添加\\s+(.+)$`));
    if (addMatch) {
      if (!isSuperAdmin) {
        await this.sendText(groupId, MSG_ADMIN_NO_PERMISSION);
        return;
      }

      const targetQq = extractQqFromInput(addMatch[1]);
      if (!targetQq) {
        await this.sendText(groupId, MSG_INVALID_QQ);
        return;
      }

      const updatedGroup = await this.groupConfigService.addAdminUser(groupId, targetQq);
      await this.logAdminOperation(groupId, userId, "管理员添加", targetQq);
      await this.sendText(
        groupId,
        `已将 ${targetQq} 设为本群管理员，当前管理员：${updatedGroup.switcherUserIds.join("、")}`,
      );
      return;
    }

    const removeMatch = normalized.match(new RegExp(`^${escapeRegex(ADMIN_PREFIX)}\\s*移除\\s+(.+)$`));
    if (removeMatch) {
      if (!isSuperAdmin) {
        await this.sendText(groupId, MSG_ADMIN_NO_PERMISSION);
        return;
      }

      const targetQq = extractQqFromInput(removeMatch[1]);
      if (!targetQq) {
        await this.sendText(groupId, MSG_INVALID_QQ);
        return;
      }

      const updatedGroup = await this.groupConfigService.removeAdminUser(groupId, targetQq);
      await this.logAdminOperation(groupId, userId, "管理员移除", targetQq);
      await this.sendText(
        groupId,
        updatedGroup.switcherUserIds.length > 0
          ? `已移除管理员 ${targetQq}，当前管理员：${updatedGroup.switcherUserIds.join("、")}`
          : `已移除管理员 ${targetQq}，当前本群暂无管理员`,
      );
      return;
    }

    await this.sendText(
      groupId,
      [
        "管理员命令格式：",
        `${ADMIN_PREFIX} 列表`,
        `${ADMIN_PREFIX} 添加 <QQ号>`,
        `${ADMIN_PREFIX} 移除 <QQ号>`,
        "注意：添加和移除管理员仅超级管理员可用，超级管理员需要在 config/groups.json 中配置",
      ].join("\n"),
    );
  }

  private async handleConversationCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();
    const clearRegex = new RegExp(`^${escapeRegex(CONVERSATION_PREFIX)}\\s*清空(?:\\s+(.+))?$`);
    const match = normalized.match(clearRegex);
    const mentionedUserId = extractFirstAtUserId(event.message, this.botQq);

    if (!match) {
      await this.sendText(
        groupId,
        [
          "对话命令格式：",
          `${CONVERSATION_PREFIX} 清空`,
          `${CONVERSATION_PREFIX} 清空 <QQ号>`,
          `${CONVERSATION_PREFIX} 清空 全部`,
        ].join("\n"),
      );
      return;
    }

    const targetInput = match[1]?.trim() || mentionedUserId;
    if (!targetInput) {
      await this.clearUserConversationContext(groupId, userId);
      await this.sendText(groupId, "已清空你在当前群的对话上下文");
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_CONVERSATION_NO_PERMISSION);
      return;
    }

    if (targetInput === "全部" || targetInput.toLowerCase() === "all") {
      await this.clearGroupConversationContext(groupId);
      await this.logAdminOperation(groupId, userId, "清空对话", "全部");
      await this.sendText(groupId, "已清空当前群全部成员的对话上下文");
      return;
    }

    const targetQq = extractQqFromInput(targetInput);
    if (!targetQq) {
      await this.sendText(groupId, MSG_INVALID_QQ);
      return;
    }

    await this.clearUserConversationContext(groupId, targetQq);
    await this.logAdminOperation(groupId, userId, "清空对话", targetQq);
    await this.sendText(groupId, `已清空 ${targetQq} 在当前群的对话上下文`);
  }

  private async handleClearGroupContextCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_CONVERSATION_NO_PERMISSION);
      return;
    }

    await this.clearGroupConversationContext(groupId);
    await this.logAdminOperation(groupId, userId, "清空对话", "全部");
    await this.sendText(groupId, "已清空当前群全部成员的对话上下文");
  }

  private async handleConversation(
    groupConfig: GroupBotConfig,
    userId: string,
    userInput: string,
    images: MessageImageInput[],
    replyMode: ReplyOutputMode = "text",
    prefixMentionUserIds: string[] = [],
    messageContext: MessageInteractionContext = { interactionTargets: [] },
    optionsOrAllowControlledMention: ConversationOptions | boolean = false,
    conversationRoute?: ConversationRoute,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.isCapabilityEnabled("conversation")) {
      await this.rejectCapability(groupConfig.groupId, "conversation");
      return;
    }
    const conversationStartedAt = Date.now();
    const currentMessageHasImages = images.length > 0;
    let normalizedUserInput = userInput.trim() || "[图片消息]";
    // Determine this before reading the causal branch. A profile request is
    // intentionally isolated from prior conversation text even when it later
    // resolves through an @, quoted message, or saved alias.
    const explicitProfileTargetUserIds = collectEvaluationTargetUserIds(messageContext.interactionTargets, this.botQq);
    const memberQueryText = normalizedUserInput.replace(/@(\d+)\b/gu, (token, id: string) =>
      explicitProfileTargetUserIds.includes(id) ? "" : token).trim();
    const profileQuestionIntent = isMemberProfileQueryRequest(memberQueryText);
    const profileAliasResolution = profileQuestionIntent
      ? resolveSavedAliasEvaluationTarget(groupConfig, normalizedUserInput)
      : { status: "none" as const };
    const selfProfileQuery = profileQuestionIntent && /^(?:请(?:你)?|说说|讲讲|介绍(?:一下)?|告诉我)?(?:我|本人|自己)(?:的|常用|最|爱|喜欢|有|做|说话|聊天)/u.test(memberQueryText.replace(/\s+/gu, ""));
    const memberProfileQueryIntent = profileQuestionIntent && (
      selfProfileQuery || explicitProfileTargetUserIds.length > 0 || profileAliasResolution.status !== "none" ||
      isUnresolvedMemberProfileQuery(memberQueryText)
    );
    const sourceRowId = messageContext.sourceMessageId
      ? this.conversationContextRepository?.getSourceRowId?.(
        groupConfig.groupId,
        messageContext.sourceMessageId,
      )
      : undefined;
    if (!conversationRoute && this.conversationContextRouter && messageContext.sourceMessageId) {
      if (sourceRowId !== undefined) {
        const input = {
          sourceRowId,
          groupId: groupConfig.groupId,
          userId,
          sourceMessageId: messageContext.sourceMessageId,
          replyToMessageId: messageContext.replyMessageId,
          text: userInput,
          hasImages: images.length > 0,
        };
        conversationRoute = await this.prepareConversationRoute(input, signal) ?? this.conversationContextRouter.resolve(input);
      } else {
        logWarn("Conversation source row is missing; using isolated context.", {
          groupId: groupConfig.groupId,
          sourceMessageId: messageContext.sourceMessageId,
        });
      }
    }
    const baseOptions: ConversationOptions = typeof optionsOrAllowControlledMention === "boolean"
      ? { allowControlledMention: optionsOrAllowControlledMention }
      : optionsOrAllowControlledMention;
    const options = baseOptions;
    const orchestration = this.conversationContextRepository?.orchestration;
    if (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId)) return;
    let contextResolution = sourceRowId === undefined ? undefined : orchestration?.getResolution(sourceRowId);
    const deicticImagePersonQuestion = isDeicticImagePersonQuestion(normalizedUserInput);
    const hasImageAnchor = currentMessageHasImages ||
      (messageContext.replyContext?.images?.length ?? 0) > 0 ||
      Boolean(contextResolution?.mediaSourceMessageIds.length);
    // A named alias and an ordinary pronoun still use member identity lookup.
    // Explicit visual wording is never reduced to a name such as "这", even
    // while a missing or ambiguous image is being resolved.
    const visualImagePersonQuery = deicticImagePersonQuestion && (
      hasImageAnchor || isExplicitImagePersonQuestion(normalizedUserInput)
    );
    const visualIdentityInstruction = visualImagePersonQuery
      ? "用户在问图中人物。只能根据图片可见内容回答；无法可靠确认身份时直接说明看不出来。不得把发图者、引用作者、群成员名片或外号当作图中人物。"
      : undefined;
    const identityQuery = visualImagePersonQuery
      ? undefined
      : parseMemberIdentityQuery(normalizedUserInput, groupConfig, messageContext.interactionTargets, this.botQq);
    if (identityQuery) {
      const identityHandled = await this.identityQueryLock.run(`${groupConfig.groupId}:${conversationRoute?.turnId ?? messageContext.sourceMessageId ?? userId}`, async () => {
        if (conversationRoute && this.conversationContextRepository?.hasAssistantReplyForTurn?.(conversationRoute.branchId, conversationRoute.turnId)) return true;
        const identityArgs = {
          group: groupConfig, userId, targets: messageContext.interactionTargets, botQq: this.botQq,
          senderCard: messageContext.senderCard, senderNickname: messageContext.senderNickname,
        };
        let answer = resolveMemberIdentityQuery(identityQuery, identityArgs);
        let directoryStatus = "not_needed";
        if (answer.needsDirectory) {
          try {
            const members = await refreshIdentityDirectory(() => {
              if (!this.transport.listGroupMembers) throw new Error("identity_directory_unavailable");
              return this.transport.listGroupMembers(groupConfig.groupId, { refresh: true });
            });
            answer = resolveMemberIdentityQuery(identityQuery, { ...identityArgs, members });
            directoryStatus = "read";
          } catch (error) {
            directoryStatus = error instanceof Error && error.message === "identity_directory_timeout" ? "timeout" : "unavailable";
          }
        }
        if (!answer.handled) {
          logInfo("Member identity comparison resumed normal conversation.", {
            groupId: groupConfig.groupId, memberQueryType: "identity_check", identityQueryKind: answer.kind,
            identityQueryStatus: answer.status, targetUserIds: answer.targetIds,
            memberQueryResolutionSource: answer.source, memberQueryUnresolvedReason: answer.reason,
            identityDirectoryStatus: directoryStatus, memorySubjectUserIds: [],
          });
          return Boolean(signal?.aborted || (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId)));
        }
        if (signal?.aborted || (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId))) return true;
        const receipt = await this.sendTextWithContext(groupConfig.groupId, answer.text, conversationRoute);
        await this.persistAssistantContext(conversationRoute, answer.text, receipt ? [receipt] : []);
        logInfo("Completed verified member identity query.", {
          groupId: groupConfig.groupId, memberQueryType: "identity_check", identityQueryKind: answer.kind,
          identityQueryStatus: answer.status, targetUserIds: answer.targetIds,
          memberQueryResolutionSource: answer.source, memberQueryUnresolvedReason: answer.reason,
          identityDirectoryStatus: directoryStatus, memorySubjectUserIds: [],
        });
        return true;
      });
      if (identityHandled) return;
    }
    if (isExplicitUnauthorizedCyberIntrusionRequest(normalizedUserInput)) {
      const receipt = await this.sendTextWithContext(groupConfig.groupId, MSG_UNAUTHORIZED_CYBER_REFUSAL, conversationRoute);
      await this.persistAssistantContext(conversationRoute, MSG_UNAUTHORIZED_CYBER_REFUSAL, receipt ? [receipt] : []);
      return;
    }
    // A picture reply is evidence for vision, not an identity target. Keep the
    // media for delivery, but do not let its sender turn into person context.
    if (visualImagePersonQuery) {
      messageContext = { ...messageContext, interactionTargets: [] };
    }
    // Route planning may have hit a transient remote failure before this worker
    // gets a second chance to resolve the same quote. A recovered quote wins
    // over that persisted placeholder, including after a worker restart.
    if (
      sourceRowId !== undefined &&
      orchestration &&
      messageContext.replyContext &&
      contextResolution?.clarification === MSG_QUOTED_MESSAGE_UNAVAILABLE
    ) {
      const replacement = resolveContextByRules({
        userId,
        text: normalizedUserInput,
        hasImages: images.length > 0,
        replyToMessageId: messageContext.replyMessageId,
        reference: {
          messageId: messageContext.replyContext.messageId,
          ...(messageContext.replyContext.userId ? { userId: messageContext.replyContext.userId } : {}),
          ...(messageContext.replyContext.userName ? { userName: messageContext.replyContext.userName } : {}),
          text: messageContext.replyContext.text,
          images: messageContext.replyContext.images ?? [],
        },
        candidates: [],
        messages: [],
      });
      contextResolution = orchestration.replaceUnavailableQuoteResolution(
        sourceRowId,
        MSG_QUOTED_MESSAGE_UNAVAILABLE,
        replacement,
      ) ?? contextResolution;
    }
    // A reply segment is an explicit request to use that message as evidence.
    // Do not let a missing local/remote payload fall through to unrelated
    // branch history or ask the user to describe the bot's own old reply.
    if (messageContext.replyMessageId && !messageContext.replyContext) {
      const receipt = await this.sendTextWithContext(groupConfig.groupId, MSG_QUOTED_MESSAGE_UNAVAILABLE, conversationRoute);
      await this.persistAssistantContext(conversationRoute, MSG_QUOTED_MESSAGE_UNAVAILABLE, receipt ? [receipt] : []);
      return;
    }
    const excludedContextUsers = [...(groupConfig.blacklistedUserIds ?? []), ...(groupConfig.memoryDisabledUserIds ?? [])];
    if (!memberProfileQueryIntent && sourceRowId !== undefined && orchestration) {
      const merged = orchestration.mergedInput(sourceRowId, groupConfig.groupId, userId);
      normalizedUserInput = merged.text || normalizedUserInput;
      const media = orchestration.mediaByIds(groupConfig.groupId, contextResolution?.mediaSourceMessageIds ?? [], sourceRowId, excludedContextUsers);
      images = uniqueConversationImages([...images, ...merged.images, ...media.flatMap(item => item.images)]);
    }
    const hasResolvedImage = images.length > 0 || (messageContext.replyContext?.images?.length ?? 0) > 0;
    if (isExplicitImagePersonQuestion(normalizedUserInput) && !hasResolvedImage &&
      contextResolution?.clarification !== MSG_IMAGE_SELECTION_REQUIRED) {
      const missingImageText = "我没看到你指的图，引用那条图片消息或重发一下。";
      const receipt = await this.sendTextWithContext(groupConfig.groupId, missingImageText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, missingImageText, receipt ? [receipt] : []);
      return;
    }
    const knowledgeSessionKey = knowledgeContinuationKey(groupConfig.groupId, userId);
    let knowledgeSession = this.knowledgeContinuationSessions.get(knowledgeSessionKey);
    if (knowledgeSession && (
      Date.now() - knowledgeSession.updatedAt >= KNOWLEDGE_CONTINUATION_WINDOW_MS ||
      !isKnowledgeContinuation(knowledgeSession, normalizedUserInput)
    )) {
      this.knowledgeContinuationSessions.delete(knowledgeSessionKey);
      knowledgeSession = undefined;
    }

    const explicitFaqRequest = isExplicitGroupFaqLookup(normalizedUserInput);
    const faqFollowup = knowledgeSession?.source === "group_faq" &&
      isGroupFaqContinuation(normalizedUserInput);
    if (explicitFaqRequest || faqFollowup) {
      if (!this.isCapabilityEnabled("knowledge")) {
        await this.rejectCapability(groupConfig.groupId, "knowledge");
        return;
      }
      const searchQuery = explicitFaqRequest
        ? stripGroupFaqSource(normalizedUserInput)
        : getGroupFaqContinuationQuery(knowledgeSession!, normalizedUserInput);
      const messages = await this.answerCurrentGroupFaq(groupConfig.groupId, searchQuery);
      const receipts = await this.sendTextMessages(
        groupConfig.groupId,
        messages,
        prefixMentionUserIds,
        conversationRoute,
      );
      await this.persistAssistantContext(conversationRoute, messages.join("\n\n"), receipts);
      this.rememberKnowledgeSession(knowledgeSessionKey, {
        source: "group_faq",
        query: explicitFaqRequest ? searchQuery : knowledgeSession!.query,
        reply: messages.join("\n\n"),
        updatedAt: Date.now(),
        branchId: conversationRoute?.branchId,
      }, messageContext.sourceMessageId);
      return;
    }
    // Read the causal branch before the vision gate. A ranking follow-up such
    // as "分别是哪些" needs the immediately preceding verified answer, and an
    // incidental image must not turn that deterministic query into a vision
    // request. The same history is reused below for ordinary model replies.
    let causalHistory: ConversationContextTurn[] = [];
    let conversationStateHistory: ConversationContextTurn[] = [];
    if (!memberProfileQueryIntent && conversationRoute && this.conversationContextRepository) {
      try {
        if (orchestration) {
          const since = (orchestration.sourceReceivedAt(conversationRoute.sourceRowId) ?? Date.now()) - 60 * 60_000;
          conversationStateHistory = this.conversationContextRepository.getCausalTurnsBeforeTurn(
            conversationRoute.branchId, conversationRoute.turnId, { maxTurns: 200, maxChars: 80_000 },
          ).filter(turn => turn.createdAt >= since);
        }
        causalHistory = this.conversationContextRepository.getCausalTurnsBeforeTurn(
          conversationRoute.branchId,
          conversationRoute.turnId,
        );
        const hasExcludedAncestor = causalHistory.some(turn => turn.userId && excludedContextUsers.includes(turn.userId));
        if (orchestration) causalHistory = causalHistory.flatMap(turn => {
          if (turn.role !== "assistant") return turn.userId && excludedContextUsers.includes(turn.userId) ? [] : [turn];
          if (hasExcludedAncestor) return [];
          const content = orchestration.deliveredText(turn.id, turn.content, turn.deliveryId);
          return content ? [{ ...turn, content }] : [];
        });
      } catch (error) {
        logWarn("Conversation history read failed closed; using current message only.", {
          topicId: conversationRoute.topicId,
          branchId: conversationRoute.branchId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    const rankingContinuation = knowledgeSession?.source === "private_enterprise_ranking"
      ? knowledgeSession
      : undefined;
    const rankingHistory = rankingContinuation
      ? [
        { role: "user", content: rankingContinuation.query },
        { role: "assistant", content: rankingContinuation.reply },
      ]
      : [];
    // A deterministic Top 500 request is fully answered from the verified
    // local dataset. Handle it before the vision gate so an incidental
    // attachment cannot make a verified fact query fall back to a model.
    const rankingRequestScope = classifyPrivateEnterpriseRankingRequest(normalizedUserInput, rankingHistory);
    const namedRankingRequest = rankingRequestScope !== "none";
    const preflightRankingAnswer = this.privateEnterpriseRanking?.answer(normalizedUserInput, rankingHistory);
    if (namedRankingRequest || preflightRankingAnswer) {
      if (!this.isCapabilityEnabled("knowledge")) {
        await this.rejectCapability(groupConfig.groupId, "knowledge");
        return;
      }
      const messages = preflightRankingAnswer?.messages ?? [
        "2026中国民营企业500强知识库暂不能解析这个问法；请明确企业名称、名次、省级地区或名单需求。",
      ];
      const receipts = await this.sendTextMessages(
        groupConfig.groupId,
        messages,
        prefixMentionUserIds,
        conversationRoute,
      );
      await this.persistAssistantContext(conversationRoute, messages.join("\n\n"), receipts);
      this.rememberKnowledgeSession(knowledgeSessionKey, {
        source: "private_enterprise_ranking",
        query: rankingRequestScope === "contextual" && rankingContinuation
          ? rankingContinuation.query
          : normalizedUserInput,
        reply: messages.join("\n\n"),
        updatedAt: Date.now(),
        branchId: conversationRoute?.branchId,
      }, messageContext.sourceMessageId);
      return;
    }

    const imageInputCount = images.length + (messageContext.replyContext?.images?.length ?? 0);
    if (!memberProfileQueryIntent && imageInputCount > 0 && groupConfig.visionEnabled !== true) {
      const disabledText = "本群未开启图片理解，请联系群管理员在后台开启后再发送图片。";
      logInfo("Skipped image reply because vision is disabled for this group.", {
        groupId: groupConfig.groupId,
        imageCount: imageInputCount,
        visionEnabled: false,
      });
      const receipt = await this.sendTextWithContext(groupConfig.groupId, disabledText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, disabledText, receipt ? [receipt] : []);
      return;
    }
    const skill = await this.resolveSkill(groupConfig);
    const explicitEvaluationTargetUserIds = collectEvaluationTargetUserIds(
      messageContext.interactionTargets,
      this.botQq,
    );
    const localTranscriptTargetRequest = isLocalTranscriptTargetRequest(normalizedUserInput);
    const memberProfileQueryRequested = memberProfileQueryIntent;
    const savedAliasResolution = memberProfileQueryRequested ? profileAliasResolution : explicitEvaluationTargetUserIds.length === 0 &&
      (isPersonEvaluationRequest(normalizedUserInput, true) || localTranscriptTargetRequest || memberProfileQueryRequested)
      ? resolveSavedAliasEvaluationTarget(groupConfig, normalizedUserInput)
      : { status: "none" as const };
    const profileTargetConflict = memberProfileQueryRequested && (
      (selfProfileQuery && (explicitEvaluationTargetUserIds.some(id => id !== userId) ||
        (savedAliasResolution.status === "resolved" && savedAliasResolution.target.userId !== userId))) ||
      (savedAliasResolution.status === "resolved" && explicitEvaluationTargetUserIds.length > 0 &&
        explicitEvaluationTargetUserIds.some(id => id !== savedAliasResolution.target.userId))
    );
    if (memberProfileQueryRequested && selfProfileQuery) {
      const names = groupConfig.manualIdentities?.find(identity => identity.userIds.includes(userId))?.names ?? [];
      messageContext = { ...messageContext, interactionTargets: [{ userId, names, source: "self" }] };
    } else if (savedAliasResolution.status === "resolved" && explicitEvaluationTargetUserIds.length === 0) {
      messageContext = {
        ...messageContext,
        interactionTargets: [savedAliasResolution.target],
      };
    }
    const relatedUserIds = messageContext.interactionTargets
      .map((target) => target.userId)
      .filter((target): target is string => Boolean(target));
    // A model only receives the current speaker and people explicitly named by
    // an @ or a quoted message. The stored group roster remains an admin-side
    // data source and must not become ambient prompt context.
    const promptManualIdentities = selectManualIdentitiesForUserIds(
      groupConfig.manualIdentities,
      [userId, ...relatedUserIds],
    );
    const promptGroupConfig: GroupBotConfig = {
      ...groupConfig,
      manualIdentities: promptManualIdentities,
    };
    // Fail closed: routed production messages read only their causal branch.
    // The branch was loaded above so a deterministic knowledge answer could
    // bypass the vision gate, and is reused here for model context.
    const history: ConversationTurn[] = visualImagePersonQuery
      ? []
      : causalHistory.map((turn): ConversationTurn => ({
          groupId: groupConfig.groupId,
          role: turn.role,
          content: turn.role === "user"
            ? formatCausalUserTurn(turn.userId, turn.content, promptGroupConfig)
            : turn.content,
          ...(turn.userId ? { userId: turn.userId } : {}),
          timestamp: new Date(turn.createdAt).toISOString(),
        }));
    const evaluationTargetUserIds = collectEvaluationTargetUserIds(
      messageContext.interactionTargets,
      this.botQq,
    );
    const personEvaluationRequested = isPersonEvaluationRequest(
      normalizedUserInput,
      messageContext.interactionTargets.length > 0,
    ) || savedAliasResolution.status === "ambiguous";
    const targetedMemberProfileRequested = memberProfileQueryRequested && evaluationTargetUserIds.length === 1;
    const memberQueryDiagnostics = {
      memberQueryType: memberProfileQueryRequested ? "member_profile" : "none",
      memberQueryResolutionSource: selfProfileQuery ? "self" : explicitEvaluationTargetUserIds.length ? "member_object" : savedAliasResolution.status === "resolved" ? "saved_alias" : "none",
      memberQueryUnresolvedReason: profileTargetConflict ? "target_conflict" : savedAliasResolution.status === "ambiguous" ? "ambiguous_saved_alias" : evaluationTargetUserIds.length > 1 ? "multiple_verified_targets" : memberProfileQueryRequested && !evaluationTargetUserIds.length ? "unknown_member_name" : undefined,
    };
    const targetedGroupEvidenceRequested =
      !targetedMemberProfileRequested &&
      (personEvaluationRequested || localTranscriptTargetRequest) && evaluationTargetUserIds.length === 1;
    const explicitGroupEvaluationRequested = isExplicitGroupEvaluationRequest(normalizedUserInput);
    const ordinaryEvaluationFallback =
      personEvaluationRequested &&
      evaluationTargetUserIds.length === 0 &&
      savedAliasResolution.status === "none" &&
      !explicitGroupEvaluationRequested;
    const requiresClarification =
      profileTargetConflict ||
      (memberProfileQueryRequested && evaluationTargetUserIds.length === 0) ||
      savedAliasResolution.status === "ambiguous" ||
      ((personEvaluationRequested || memberProfileQueryRequested) && evaluationTargetUserIds.length > 1) ||
      (personEvaluationRequested && explicitGroupEvaluationRequested && evaluationTargetUserIds.length !== 1);
    if (requiresClarification) {
      const clarificationText = memberProfileQueryRequested
        ? "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要查询的群友。"
        : "请使用一个已保存且唯一的群友别名，或者明确 @/回复一位要评价的群友。";
      const receipt = await this.sendTextWithContext(groupConfig.groupId, clarificationText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, clarificationText, receipt ? [receipt] : []);
      const clarificationReason = profileTargetConflict ? "target_conflict" : memberProfileQueryRequested && evaluationTargetUserIds.length === 0 && savedAliasResolution.status === "none" ? "unknown_member_name" : savedAliasResolution.status === "ambiguous"
        ? "ambiguous_saved_alias"
        : evaluationTargetUserIds.length > 1
          ? "multiple_verified_targets"
          : "explicit_group_scope_without_verified_target";
      logInfo("Skipped group evidence because an explicitly scoped evaluation target was not uniquely verified.", {
        groupId: groupConfig.groupId,
        verifiedTargetCount: evaluationTargetUserIds.length,
        savedAliasStatus: savedAliasResolution.status,
        memberProfileQueryIntent: profileQuestionIntent,
        memberProfileQueryRequested,
        targetUserIds: evaluationTargetUserIds,
        memorySubjectUserIds: [],
        clarificationReason,
        ...memberQueryDiagnostics,
      });
      return;
    }
    if (localTranscriptTargetRequest && !targetedMemberProfileRequested && groupConfig.ambientGroupContextEnabled === false) {
      const unavailableText = "本群未开启近期群聊上下文，无法根据以上聊天记录回答。";
      const receipt = await this.sendTextWithContext(groupConfig.groupId, unavailableText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, unavailableText, receipt ? [receipt] : []);
      logInfo("Skipped local transcript evidence because ambient group context is disabled.", {
        groupId: groupConfig.groupId,
      });
      return;
    }
    if (ordinaryEvaluationFallback) {
      logInfo("Falling back to an ordinary AI reply for an unverified open-ended evaluation.", {
        groupId: groupConfig.groupId,
        savedAliasStatus: savedAliasResolution.status,
      });
    }
    const recentGroupEvidenceTriggered = targetedGroupEvidenceRequested;
    const targetPrivacyOptedOut = targetedGroupEvidenceRequested &&
      (groupConfig.memoryDisabledUserIds ?? []).includes(evaluationTargetUserIds[0]!);
    const memberProfileTargetPrivacyOptedOut = targetedMemberProfileRequested &&
      (groupConfig.memoryDisabledUserIds ?? []).includes(evaluationTargetUserIds[0]!);
    if (targetPrivacyOptedOut || memberProfileTargetPrivacyOptedOut) {
      const unavailableText = memberProfileTargetPrivacyOptedOut
        ? MSG_MEMBER_PROFILE_UNAVAILABLE
        : "当前没有可用于回答这位群友相关问题的聊天记录。";
      const receipt = await this.sendTextWithContext(groupConfig.groupId, unavailableText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, unavailableText, receipt ? [receipt] : []);
      logInfo(memberProfileTargetPrivacyOptedOut
        ? "Skipped member profile query for a privacy-opted-out target."
        : "Skipped group evidence for a privacy-opted-out target.", {
        groupId: groupConfig.groupId,
        ...memberQueryDiagnostics,
        memberQueryUnresolvedReason: "privacy_disabled",
        memberProfileQueryIntent: profileQuestionIntent,
        memberProfileQueryRequested,
        savedAliasStatus: savedAliasResolution.status,
        targetUserIds: evaluationTargetUserIds,
        memorySubjectUserIds: [],
      });
      return;
    }
    let recentGroupEvidence: NonNullable<AiIdentityContext["recentGroupEvidence"]> = [];
    if (recentGroupEvidenceTriggered && sourceRowId !== undefined) {
      try {
        const excludedUserIds = [
          ...(groupConfig.blacklistedUserIds ?? []),
          ...(groupConfig.memoryDisabledUserIds ?? []),
        ];
        recentGroupEvidence = localTranscriptTargetRequest
          ? this.recentGroupEvidenceService?.listAmbient?.({
            groupId: groupConfig.groupId,
            beforeSourceRowId: sourceRowId,
            lookbackMs: AMBIENT_GROUP_CONTEXT_LOOKBACK_MS,
            excludedUserIds,
            limit: 30,
          }) ?? []
          : this.recentGroupEvidenceService?.list({
            groupId: groupConfig.groupId,
            beforeSourceRowId: sourceRowId,
            sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1_000,
            excludedUserIds,
            limit: 30,
          }) ?? [];
      } catch (error) {
        logWarn("Recent group evidence read failed closed.", {
          groupId: groupConfig.groupId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let ambientGroupContext: NonNullable<AiIdentityContext["ambientGroupContext"]> = [];
    let ambientGroupContextStatus:
      | "loaded"
      | "member_profile_query"
      | "visual_image"
      | "disabled"
      | "explicit_reply"
      | "targeted_group_evidence"
      | "missing_source"
      | "unavailable"
      | "read_failed";
    if (visualImagePersonQuery) {
      // A photo's sender and its nearby discussion do not establish who is
      // pictured. Vision gets the image itself, without roster context.
      ambientGroupContextStatus = "visual_image";
    } else if (targetedMemberProfileRequested) {
      // A member-profile query must be answered from approved durable profile
      // data only. Do not mix in nearby messages or the quoted reply used to
      // identify the target.
      ambientGroupContextStatus = "member_profile_query";
    } else if (groupConfig.ambientGroupContextEnabled === false) {
      ambientGroupContextStatus = "disabled";
    } else if (recentGroupEvidenceTriggered) {
      ambientGroupContextStatus = "targeted_group_evidence";
    } else if (sourceRowId === undefined) {
      ambientGroupContextStatus = "missing_source";
    } else if (!this.recentGroupEvidenceService?.listAmbient) {
      ambientGroupContextStatus = "unavailable";
    } else {
      try {
        const causalMessageIds = new Set(
          causalHistory.flatMap((turn) => [turn.sourceMessageId, turn.platformMessageId])
            .filter((messageId): messageId is string => Boolean(messageId)),
        );
        const explicitQuoteId = contextResolution?.anchor?.kind === "explicit_reply"
          ? messageContext.replyContext?.messageId
          : undefined;
        const ambientCandidates = this.recentGroupEvidenceService.listAmbient({
          groupId: groupConfig.groupId,
          beforeSourceRowId: sourceRowId,
          lookbackMs: contextResolution?.expandedContext ? 60 * 60_000 : AMBIENT_GROUP_CONTEXT_LOOKBACK_MS,
          excludedUserIds: [
            ...(groupConfig.blacklistedUserIds ?? []),
            ...(groupConfig.memoryDisabledUserIds ?? []),
          ],
          limit: contextResolution?.expandedContext ? 200 : AMBIENT_GROUP_CONTEXT_MESSAGE_LIMIT,
        }).filter((message) => !message.messageId || !causalMessageIds.has(message.messageId) || message.messageId === explicitQuoteId);
        const selectedMessageIds = explicitQuoteId
          ? [...new Set([
              ...(contextResolution?.selectedMessageIds ?? []),
              ...selectDiscussionClusterAroundMessage(ambientCandidates, explicitQuoteId)
                .flatMap(message => message.messageId ? [message.messageId] : []),
            ])]
          : contextResolution?.selectedMessageIds ?? [];
        const branchOnlyEvidence = contextResolution?.anchor?.kind === "explicit_follow_up" && selectedMessageIds.length === 0;
        ambientGroupContext = branchOnlyEvidence || (contextResolution?.source === "model" && selectedMessageIds.length === 0)
          ? [] : selectConversationEvidence(ambientCandidates, selectedMessageIds);
        ambientGroupContextStatus = "loaded";
      } catch (error) {
        ambientGroupContextStatus = "read_failed";
        logWarn("Ambient group context read failed closed.", {
          groupId: groupConfig.groupId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ambientGroupContextChars = formatRecentGroupEvidenceForMetrics(ambientGroupContext).length;
    const conversationState = !targetedMemberProfileRequested && !visualImagePersonQuery
      ? orchestration?.readState(conversationStateHistory, excludedContextUsers) ?? emptyConversationState()
      : emptyConversationState();
    if (!targetedMemberProfileRequested && !visualImagePersonQuery && conversationRoute && orchestration) {
      conversationState.pendingMedia = orchestration.pendingMedia(conversationRoute, excludedContextUsers);
    }
    const replyPolicy = new ReplyPolicyService();
    const replyPlan = replyPolicy.plan({
      resolution: contextResolution ?? resolveContextByRules({
        userId, text: normalizedUserInput, hasImages: images.length > 0, replyToMessageId: messageContext.replyMessageId, candidates: [], messages: ambientGroupContext,
      }),
      state: conversationState, userId, userInput: normalizedUserInput, sourceMessageId: messageContext.sourceMessageId,
      mediaSourceMessageIds: [...(currentMessageHasImages && messageContext.sourceMessageId ? [messageContext.sourceMessageId] : []), ...(contextResolution?.mediaSourceMessageIds ?? [])],
    });
    if (!targetedMemberProfileRequested && replyPlan.action === "clarify" && replyPlan.clarification) {
      signal?.throwIfAborted();
      if (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId)) return;
      const receipt = await this.sendTextWithContext(groupConfig.groupId, replyPlan.clarification, conversationRoute);
      await this.persistAssistantContext(conversationRoute, replyPlan.clarification, receipt ? [receipt] : []);
      return;
    }
    // L5 群氛围：注入的是摘要而不是原文（计划 §3/§5.2）。
    const atmosphere = !targetedMemberProfileRequested && !visualImagePersonQuery && this.atmosphereSummarizer
      ? (this.atmosphereSummarizer.getSummary(groupConfig.groupId) ?? this.atmosphereSummarizer.summarizeNow(
          groupConfig.groupId,
          this.groupTranscriptService.getRecentMessages(groupConfig.groupId, {
            excludeMessageId: messageContext.sourceMessageId,
          }),
        ))
      : undefined;
    const explicitReplyLengthPlan = (() => {
      if (replyMode !== "text") return undefined;
      const intent = resolveReplyLengthIntent(normalizedUserInput, causalHistory, userId);
      return intent ? buildExplicitReplyLengthPlan(skill, intent) : undefined;
    })();
    const replyFormatBudget = explicitReplyLengthPlan?.budget
      ?? replyPolicy.replyFormatBudget(skill, normalizedUserInput, replyPlan);
    const replyLengthInstruction = explicitReplyLengthPlan
      ? buildExplicitReplyLengthInstruction(explicitReplyLengthPlan)
      : undefined;
    const scenarioInstruction = [options.scenarioInstruction, replyLengthInstruction, visualIdentityInstruction,
      !targetedMemberProfileRequested ? replyPolicy.instruction(replyPlan, conversationState, {
        formatBudget: replyFormatBudget,
        explicitReplyLength: Boolean(explicitReplyLengthPlan),
      }) : undefined]
      .filter((instruction): instruction is string => Boolean(instruction))
      .join("\n\n");
    const currentSpeaker = buildCurrentSpeaker(promptGroupConfig, userId, messageContext);
    const memoryQueryText = visualImagePersonQuery
      ? normalizedUserInput
      : [
          normalizedUserInput,
          messageContext.replyContext?.text ?? "",
          ...messageContext.interactionTargets.flatMap((target) => target.names),
        ].join(" ");
    const memberProfileTargetUserId = targetedMemberProfileRequested ? evaluationTargetUserIds[0]! : undefined;
    // Generic "you tell us" and terse reactions to an explicit quote only need
    // the anchor selected for this turn. Old durable profiles would turn a
    // short prompt into a stale personal-topic answer.
    const suppressLongTermMemory = visualImagePersonQuery || (!memberProfileTargetUserId && (
      contextResolution?.anchor?.kind === "recent_cluster" ||
      isBareOpinionRequest(normalizedUserInput) ||
      (Boolean(messageContext.replyContext) && isReferenceDependentShortReaction(normalizedUserInput))
    ));
    const memoryIdentityTerms = collectMemoryIdentityTerms(
      promptGroupConfig,
      memberProfileTargetUserId ? [memberProfileTargetUserId] : [userId, ...relatedUserIds],
    );
    const realtimeLookupStartedAt = Date.now();
    // 分级超时（计划 §2.4）：记忆检索 1.5s/2s、实时查询 8s/10s——超时跳过该层，
    // 不阻塞回复生成。
    const [retrievedGroupMemories, realtimeLookup] = await Promise.all([
      this.isCapabilityEnabled("explicit_memory") && !suppressLongTermMemory
        ? withTimeout(
          memberProfileTargetUserId
            // The regular relevance ranking can prefer the speaker or a group
            // fact and omit the target at its result limit. Profile queries
            // instead read records and keep only this verified target's
            // enabled profile, without the store's default listEnabled cap.
            ? this.groupMemoryStore?.list(groupConfig.groupId) ?? Promise.resolve([])
            : this.groupMemoryStore?.listRelevantEnabled({
              groupId: groupConfig.groupId,
              currentUserId: userId,
              relatedUserIds,
              excludedSubjectUserIds: groupConfig.memoryDisabledUserIds,
              queryText: memoryQueryText,
              identityTerms: memoryIdentityTerms,
              limit: 8,
              maxChars: 3_200,
            }) ?? Promise.resolve([]),
          1_500,
        ).catch((error) => {
        logWarn("Memory retrieval timed out; skipping L1 layer.", {
          groupId: groupConfig.groupId,
          error: error instanceof Error ? error.message : String(error),
        });
          return [];
        })
        : Promise.resolve([]),
      visualImagePersonQuery || targetedMemberProfileRequested
        ? Promise.resolve(undefined)
        : this.resolveRealtimeLookup(groupConfig, replyPlan),
    ]);
    const realtimeLookupMs = Date.now() - realtimeLookupStartedAt;
    const visibleSubjectUserIds = new Set(memberProfileTargetUserId ? [memberProfileTargetUserId] : [userId, ...relatedUserIds]);
    const memoryDisabledUserIds = new Set(groupConfig.memoryDisabledUserIds ?? []);
    // Keep this second filter at the context boundary. It protects against a
    // future store implementation or a test double that forgets the opt-out
    // filter, and avoids injecting unrelated member profiles into a reply.
    const groupMemories = retrievedGroupMemories.filter((memory) => {
      if (memberProfileTargetUserId) {
        return memory.type === "member_profile" &&
          memory.groupId === groupConfig.groupId &&
          memory.subjectUserId === memberProfileTargetUserId &&
          memory.enabled &&
          !memoryDisabledUserIds.has(memberProfileTargetUserId);
      }
      return !memory.subjectUserId || (
        visibleSubjectUserIds.has(memory.subjectUserId) &&
        !memoryDisabledUserIds.has(memory.subjectUserId)
      );
    });
    if (memberProfileTargetUserId && groupMemories.length === 0) {
      const receipt = await this.sendTextWithContext(groupConfig.groupId, MSG_MEMBER_PROFILE_UNAVAILABLE, conversationRoute);
      await this.persistAssistantContext(conversationRoute, MSG_MEMBER_PROFILE_UNAVAILABLE, receipt ? [receipt] : []);
      logInfo("Skipped member profile query without an enabled approved profile.", {
        groupId: groupConfig.groupId,
        ...memberQueryDiagnostics,
        memberQueryUnresolvedReason: "profile_unavailable",
        memberProfileQueryIntent: profileQuestionIntent,
        memberProfileQueryRequested,
        savedAliasStatus: savedAliasResolution.status,
        targetUserIds: [memberProfileTargetUserId],
        memorySubjectUserIds: [],
      });
      return;
    }
    const memorySubjectUserIds = new Set(
      groupMemories
        .map((memory) => memory.subjectUserId)
        .filter((memberId): memberId is string => Boolean(memberId)),
    );
    const napcatMembers = memorySubjectUserIds.size > 0
      ? (await this.safeListGroupMembers(groupConfig.groupId)).filter((member) => memorySubjectUserIds.has(String(member.user_id)))
      : [];
    const memberProfiles = groupMemories.length > 0
      ? buildGroupMemberProfiles({
          groupConfig: promptGroupConfig,
          napcatMembers,
          memories: groupMemories,
        })
      : [];
    const visibleMemberProfiles = memberProfileTargetUserId
      ? memberProfiles.filter((profile) => profile.userId === memberProfileTargetUserId)
      : memberProfiles;
    const allImages = targetedMemberProfileRequested
      ? []
      : uniqueConversationImages([
        ...images,
        ...(messageContext.replyContext?.images ?? []),
      ]);
    // 图片两阶段（计划 §4）：Stage1 本地化（NapCat 缓存 → 内部代理）→ data URL；
    // 失败进入分级话术（L1-L4），绝不说成"思考超时"。
    const visionEnabled = groupConfig.visionEnabled === true;
    const resolvedImages = visionEnabled
      ? await this.resolveImagesWithPipeline(groupConfig, allImages)
      : [];
    if (visionEnabled && allImages.length > 0 && resolvedImages.length === 0) {
      const error = new ImageInputUnavailableError();
      logWarn("Skipped AI reply because attached images could not be materialized.", {
        groupId: groupConfig.groupId,
        imageCount: allImages.length,
        tier: "image_unavailable",
      });
      const failureText = messageForAiFailure(error, "image_input");
      const failureReceipt = await this.sendTextWithContext(groupConfig.groupId, failureText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, failureText, failureReceipt ? [failureReceipt] : []);
      return;
    }
    // Referenced-message image metadata is also untrusted media input. Keep it
    // out of the model payload unless this group explicitly enabled vision.
    const replyContextForAi = targetedMemberProfileRequested ? undefined : (() => {
      if (visualImagePersonQuery && messageContext.replyContext) {
        return {
          messageId: messageContext.replyContext.messageId,
          text: "",
          ...(visionEnabled && messageContext.replyContext.images?.length
            ? { images: messageContext.replyContext.images }
            : {}),
        };
      }
      if (
        visionEnabled ||
        !messageContext.replyContext ||
        (messageContext.replyContext.images?.length ?? 0) === 0
      ) {
        return messageContext.replyContext;
      }
      return { ...messageContext.replyContext, images: [] };
    })();
    const identityContext = {
      groupId: groupConfig.groupId,
      currentUserId: userId,
      ...(Object.keys(currentSpeaker).length > 0 ? { currentSpeaker } : {}),
      botUserId: this.botQq,
      manualIdentities: promptManualIdentities,
      ...(visibleMemberProfiles.length > 0 ? { memberProfiles: visibleMemberProfiles } : {}),
      ...(groupMemories.length > 0 ? { groupMemories } : {}),
      ...(messageContext.interactionTargets.length > 0
        ? { interactionTargets: messageContext.interactionTargets }
        : {}),
      ...(replyContextForAi ? { replyContext: replyContextForAi } : {}),
      ...(realtimeLookup ? { realtimeLookup } : {}),
      ...(recentGroupEvidence.length > 0 ? { recentGroupEvidence } : {}),
      ...(recentGroupEvidenceTriggered ? {
        recentGroupEvidenceRequested: true,
        recentGroupEvidenceTargetUserId: evaluationTargetUserIds[0],
      } : {}),
      ...(ambientGroupContext.length > 0 ? { ambientGroupContext } : {}),
      ...(!targetedMemberProfileRequested && orchestration ? { conversationState, replyPlan } : {}),
      ...(atmosphere ? { atmosphereSummary: atmosphere.summary } : {}),
    };
    const replyArgs = {
      skill,
      history: targetedMemberProfileRequested ? [] : history,
      userInput: normalizedUserInput,
      images: resolvedImages,
      identityContext,
      ...(scenarioInstruction ? { scenarioInstruction } : {}),
    };
    const preparationMs = Date.now() - conversationStartedAt;
    const modelStartedAt = Date.now();

    try {
      let { reply, usedMode, fallbackUsed, visionFallback } = await this.generateReplyWithSelectedModel(groupConfig, { ...replyArgs, signal });
      const rewriteReason = replyPolicy.review(reply, replyPlan, history.filter(turn => turn.role === "assistant").map(turn => turn.content), {
        formatBudget: replyFormatBudget,
        explicitReplyLength: Boolean(explicitReplyLengthPlan),
      });
      if (rewriteReason && !targetedMemberProfileRequested && !reply.messages?.length) {
        const revised = await this.generateReplyWithSelectedModel(groupConfig, { ...replyArgs, signal,
          scenarioInstruction: replyPolicy.rewriteInstruction(scenarioInstruction, rewriteReason, reply.text),
        });
        reply = revised.reply;
        usedMode = revised.usedMode;
        fallbackUsed ||= revised.fallbackUsed;
        visionFallback ||= revised.visionFallback;
      }
      signal?.throwIfAborted();
      if (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId)) return;
      const modelMs = Date.now() - modelStartedAt;
      const resolvedMentionUserIds = await this.resolveMentionUserIds(
        groupConfig.groupId,
        prefixMentionUserIds,
      );
      const terminalMessages = reply.messages?.map((message) => message.trim()).filter(Boolean);
      const keepTerminalMessages = Boolean(
        terminalMessages?.length && (
          skill.id !== "huixian" ||
          // A Huixian reply always passes through the active format budget.
          // Only a user-requested long reply keeps model-authored segments.
          (explicitReplyLengthPlan?.budget.maxTotalChars ?? 0) > 180
        ),
      );
      const rawReplyText = terminalMessages?.length ? terminalMessages.join("\n\n") : reply.text;
      const replyText = keepTerminalMessages
        ? rawReplyText
        : appendRealtimeLookupFooterToReply(
            sanitizeMentionEcho(
              rawReplyText,
              buildSanitizeTargets(messageContext),
              messageContext.plainTextMentionCandidates,
            ),
            skill,
            realtimeLookup,
            replyFormatBudget?.maxTotalChars,
          );
      if (hasConversationReplyEnvelopeMarker([
        reply.text,
        ...(terminalMessages ?? []),
        replyText,
      ].join(""))) {
        throw new ConversationReplyEnvelopeError();
      }
      const controlledMentionIdentities = selectManualIdentitiesForUserIds(
        promptManualIdentities,
        messageContext.interactionTargets
          .filter((target) => target.source !== "alias")
          .map((target) => target.userId)
          .filter((target): target is string => Boolean(target)),
      );
      const controlledMentionUserId =
        !keepTerminalMessages &&
        options.allowControlledMention === true &&
        controlledMentionIdentities.length > 0 &&
        resolvedMentionUserIds.length === 0 &&
        replyMode === "text"
          ? await this.resolveControlledMentionUserId({
              manualIdentities: controlledMentionIdentities,
              signal,
              skill,
              history,
              userInput: normalizedUserInput,
              assistantReply: replyText,
              identityContext: {
                ...identityContext,
                manualIdentities: controlledMentionIdentities,
              },
            })
          : undefined;
      const outgoingMentionUserIds = controlledMentionUserId
        ? [controlledMentionUserId]
        : resolvedMentionUserIds;

      const outgoingMessages = keepTerminalMessages && terminalMessages?.length
        ? terminalMessages
        : formatReplyMessages(skill, replyText, replyFormatBudget);
      if (outgoingMessages.length === 0) {
        throw new Error("Formatted AI reply was empty.");
      }
      if (hasConversationReplyEnvelopeMarker(outgoingMessages.join(""))) {
        throw new ConversationReplyEnvelopeError();
      }

      const receipts = await this.sendTextMessages(
        groupConfig.groupId,
        outgoingMessages,
        outgoingMentionUserIds,
        conversationRoute,
      );
      if (signal?.aborted || (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId))) return;
      const stateSources = orchestration?.sourceMap(causalHistory, ambientGroupContext, messageContext.sourceMessageId ?? "", userId);
      if (stateSources && messageContext.replyContext?.userId && !visualImagePersonQuery) {
        stateSources.set(messageContext.replyContext.messageId, messageContext.replyContext.userId);
      }
      if (stateSources && sourceRowId !== undefined) {
        for (const media of orchestration!.mediaByIds(groupConfig.groupId, contextResolution?.mediaSourceMessageIds ?? [], sourceRowId, excludedContextUsers)) stateSources.set(media.sourceMessageId, media.userId);
      }
      const deliveredReplyText = outgoingMessages.map((message, index) => index === 0 && outgoingMentionUserIds.length
        ? prefixAtMentions(outgoingMentionUserIds, message) : message).join("\n\n");
      const compactReply = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, "");
      await this.persistAssistantContext(conversationRoute, deliveredReplyText, receipts,
        stateSources && conversationRoute ? { value: compactReply(outgoingMessages.join("")) === compactReply(replyText) ? reply.conversationUpdate : undefined,
          route: conversationRoute, sources: stateSources, expectedRevision: conversationState.revision } : undefined);
      if (options.allowNormalChatMeme === true && normalizedUserInput.trim()) {
        await this.maybeSendNormalChatMeme({
          groupConfig,
          userInput: normalizedUserInput,
        });
      }

      const promptSources = {
        causalHistory: replyArgs.history.map((turn) => turn.content).join("\n"),
        explicitReference: replyContextForAi?.text ?? "",
        longTermMemory: groupMemories.map((memory) => memory.content).join("\n"),
        atmosphere: atmosphere?.summary ?? "",
        recentGroupEvidence: formatRecentGroupEvidenceForMetrics(recentGroupEvidence),
        ambientGroupContext: formatRecentGroupEvidenceForMetrics(ambientGroupContext),
        currentInput: normalizedUserInput,
      };

      logInfo("Sent AI reply.", {
        ...memberQueryDiagnostics,
        groupId: groupConfig.groupId,
        skillId: skill.id,
        model: reply.model,
        replyModelMode: usedMode,
        fallbackUsed,
        visionFallback,
        messageCount: outgoingMessages.length,
        preparationMs,
        modelMs,
        totalMs: Date.now() - conversationStartedAt,
        memoryCount: groupMemories.length,
        memberProfileQueryIntent: profileQuestionIntent,
        memberProfileQueryRequested,
        savedAliasStatus: savedAliasResolution.status,
        targetUserIds: evaluationTargetUserIds,
        memorySubjectUserIds: [...memorySubjectUserIds],
        recentGroupEvidenceTriggered,
        recentGroupEvidenceCount: recentGroupEvidence.length,
        recentGroupEvidenceTargetPrivacyOptedOut: targetPrivacyOptedOut,
        ambientGroupContextStatus,
        ambientGroupContextCount: ambientGroupContext.length,
        ambientGroupContextChars,
        promptChars: reply.promptChars ?? 0,
        promptSourceChars: mapTextMetrics(promptSources, (text) => text.length),
        promptSourceTokensEstimated: mapTextMetrics(promptSources, estimateTextTokens),
        realtimeLookupKind: realtimeLookup?.kind,
        realtimeLookupStatus: realtimeLookup?.status,
        realtimeLookupMs,
        inputImageCount: resolvedImages.length,
        imageInspectionUsed: reply.imageInspectionUsed === true,
        reasoningEffort: reply.reasoningEffort,
        knowledgeToolCalls: reply.knowledgeToolCalls ?? [],
        contextScope: conversationRoute ? "causal_branch" : "isolated",
        topicId: conversationRoute?.topicId,
        branchId: conversationRoute?.branchId,
        routeReason: conversationRoute?.routeReason,
      });
    } catch (error) {
      // Worker outbox drafts have not reached QQ yet. Let ConsumerRunner retry
      // the original message instead of publishing a misleading failure reply.
      if (error instanceof CausalContextPersistenceError) {
        throw error;
      }
      // 已取消的任务不发任何回复（计划 §2.3）：用户重触发后旧任务被取消，
      // 它的失败话术如果照发，就会和新消息的回复一起冒出来。
      if (signal?.aborted || (conversationRoute && orchestration && !orchestration.isTaskCurrent(conversationRoute.sourceRowId))) {
        this.metricsAbortedReply();
        logInfo("Skipped failure reply because the task was cancelled.", {
          groupId: groupConfig.groupId,
        });
        return;
      }
      const failureKind = classifyUpstreamFailure({ error });
      logError("Failed to generate AI reply.", {
        groupId: groupConfig.groupId,
        failureKind,
        preparationMs,
        modelMs: Date.now() - modelStartedAt,
        ...memberQueryDiagnostics,
        totalMs: Date.now() - conversationStartedAt,
        memoryCount: groupMemories.length,
        memberProfileQueryIntent: profileQuestionIntent,
        memberProfileQueryRequested,
        savedAliasStatus: savedAliasResolution.status,
        targetUserIds: evaluationTargetUserIds,
        memorySubjectUserIds: [...memorySubjectUserIds],
        realtimeLookupKind: realtimeLookup?.kind,
        realtimeLookupStatus: realtimeLookup?.status,
        realtimeLookupMs,
        error: summarizeAiError(error),
      });
      const failureText = messageForAiFailure(error, failureKind, normalizedUserInput);
      const failureReceipt = await this.sendTextWithContext(groupConfig.groupId, failureText, conversationRoute);
      await this.persistAssistantContext(conversationRoute, failureText, failureReceipt ? [failureReceipt] : []);
    }
  }

  private metricsAbortedReply(): void {
    // Placeholder hook so the worker can count cancelled tasks (#11 cancelled_task_rate).
    this.cancelledReplyHook?.();
  }

  private async resolveRealtimeLookup(
    groupConfig: GroupBotConfig,
    plan: ReplyPlan,
  ): Promise<RealtimeLookupResult | undefined> {
    if (!this.isCapabilityEnabled("realtime_lookup") || !this.realtimeLookupService || groupConfig.onlineLookupEnabled !== true) {
      return undefined;
    }
    if (plan.lookupRequired === false) return undefined;
    const originalKind = detectRealtimeIntent(plan.resolvedInput);
    const text = originalKind === "weather" || originalKind === "stock"
      ? plan.resolvedInput : plan.lookupQuery || plan.resolvedInput;
    const detected = detectRealtimeIntent(text);
    const intent = detected ?? (plan.lookupRequired === true ? "web" : undefined);
    if (!intent) return undefined;

    try {
      const settings = await this.systemSettingsStore?.getInternal();
      if (settings?.onlineLookupEnabled !== true) {
        return undefined;
      }
      const startedAt = Date.now();
      const result = await this.realtimeLookupService.lookup({
        text,
        ...(!detected ? { intent } : {}),
        ...(intent === "web" && plan.lookupSubject ? { lookupSubject: plan.lookupSubject } : {}),
        ...(intent === "web" && plan.lookupFallbackQueries?.length ? { lookupFallbackQueries: plan.lookupFallbackQueries } : {}),
      });
      logInfo("Completed realtime lookup before reply generation.", {
        groupId: groupConfig.groupId,
        trigger: plan.lookupRequired ? "reply_plan" : "keywords",
        kind: intent,
        status: result?.status ?? "skipped",
        durationMs: Date.now() - startedAt,
        resultCount: result?.sources.length ?? 0,
        failureReason: result?.failureReason,
        ...(result?.searchDiagnostics ?? {}),
      });
      return result;
    } catch (error) {
      logWarn("Realtime lookup failed before reply generation.", {
        groupId: groupConfig.groupId,
        error: summarizeAiError(error),
      });
      return {
        kind: intent, status: "unavailable", queriedAt: new Date().toISOString(), sources: [],
        failureReason: "lookup_failed", promptContext: "The requested lookup failed. Do not invent current facts.",
      };
    }
  }

  private async resolveControlledMentionUserId(args: {
    signal?: AbortSignal;
    manualIdentities: NonNullable<GroupBotConfig["manualIdentities"]>;
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: AiIdentityContext;
  }): Promise<string | undefined> {
    if (args.manualIdentities.length === 0) {
      return undefined;
    }

    let decision;
    try {
      const group = await this.groupConfigService.getGroup(args.identityContext.groupId);
      const router = await this.getReplyRouter();
      if (router && group) {
        const session = await router.begin(group, "auxiliary", { signal: args.signal, gate: this.backgroundLlmGate });
        decision = (await session.run((service, signal) => service.evaluateControlledMention({ ...args, signal, throwOnFailure: true }))).value;
      } else decision = await this.aiService.evaluateControlledMention?.({ ...args, signal: args.signal });
    } catch { return undefined; }

    const target = resolveManualIdentityTargetFromDecision(args.manualIdentities, decision);
    if (!target?.userId) {
      return undefined;
    }

    return target.userId;
  }

  private async generateReplyWithSelectedModel(
    groupConfig: GroupBotConfig,
    args: ReplyGenerationArgs,
  ): Promise<ReplyAiResult> {
    const router = await this.getReplyRouter();
    if (router) {
      const session = await router.begin(groupConfig, "chat", { signal: args.signal, vision: Boolean(args.images?.length), gate: this.backgroundLlmGate });
      const result = await session.run((service, signal) => this.generateReplyWithEnvelopeRecovery(service, args, signal));
      return { reply: result.value, usedMode: result.modelId, fallbackUsed: result.fallbackUsed, visionFallback: Boolean(args.images?.length) && result.fallbackUsed };
    }
    const selectedRoute = await this.getReplyAiRoute(groupConfig);
    const hasImages = (args.images?.length ?? 0) > 0;
    let route = selectedRoute;
    let visionFallback = false;

    if (hasImages && !selectedRoute.supportsVision) {
      const options = await this.getReplyModelOptions({ allowEnvironmentFallback: false });
      const gptVisionRoute = options.find((option) => option.mode === "gpt" && option.supportsVision);
      if (!gptVisionRoute) {
        throw new VisionFallbackUnavailableError(selectedRoute.label);
      }
      route = gptVisionRoute;
      visionFallback = true;
      logInfo("Routing image reply through configured GPT vision fallback.", {
        groupId: groupConfig.groupId,
        selectedMode: selectedRoute.mode,
        visionFallbackMode: route.mode,
        inputImageCount: args.images?.length ?? 0,
      });
    }
    const call = async () => this.generateReplyWithEnvelopeRecovery(route.service, args, args.signal);
    const reply = this.llmGate ? await this.llmGate(call, args.signal) : await call();
    return {
      reply,
      usedMode: route.mode,
      fallbackUsed: visionFallback,
      visionFallback,
    };
  }

  /**
   * Real AiService instances parse and repair reply envelopes themselves. This
   * second boundary covers compatibility adapters that hand a raw draft back to
   * BotApplication. Keeping it inside the model-router session lets a second
   * malformed response reach the configured backup model instead of leaking.
   */
  private async generateReplyWithEnvelopeRecovery(
    service: Pick<RuntimeAiService, "generateReply">,
    args: ReplyGenerationArgs,
    signal?: AbortSignal,
  ): Promise<AiReply> {
    const reply = await service.generateReply({ ...args, signal });
    if (!hasPrivateReplyEnvelopeMarker(reply)) return reply;

    const repaired = await service.generateReply({
      ...args,
      signal,
      scenarioInstruction: buildReplyEnvelopeRecoveryInstruction(args.scenarioInstruction),
    });
    if (hasPrivateReplyEnvelopeMarker(repaired)) throw new ConversationReplyEnvelopeError();
    return repaired;
  }

  private async getReplyRouter(): Promise<ReplyModelRouter | undefined> {
    if (!this.systemSettingsStore) return undefined;
    if (!this.usesV3AdminAuthority() && !(await this.systemSettingsStore.get()).models.some(model => model.purpose === "reply")) return undefined;
    return this.replyRouter ??= new ReplyModelRouter(this.systemSettingsStore, this.capabilityPolicy);
  }

  private async canUseRuntimeCommand(command: SystemCommandConfig, group: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<boolean> {
    if (!command.enabled) return false;
    const userId = String(event.user_id);
    const role = await this.isSuperAdmin(group, userId) ? "super_admin" : await this.isAdmin(group, userId, event.sender?.role) ? "group_admin" : "member";
    return permissionAtLeast(role, command.permission);
  }

  private async getReplyAiRoute(groupConfig: GroupBotConfig): Promise<ReplyAiRoute> {
    const settings = await this.systemSettingsStore?.get();
    const mode = effectiveReplyModelId(groupConfig, settings?.selectedModelIds.reply);
    const options = await this.getReplyModelOptions({ allowEnvironmentFallback: true });
    const primary = options.find((option) => option.mode === mode) ?? options.find((option) => option.mode === "gpt") ?? options[0]!;
    return primary;
  }

  private async getReplyModelOptions(options: { allowEnvironmentFallback?: boolean } = {}): Promise<ReplyModelOption[]> {
    if (!this.systemSettingsStore) {
      return [await this.getEnvironmentReplyModelOption()];
    }

    try {
      const settings = await this.systemSettingsStore.get();
      const replyOptions: ReplyModelOption[] = [];
      const existingModes = new Set<string>();
      for (const model of settings.models) {
        if (
          model.purpose !== "reply" ||
          model.enabled !== true ||
          !model.hasApiKey ||
          existingModes.has(model.id)
        ) {
          continue;
        }
        replyOptions.push({
          mode: model.id,
          label: this.formatConfiguredReplyModelLabel(model.id, model.model),
          service: new ConfiguredAiService(
            this.aiService,
            this.systemSettingsStore,
            "reply",
            undefined,
            model.id,
            this.capabilityPolicy,
          ),
          supportsVision: (model.supportsVision === true || (model.supportsVision === undefined && model.id === "gpt")) &&
            this.isProviderFeatureEnabled(model.apiProtocol === "anthropic" ? "anthropic" : "openai", "vision"),
        });
        existingModes.add(model.id);
      }
      if (replyOptions.length === 0 && options.allowEnvironmentFallback) {
        return [await this.getEnvironmentReplyModelOption()];
      }
      return replyOptions;
    } catch (error) {
      logWarn("Failed to load configured reply model options.", {
        error: (error as Error).message,
      });
      if (options.allowEnvironmentFallback) {
        return [await this.getEnvironmentReplyModelOption()];
      }
    }
    return [];
  }

  private async getEnvironmentReplyModelOption(): Promise<ReplyModelOption> {
    return {
      mode: "gpt",
      label: await this.formatReplyModelName("gpt"),
      service: this.aiService,
      supportsVision: this.isProviderFeatureEnabled("openai", "vision"),
    };
  }

  private async formatReplyModelName(mode: ReplyModelMode): Promise<string> {
    const configured = await this.getRuntimeReplyModelLabel(mode) ?? this.replyModelLabels[mode]?.trim();
    if (configured) {
      return this.formatConfiguredReplyModelLabel(mode, configured);
    }
    return "GPT";
  }

  private formatConfiguredReplyModelLabel(mode: ReplyModelMode, name: string): string {
    if (mode === "gpt") return `GPT（${name}）`;
    return `${name}（${mode}）`;
  }

  private async getRuntimeReplyModelLabel(mode: ReplyModelMode): Promise<string | undefined> {
    if (!this.systemSettingsStore) {
      return undefined;
    }
    try {
      const settings = await this.systemSettingsStore.get();
      const model = settings.models.find((item) =>
        item.purpose === "reply" &&
        item.enabled &&
        item.id === mode &&
        item.model.trim()
      );
      return model?.model.trim();
    } catch (error) {
      logWarn("Failed to load runtime reply model label.", {
        mode,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  private async handleModelCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();
    const settings = await this.systemSettingsStore?.get();
    const currentMode = effectiveReplyModelId(groupConfig, settings?.selectedModelIds.reply);
    const options = await this.getReplyModelOptions();
    const currentLabel = options.find((option) => option.mode === currentMode)?.label ?? await this.formatReplyModelName(currentMode);

    if (normalized === MODEL_PREFIX || normalized === `${MODEL_PREFIX}状态` || normalized === `${MODEL_PREFIX} 状态` || normalized === `${MODEL_PREFIX}列表` || normalized === `${MODEL_PREFIX} 列表`) {
      const lines = options.map((option) => {
        const activeMark = option.mode === currentMode ? " [当前]" : "";
        return `- ${option.mode}: ${option.label}${activeMark}`;
      });
      await this.sendText(groupId, `当前群聊回复模型：${currentLabel}\n模型来源：${groupConfig.replyModelSource === "global" ? "跟随统一默认" : "本群指定模型"}\n可用模型：\n${lines.join("\n")}`);
      return;
    }

    const switchRegex = new RegExp(`^${escapeRegex(MODEL_PREFIX)}\\s*(?:切换\\s*)?(.+)$`, "i");
    const match = normalized.match(switchRegex);
    if (!match) {
      await this.sendText(groupId, `模型命令格式：#模型状态 或 #模型切换 <模型ID>\n可用模型：${options.map((option) => option.mode).join("、")}`);
      return;
    }

    if (!(await this.isSuperAdmin(groupConfig, userId))) {
      await this.sendText(groupId, "你没有切换群聊回复模型的权限");
      return;
    }

    const rawTarget = match[1]!.trim();
    if (["跟随", "默认"].includes(rawTarget)) {
      await this.groupConfigService.updateGroupConfig(groupId, { replyModelSource: "global" });
      await this.logAdminOperation(groupId, userId, "回复模型跟随", settings?.selectedModelIds.reply ?? "gpt");
      await this.sendText(groupId, "已恢复跟随统一默认模型");
      return;
    }
    const target = options.find((option) => option.mode.toLowerCase() === rawTarget.toLowerCase());
    if (!target) {
      await this.sendText(groupId, `模型 ${rawTarget} 不在可切换列表中。可用模型：${options.map((option) => option.mode).join("、")}`);
      return;
    }

    const targetMode = target.mode;
    const updated = await this.groupConfigService.updateReplyModelMode(groupId, targetMode);
    await this.logAdminOperation(groupId, userId, "回复模型切换", targetMode, target.label);
    await this.sendText(
      groupId,
      `已切换群聊回复模型：${options.find((option) => option.mode === normalizeReplyModelMode(updated.replyModelMode))?.label ?? target.label}`,
    );
  }

  private async handleMemoryCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    if (!this.isCapabilityEnabled("explicit_memory")) {
      await this.rejectCapability(groupConfig.groupId, "explicit_memory");
      return;
    }
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const suffix = commandText.slice(MEMORY_PREFIX.length).trim();

    if (!suffix || ["状态", "查看"].includes(suffix)) {
    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
        await this.sendText(groupId, MSG_STATUS_NO_PERMISSION);
        return;
      }
      const memories = this.groupMemoryStore ? await this.groupMemoryStore.list(groupId) : [];
      const enabledCount = memories.filter((memory) => memory.enabled).length;
      await this.sendText(
        groupId,
        [
          `群记忆状态：群 ${groupId}`,
          `记忆：${enabledCount}/${memories.length} 条启用`,
          `写入方式：${MEMORY_PREFIX} <内容> 或 @我 请记住 <内容>`,
          `后台：${this.adminPublicBaseUrl ?? "未配置"}`,
        ].join("\n"),
      );
      return;
    }

    const content = stripExplicitMemoryLead(suffix);
    await this.captureExplicitMemory(groupConfig, event, content, "explicit_command");
  }

  private async handleExplicitMemoryRequest(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    content: string,
  ): Promise<void> {
    await this.captureExplicitMemory(groupConfig, event, content, "explicit_request");
  }

  private async captureExplicitMemory(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    content: string,
    source: "explicit_command" | "explicit_request",
  ): Promise<void> {
    if (!this.explicitMemoryService) {
      await this.sendText(groupConfig.groupId, "记忆功能未启用");
      return;
    }

    const userId = String(event.user_id);
    try {
      const result = await this.explicitMemoryService.capture({
        groupId: groupConfig.groupId,
        userId,
        userName: resolveSenderName(event),
        content,
        source,
      }, {
        memoryDisabled: (groupConfig.memoryDisabledUserIds ?? []).includes(userId),
      });
      if (result.status === "created") {
        await this.sendText(groupConfig.groupId, "好，我记下了。之后我会在这个群里按这条信息更好地回应你。");
        return;
      }
      if (result.status === "duplicate") {
        await this.sendText(groupConfig.groupId, "这条我已经记下了，不会重复存一遍。");
        return;
      }
      if (result.status === "disabled") {
        await this.sendText(groupConfig.groupId, "你的记忆收集目前已关闭，所以这条我不会保存。");
        return;
      }
      if (result.status === "unsafe") {
        await this.sendText(groupConfig.groupId, "这类凭据或敏感信息别交给我保存；请放进可信的密码管理器里。 ");
        return;
      }
      await this.sendText(groupConfig.groupId, `记忆内容不能为空。用法：${MEMORY_PREFIX} <内容>`);
    } catch (error) {
      logWarn("Failed to save explicit member memory.", {
        groupId: groupConfig.groupId,
        userId,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendText(groupConfig.groupId, "这条记忆暂时没有保存成功，稍后再试一次。 ");
    }
  }

  private async handleKnowledgeStatusCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    if (!this.isCapabilityEnabled("knowledge")) {
      await this.rejectCapability(groupConfig.groupId, "knowledge");
      return;
    }
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId, event.sender?.role))) {
      await this.sendText(groupId, MSG_STATUS_NO_PERMISSION);
      return;
    }

    const entries = this.knowledgeBaseStore ? await this.knowledgeBaseStore.list(groupId) : [];
    const enabledCount = entries.filter((entry) => entry.enabled).length;
    await this.sendText(
      groupId,
      [
        `知识库状态：群 ${groupId}`,
        `FAQ：${enabledCount}/${entries.length} 条启用`,
        `群 FAQ：${this.knowledgeSourceBindingStore.get("group_faq", groupId)} <问题>`,
        `民营企业榜单：${this.knowledgeSourceBindingStore.get("private_enterprise_ranking")} <问题>`,
        `后台：${this.adminPublicBaseUrl ?? "未配置"}`,
      ].join("\n"),
    );
  }

  private async handleSelectedKnowledgeCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    source: KnowledgeSourceId,
    query: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      const command = this.knowledgeSourceBindingStore.get(source, groupId);
      await this.sendText(groupId, `用法：${command} <查询内容>`);
      return;
    }

    let messages: string[];
    if (source === "private_enterprise_ranking") {
      messages = this.privateEnterpriseRanking?.answerInSelectedSource(trimmedQuery)?.messages ?? [
        "2026中国民营企业500强知识库暂不能解析这个问法；可查询企业名次、榜单名次、省级地区家数或名单。",
      ];
    } else {
      messages = await this.answerCurrentGroupFaq(groupId, trimmedQuery);
    }

    const sourceRowId = this.conversationContextRepository?.getSourceRowId?.(groupId, String(event.message_id));
    const route = sourceRowId !== undefined ? this.conversationContextRouter?.resolve({
      groupId, userId: String(event.user_id), sourceRowId,
      sourceMessageId: String(event.message_id), text: trimmedQuery,
    }) : undefined;
    const receipts = await this.sendTextMessages(groupId, messages, [], route);
    await this.persistAssistantContext(route, messages.join("\n\n"), receipts);
    this.rememberKnowledgeSession(knowledgeContinuationKey(groupId, String(event.user_id)), {
      source,
      query: trimmedQuery,
      reply: messages.join("\n\n"),
      updatedAt: Date.now(),
      branchId: route?.branchId,
    }, String(event.message_id));
  }

  private rememberKnowledgeSession(key: string, session: KnowledgeContinuationSession, sourceMessageId?: string): void {
    // A delayed lookup/list must not revive a source after a newer topic or source switch.
    if (sourceMessageId && this.knowledgeLatestMessages.get(key) === sourceMessageId) {
      this.knowledgeContinuationSessions.set(key, session);
    }
  }

  private async answerCurrentGroupFaq(groupId: string, query: string): Promise<string[]> {
    if (!this.knowledgeBaseStore) return ["当前群知识库暂时不可用，无法核验这项内容。"];
    if (!query.trim() || query.length > 400) return ["群 FAQ 只查询当前群已启用的标准问答，请提供 1 至 400 字的问题或关键词。"];
    try {
      const hits = await this.knowledgeBaseStore.search(groupId, query, 3);
      return hits.length > 0
        ? terminalFaqMessages(hits)
        : ["当前群知识库未找到可核验的相关内容，请换个关键词或联系群管理员补充。"];
    } catch {
      return ["当前群知识库暂时不可用，无法核验这项内容。"];
    }
  }

  private async recordDailyReportMessage(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    parsedMessage: ReturnType<typeof parseGroupMessage>,
  ): Promise<void> {
    if (!this.isCapabilityEnabled("daily_reports") || groupConfig.dailyReportEnabled === false) {
      return;
    }

    const reportText = buildDailyReportMessageText(parsedMessage);
    if (!reportText) {
      return;
    }

    await this.dailyReportService.recordMessage({
      groupId: groupConfig.groupId,
      userId: String(event.user_id),
      userName: resolveSenderName(event),
      text: reportText,
      // Ingress writes a receipt-safe message timestamp into the worker event.
      // Do not replace it with worker processing time: that would let a delayed
      // consumer extend the seven-day raw-message retention period.
      timestamp: toReceiptSafeEventTimestamp(event.time),
    });
  }

  private recordGroupTranscriptMessage(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    parsedMessage: ReturnType<typeof parseGroupMessage>,
    commandText: string,
    runtimeCommands: SystemCommandConfig[],
  ): void {
    if (isRecognizedRuntimeCommand(commandText, runtimeCommands)) {
      return;
    }

    const text = buildGroupTranscriptText(parsedMessage);
    if (!text) {
      return;
    }

    this.groupTranscriptService.addMessage({
      groupId: groupConfig.groupId,
      userId: String(event.user_id),
      messageId: String(event.message_id),
      text,
      senderCard: event.sender?.card,
      senderNickname: event.sender?.nickname,
    });
  }

  private isLiveChatUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return groupConfig.liveChatUserIds.includes(userId);
  }

  private resolveKeywordReplyMentionUserIds(
    speakerUserId: string,
    messageContext: MessageInteractionContext,
  ): string[] {
    const thirdPartyMentionUserIds = messageContext.interactionTargets
      .filter((target) =>
        target.source === "mention" &&
        target.userId &&
        target.userId !== this.botQq &&
        target.userId !== speakerUserId
      )
      .map((target) => target.userId!);

    return thirdPartyMentionUserIds.length > 0
      ? [...new Set(thirdPartyMentionUserIds)]
      : [speakerUserId];
  }

  private isBlacklistedUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return (groupConfig.blacklistedUserIds ?? []).includes(userId);
  }

  private checkAndTriggerRepeat(groupId: string, text: string): boolean {
    const now = Date.now();
    const state = this.groupRepeatStates.get(groupId);
    const nextCount = state && state.text === text && now - state.lastTimestamp <= REPEAT_WINDOW_MS
      ? state.count + 1
      : 1;

    this.groupRepeatStates.set(groupId, {
      text,
      count: nextCount,
      lastTimestamp: now,
    });

    return nextCount === REPEAT_THRESHOLD;
  }

  private async isAdmin(groupConfig: GroupBotConfig, userId: string, senderRole?: string): Promise<boolean> {
    if (this.usesV3AdminAuthority()) {
      if (this.qqAdminAuthorization?.resolve(userId, groupConfig.groupId)) return true;
      if (senderRole === "owner" || senderRole === "admin") return true;
      if (senderRole === "member") return false;
      const member = (await this.safeListGroupMembers(groupConfig.groupId, { refresh: true }))
        .find((item) => String(item.user_id) === userId);
      return member?.role === "owner" || member?.role === "admin";
    }
    if (groupConfig.switcherUserIds.includes(userId)) {
      return true;
    }

    return this.groupConfigService.isSuperAdmin(userId);
  }

  private async isSuperAdmin(groupConfig: GroupBotConfig, userId: string): Promise<boolean> {
    if (this.usesV3AdminAuthority()) {
      return this.qqAdminAuthorization?.resolve(userId, groupConfig.groupId)?.role === "super_admin";
    }
    return this.groupConfigService.isSuperAdmin(userId);
  }

  private usesV3AdminAuthority(): boolean {
    const service = this.groupConfigService as unknown as { isV3Runtime?: () => boolean };
    return service.isV3Runtime?.() === true;
  }

  private async resolveSkill(groupConfig: GroupBotConfig): Promise<SkillDefinition> {
    // Production SkillService only returns huixian. Querying the configured id
    // first keeps compatibility with test and third-party in-memory adapters;
    // any persisted legacy id naturally falls back to huixian in production.
    const configured = await this.skillService.getSkill(groupConfig.currentSkillId);
    if (configured) {
      return configured;
    }
    const huixian = await this.skillService.getSkill("huixian");
    if (huixian) {
      logWarn("Legacy persona configuration fell back to huixian.", {
        groupId: groupConfig.groupId,
        configuredSkillId: groupConfig.currentSkillId,
      });
      return huixian;
    }
    throw new Error("Huixian persona is not available.");
  }

  private async getTransportHealthStatus(): Promise<TransportHealthStatus> {
    if (!this.transport.getHealthStatus) {
      return {
        ok: true,
        detail: "当前传输层未提供连接自检",
      };
    }

    try {
      return await this.transport.getHealthStatus();
    } catch (error) {
      return {
        ok: false,
        detail: `自检失败：${(error as Error).message}`,
      };
    }
  }

  private async safeListGroupMembers(groupId: string, options?: { refresh?: boolean }): Promise<NapcatGroupMember[]> {
    if (!this.transport.listGroupMembers) {
      return [];
    }

    try {
      return await this.transport.listGroupMembers(groupId, options);
    } catch (error) {
      logWarn("Failed to list group members for AI context.", {
        groupId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  private async getEnabledGroupConfigs(): Promise<GroupBotConfig[]> {
    const service = this.groupConfigService as GroupConfigService & {
      getEnabledGroups?: () => Promise<GroupBotConfig[]>;
    };
    if (typeof service.getEnabledGroups === "function") {
      return service.getEnabledGroups();
    }
    const groups = await this.groupConfigService.getAll();
    return groups.filter((group) => group.enabled !== false);
  }

  private async logAdminOperation(
    groupId: string,
    operatorUserId: string,
    action: string,
    target?: string,
    detail?: string,
  ): Promise<void> {
    try {
      const principal = this.qqAdminAuthorization?.resolve(operatorUserId, groupId);
      const platformMember = principal ? undefined : (await this.safeListGroupMembers(groupId, { refresh: true }))
        .find((item) => String(item.user_id) === operatorUserId);
      const operatorAuthority = principal
        ? "account_binding"
        : platformMember?.role === "owner"
          ? "qq_group_owner"
          : platformMember?.role === "admin"
            ? "qq_group_admin"
            : undefined;
      await this.adminOperationLogService.record({
        groupId,
        operatorUserId,
        ...(principal ? {
          operatorAccountId: principal.accountId,
          operatorUsername: principal.username,
          operatorRole: principal.role,
        } : {}),
        ...(operatorAuthority ? { operatorAuthority } : {}),
        action,
        target,
        detail,
      });
    } catch (error) {
      logWarn("Failed to record admin operation.", {
        groupId,
        operatorUserId,
        action,
        error: (error as Error).message,
      });
    }
  }

  private async sendOpsAlertToGroups(args: {
    groups: GroupBotConfig[];
    type: OpsAlertType;
    now: Date;
    message: string;
    ignoreCooldown?: boolean;
  }): Promise<void> {
    if (args.groups.length === 0) {
      return;
    }

    const nowMs = args.now.getTime();
    const lastAlertAt = this.opsAlertState.lastAlertAtByType.get(args.type) ?? 0;
    if (!args.ignoreCooldown && nowMs - lastAlertAt < OPS_ALERT_COOLDOWN_MS) {
      return;
    }

    const textByGroup = new Map<string, string>();
    for (const group of args.groups) {
      textByGroup.set(
        group.groupId,
        `【运维告警】${args.message}`,
      );
    }

    let sentCount = 0;
    for (const [groupId, text] of textByGroup.entries()) {
      try {
        await this.transport.sendGroupMessage(groupId, text);
        this.liveChatService.recordBotActivity(groupId);
        sentCount += 1;
      } catch (error) {
        logWarn("Failed to send ops alert.", {
          groupId,
          type: args.type,
          error: (error as Error).message,
        });
      }
    }

    if (sentCount > 0) {
      this.opsAlertState.lastAlertAtByType.set(args.type, nowMs);
      this.opsAlertState.lastAlertSummary = `${formatLocalDateTime(args.now)} ${args.message}`;
    }
  }

  private async handleSendFailure(error: unknown): Promise<void> {
    this.opsAlertState.consecutiveSendFailures += 1;
    if (
      this.opsAlertState.sendFailureAlertActive ||
      this.opsAlertState.consecutiveSendFailures < SEND_FAILURE_ALERT_THRESHOLD
    ) {
      return;
    }

    this.opsAlertState.sendFailureAlertActive = true;
    const groups = (await this.getEnabledGroupConfigs()).filter((group) => group.opsAlertsEnabled === true);
    await this.sendOpsAlertToGroups({
      groups,
      type: "send-failure",
      now: new Date(),
      message: `消息发送连续失败 ${this.opsAlertState.consecutiveSendFailures} 次，最近错误：${(error as Error).message}`,
    });
  }

  private async handleSendSuccessRecovery(): Promise<void> {
    if (this.opsAlertState.consecutiveSendFailures === 0) {
      return;
    }

    const previousFailures = this.opsAlertState.consecutiveSendFailures;
    const shouldNotifyRecovery = this.opsAlertState.sendFailureAlertActive;
    this.opsAlertState.consecutiveSendFailures = 0;
    this.opsAlertState.sendFailureAlertActive = false;

    if (!shouldNotifyRecovery) {
      return;
    }

    const groups = (await this.getEnabledGroupConfigs()).filter((group) => group.opsAlertsEnabled === true);
    await this.sendOpsAlertToGroups({
      groups,
      type: "send-recovered",
      now: new Date(),
      message: `消息发送已恢复，之前连续失败 ${previousFailures} 次`,
    });
  }

  private async sendText(groupId: string, text: string, replyToMessageId?: string): Promise<MessageReceipt | undefined> {
    try {
      const receipt = await this.transport.sendGroupMessage(groupId, text, replyToMessageId ? { replyToMessageId } : undefined);
      this.liveChatService.recordBotActivity(groupId);
      await this.handleSendSuccessRecovery();
      return receipt ?? undefined;
    } catch (error) {
      await this.handleSendFailure(error);
      throw error;
    }
  }

  /**
   * A blacklist response must stay an isolated image-only action: it cannot
   * reset live-chat timers or emit a recovery notice alongside the meme.
   */
  private async sendBlacklistedAtMeme(groupId: string, imageFile: string): Promise<MessageReceipt | undefined> {
    return (await this.transport.sendGroupImage(groupId, imageFile)) ?? undefined;
  }

  /**
   * Blacklisted @ replies remain fully isolated from normal activity tracking
   * and model work. The legacy asset fallback keeps pre-library embeddings
   * compatible while V3 uses the protected random pool.
   */
  private async maybeSendBlacklistedAtMeme(groupId: string): Promise<void> {
    try {
      const selection = this.memeLibraryService
        ? await this.memeLibraryService.selectBlacklistedAtImage(groupId)
        : { imageFile: await getBlacklistedAtMemeImageFile() };
      if (!selection?.imageFile) {
        return;
      }
      await this.sendBlacklistedAtMeme(groupId, selection.imageFile);
    } catch (error) {
      logWarn("Skipped blacklisted @ meme because the selected asset could not be sent.", {
        groupId,
        error: summarizeAiError(error),
      });
    }
  }

  /**
   * An extra normal-chat image is best effort only. It runs after the primary
   * reply is both sent and persisted, so library/transport failures can
   * never change the conversation response already delivered to the group.
   */
  private async maybeSendNormalChatMeme(args: {
    groupConfig: GroupBotConfig;
    userInput: string;
  }): Promise<void> {
    if (!this.memeLibraryService) {
      return;
    }

    try {
      const result = await this.memeLibraryService.claimNormalChatImage({
        groupId: args.groupConfig.groupId,
        userText: args.userInput,
      });
      const { selection } = result;
      if (!selection?.imageFile) {
        logInfo("Skipped normal chat meme.", {
          groupId: args.groupConfig.groupId,
          reason: result.reason,
          matchedTagIds: result.matchedTagIds,
        });
        return;
      }
      await this.sendNormalChatMeme(args.groupConfig.groupId, selection.imageFile);
      logInfo("Sent normal chat meme.", {
        groupId: args.groupConfig.groupId,
        reason: result.reason,
        matchedTagIds: result.matchedTagIds,
      });
    } catch (error) {
      logWarn("Skipped normal chat meme after primary reply.", {
        groupId: args.groupConfig.groupId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async sendNormalChatMeme(groupId: string, imageFile: string): Promise<MessageReceipt | undefined> {
    const receipt = await this.transport.sendGroupImage(groupId, imageFile);
    this.liveChatService.recordBotActivity(groupId);
    return receipt ?? undefined;
  }

  private async clearUserConversationContext(groupId: string, userId: string): Promise<void> {
    this.knowledgeContinuationSessions.delete(knowledgeContinuationKey(groupId, userId));
    this.knowledgeLatestMessages.delete(knowledgeContinuationKey(groupId, userId));
    this.conversationContextRepository?.clearUser(groupId, userId);
    await this.conversationStore.clearUser(groupId, userId);
  }

  private async clearGroupConversationContext(groupId: string): Promise<void> {
    for (const key of this.knowledgeLatestMessages.keys()) {
      if (key.startsWith(`${groupId}\u0000`)) {
        this.knowledgeLatestMessages.delete(key);
        this.knowledgeContinuationSessions.delete(key);
      }
    }
    this.conversationContextRepository?.clearGroup(groupId);
    await this.conversationStore.clearGroup(groupId);
  }

  private async sendTextMessages(
    groupId: string,
    messages: string[],
    mentionUserIds: string[] = [],
    conversationRoute?: ConversationRoute,
  ): Promise<MessageReceipt[]> {
    // This is the last boundary before individual messages become outbox rows.
    // Check the complete batch before sending the first item so a malformed
    // reply cannot deliver its natural-text prefix and leak state metadata in
    // a later split message.
    if (hasConversationReplyEnvelopeMarker(messages.join(""))) {
      throw new ConversationReplyEnvelopeError();
    }
    const receipts: MessageReceipt[] = [];
    for (const [index, message] of messages.entries()) {
      const outgoingText =
        index === 0 && mentionUserIds.length > 0
          ? prefixAtMentions(mentionUserIds, message)
          : message;
      const receipt = await this.sendTextWithContext(groupId, outgoingText, conversationRoute);
      if (receipt) {
        receipts.push(receipt);
      }

      if (index < messages.length - 1) {
        await sleep(MULTI_MESSAGE_DELAY_MS);
      }
    }
    return receipts;
  }

  private async sendTextWithContext(
    groupId: string,
    text: string,
    route?: ConversationRoute,
  ): Promise<MessageReceipt | undefined> {
    if (!route) {
      return this.sendText(groupId, text);
    }
    if (this.conversationContextRepository?.orchestration && !this.conversationContextRepository.orchestration.isTaskCurrent(route.sourceRowId)) {
      throw new Error("conversation_task_superseded");
    }
    const contextualTransport = this.transport as MessageTransport & {
      runWithConversationContext?<T>(route: ConversationRoute, task: () => Promise<T>): Promise<T>;
      setConversationContext?(route?: ConversationRoute): void;
    };
    if (contextualTransport.runWithConversationContext) {
      return contextualTransport.runWithConversationContext(route, () => this.sendText(groupId, text));
    }
    if (!contextualTransport.setConversationContext) {
      return this.sendText(groupId, text, route.sourceMessageId);
    }
    contextualTransport.setConversationContext(route);
    try {
      return await this.sendText(groupId, text);
    } finally {
      contextualTransport.setConversationContext(undefined);
    }
  }

  private async persistAssistantContext(
    route: ConversationRoute | undefined,
    content: string,
    receipts: MessageReceipt[],
    stateUpdate?: import("./services/conversation-context-repository.js").AppendAssistantTurnInput["stateUpdate"],
  ): Promise<number | undefined> {
    if (!route || !this.conversationContextRepository) {
      return;
    }
    if (this.conversationContextRepository.orchestration && !this.conversationContextRepository.orchestration.isTaskCurrent(route.sourceRowId)) return;
    try {
      const firstReceipt = receipts[0];
      const deliveryIds = receipts.flatMap((receipt) => receipt.deliveryId ? [receipt.deliveryId] : []);
      const turn = this.conversationContextRepository.appendAssistantTurn({
        topicId: route.topicId,
        branchId: route.branchId,
        parentTurnId: route.turnId,
        content,
        createdAt: Date.now(),
        deliveryId: firstReceipt?.deliveryId,
        platformMessageId: firstReceipt?.platformMessageId ?? firstReceipt?.messageId,
        deliveryIds,
        stateUpdate,
      });
      const contextualTransport = this.transport as MessageTransport & {
        bindConversationTurn?(receipts: MessageReceipt[], route: ConversationRoute, turnId: number): void;
      };
      if (deliveryIds.length === 0) {
        contextualTransport.bindConversationTurn?.(receipts, route, turn.id);
      }
      for (const receipt of receipts.slice(1)) {
        const platformMessageId = receipt.platformMessageId ?? receipt.messageId;
        if (platformMessageId) {
          const branch = this.conversationContextRepository.getBranch(route.branchId);
          if (branch) {
            this.conversationContextRepository.bindPlatformMessage({
              groupId: branch.groupId,
              platformMessageId,
              topicId: route.topicId,
              branchId: route.branchId,
              turnId: turn.id,
              direction: "assistant",
              createdAt: Date.now(),
            });
          }
        }
      }
      return turn.id;
    } catch (error) {
      const contextualTransport = this.transport as MessageTransport & {
        discardConversationDrafts?(receipts: MessageReceipt[]): void;
      };
      if (contextualTransport.discardConversationDrafts) {
        contextualTransport.discardConversationDrafts(receipts);
        throw new CausalContextPersistenceError(error);
      }
      logWarn("Failed to persist causal assistant turn.", {
        topicId: route.topicId,
        branchId: route.branchId,
        error: (error as Error).message,
      });
    }
  }

  private async resolveMentionUserIds(groupId: string, candidates: string[]): Promise<string[]> {
    const uniqueCandidates = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
    if (uniqueCandidates.length === 0) {
      return [];
    }

    if (!this.transport.resolveMentionTargets) {
      return uniqueCandidates.filter((candidate) => /^\d+$/.test(candidate));
    }

    try {
      const resolved = await this.transport.resolveMentionTargets(groupId, uniqueCandidates);
      const numericCandidates = uniqueCandidates.filter((candidate) => /^\d+$/.test(candidate));
      return [...new Set([...resolved, ...numericCandidates])];
    } catch (error) {
      logWarn("Failed to resolve mention targets. Falling back to plain reply.", {
        groupId,
        error: (error as Error).message,
        candidateCount: uniqueCandidates.length,
      });
      return uniqueCandidates.filter((candidate) => /^\d+$/.test(candidate));
    }
  }

  private async buildMessageInteractionContext(
    groupConfig: GroupBotConfig,
    parsedMessage: ReturnType<typeof parseGroupMessage>,
    sourceMessageId?: string,
    senderCard?: string,
    senderNickname?: string,
  ): Promise<MessageInteractionContext> {
    const interactionTargets = await this.resolveInteractionTargets(
      groupConfig,
      parsedMessage.verifiedMentionUserIds,
      "mention",
      isMemberIdentityQuerySyntax(parsedMessage.text),
    );
    const replyContext = await this.resolveReplyContext(groupConfig, parsedMessage.replyMessageId);

    // Keep a quoted bot reply as evidence for the current turn, but do not
    // treat the bot itself as a person the model should address.
    if (replyContext && String(replyContext.userId ?? "") !== this.botQq) {
      interactionTargets.push(
        ...buildInteractionTargetsFromReply(groupConfig, replyContext),
      );
    }

    return {
      interactionTargets: dedupeInteractionTargets(interactionTargets),
      ...(parsedMessage.plainTextMentionCandidates.length > 0
        ? { plainTextMentionCandidates: parsedMessage.plainTextMentionCandidates }
        : {}),
      replyContext,
      sourceMessageId,
      replyMessageId: parsedMessage.replyMessageId,
      ...(normalizeIdentityDisplayText(senderCard) ? { senderCard: normalizeIdentityDisplayText(senderCard) } : {}),
      ...(normalizeIdentityDisplayText(senderNickname) ? { senderNickname: normalizeIdentityDisplayText(senderNickname) } : {}),
    };
  }

  private async resolveInteractionTargets(
    groupConfig: GroupBotConfig,
    candidates: string[],
    source: AiInteractionTarget["source"],
    identityOnly = false,
  ): Promise<AiInteractionTarget[]> {
    const uniqueCandidates = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
    if (uniqueCandidates.length === 0) {
      return [];
    }

    const byCandidate = new Map<string, AiInteractionTarget>();
    const unresolved: string[] = [];
    for (const candidate of uniqueCandidates) {
      const manualTarget = resolveManualIdentityTarget(groupConfig, candidate, source);
      if (manualTarget) {
        byCandidate.set(candidate, manualTarget);
      } else if (identityOnly && source === "mention" && /^\d+$/u.test(candidate)) {
        // A real platform @ already carries the account. Fetch its display
        // only in the bounded identity-directory step, not an earlier API call.
        byCandidate.set(candidate, { userId: candidate, names: [], source });
      } else {
        unresolved.push(candidate);
      }
    }

    if (unresolved.length > 0 && this.transport.resolveMemberIdentities) {
      try {
        const memberIdentities = await this.transport.resolveMemberIdentities(groupConfig.groupId, unresolved);
        for (const identity of memberIdentities) {
          const matchedCandidate = unresolved.find((candidate) =>
            !byCandidate.has(candidate) && identityMatchesCandidate(identity, candidate),
          );
          if (!matchedCandidate) {
            continue;
          }

          const manualTarget = resolveManualIdentityTarget(groupConfig, identity.userId, source);
          byCandidate.set(matchedCandidate, manualTarget ?? {
            userId: identity.userId,
            names: normalizeNames(identity.names),
            source,
          });
        }
      } catch (error) {
        logWarn("Failed to resolve interaction target names. Falling back to raw candidates.", {
          groupId: groupConfig.groupId,
          error: (error as Error).message,
          candidateCount: unresolved.length,
        });
      }
    }

    for (const candidate of unresolved) {
      if (byCandidate.has(candidate)) {
        continue;
      }

      const strippedCandidate = stripMentionPrefix(candidate);
      byCandidate.set(
        candidate,
        /^\d+$/.test(strippedCandidate)
          ? { userId: strippedCandidate, names: [strippedCandidate], source }
          : { names: [strippedCandidate], source },
      );
    }

    return [...byCandidate.values()];
  }

  private async resolveImagesWithPipeline(
    groupConfig: GroupBotConfig,
    allImages: MessageImageInput[],
  ): Promise<MessageImageInput[]> {
    if (groupConfig.visionEnabled !== true || allImages.length === 0) {
      return [];
    }
    // When a pipeline is injected (worker), run Stage1 localization; otherwise
    // keep the legacy transport resolution.
    if (this.imagePipeline) {
      try {
        const resolved = await this.imagePipeline.resolveForVision(allImages);
        return resolved.map((image) => ({ ...image.input, url: image.dataUrl }));
      } catch (error) {
        const tier = error instanceof ImagePipelineError ? error.tier : "image_unavailable";
        logWarn("Image stage1 failed; entering failure tier.", {
          groupId: groupConfig.groupId,
          tier,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }
    return this.transport.resolveImageInputs
      ? await this.transport.resolveImageInputs(allImages)
      : allImages.filter((image) => Boolean(image.url));
  }

  private async resolveReplyContext(
    groupConfig: GroupBotConfig,
    replyMessageId?: string,
  ): Promise<AiReplyContext | undefined> {
    if (!replyMessageId) {
      return undefined;
    }

    try {
      const excluded = [...(groupConfig.blacklistedUserIds ?? []), ...(groupConfig.memoryDisabledUserIds ?? [])];
      const store = this.conversationContextRepository?.orchestration;
      if (store?.isReferenceRetracted(groupConfig.groupId, replyMessageId)) return undefined;
      const cacheKey = replyContextCacheKey(groupConfig.groupId, replyMessageId);
      const cached = this.recoveredReplyContexts.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (!cached.context.userId || !excluded.includes(cached.context.userId)) return cached.context;
        this.recoveredReplyContexts.delete(cacheKey);
        return undefined;
      }
      if (cached) this.recoveredReplyContexts.delete(cacheKey);
      const local = store?.reference(groupConfig.groupId, replyMessageId, undefined, excluded);
      const referenced = local ?? await this.transport.getMessage?.(replyMessageId);
      if (!referenced) {
        return undefined;
      }
      if (referenced.groupId && referenced.groupId !== groupConfig.groupId) return undefined;
      if (store && !local && !referenced.groupId && !this.conversationContextRepository?.getMessageContext(groupConfig.groupId, replyMessageId)) return undefined;
      if (referenced.userId && excluded.includes(referenced.userId)) return undefined;

      const manualTarget = referenced.userId
        ? resolveManualIdentityTarget(groupConfig, referenced.userId, "reply")
        : undefined;
      const primaryName =
        manualTarget?.names[0] ?? referenced.userName ?? referenced.userId;

      const context = {
        messageId: referenced.messageId,
        userId: referenced.userId,
        userName: primaryName,
        text: buildReferencedMessageText(referenced),
        images: referenced.images,
      };
      this.cacheRecoveredReplyContext(cacheKey, context);
      return context;
    } catch (error) {
      logWarn("Failed to load referenced message context.", {
        groupId: groupConfig.groupId,
        replyMessageId,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  private cacheRecoveredReplyContext(cacheKey: string, context: AiReplyContext): void {
    const now = Date.now();
    for (const [key, value] of this.recoveredReplyContexts) {
      if (value.expiresAt <= now) this.recoveredReplyContexts.delete(key);
    }
    while (this.recoveredReplyContexts.size >= MAX_RECOVERED_REPLY_CONTEXTS) {
      const oldest = this.recoveredReplyContexts.keys().next().value;
      if (oldest === undefined) break;
      this.recoveredReplyContexts.delete(oldest);
    }
    this.recoveredReplyContexts.set(cacheKey, { context, expiresAt: now + RECOVERED_REPLY_CONTEXT_TTL_MS });
  }

}

function resolveRecentClusterRoute(
  repository: ConversationContextRepository,
  groupId: string,
  userId: string,
  messageIds: string[],
): NonNullable<ConversationRouteInput["resolvedContext"]> | undefined {
  const contexts = messageIds.flatMap(messageId => {
    const context = repository.getMessageContext(groupId, messageId);
    return context ? [context] : [];
  });
  const topicIds = new Set(contexts.map(context => context.topicId));
  // Interleaved known branches are ambiguous. Preserve the recent-cluster
  // evidence, but do not silently attach the new message to either branch.
  if (topicIds.size !== 1) return undefined;
  const anchor = [...contexts].reverse().find(context => context.direction === "assistant" && context.turnId !== undefined)
    ?? [...contexts].reverse().find(context => context.turnId !== undefined);
  if (!anchor) return undefined;
  const branch = repository.getBranch(anchor.branchId);
  if (!branch || branch.groupId !== groupId || branch.topicId !== anchor.topicId) return undefined;
  if (branch.ownerUserId !== userId || anchor.turnId === undefined) {
    return { topicId: anchor.topicId };
  }
  return { topicId: anchor.topicId, branchId: anchor.branchId, parentTurnId: anchor.turnId };
}

function uniqueConversationImages(images: MessageImageInput[]): MessageImageInput[] {
  return [...new Map(images.map(image => [image.file || image.url || JSON.stringify(image), image])).values()].slice(0, 6);
}

function extractCommandText(message: NapcatGroupMessageEvent["message"]): string {
  if (typeof message === "string") {
    return message.trim();
  }

  return message
    .map((segment) => {
      if (typeof segment === "string") {
        return segment;
      }
      if (segment.type === "text") {
        return segment.data?.text ?? "";
      }
      return "";
    })
    .join(" ")
    .trim();
}

function extractRepeatableText(message: NapcatGroupMessageEvent["message"], botQq: string): string | undefined {
  const parsedMessage = parseGroupMessage(message, botQq);
  if (parsedMessage.hasAtBot) {
    return undefined;
  }

  const text = extractCommandText(message);
  if (!text || text.startsWith("#")) {
    return undefined;
  }
  return text;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readRuntimeCommands(store?: SystemSettingsStore): Promise<SystemCommandConfig[]> {
  if (!store) {
    return [];
  }
  try {
    return (await store.get()).commands;
  } catch (error) {
    logWarn("Failed to read runtime command settings, using built-in commands.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function matchRuntimeCommand(
  commandText: string,
  commands: SystemCommandConfig[],
  commandId: RuntimeCommandId,
): RuntimeCommandMatch | undefined {
  const spec = RUNTIME_COMMAND_SPECS[commandId];
  const configured = commands.find((command) => command.id === commandId);
  if (configured?.enabled === false) {
    return undefined;
  }

  if (commandId === "bt_search") {
    const match = matchBtCommand(commandText, commands);
    return match?.enabled ? { matchedPrefix: match.primary, suffix: match.suffix, rewrittenText: `${BT_COMMAND_PRIMARY} ${match.suffix}`.trim() } : undefined;
  }

  if (commandId === "mute") {
    return matchMuteRuntimeCommand(commandText, configured);
  }

  const prefixes = configured
    ? [configured.primary, ...configured.aliases]
    : [spec.builtinPrefix, ...spec.builtinAliases];
  return matchCommandPrefix(commandText, normalizeCommandPrefixes(prefixes), spec.builtinPrefix);
}

function isRuntimeCommandEnabled(commands: SystemCommandConfig[], commandId: RuntimeCommandId): boolean {
  const configured = commands.find((command) => command.id === commandId);
  return configured?.enabled !== false;
}

function runtimeCommandPrimary(commands: SystemCommandConfig[], commandId: RuntimeCommandId): string {
  const configured = commands.find((command) => command.id === commandId);
  return configured?.primary?.trim() || RUNTIME_COMMAND_SPECS[commandId].builtinPrefix;
}

function normalizeCommandPrefixes(prefixes: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const prefix of prefixes) {
    const value = prefix.replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized.sort((left, right) => right.length - left.length);
}

function matchCommandPrefix(
  commandText: string,
  prefixes: string[],
  builtinPrefix: string,
): RuntimeCommandMatch | undefined {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  for (const prefix of prefixes) {
    if (normalized === prefix) {
      return { matchedPrefix: prefix, suffix: "", rewrittenText: builtinPrefix };
    }
    if (normalized.startsWith(`${prefix} `)) {
      const suffix = normalized.slice(prefix.length).trim();
      return {
        matchedPrefix: prefix,
        suffix,
        rewrittenText: `${builtinPrefix} ${suffix}`.trim(),
      };
    }
    if (prefix.startsWith("#") && normalized.startsWith(prefix) && normalized.length > prefix.length) {
      const nextChar = normalized[prefix.length];
      if (nextChar && !nextChar.startsWith("#")) {
        const suffix = normalized.slice(prefix.length).trim();
        return {
          matchedPrefix: prefix,
          suffix,
          rewrittenText: `${builtinPrefix}${suffix}`.trim(),
        };
      }
    }
  }

  return undefined;
}

function matchMuteRuntimeCommand(commandText: string, configured?: SystemCommandConfig): RuntimeCommandMatch | undefined {
  const mutePrefixes = normalizeCommandPrefixes([configured?.primary ?? MUTE_COMMAND]);
  const unmutePrefixes = normalizeCommandPrefixes(configured ? configured.aliases : [UNMUTE_COMMAND]);
  return matchCommandPrefix(commandText, mutePrefixes, MUTE_COMMAND)
    ?? matchCommandPrefix(commandText, unmutePrefixes, UNMUTE_COMMAND);
}

function isRetiredPersonaCommand(commandText: string): boolean {
  return /^(?:#技能|#人格|#角色)(?:\s|$)/u.test(commandText.trim());
}

function extractQqFromInput(input: string): string {
  return input.trim().replace(/\D/g, "");
}

function extractFirstAtUserId(message: NapcatGroupMessageEvent["message"], botQq: string): string | undefined {
  if (typeof message === "string") {
    const match = message.match(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/i);
    const userId = match?.[1];
    return userId && userId !== botQq ? userId : undefined;
  }

  for (const segment of message) {
    if (typeof segment === "string") {
      continue;
    }

    if (segment.type !== "at") {
      continue;
    }

    const userId = String(segment.data?.qq ?? "").trim();
    if (userId && userId !== botQq) {
      return userId;
    }
  }

  return undefined;
}

function buildBufferedInteractionContext(messages: BufferedMessage[]): MessageInteractionContext {
  const interactionTargets = messages.flatMap((message) => message.interactionTargets ?? []);
  const latestContextMessage = [...messages].reverse().find((message) =>
    message.replyContext || message.replyMessageId || message.sourceMessageId,
  );
  const replyContext = latestContextMessage?.replyContext;

  return {
    interactionTargets: dedupeInteractionTargets(interactionTargets),
    replyContext,
    sourceMessageId: latestContextMessage?.sourceMessageId,
    replyMessageId: latestContextMessage?.replyMessageId,
  };
}

function buildCurrentSpeaker(
  groupConfig: GroupBotConfig,
  userId: string,
  messageContext: MessageInteractionContext,
): NonNullable<AiIdentityContext["currentSpeaker"]> {
  const manualName = findUniqueManualIdentity(groupConfig, userId)?.names[0];
  const senderCard = normalizeIdentityDisplayText(messageContext.senderCard);
  const senderNickname = normalizeIdentityDisplayText(messageContext.senderNickname);
  return {
    ...(manualName ? { manualName } : {}),
    ...(senderCard ? { senderCard } : {}),
    ...(senderNickname ? { senderNickname } : {}),
  };
}

function normalizeIdentityDisplayText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

function formatBufferedMessages(messages: BufferedMessage[]): string {
  if (messages.length === 1) {
    return formatBufferedMessage(messages[0]!);
  }

  return messages
    .map((message, index) => `${index + 1}. ${formatBufferedMessage(message)}`)
    .join("\n");
}

function formatBufferedMessage(message: BufferedMessage): string {
  return message.text;
}

function prefixAtMentions(userIds: string[], message: string): string {
  const prefix = userIds.map((userId) => `[CQ:at,qq=${userId}]`).join(" ");
  const normalized = message.trim();
  return normalized ? `${prefix} ${normalized}` : prefix;
}

function sanitizeMentionEcho(
  text: string,
  targets: AiInteractionTarget[],
  plainTextMentionCandidates: readonly string[] = [],
): string {
  let sanitized = text;
  const authoritativeCandidates = new Set(
    targets.flatMap((target) => [target.userId, ...target.names])
      .map((candidate) => normalizeIdentityCandidate(candidate ?? ""))
      .filter(Boolean),
  );

  for (const target of targets) {
    const replacement = getTargetDisplayName(target);
    if (target.userId) {
      const escapedUserId = escapeRegex(target.userId);
      sanitized = sanitized
        .replace(new RegExp(`\\[CQ:at,qq=${escapedUserId}(?:,[^\\]]*)?\\]`, "gi"), replacement)
        .replace(new RegExp(`@${escapedUserId}(?!\\d)`, "g"), replacement);
    }

    for (const name of target.names) {
      const normalizedName = stripMentionPrefix(name);
      if (!normalizedName || /^\d+$/.test(normalizedName)) {
        continue;
      }

      const escapedName = escapeRegex(normalizedName);
      sanitized = sanitized.replace(new RegExp(`@${escapedName}`, "g"), normalizedName);
    }
  }

  // This is cosmetic output hygiene only. A QQ number or name typed into a
  // normal text segment never reaches interactionTargets, the prompt identity
  // context, or prefixAtMentions. It merely prevents the model from echoing a
  // literal `@` that can be confusing to readers.
  for (const rawCandidate of plainTextMentionCandidates) {
    const candidate = stripMentionPrefix(rawCandidate);
    const normalizedCandidate = normalizeIdentityCandidate(candidate);
    if (!candidate || authoritativeCandidates.has(normalizedCandidate)) {
      continue;
    }
    const escapedCandidate = escapeRegex(candidate);
    sanitized = sanitized
      .replace(new RegExp(`\\[CQ:at,qq=${escapedCandidate}(?:,[^\\]]*)?\\]`, "gi"), candidate)
      .replace(new RegExp(`@${escapedCandidate}(?![\\p{L}\\p{N}_])`, "gu"), candidate);
  }

  return sanitized
    .replace(/\s+/g, " ")
    .replace(/[ \t]+([，。！？；,.!?;:])/g, "$1")
    .trim();
}

function buildSanitizeTargets(context: MessageInteractionContext): AiInteractionTarget[] {
  return dedupeInteractionTargets(context.interactionTargets);
}

function buildInteractionTargetsFromReply(
  groupConfig: GroupBotConfig,
  replyContext: AiReplyContext,
): AiInteractionTarget[] {
  if (replyContext.userId) {
    const manualTarget = resolveManualIdentityTarget(groupConfig, replyContext.userId, "reply");
    return [
      manualTarget ?? {
        userId: replyContext.userId,
        names: normalizeNames([replyContext.userName, replyContext.userId]),
        source: "reply",
      },
    ];
  }

  if (replyContext.userName) {
    return [{ names: [replyContext.userName], source: "reply" }];
  }

  return [];
}

function resolveManualIdentityTarget(
  groupConfig: GroupBotConfig,
  candidate: string,
  source: AiInteractionTarget["source"],
): AiInteractionTarget | undefined {
  const normalizedCandidate = normalizeIdentityCandidate(candidate);
  if (!normalizedCandidate) {
    return undefined;
  }

  const identities = groupConfig.manualIdentities?.filter((item) => {
    const ids = item.userIds.map(normalizeIdentityCandidate);
    const names = item.names.map(normalizeIdentityCandidate);
    return ids.includes(normalizedCandidate) || names.includes(normalizedCandidate);
  }) ?? [];
  const identity = identities.length === 1 ? identities[0] : undefined;

  if (!identity) {
    return undefined;
  }

  return {
    userId: identity.userIds[0],
    names: normalizeNames(identity.names),
    source,
  };
}

function findUniqueManualIdentity(
  groupConfig: GroupBotConfig,
  userId: string,
): NonNullable<GroupBotConfig["manualIdentities"]>[number] | undefined {
  const matches = groupConfig.manualIdentities?.filter((identity) => identity.userIds.includes(userId)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveManualIdentityTargetFromDecision(
  identities: GroupBotConfig["manualIdentities"],
  decision?: ControlledMentionDecision,
): AiInteractionTarget | undefined {
  const target = decision?.target?.trim();
  if (!decision?.shouldMention || !target) {
    return undefined;
  }

  const matches =
    identities?.filter((identity) => {
      const candidates = [...identity.userIds, ...identity.names].map(normalizeIdentityCandidate);
      return candidates.includes(normalizeIdentityCandidate(target));
    }) ?? [];

  if (matches.length !== 1) {
    return undefined;
  }

  const identity = matches[0]!;
  return {
    userId: identity.userIds[0],
    names: normalizeNames(identity.names),
    source: "mention",
  };
}

function identityMatchesCandidate(identity: GroupMemberIdentity, candidate: string): boolean {
  const normalizedCandidate = normalizeIdentityCandidate(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  return (
    normalizeIdentityCandidate(identity.userId) === normalizedCandidate ||
    identity.names.some((name) => normalizeIdentityCandidate(name) === normalizedCandidate)
  );
}

function dedupeInteractionTargets(targets: AiInteractionTarget[]): AiInteractionTarget[] {
  const byKey = new Map<string, AiInteractionTarget>();

  for (const target of targets) {
    const names = normalizeNames(target.names);
    const key = target.userId ? `${target.source}:${target.userId}` : `${target.source}:${names[0] ?? ""}`;
    if (!key.endsWith(":")) {
      byKey.set(key, {
        ...target,
        names,
      });
    }
  }

  return [...byKey.values()];
}

function normalizeNames(names: Array<string | undefined>): string[] {
  return [...new Set(names.map((name) => name?.trim()).filter((name): name is string => Boolean(name)))];
}

function stripMentionPrefix(value: string): string {
  return value.replace(/^@+/, "").trim();
}

function normalizeIdentityCandidate(value: string): string {
  return stripMentionPrefix(value)
    .toLowerCase()
    .replace(/^[\s,，:：;；。.!！?？、"'`()[\]（）【】<>《》]+|[\s,，:：;；。.!！?？、"'`()[\]（）【】<>《》]+$/g, "")
    .replace(/\s+/g, "");
}

function getTargetDisplayName(target: AiInteractionTarget): string {
  return normalizeNames(target.names)[0] ?? target.userId ?? "";
}

function buildReferencedMessageText(message: ReferencedMessage): string {
  const text = message.text.trim();
  if (text && message.images.length > 0) {
    return `${text} [图片 ${message.images.length} 张]`;
  }

  if (text) {
    return text;
  }

  if (message.images.length > 0) {
    return message.images.length > 1 ? `[图片消息 ${message.images.length} 张]` : "[图片消息]";
  }

  return "";
}

function buildDailyReportMessageText(
  parsedMessage: ReturnType<typeof parseGroupMessage>,
): string {
  const text = parsedMessage.text.trim();

  if (text && parsedMessage.images.length > 0) {
    return `${text} [附图 ${parsedMessage.images.length} 张]`;
  }

  if (text) {
    return text;
  }

  if (parsedMessage.images.length > 0) {
    return parsedMessage.images.length > 1 ? `[图片消息 ${parsedMessage.images.length} 张]` : "[图片消息]";
  }

  return "";
}

function resolveSenderName(event: NapcatGroupMessageEvent): string {
  const card = event.sender?.card?.trim();
  if (card) {
    return card;
  }

  const nickname = event.sender?.nickname?.trim();
  if (nickname) {
    return nickname;
  }

  return String(event.user_id);
}

function toReceiptSafeEventTimestamp(eventTimeSeconds: unknown, receivedAtMs = Date.now()): string {
  const seconds = typeof eventTimeSeconds === "number" ? eventTimeSeconds : Number(eventTimeSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date(receivedAtMs).toISOString();
  }

  const eventTimeMs = Math.trunc(seconds * 1_000);
  if (!Number.isSafeInteger(eventTimeMs)) {
    return new Date(receivedAtMs).toISOString();
  }

  // Worker events already carry ingress-normalized time. The additional clamp
  // protects the legacy direct runtime from a future OneBot timestamp too.
  return new Date(Math.min(eventTimeMs, receivedAtMs)).toISOString();
}

function formatClockTime(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function formatLocalDateTime(date: Date): string {
  return [
    `${date.getMonth() + 1}`.padStart(2, "0"),
    "-",
    `${date.getDate()}`.padStart(2, "0"),
    " ",
    formatClockTime(date),
  ].join("");
}

function getMemoryStatus(): { total: number; used: number; percent: number } {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return { total, used, percent };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}天`);
  }
  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}分钟`);
  }
  if (parts.length === 0) {
    parts.push(`${remainingSeconds}秒`);
  }

  return parts.join("");
}

function buildFeatureListMessage(
  commandText = "",
  commands: SystemCommandConfig[] = [],
  includeImageGeneration = false,
  hiddenIds = new Set<string>(),
): string {
  const topic = parseHelpTopic(commandText);
  const helper = createCommandHelpFormatter(commands);
  const sections = buildHelpSections(helper, includeImageGeneration).filter(section => !section.commandId || !hiddenIds.has(section.commandId));

  if (!topic) {
    return buildHelpOverviewMessage(sections, helper, includeImageGeneration, hiddenIds);
  }

  const matchedSection = sections.find((section) => section.aliases.includes(topic));
  if (!matchedSection) {
    return [
      `没找到“${topic}”这个帮助分类`,
      "",
      `可用分类：${sections.map((section) => section.title).join("、")}`,
      `示例：${helper("help")} 技能`,
      "",
      buildHelpOverviewMessage(sections, helper, includeImageGeneration, hiddenIds),
    ].join("\n");
  }

  return [
    `帮助分类：${matchedSection.title}`,
    ...matchedSection.lines,
    "",
    `更多帮助：${helper("help", { includeAliases: true }).join(" / ")}`,
  ].join("\n");
}

function parseHelpTopic(commandText: string): string | null {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const matchedPrefix = HELP_PREFIXES.find((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
  if (!matchedPrefix) {
    return null;
  }

  const suffix = normalized.slice(matchedPrefix.length).trim();
  if (!suffix || ["列表", "查看", "全部"].includes(suffix)) {
    return null;
  }

  return suffix.toLowerCase();
}

type HelpSection = {
  commandId?: RuntimeCommandId;
  title: string;
  aliases: string[];
  lines: string[];
};

function buildHelpSections(command: CommandHelpFormatter, includeImageGeneration: boolean): HelpSection[] {
  return [
    {
      commandId: "bt_search", title: "BT 搜索", aliases: ["bt", "资源", "bt搜索", "资源搜索"],
      lines: [`${command("bt_search")} <关键词> [anime|movie|adult]`,
        "默认完整搜索，前 5 条合并为一张转发卡片；--fast 加速，--full 展开分站详情。",
        "支持 --source、--timeout、--limit、--no-cache、--no-deep、--json、--debug。"],
    },
    {
      commandId: "conversation", title: "对话",
      aliases: ["对话", "聊天", "chat"],
      lines: [
        "1. @机器人 <内容>",
        `2. ${command("conversation")} 清空`,
        `3. ${command("conversation")} 清空 <QQ号> / 全部`,
        `4. ${command("conversation", { alias: CLEAR_GROUP_CONTEXT_COMMAND })}`,
        "作用：使用当前 skill 进行文本对话，或清空当前群上下文",
        `说明：普通群消息不会触发，必须 @机器人；${command("conversation", { alias: CLEAR_GROUP_CONTEXT_COMMAND })} 需要群管理员或超级管理员`,
      ],
    },
    ...(includeImageGeneration ? [{
      commandId: "image_generation" as const, title: "画图",
      aliases: ["画图", "生图", "image"],
      lines: [
        `1. ${command("image_generation")} <提示词>`,
        `2. ${command("image_generation", { alias: "#生图" })} <提示词>`,
        "作用：根据文字提示生成一张图片，使用权限由后台指令设置控制",
        `限制：提示词最多 ${IMAGE_GENERATION_MAX_PROMPT_CHARS} 字；成功生成后冷却 60 秒`,
      ],
    }] : []),
    {
      commandId: "live_chat", title: "实时对话",
      aliases: ["实时对话", "实时", "live", "livechat"],
      lines: [
        `1. ${command("live_chat")} 列表`,
        `2. ${command("live_chat")} 添加 <QQ号>`,
        `3. ${command("live_chat")} 移除 <QQ号>`,
        `4. ${command("live_chat")} 间隔 <分钟>`,
      ],
    },
    {
      commandId: "scheduled_reminder", title: "定时任务",
      aliases: ["定时任务", "提醒", "reminder"],
      lines: [
        "1. @机器人 设置定时任务一个小时提醒群友喝水",
        `2. ${command("scheduled_reminder")} 列表`,
        `3. ${command("scheduled_reminder")} 添加 每小时提醒群友喝水`,
        `4. ${command("scheduled_reminder")} 修改 <任务ID> 每30分钟提醒群友喝水`,
        `5. ${command("scheduled_reminder")} 删除 <任务ID>`,
        `6. ${command("scheduled_reminder")} 状态 / 开启 / 关闭`,
        "作用：按固定间隔在当前群发送提醒，每次尽量换不同说法",
        "限制：定时任务仅在工作日 9:00-18:00 范围内触发",
      ],
    },
    {
      commandId: "daily_report", title: "日报",
      aliases: ["日报", "report"],
      lines: [
        `1. ${command("daily_report")} 状态`,
        `2. ${command("daily_report")} 发送`,
        `3. ${command("daily_report")} 开启 / 关闭`,
        `4. ${command("daily_report")} 时间 <HH:mm>`,
      ],
    },
    {
      commandId: "holiday_countdown", title: "节假日",
      aliases: ["节假日", "假日", "holiday"],
      lines: [
        `1. ${command("holiday_countdown")}`,
        `2. ${command("holiday_countdown")} 状态`,
        `3. ${command("holiday_countdown")} 发送`,
        `4. ${command("holiday_countdown")} 开启 / 关闭 / 时间 <HH:mm>`,
      ],
    },
    {
      commandId: "model", title: "模型", aliases: ["模型", "model"],
      lines: [`${command("model")} 状态 / 列表`, `超级管理员：${command("model")} 切换 <模型ID> / 跟随`],
    },
    {
      title: "权限",
      aliases: ["权限", "auth", "permission"],
      lines: [
        "普通成员：可用对话、帮助和部分状态查询",
        "群内权限优先由后台账号绑定决定；未绑定时，群主和群管理员自动获得本群管理权限",
        "共享群密码和 #管理员 已退休",
      ],
    },
  ];
}

function buildHelpOverviewMessage(
  sections: HelpSection[],
  command: CommandHelpFormatter,
  includeImageGeneration: boolean,
  hiddenIds: Set<string>,
): string {
  const show = (id: RuntimeCommandId, text: string): string[] => hiddenIds.has(id) ? [] : [text];
  const features = [
    ...show("conversation", "对话：群里 @机器人 可触发当前 skill 对话，支持图片理解"),
    ...show("bt_search", `资源搜索：${command("bt_search", { includeAliases: true }).join(" / ")} <关键词> [anime|movie|adult]（所有成员，无需 @）`),
    ...(includeImageGeneration ? [`画图：${command("image_generation")} <提示词>`] : []),
    ...show("live_chat", `实时对话：${command("live_chat")} 列表、添加、移除、间隔 <分钟>`),
    ...show("scheduled_reminder", `定时任务：${command("scheduled_reminder")} 列表、添加、修改、删除、状态、开启、关闭`),
    ...show("daily_report", `日报：${command("daily_report")} 状态、发送、开启、关闭、时间 <HH:mm>`),
    ...show("holiday_countdown", `节假日：${command("holiday_countdown")}、状态、发送、开启、关闭、时间 <HH:mm>`),
    ...show("model", `模型：${command("model")} 状态 / 列表（切换仅限超级管理员）`),
    ...(["status", "health", "server", "ops_alert", "operation_log"] as RuntimeCommandId[]).filter(id => !hiddenIds.has(id)).map(id => `管理状态：${command(id)}`),
    ...show("mute", `闭嘴：${command("mute", { includeAliases: true }).join(" / ")}（已授权后台管理员）`),
    ...show("blacklist", `黑名单：${command("blacklist")} <QQ号>、${command("blacklist")} 解除 <QQ号>`),
    ...show("help", `帮助：${command("help", { includeAliases: true }).join("、")} 都能调出本列表`),
  ];
  return [
    "系统功能总览：",
    ...features.map((feature, index) => `${index + 1}. ${feature}`),
    `分类帮助：${command("help")} ${sections.map((section) => section.title).join(" / ")}`,
    "定时任务限制：仅在工作日 9:00-18:00 范围内触发",
    "权限说明：后台账号绑定优先；未绑定时，群主和群管理员自动拥有当前群的管理指令权限",
    `提示：${command("help", { includeAliases: true }).join(" / ")} 只会回帮助信息，不会主动触发日报或节假日发送`,
    `可用分类：${sections.map((section) => section.title).join("、")}`,
  ].join("\n");
}

type CommandHelpFormatter = {
  (commandId: RuntimeCommandId, options?: { alias?: string }): string;
  (commandId: RuntimeCommandId, options: { includeAliases: true }): string[];
};

function createCommandHelpFormatter(commands: SystemCommandConfig[]): CommandHelpFormatter {
  return ((commandId: RuntimeCommandId, options?: { alias?: string; includeAliases?: true }) => {
    const configured = commands.find((command) => command.id === commandId);
    const spec = RUNTIME_COMMAND_SPECS[commandId];
    const primary = configured?.primary?.trim() || spec.builtinPrefix;
    const builtinAliases = [...spec.builtinAliases];
    const aliases = normalizeCommandPrefixes(configured ? configured.aliases : builtinAliases);

    if (options?.includeAliases) {
      return normalizeCommandPrefixes([primary, ...aliases]);
    }

    if (options?.alias && aliases.includes(options.alias)) {
      return options.alias;
    }

    if (options?.alias && builtinAliases.includes(options.alias)) {
      return options.alias;
    }

    return primary;
  }) as CommandHelpFormatter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function allowsSelectedMemberParticipation(groupConfig: GroupBotConfig): boolean {
  return groupConfig.participationMode === "selected_members";
}

function getLiveChatDelaySeconds(groupConfig: GroupBotConfig): number {
  if (
    typeof groupConfig.liveChatDelaySeconds === "number" &&
    Number.isFinite(groupConfig.liveChatDelaySeconds) &&
    groupConfig.liveChatDelaySeconds > 0
  ) {
    return groupConfig.liveChatDelaySeconds;
  }

  return (groupConfig.liveChatDelayMinutes ?? 5) * 60;
}

function getActiveChatUserIds(groupConfig: GroupBotConfig): string[] {
  return Array.from(new Set(groupConfig.liveChatUserIds));
}

function collectMemoryIdentityTerms(groupConfig: GroupBotConfig, userIds: string[]): string[] {
  const wantedUserIds = new Set(userIds.filter(Boolean));
  return (groupConfig.manualIdentities ?? [])
    .filter((identity) => identity.userIds.some((userId) => wantedUserIds.has(userId)))
    .flatMap((identity) => identity.names)
    .map((name) => name.trim())
    .filter((name) => name.length >= 2);
}

type ReplyOutputMode = "text";

type SavedAliasEvaluationResolution =
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "resolved"; target: AiInteractionTarget };

function collectEvaluationTargetUserIds(targets: AiInteractionTarget[], botQq: string): string[] {
  return [...new Set(
    targets
      .map((target) => target.userId?.trim())
      .filter((target): target is string => Boolean(target) && target !== botQq),
  )];
}

function resolveSavedAliasEvaluationTarget(
  groupConfig: GroupBotConfig,
  text: string,
): SavedAliasEvaluationResolution {
  const normalizedText = normalizeSavedAliasMatchText(text);
  if (!normalizedText) return { status: "none" };

  const matches: Array<{
    start: number;
    end: number;
    aliasLength: number;
    userIds: string[];
    names: string[];
  }> = [];
  for (const identity of groupConfig.manualIdentities ?? []) {
    const userIds = [...new Set(identity.userIds.map((userId) => userId.trim()).filter((userId) => /^\d+$/.test(userId)))];
    if (userIds.length === 0) continue;
    for (const rawAlias of identity.names) {
      const alias = normalizeSavedAliasMatchText(rawAlias);
      const aliasLength = Array.from(alias).length;
      if (aliasLength < 2 || /^\d+$/.test(alias)) continue;

      let start = normalizedText.indexOf(alias);
      while (start >= 0) {
        matches.push({
          start,
          end: start + alias.length,
          aliasLength,
          userIds,
          names: normalizeNames(identity.names),
        });
        start = normalizedText.indexOf(alias, start + alias.length);
      }
    }
  }

  if (matches.length === 0) return { status: "none" };

  const longestMatches = matches.filter((match) => !matches.some((candidate) =>
    candidate.aliasLength > match.aliasLength &&
    candidate.start <= match.start &&
    candidate.end >= match.end
  ));
  // A shorter alias embedded in a longer, uniquely mapped name must not
  // make the longer match ambiguous. Resolve ambiguity only after longest
  // match selection, and never guess between multiple QQ accounts.
  if (longestMatches.some((match) => match.userIds.length !== 1)) return { status: "ambiguous" };
  const byUserId = new Map<string, AiInteractionTarget>();
  for (const match of longestMatches) {
    const userId = match.userIds[0]!;
    byUserId.set(userId, {
      userId,
      names: match.names,
      source: "alias",
    });
  }
  if (byUserId.size !== 1) return { status: "ambiguous" };
  return { status: "resolved", target: [...byUserId.values()][0]! };
}

function normalizeSavedAliasMatchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function isExplicitGroupEvaluationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /(?:群友|群成员|本群|群里|群聊(?:记录|内容|消息)?|聊天记录)/u.test(normalized);
}

function isLocalTranscriptTargetRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /(?:从|根据|结合|看)(?:(?:以上|上面|前面|刚才|这段|本段)(?:的)?(?:聊天|群聊|对话|发言|消息|内容|记录)?|(?:群聊|聊天记录|上文|上下文))(?:中|里)?(?:看|判断|分析|来说)?/u.test(normalized);
}

/**
 * This intentionally recognizes only requests for saved member-profile facts.
 * It must not turn an ordinary mention or a declarative sentence into a
 * third-party profile lookup.
 */
function isMemberProfileQueryRequest(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, "").trim();
  if (!normalized) return false;
  if (/(?:不知道|不清楚|不了解|不关心|不重要|告诉你|听说)/u.test(normalized) &&
      !/(?:请|告诉我|介绍|说说|讲讲|想知道|想问)/u.test(normalized)) return false;

  // Keep question terms tied to a profile field. A broad "contains 工作 and
  // 什么" check would misclassify declarations such as “鸡哥的工作我什么都
  // 不知道” and could expose a third-party profile without a real query.
  const field = "(?:常用(?:的)?(?:词(?:语)?|用语)|常用语|口头禅|流行语|聊天习惯|聊天风格|说话习惯|爱好|兴趣|职业|工作)";
  const end = "(?:[（(](?:流行语|口头禅|常用语)[）)])?[?？!！。…]*$";
  return [
    `^(?:的)?${field}${end}`,
    `^(?!(?:我喜欢|我爱|例如|解释|什么是|讨论|研究|介绍词语))[^。!?！？的]{1,24}的${field}${end}`,
    `(?:最(?:爱|喜欢)|喜欢|爱|常)(?:说|用)(?:的)?(?:那些?|什么|哪些?|哪种)(?:词(?:语)?|话|口头禅|流行语)?(?:来)?(?:聊天|说话)?${end}`,
    `(?:有|是|都有|会说|会用)(?:什么|哪些|啥|哪种)(?:的)?${field}${end}`,
    `${field}(?:是|有|都有|包括|为)?(?:什么|哪些|哪种|咋样|怎么样|怎样|如何|吗|嘛|呢)${end}`,
    `(?:做|干|从事)(?:什么|啥)(?:工作|职业)${end}`,
    `(?:喜欢|爱)(?:做|玩)(?:什么|哪些|哪种)(?:游戏|运动|事情)?${end}`,
    `(?:说说|讲讲|介绍(?:一下)?|告诉我|列(?:出|一下))[^。!?！？]{0,20}${field}(?:有哪些)?${end}`,
    `${field}[?？]+$`,
  ].some((pattern) => new RegExp(pattern, "u").test(normalized));
}

function isUnresolvedMemberProfileQuery(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, "");
  // Typed QQ numbers do not verify a member. Generic vocabulary explanations
  // stay ordinary chat and cannot read third-party profiles.
  if (/\d{5,}/u.test(normalized) || /^(?:什么是|解释|科普|介绍一下(?:什么是)?|(?:常用语|常用词|口头禅|流行语|聊天习惯|聊天风格|说话习惯|爱好|兴趣|职业|工作)(?:是|有|指|包括|如何))/u.test(normalized)) return false;
  return /^(?:请问|请|说说|讲讲|介绍(?:一下)?|告诉我)?[^，。!?！？]{1,24}(?:的(?:常用语|常用词(?:语)?|口头禅|流行语|聊天习惯|聊天风格|说话习惯|爱好|兴趣|工作|职业)|(?:做|干|从事)(?:什么|啥)(?:工作|职业)|(?:有|是)(?:哪些|什么)(?:爱好|兴趣)|(?:常用|爱说|喜欢用)(?:哪些|什么))/u.test(normalized);
}

function isPersonEvaluationRequest(text: string, hasInteractionTarget: boolean): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/(?:评价|锐评|点评|评一评|吐槽(?:一下)?)/u.test(normalized)) return true;
  if (/(?:是个?|是什么|是怎样|是何种)(?:[什怎]么样|怎样|啥样|何等)(?:的?(?:人|女性|男性|女生|男生|妹子|姑娘|女人|男人|汉子|小伙|家伙|角色|存在|朋友|同事))?/u.test(normalized)) return true;
  if (/(?:是什么人|是怎样的人|是何许人|是何方神圣)/u.test(normalized)) return true;
  if (/(?:在?你的?眼[中里]|在?你的?看来|在?你的?印象[中里])/u.test(normalized)) return true;
  const hasTraitWord = /(?:性格|脾气|为人|人品|作风|特点|特质|风格|人设|底细|背景|形象|印象|看法|观感)/u.test(normalized);
  const hasInquiryWord = /(?:[咋怎]样|[什怎]么样|啥样|如何|好不好|靠谱|行不行|何如|怎么样|评价|聊聊|说说|讲讲|谈谈|介绍)/u.test(normalized);
  if (hasTraitWord && hasInquiryWord) return true;
  if (/(?:你觉得.{1,10}怎么样|对.{1,10}有什么(?:看法|印象|评价|感觉))/u.test(normalized)) return true;
  if (/(?:说说|聊聊|讲讲|谈谈).{1,10}(?:这个人|这人|这妹子|这姑娘|这老哥|这哥们|印象|看法|评价|感觉)/u.test(normalized)) return true;
  return hasInteractionTarget && /(?:怎么看|如何看待|分析一下|说说.{0,8}(?:印象|看法|感觉))/u.test(normalized);
}

function formatRecentGroupEvidenceForMetrics(
  messages: NonNullable<AiIdentityContext["recentGroupEvidence"]>,
): string {
  return messages.map((message) => message.text).join("\n");
}

function selectManualIdentitiesForUserIds(
  identities: GroupBotConfig["manualIdentities"],
  userIds: readonly string[],
): NonNullable<GroupBotConfig["manualIdentities"]> {
  const visibleUserIds = new Set(userIds.map((userId) => userId.trim()).filter(Boolean));
  return (identities ?? []).filter((identity) =>
    identity.userIds.some((userId) => visibleUserIds.has(userId)),
  );
}

function shouldBufferActiveChatMessage(
  parsedMessage: ReturnType<typeof parseGroupMessage>,
  commandText: string,
): boolean {
  return !parsedMessage.hasAtBot &&
    Boolean(parsedMessage.text.trim()) &&
    !commandText.trim().startsWith("#");
}

function isRecognizedRuntimeCommand(
  commandText: string,
  commands: SystemCommandConfig[],
): boolean {
  return (Object.keys(RUNTIME_COMMAND_SPECS) as RuntimeCommandId[])
    .some((commandId) => Boolean(matchRuntimeCommand(commandText, commands, commandId)));
}

function buildGroupTranscriptText(
  parsedMessage: ReturnType<typeof parseGroupMessage>,
): string | undefined {
  if (parsedMessage.text) {
    return parsedMessage.text;
  }
  return parsedMessage.images.length > 0 ? "[图片消息]" : undefined;
}

function formatCausalUserTurn(
  userId: string | undefined,
  content: string,
  groupConfig: GroupBotConfig,
): string {
  if (!userId) {
    return content;
  }
  const manualName = groupConfig.manualIdentities
    ?.find((identity) => identity.userIds.includes(userId))
    ?.names[0]
    ?.trim();
  return `发言者：${manualName ?? `QQ ${userId}`}（QQ ${userId}）：${content}`;
}

function formatLiveChatDelay(groupConfig: GroupBotConfig): string {
  const seconds = getLiveChatDelaySeconds(groupConfig);
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

function resolveDefaultReplyMode(): ReplyOutputMode {
  return "text";
}

function normalizeReplyModelMode(value: unknown): ReplyModelMode {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "gpt";
}

function mapTextMetrics<T extends Record<string, string>>(
  sources: T,
  measure: (text: string) => number,
): { [K in keyof T]: number } {
  return Object.fromEntries(
    Object.entries(sources).map(([name, text]) => [name, measure(text)]),
  ) as { [K in keyof T]: number };
}

/** Lightweight language-aware estimate for source-level prompt telemetry. */
function estimateTextTokens(text: string): number {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) {
    return 0;
  }
  const cjkCount = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const withoutCjk = normalized.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, "");
  const alphanumericCount = withoutCjk.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const symbolCount = withoutCjk.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0;
  return cjkCount + Math.ceil(alphanumericCount / 4) + Math.ceil(symbolCount / 2);
}

const GROUP_FAQ_SOURCE_NAME = /(?:(?:本群|当前群|群内|群里)(?:的)?(?:群)?(?:知识库|FAQ)|群(?:知识库|FAQ))/iu;
const GROUP_FAQ_FACT_INTENT = /(?:报销|请假|打卡|会议室|会议(?:制度|规则)|流程|规定|规则|制度|要求|怎么|如何|怎样|什么|哪(?:里|些|个)?|多少|几(?:家|个|条)?|查询|申请|办理|能否|是否|吗[？?。！!]*$|[？?])/u;
const GROUP_FAQ_CONCEPT_DISCUSSION = /(?:是什么意思|指什么|怎么设计|如何设计|如何工作|怎么工作的|有什么功能)/u;

function isExplicitGroupFaqLookup(text: string): boolean {
  return GROUP_FAQ_SOURCE_NAME.test(text) &&
    GROUP_FAQ_FACT_INTENT.test(text) &&
    !GROUP_FAQ_CONCEPT_DISCUSSION.test(text) &&
    !/命令|关键词|绑定|这句话|翻译/u.test(text) &&
    !/^(?:是什么|怎么查|怎么用|如何使用|有什么作用|有哪些功能)[？?。！!]*$/u.test(stripGroupFaqSource(text));
}

function stripGroupFaqSource(text: string): string {
  return text
    .replace(/(?:在)?(?:(?:本群|当前群|群内|群里)(?:的)?(?:群)?(?:知识库|FAQ)|群(?:知识库|FAQ))(?:里|中|内)?/giu, " ")
    .replace(/^[\s，,。！!？?:：]+|[\s，,。！!？?:：]+$/gu, "")
    .trim();
}

function isGroupFaqContinuation(text: string): boolean {
  return /^(?:还有吗|还有哪些|还有呢|具体呢|再详细(?:点|说说|讲讲)?|展开说说|继续|为什么|然后呢|这个呢)[？?。！!]*$/u.test(text.normalize("NFKC").trim());
}

function getGroupFaqContinuationQuery(session: KnowledgeContinuationSession, text: string): string {
  return `${session.query} ${text}`.trim();
}

function isKnowledgeContinuation(session: KnowledgeContinuationSession, text: string): boolean {
  if (session.source === "group_faq") return isGroupFaqContinuation(text);
  return classifyPrivateEnterpriseRankingRequest(text, [
    { role: "user", content: session.query },
    { role: "assistant", content: session.reply },
  ]) === "contextual";
}

function knowledgeContinuationKey(groupId: string, userId: string): string {
  return `${groupId}\u0000${userId}`;
}

function messageForAiFailure(error: unknown, failureKind: string, userInput = ""): string {
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";
  if (error instanceof ConversationReplyEnvelopeError || errorName === "ConversationReplyEnvelopeError") {
    return MSG_REPLY_ENVELOPE_INVALID;
  }
  if (errorName === "VisionFallbackUnavailableError") {
    return "当前图片理解模型不可用，请联系管理员检查 GPT 图片理解配置后再试。";
  }
  if (errorName === "ImageInputUnavailableError" || errorName === "ImageInspectionError" || /provided URL|image_url|image input/i.test(message)) {
    return "这张图片没有成功读取成可分析内容，请重新发送原图或直接贴出代码文本。";
  }
  if (errorName === "ReasoningEffortUnavailableError") {
    return "当前 GPT 上游不支持会仙要求的高推理模式，已停止本次回答，避免用低推理结果敷衍。";
  }
  if (error instanceof KnowledgeToolUnavailableError || errorName === "KnowledgeToolUnavailableError") {
    return "当前回复模型暂不支持知识库查询，本次没有用未核验数据猜测回答；请稍后重试或联系管理员检查模型配置。";
  }
  if (/content was flagged|content policy|safety(?: |-)?(?:rule|filter)|cybersecurity risk/i.test(message)) {
    if (isExplicitUnauthorizedCyberIntrusionRequest(userInput)) {
      return MSG_UNAUTHORIZED_CYBER_REFUSAL;
    }
    return "这类高风险内容不能帮。若是合法场景，可以问防护、风险排查或合规的安全练习。";
  }
  if (failureKind === "timeout") {
    return "这次回复超过等待时间了，请稍后再试一次。";
  }
  if (failureKind === "rate_limit") {
    return "回复服务现在有点忙，请稍后再试一次。";
  }
  if (failureKind === "auth") {
    return "回复服务的上游配置异常，管理员需要检查模型连接。";
  }
  if (failureKind === "unavailable" || failureKind === "network") {
    return "回复服务暂时不可用，请稍后再试一次。";
  }
  return MSG_AI_FAIL;
}

function isExplicitUnauthorizedCyberIntrusionRequest(userInput: string): boolean {
  const normalized = userInput.normalize("NFKC").replace(/\s+/gu, "");
  if (!normalized) return false;
  if (/(?:防护|防范|防止|修复|检测|审计|授权|靶场|演练|自有|自己的|合规)/u.test(normalized)) return false;
  const action = "(?:破解|入侵|攻击|攻破|黑进|黑入|绕过|拿下|打穿)";
  const target = "(?:银行|金融|支付|账户|账号|系统|服务器|网站|平台|数据库)";
  return new RegExp(`${action}.{0,24}${target}`, "u").test(normalized) ||
    new RegExp(`${target}.{0,16}(?:怎么|如何|能否|可不可以|可以|我要|想要|教我|帮我).{0,12}${action}`, "u").test(normalized);
}

function isReferenceDependentShortReaction(userInput: string): boolean {
  const normalized = userInput.normalize("NFKC").trim().toLowerCase();
  return /^(?:[?!]+|fw|什么鬼|这啥|就这|啥意思|什么意思)$/u.test(normalized);
}

function replyContextCacheKey(groupId: string, messageId: string): string {
  return `${groupId}\u0000${messageId}`;
}

/** A reply envelope is private metadata even when an adapter bypasses AiService. */
function hasPrivateReplyEnvelopeMarker(reply: Pick<AiReply, "text" | "messages">): boolean {
  return hasConversationReplyEnvelopeMarker([reply.text, ...(reply.messages ?? [])].join("\n"));
}

function buildReplyEnvelopeRecoveryInstruction(original?: string): string {
  return [
    original,
    "FORMAT RETRY: The previous draft exposed private reply metadata. Regenerate the reply from the supplied conversation.",
    "When this request has a reply plan, return exactly one complete JSON object matching its requested reply schema. Otherwise return only natural user-facing text.",
    "Do not emit incomplete JSON, private state fields, review fields, markdown fences, or any characters outside the required response.",
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

function summarizeAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function appendRealtimeLookupFooterToReply(
  replyText: string,
  skill: SkillDefinition,
  lookup: RealtimeLookupResult | undefined,
  maxTotalChars?: number,
): string {
  const footer = formatRealtimeLookupFooter(lookup);
  if (!footer) {
    return replyText;
  }
  const maximum = Math.max(160, maxTotalChars ?? skill.maxTotalReplyChars ?? 600);
  const bodyLimit = Math.max(40, maximum - footer.length);
  const body = replyText.length > bodyLimit
    ? replyText.slice(0, bodyLimit).replace(/[\s,;:]+$/u, "").trim()
    : replyText.trim();
  return `${body}${footer}`;
}

function parseLiveChatDelay(raw: string): { unit: "seconds" | "minutes"; value: number } | undefined {
  const normalized = raw.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(秒|s|sec|secs|second|seconds|分钟|分|m|min|mins|minute|minutes)?$/);
  if (!match) {
    return undefined;
  }

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }

  const unit = match[2];
  if (unit === "秒" || unit === "s" || unit === "sec" || unit === "secs" || unit === "second" || unit === "seconds") {
    return { unit: "seconds", value: Math.floor(numericValue) };
  }

  return { unit: "minutes", value: numericValue };
}

function formatModelPurpose(purpose: string): string {
  const labels: Record<string, string> = {
    reply: "回复",
    profile: "画像",
    memory: "记忆",
    dedup: "去重",
    summary: "总结",
  };
  return labels[purpose] ?? purpose;
}

