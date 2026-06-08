import os from "node:os";

import { logError, logInfo, logWarn } from "./logger.js";
import type { AiService } from "./services/ai-service.js";
import { ConfiguredAiService, type RuntimeAiService } from "./services/configured-ai-service.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { ConversationStore } from "./services/conversation-store.js";
import type { DailyProfileReviewService } from "./services/daily-profile-review-service.js";
import { getYesterdayDateKey } from "./services/daily-profile-review-service.js";
import type { DailyReportService } from "./services/daily-report-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupLock } from "./services/group-lock.js";
import type { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryDeduplicateService } from "./services/group-memory-deduplicate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import type { BufferedMessage, LiveChatService } from "./services/live-chat-service.js";
import { buildGroupMemberProfiles } from "./services/member-profile-service.js";
import type { ProfileRecordStore } from "./services/profile-record-store.js";
import type { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { formatIntervalLabel, isWithinWorkHours } from "./services/scheduled-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import type { RuntimeTtsService } from "./services/configured-tts-service.js";
import { TtsServiceError } from "./services/tts-service.js";
import type {
  AiInteractionTarget,
  AiIdentityContext,
  AiReply,
  AiReplyContext,
  ControlledMentionDecision,
  ConversationTurn,
  GroupMemberProfile,
  GroupMemberIdentity,
  GroupBotConfig,
  GroupMemory,
  MessageImageInput,
  NapcatGroupInfo,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  ReplyModelMode,
  ReferencedMessage,
  SkillDefinition,
  SystemCommandConfig,
  SystemSettings,
} from "./types.js";
import { parseChatSummaryRequest } from "./utils/chat-summary-request.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import { formatReplyMessages } from "./utils/reply-format.js";
import { parseVoiceCommand } from "./utils/voice-command.js";

const SKILL_PREFIX = "#技能";
const MODEL_PREFIX = "#模型";
const VOICE_PREFIX = "#语音";
const VOICE_REPLY_PREFIX = "#语音回复";
const SING_PREFIX = "#唱歌";
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
const YESTERDAY_PROFILE_PREFIX = "#昨日画像";
const GROUP_PROFILE_PREFIX = "#群聊画像";
const HELP_PREFIXES = ["#功能", "#帮助", "#命令"];
const LIVE_CHAT_TICK_MS = 15 * 1000;
const DAILY_REPORT_TICK_MS = 30 * 1000;
const HOLIDAY_COUNTDOWN_TICK_MS = 30 * 1000;
const SCHEDULED_REMINDER_TICK_MS = 30 * 1000;
const OPS_ALERT_TICK_MS = 30 * 1000;
const DAILY_PROFILE_REVIEW_TICK_MS = 30 * 1000;
const MEMORY_CANDIDATE_FLUSH_TICK_MS = 2 * 60 * 1000;
const MEMORY_DEDUP_TICK_MS = 30 * 1000;
const MULTI_MESSAGE_DELAY_MS = 1000;
const CHENGFENG_TRIGGER_GROUP_ID = "866209871";
const CHENGFENG_TRIGGER_KEYWORD = "乘风";
const REPEAT_THRESHOLD = 4;
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const OPS_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const SEND_FAILURE_ALERT_THRESHOLD = 3;
const MEMORY_PERCENT_ALERT_THRESHOLD = 85;
const MEMORY_PERCENT_RECOVERY_THRESHOLD = 75;
const PROCESS_RSS_ALERT_BYTES = 1024 * 1024 * 1024;

const MSG_AI_FAIL = "我刚刚思考超时了，请稍后再试一次";
const MSG_VOICE_FAIL = "语音发送失败，我先用文字回复你";
const MSG_CONVERSATION_NO_PERMISSION = "你没有清理其他人对话上下文的权限";
const MSG_LIVE_CHAT_NO_PERMISSION = "你没有管理实时对话的权限";
const MSG_INVALID_QQ = "请提供有效的 QQ 号";
const MSG_DAILY_REPORT_NO_PERMISSION = "你没有管理群聊日报的权限";
const MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION = "你没有管理节假日倒计时的权限";
const MSG_SCHEDULED_REMINDER_NO_PERMISSION = "你没有管理定时任务总开关的权限";
const MSG_ADMIN_NO_PERMISSION = "你没有管理管理员的权限";
const MSG_MUTE_NO_PERMISSION = "你没有让机器人闭嘴或说话的权限";
const MSG_BLACKLIST_NO_PERMISSION = "你没有管理机器人黑名单的权限";
const MSG_STATUS_NO_PERMISSION = "你没有查看机器人状态的权限";
const MSG_HEALTH_NO_PERMISSION = "你没有查看机器人健康检查的权限";
const MSG_OPERATION_LOG_NO_PERMISSION = "你没有查看机器人操作日志的权限";
const MSG_SERVER_NO_PERMISSION = "你没有查看服务器状态的权限";
const MSG_OPS_ALERT_NO_PERMISSION = "你没有管理运维告警的权限";
const MSG_VOICE_REPLY_NO_PERMISSION = "你没有管理语音回复的权限";

const ROAST_MODE_SCENARIO_INSTRUCTION = [
  "本轮是群管理后台配置的“嘴臭模式”主动接话。",
  "保持当前 skill 的完整人格、语气、表达 DNA 和回复格式，不要切换成通用助理。",
  "把当前发言人视为刚刚挑衅或攻击了机器人：你可以像被骂急了一样反击，语气尖锐、嘴硬、阴阳怪气、嘲讽感强，允许不讲太多道理，优先短促有力。",
  "围绕对方这几句发言本身开火，不要编造现实身份、隐私、家庭、疾病、民族、性别、地域等不可验证攻击点，不要输出威胁或煽动现实伤害。",
].join("\n");

const RUNTIME_COMMAND_SPECS = {
  admin: { builtinPrefix: ADMIN_PREFIX, builtinAliases: [] },
  blacklist: { builtinPrefix: BLACKLIST_PREFIX, builtinAliases: [] },
  conversation: { builtinPrefix: CONVERSATION_PREFIX, builtinAliases: [CLEAR_GROUP_CONTEXT_COMMAND] },
  daily_report: { builtinPrefix: DAILY_REPORT_PREFIX, builtinAliases: [] },
  health: { builtinPrefix: HEALTH_PREFIX, builtinAliases: [SHORT_HEALTH_PREFIX] },
  help: { builtinPrefix: HELP_PREFIXES[0]!, builtinAliases: HELP_PREFIXES.slice(1) },
  holiday_countdown: { builtinPrefix: HOLIDAY_COUNTDOWN_PREFIX, builtinAliases: [] },
  knowledge: { builtinPrefix: KNOWLEDGE_PREFIX, builtinAliases: [] },
  live_chat: { builtinPrefix: LIVE_CHAT_PREFIX, builtinAliases: [] },
  memory: { builtinPrefix: MEMORY_PREFIX, builtinAliases: [] },
  model: { builtinPrefix: MODEL_PREFIX, builtinAliases: [] },
  mute: { builtinPrefix: MUTE_COMMAND, builtinAliases: [UNMUTE_COMMAND] },
  operation_log: { builtinPrefix: OPERATION_LOG_PREFIX, builtinAliases: [] },
  ops_alert: { builtinPrefix: OPS_ALERT_PREFIX, builtinAliases: [] },
  profile_overall: { builtinPrefix: GROUP_PROFILE_PREFIX, builtinAliases: [] },
  profile_yesterday: { builtinPrefix: YESTERDAY_PROFILE_PREFIX, builtinAliases: [] },
  scheduled_reminder: { builtinPrefix: SCHEDULED_REMINDER_PREFIX, builtinAliases: [] },
  server: { builtinPrefix: SERVER_PREFIX, builtinAliases: [] },
  status: { builtinPrefix: STATUS_PREFIX, builtinAliases: [] },
  skill: { builtinPrefix: SKILL_PREFIX, builtinAliases: [] },
  sing: { builtinPrefix: SING_PREFIX, builtinAliases: [] },
  voice: { builtinPrefix: VOICE_PREFIX, builtinAliases: [] },
  voice_reply: { builtinPrefix: VOICE_REPLY_PREFIX, builtinAliases: [] },
} as const;

type RuntimeCommandId = keyof typeof RUNTIME_COMMAND_SPECS;

interface RuntimeCommandMatch {
  rewrittenText: string;
  matchedPrefix: string;
  suffix: string;
}

interface ReplyAiRoute {
  mode: ReplyModelMode;
  label: string;
  service: Pick<RuntimeAiService, "generateReply">;
  fallback?: {
    mode: ReplyModelMode;
    label: string;
    service: Pick<RuntimeAiService, "generateReply">;
  };
}

interface ReplyModelOption {
  mode: ReplyModelMode;
  label: string;
  service: Pick<RuntimeAiService, "generateReply">;
}

interface ReplyAiResult {
  reply: AiReply;
  usedMode: ReplyModelMode;
  fallbackUsed: boolean;
}

interface ProfileTargetResolution {
  status: "ok" | "ambiguous" | "not_found";
  userId?: string;
  label?: string;
  matches?: string[];
}

export interface TransportHealthStatus {
  ok: boolean;
  detail: string;
}

export interface MessageTransport {
  sendGroupMessage(groupId: string, text: string): Promise<void>;
  sendGroupRecord(groupId: string, recordFile: string): Promise<void>;
  sendGroupAiRecord(groupId: string, text: string): Promise<void>;
  resolveImageInputs?(images: MessageImageInput[]): Promise<MessageImageInput[]>;
  listGroupMembers?(groupId: string): Promise<NapcatGroupMember[]>;
  listGroups?(): Promise<NapcatGroupInfo[]>;
  resolveMentionTargets?(groupId: string, candidates: string[]): Promise<string[]>;
  resolveMemberIdentities?(groupId: string, candidates: string[]): Promise<GroupMemberIdentity[]>;
  getMessage?(messageId: string): Promise<ReferencedMessage | undefined>;
  getHealthStatus?(): Promise<TransportHealthStatus>;
}

interface MessageInteractionContext {
  interactionTargets: AiInteractionTarget[];
  replyContext?: AiReplyContext;
}

interface ConversationOptions {
  allowControlledMention?: boolean;
  scenarioInstruction?: string;
}

type ReplyOutputMode = "text" | "voice" | "singing";

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
  private liveChatTimer?: NodeJS.Timeout;
  private dailyReportTimer?: NodeJS.Timeout;
  private holidayCountdownTimer?: NodeJS.Timeout;
  private scheduledReminderTimer?: NodeJS.Timeout;
  private opsAlertTimer?: NodeJS.Timeout;
  private dailyProfileReviewTimer?: NodeJS.Timeout;
  private memoryCandidateFlushTimer?: NodeJS.Timeout;
  private memoryDedupTimer?: NodeJS.Timeout;
  private liveChatTickRunning = false;
  private dailyReportTickRunning = false;
  private holidayCountdownTickRunning = false;
  private scheduledReminderTickRunning = false;
  private opsAlertTickRunning = false;
  private dailyProfileReviewTickRunning = false;
  private memoryCandidateFlushTickRunning = false;
  private memoryDedupTickRunning = false;
  private lastMemoryDedupDateKey?: string;
  private readonly groupRepeatStates = new Map<string, { text: string; count: number; lastTimestamp: number }>();
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
    private readonly skillService: SkillService,
    private readonly conversationStore: ConversationStore,
    private readonly aiService: RuntimeAiService,
    private readonly ttsService: RuntimeTtsService,
    private readonly dailyReportService: DailyReportService,
    private readonly holidayCountdownService: HolidayCountdownService,
    private readonly scheduledReminderService: ScheduledReminderService,
    private readonly adminOperationLogService: AdminOperationLogService,
    private readonly groupLock: GroupLock,
    private readonly liveChatService: LiveChatService,
    private readonly botQq: string,
    private readonly allowNapCatAiVoiceFallback = false,
    private readonly groupMemoryStore?: GroupMemoryStore,
    private readonly knowledgeBaseStore?: KnowledgeBaseStore,
    private readonly groupMemoryCandidateService?: GroupMemoryCandidateService,
    private readonly dailyProfileReviewService?: DailyProfileReviewService,
    private readonly adminPublicBaseUrl?: string,
    private readonly profileReplyAiService?: RuntimeAiService,
    private readonly replyModelLabels: Partial<Record<ReplyModelMode, string>> = {},
    private readonly systemSettingsStore?: SystemSettingsStore,
    private readonly profileRecordStore?: ProfileRecordStore,
  ) {}

  start(): void {
    if (
      this.liveChatTimer ||
      this.dailyReportTimer ||
      this.holidayCountdownTimer ||
      this.scheduledReminderTimer ||
      this.opsAlertTimer ||
      this.dailyProfileReviewTimer ||
      this.memoryCandidateFlushTimer ||
      this.memoryDedupTimer
    ) {
      return;
    }

    this.liveChatTimer = setInterval(() => {
      void this.runLiveChatTick();
    }, LIVE_CHAT_TICK_MS);
    this.liveChatTimer.unref();

    this.dailyReportTimer = setInterval(() => {
      void this.runDailyReportTick();
    }, DAILY_REPORT_TICK_MS);
    this.dailyReportTimer.unref();

    this.holidayCountdownTimer = setInterval(() => {
      void this.runHolidayCountdownTick();
    }, HOLIDAY_COUNTDOWN_TICK_MS);
    this.holidayCountdownTimer.unref();

    this.scheduledReminderTimer = setInterval(() => {
      void this.runScheduledReminderTick();
    }, SCHEDULED_REMINDER_TICK_MS);
    this.scheduledReminderTimer.unref();

    this.opsAlertTimer = setInterval(() => {
      void this.runOpsAlertTick();
    }, OPS_ALERT_TICK_MS);
    this.opsAlertTimer.unref();

    this.dailyProfileReviewTimer = setInterval(() => {
      void this.runDailyProfileReviewTick();
    }, DAILY_PROFILE_REVIEW_TICK_MS);
    this.dailyProfileReviewTimer.unref();

    this.memoryCandidateFlushTimer = setInterval(() => {
      void this.runMemoryCandidateFlushTick();
    }, MEMORY_CANDIDATE_FLUSH_TICK_MS);
    this.memoryCandidateFlushTimer.unref();

    this.memoryDedupTimer = setInterval(() => {
      void this.runMemoryDedupTick();
    }, MEMORY_DEDUP_TICK_MS);
    this.memoryDedupTimer.unref();

    void this.runOpsAlertTick({ includeStartup: true });
  }

  stop(): void {
    if (this.liveChatTimer) {
      clearInterval(this.liveChatTimer);
      this.liveChatTimer = undefined;
    }

    if (this.dailyReportTimer) {
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = undefined;
    }

    if (this.holidayCountdownTimer) {
      clearInterval(this.holidayCountdownTimer);
      this.holidayCountdownTimer = undefined;
    }

    if (this.scheduledReminderTimer) {
      clearInterval(this.scheduledReminderTimer);
      this.scheduledReminderTimer = undefined;
    }

    if (this.opsAlertTimer) {
      clearInterval(this.opsAlertTimer);
      this.opsAlertTimer = undefined;
    }

    if (this.dailyProfileReviewTimer) {
      clearInterval(this.dailyProfileReviewTimer);
      this.dailyProfileReviewTimer = undefined;
    }

    if (this.memoryCandidateFlushTimer) {
      clearInterval(this.memoryCandidateFlushTimer);
      this.memoryCandidateFlushTimer = undefined;
    }

    if (this.memoryDedupTimer) {
      clearInterval(this.memoryDedupTimer);
      this.memoryDedupTimer = undefined;
    }
  }

  private async getRuntimeCommands(): Promise<SystemCommandConfig[]> {
    return readRuntimeCommands(this.systemSettingsStore);
  }

  async handleGroupMessage(event: NapcatGroupMessageEvent): Promise<void> {
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

    const commandText = extractCommandText(event.message);
    const runtimeCommands = await this.getRuntimeCommands();

    const blacklistCommand = matchRuntimeCommand(commandText, runtimeCommands, "blacklist");
    if (blacklistCommand) {
      const handled = await this.handleBlacklistCommand(groupConfig, event, blacklistCommand.rewrittenText);
      if (handled) {
        return;
      }
    }

    if (this.isBlacklistedUser(groupConfig, userId)) {
      const parsedMessage = parseGroupMessage(event.message, this.botQq);
      await this.recordDailyReportMessage(groupConfig, event, parsedMessage);
      return;
    }

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
      await this.handleMemoryStatusCommand(groupConfig, event);
      return;
    }

    const knowledgeCommand = matchRuntimeCommand(commandText, runtimeCommands, "knowledge");
    if (knowledgeCommand) {
      await this.handleKnowledgeStatusCommand(groupConfig, event);
      return;
    }

    const yesterdayProfileCommand = matchRuntimeCommand(commandText, runtimeCommands, "profile_yesterday");
    if (yesterdayProfileCommand) {
      await this.handleYesterdayProfileCommand(groupConfig, event, yesterdayProfileCommand.rewrittenText);
      return;
    }

    const overallProfileCommand = matchRuntimeCommand(commandText, runtimeCommands, "profile_overall");
    if (overallProfileCommand) {
      await this.handleGroupProfileCommand(groupConfig, event, overallProfileCommand.rewrittenText);
      return;
    }

    const opsAlertCommand = matchRuntimeCommand(commandText, runtimeCommands, "ops_alert");
    if (opsAlertCommand) {
      await this.handleOpsAlertCommand(groupConfig, event, opsAlertCommand.rewrittenText);
      return;
    }

    const voiceReplyCommand = matchRuntimeCommand(commandText, runtimeCommands, "voice_reply");
    if (voiceReplyCommand) {
      await this.handleVoiceReplyCommand(groupConfig, event, voiceReplyCommand.rewrittenText);
      return;
    }

    if (groupConfig.botMuted === true) {
      const dailyReportCommand = matchRuntimeCommand(commandText, runtimeCommands, "daily_report");
      if (dailyReportCommand) {
        await this.handleDailyReportCommand(groupConfig, event, dailyReportCommand.rewrittenText);
        return;
      }

      const holidayCountdownCommand = matchRuntimeCommand(commandText, runtimeCommands, "holiday_countdown");
      if (holidayCountdownCommand) {
        await this.handleHolidayCountdownCommand(groupConfig, event, holidayCountdownCommand.rewrittenText);
        return;
      }

      const scheduledReminderCommand = matchRuntimeCommand(commandText, runtimeCommands, "scheduled_reminder");
      if (scheduledReminderCommand) {
        await this.handleScheduledReminderCommand(groupConfig, event, scheduledReminderCommand.rewrittenText);
        return;
      }

      const parsedMessage = parseGroupMessage(event.message, this.botQq);
      await this.recordDailyReportMessage(groupConfig, event, parsedMessage);
      const chatSummaryRequest = parsedMessage.hasAtBot
        ? parseChatSummaryRequest(parsedMessage.text, new Date())
        : null;
      if (chatSummaryRequest) {
        await this.groupLock.run(groupId, async () => {
          const summary = await this.dailyReportService.buildChatSummary({
            groupId,
            request: chatSummaryRequest,
            now: new Date(),
          });
          await this.sendText(groupId, summary);
        });
      }
      return;
    }

    const liveChatCommand = matchRuntimeCommand(commandText, runtimeCommands, "live_chat");
    if (liveChatCommand) {
      await this.handleLiveChatCommand(groupConfig, event, liveChatCommand.rewrittenText);
      return;
    }

    const helpCommand = matchRuntimeCommand(commandText, runtimeCommands, "help");
    if (helpCommand) {
      await this.handleHelpCommand(groupConfig.groupId, helpCommand.rewrittenText, runtimeCommands);
      return;
    }

    const adminCommand = matchRuntimeCommand(commandText, runtimeCommands, "admin");
    if (adminCommand) {
      await this.handleAdminCommand(groupConfig, event, adminCommand.rewrittenText);
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

    const skillCommand = matchRuntimeCommand(commandText, runtimeCommands, "skill");
    if (skillCommand) {
      await this.handleSkillCommand(groupConfig, event, skillCommand.rewrittenText);
      return;
    }

    const modelCommand = matchRuntimeCommand(commandText, runtimeCommands, "model");
    if (modelCommand) {
      await this.handleModelCommand(groupConfig, event, modelCommand.rewrittenText);
      return;
    }

    const dailyReportCommand = matchRuntimeCommand(commandText, runtimeCommands, "daily_report");
    if (dailyReportCommand) {
      await this.handleDailyReportCommand(groupConfig, event, dailyReportCommand.rewrittenText);
      return;
    }

    const holidayCountdownCommand = matchRuntimeCommand(commandText, runtimeCommands, "holiday_countdown");
    if (holidayCountdownCommand) {
      await this.handleHolidayCountdownCommand(groupConfig, event, holidayCountdownCommand.rewrittenText);
      return;
    }

    const scheduledReminderCommand = matchRuntimeCommand(commandText, runtimeCommands, "scheduled_reminder");
    if (scheduledReminderCommand) {
      await this.handleScheduledReminderCommand(groupConfig, event, scheduledReminderCommand.rewrittenText);
      return;
    }

    const repeatText = extractRepeatableText(event.message, this.botQq);
    if (repeatText && this.checkAndTriggerRepeat(groupId, repeatText)) {
      logInfo("Triggered repeat message.", { groupId, userId, text: repeatText });
      await this.sendText(groupId, repeatText);
      return;
    }

    const parsedMessage = parseGroupMessage(event.message, this.botQq);
    const messageContext = await this.buildMessageInteractionContext(groupConfig, parsedMessage);
    const singCommand = matchRuntimeCommand(commandText, runtimeCommands, "sing");
    if (singCommand) {
      if (groupConfig.voiceReplyEnabled === false) {
        await this.sendText(groupId, "本群语音功能已关闭");
        return;
      }
      const singInput = singCommand.suffix.trim();
      if (!singInput) {
        await this.sendText(groupId, `唱歌命令格式：${runtimeCommandPrimary(runtimeCommands, "sing")} <内容>`);
        return;
      }
      await this.groupLock.run(groupId, async () => {
        await this.handleConversation(
          groupConfig,
          userId,
          singInput,
          parsedMessage.images,
          "singing",
          [],
          messageContext,
        );
      });
      return;
    }

    const voiceRuntimeCommand = matchRuntimeCommand(commandText, runtimeCommands, "voice");
    const voiceCommandEnabled = isRuntimeCommandEnabled(runtimeCommands, "voice");
    const voiceCommand = parseVoiceCommand(
      voiceRuntimeCommand?.rewrittenText ?? commandText,
      parsedMessage.text,
      parsedMessage.hasAtBot,
    );

    if (voiceCommand.matched) {
      if (!voiceCommandEnabled) {
        logInfo("Ignored voice command because runtime command is disabled.", { groupId, userId });
        return;
      }
      if (groupConfig.voiceReplyEnabled === false) {
        logInfo("Ignored voice command because voice reply is disabled for group.", { groupId, userId });
        return;
      }
      if (!voiceCommand.valid) {
        await this.sendText(
          groupId,
          voiceCommand.errorMessage ?? `语音命令格式：${VOICE_PREFIX} <内容>`,
        );
        return;
      }

      await this.groupLock.run(groupId, async () => {
        await this.handleConversation(
          groupConfig,
          userId,
          voiceCommand.userInput ?? "",
          parsedMessage.images,
          "voice",
          [],
          messageContext,
        );
      });
      return;
    }

    const chatSummaryRequest = parsedMessage.hasAtBot
      ? parseChatSummaryRequest(parsedMessage.text, new Date())
      : null;

    if (chatSummaryRequest) {
      await this.groupLock.run(groupId, async () => {
        const summary = await this.dailyReportService.buildChatSummary({
          groupId,
          request: chatSummaryRequest,
          now: new Date(),
        });
        await this.sendText(groupId, summary);
      });
      return;
    }

    if (parsedMessage.hasAtBot) {
      const reminderRequest = this.scheduledReminderService.parseCreateRequest(parsedMessage.text);
      if (reminderRequest) {
        if (!isRuntimeCommandEnabled(runtimeCommands, "scheduled_reminder")) {
          logInfo("Ignored natural scheduled reminder command because runtime command is disabled.", { groupId, userId });
          return;
        }
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
    this.queueMemoryCandidateMessage(groupConfig, event, parsedMessage);

    if (await this.shouldTriggerKeyword(groupConfig, parsedMessage.text, parsedMessage.hasAtBot, commandText)) {
      await this.groupLock.run(groupId, async () => {
        await this.handleConversation(
          groupConfig,
          userId,
          parsedMessage.text,
          parsedMessage.images,
          resolveDefaultReplyMode(groupConfig),
          [userId],
          messageContext,
        );
      });
      return;
    }

    if (this.isActiveChatTrackedUser(groupConfig, userId) && shouldBufferActiveChatMessage(parsedMessage, commandText)) {
      this.liveChatService.addMessage(groupId, userId, parsedMessage.text, Date.now(), messageContext);
    }

    if (!parsedMessage.hasAtBot || (!parsedMessage.text && parsedMessage.images.length === 0)) {
      logInfo("Ignored message because bot was not mentioned or content empty.", {
        groupId,
        userId,
        hasAtBot: parsedMessage.hasAtBot,
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
        resolveDefaultReplyMode(groupConfig),
        [],
        messageContext,
        true,
      );
    });
  }

  async getPublicTransportHealthStatus(): Promise<TransportHealthStatus> {
    return this.getTransportHealthStatus();
  }

  private async shouldTriggerKeyword(
    groupConfig: GroupBotConfig,
    text: string,
    hasAtBot: boolean,
    commandText: string,
  ): Promise<boolean> {
    if (
      hasAtBot ||
      commandText.trim().startsWith("#")
    ) {
      return false;
    }

    const keywords = groupConfig.triggerKeywords && groupConfig.triggerKeywords.length > 0
      ? groupConfig.triggerKeywords
      : await this.getDefaultTriggerKeywords(groupConfig.groupId);
    return keywords.some((item) => item.enabled !== false && item.keyword && text.includes(item.keyword));
  }

  private async getDefaultTriggerKeywords(groupId: string): Promise<SystemSettings["defaultTriggerKeywords"]> {
    if (this.systemSettingsStore) {
      try {
        const settings = await this.systemSettingsStore.get();
        if (settings.defaultTriggerKeywords.length > 0) {
          return settings.defaultTriggerKeywords;
        }
      } catch (error) {
        logWarn("Failed to load system default trigger keywords.", {
          groupId,
          error: (error as Error).message,
        });
      }
    }
    return groupId === CHENGFENG_TRIGGER_GROUP_ID
      ? [{ keyword: CHENGFENG_TRIGGER_KEYWORD, enabled: true }]
      : [];
  }

  private async runLiveChatTick(): Promise<void> {
    if (this.liveChatTickRunning) {
      return;
    }

    this.liveChatTickRunning = true;
    const now = Date.now();

    try {
      const groups = await this.getEnabledGroupConfigs();

      for (const groupConfig of groups) {
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
            const isRoastMode = this.isRoastModeUser(groupConfig, candidate.userId);
            await this.handleConversation(
              groupConfig,
              candidate.userId,
              formatBufferedMessages(candidate.messages),
              [],
              resolveDefaultReplyMode(groupConfig),
              [candidate.userId],
              buildBufferedInteractionContext(candidate.messages),
              {
                ...(isRoastMode ? { scenarioInstruction: ROAST_MODE_SCENARIO_INSTRUCTION } : {}),
              },
            );
          });
          logInfo("Sent live chat reply.", {
            groupId,
            userId: candidate.userId,
            messageCount: candidate.messages.length,
            delaySeconds,
            roastMode: this.isRoastModeUser(groupConfig, candidate.userId),
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
    } finally {
      this.liveChatTickRunning = false;
    }
  }

  private async runDailyReportTick(now = new Date()): Promise<void> {
    if (this.dailyReportTickRunning) {
      return;
    }

    this.dailyReportTickRunning = true;

    try {
      const groups = await this.getEnabledGroupConfigs();

      for (const groupConfig of groups) {
        if (!(await this.dailyReportService.shouldSendScheduledReport(groupConfig, now))) {
          continue;
        }

        try {
          await this.groupLock.run(groupConfig.groupId, async () => {
            const report = await this.dailyReportService.buildReport(groupConfig, now);
            await this.sendText(groupConfig.groupId, report);
            await this.dailyReportService.markSent(groupConfig.groupId, now);
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
    } finally {
      this.dailyReportTickRunning = false;
    }
  }

  private async runHolidayCountdownTick(now = new Date()): Promise<void> {
    if (this.holidayCountdownTickRunning) {
      return;
    }

    this.holidayCountdownTickRunning = true;

    try {
      const groups = await this.getEnabledGroupConfigs();

      for (const groupConfig of groups) {
        if (!(await this.holidayCountdownService.shouldSendScheduledMessage(groupConfig, now))) {
          continue;
        }

        try {
          await this.groupLock.run(groupConfig.groupId, async () => {
            const message = await this.holidayCountdownService.buildCountdownMessage(now);
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
    } finally {
      this.holidayCountdownTickRunning = false;
    }
  }

  private async runScheduledReminderTick(now = new Date()): Promise<void> {
    if (this.scheduledReminderTickRunning) {
      return;
    }

    if (!isWithinWorkHours(now)) {
      return;
    }

    this.scheduledReminderTickRunning = true;

    try {
      const groups = await this.getEnabledGroupConfigs();
      const groupsById = new Map(groups.map((group) => [group.groupId, group]));
      const dueTasks = await this.scheduledReminderService.getDueTasks(now);
      for (const task of dueTasks) {
        const groupConfig = groupsById.get(task.groupId);
        if (!groupConfig || groupConfig.enabled === false || groupConfig.scheduledRemindersEnabled === false) {
          continue;
        }

        try {
          await this.groupLock.run(task.groupId, async () => {
            const message = await this.scheduledReminderService.buildReminderMessage(task);
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
    } finally {
      this.scheduledReminderTickRunning = false;
    }
  }

  private async runDailyProfileReviewTick(now = new Date()): Promise<void> {
    if (this.dailyProfileReviewTickRunning || !this.dailyProfileReviewService) {
      return;
    }

    let dailyProfileReviewTime = "00:00";
    if (this.systemSettingsStore) {
      try {
        const settings = await this.systemSettingsStore.get();
        if (settings.dailyProfileReviewEnabled === false) {
          return;
        }
        dailyProfileReviewTime = settings.dailyProfileReviewTime || dailyProfileReviewTime;
      } catch (error) {
        logWarn("Failed to read daily profile review settings; continuing with default schedule.", {
          error: (error as Error).message,
        });
      }
    }

    if (!isScheduledClockMinute(now, dailyProfileReviewTime)) {
      return;
    }

    this.dailyProfileReviewTickRunning = true;
    const dateKey = getYesterdayDateKey(now);

    try {
      const groups = await this.getEnabledGroupConfigs();
      for (const groupConfig of groups) {
        try {
          const members = await this.buildMemberProfiles(groupConfig);
          const result = await this.dailyProfileReviewService.reviewGroup({
            groupConfig,
            dateKey,
            members,
          });
          await this.createDailyProfileRecords(groupConfig, result.createdSummaries ?? []);
          if (result.createdCount > 0) {
            logInfo("Reviewed daily member profiles.", {
              groupId: groupConfig.groupId,
              dateKey,
              createdCount: result.createdCount,
            });
          }
        } catch (error) {
          logError("Daily profile review tick failed.", {
            groupId: groupConfig.groupId,
            dateKey,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logError("Daily profile review scheduler failed.", {
        dateKey,
        error: (error as Error).message,
      });
    } finally {
      this.dailyProfileReviewTickRunning = false;
    }
  }

  private async runMemoryCandidateFlushTick(): Promise<void> {
    if (this.memoryCandidateFlushTickRunning || !this.groupMemoryCandidateService) {
      return;
    }

    this.memoryCandidateFlushTickRunning = true;
    try {
      if (this.profileReplyAiService) {
        const health = await this.profileReplyAiService.checkHealth();
        if (!health.ok) {
          logWarn("Skipped group memory candidate flush because profile AI is unhealthy.", {
            detail: health.detail,
            model: health.model,
            baseUrl: health.baseUrl,
            checkedAt: health.checkedAt,
            cached: health.cached,
          });
          return;
        }
      }
      const enabledGroupIds = (await this.getEnabledGroupConfigs()).map((group) => group.groupId);
      const results = await this.groupMemoryCandidateService.flushAll(enabledGroupIds);
      for (const result of results) {
        logInfo("Flushed buffered group memory messages.", { ...result });
      }
    } catch (error) {
      logWarn("Memory candidate flush tick failed.", {
        error: (error as Error).message,
      });
    } finally {
      this.memoryCandidateFlushTickRunning = false;
    }
  }

  private async createDailyProfileRecords(groupConfig: GroupBotConfig, summaries: GroupMemory[]): Promise<void> {
    if (!this.profileRecordStore || summaries.length === 0) {
      return;
    }

    for (const summary of summaries) {
      if (!summary.subjectUserId) {
        continue;
      }
      try {
        await this.profileRecordStore.create({
          groupId: groupConfig.groupId,
          userId: summary.subjectUserId,
          type: "yesterday",
          summary: summary.content,
          sourceMemoryCount: 1,
          generatedAt: summary.updatedAt,
          createdBy: "daily_profile_review",
        });
      } catch (error) {
        logWarn("Failed to create daily profile public record.", {
          groupId: groupConfig.groupId,
          userId: summary.subjectUserId,
          memoryId: summary.id,
          error: (error as Error).message,
        });
      }
    }
  }

  private async runMemoryDedupTick(now = new Date()): Promise<void> {
    if (this.memoryDedupTickRunning || !this.groupMemoryStore) {
      return;
    }

    let memoryDedupTime = "23:00";
    let memoryDedupSemanticTimeoutMs = 10 * 60 * 1000;
    if (this.systemSettingsStore) {
      try {
        const settings = await this.systemSettingsStore.get();
        if (settings.memoryDedupEnabled === false) {
          const dateKey = getHongKongDateKey(now);
          this.lastMemoryDedupDateKey = dateKey;
          logInfo("Skipped nightly memory dedup because it is disabled in system settings.", { dateKey });
          return;
        }
        memoryDedupTime = settings.memoryDedupTime || memoryDedupTime;
        memoryDedupSemanticTimeoutMs = settings.memoryDedupSemanticTimeoutMinutes * 60 * 1000;
      } catch (error) {
        logWarn("Failed to read memory dedup settings; continuing with nightly dedup.", {
          error: (error as Error).message,
        });
      }
    }

    if (!isScheduledClockMinute(now, memoryDedupTime)) {
      return;
    }

    const dateKey = getHongKongDateKey(now);
    if (this.lastMemoryDedupDateKey === dateKey) {
      return;
    }

    this.memoryDedupTickRunning = true;
    this.lastMemoryDedupDateKey = dateKey;
    try {
      const enabledGroups = await this.getEnabledGroupConfigs();
      const deduplicateService = new GroupMemoryDeduplicateService(
        this.groupMemoryStore,
        this.profileReplyAiService
          ? (args) => this.profileReplyAiService!.judgeMemorySemanticRelation(args)
          : undefined,
      );
      for (const group of enabledGroups) {
        try {
          const result = await deduplicateService.deduplicateMemberMemoriesForGroup(group.groupId, {
            useSemanticJudge: true,
            semanticTimeoutMs: memoryDedupSemanticTimeoutMs,
          });
          if (
            result.decisionCount > 0 ||
            result.appliedCount > 0 ||
            result.skippedCount > 0 ||
            result.semanticStats.called > 0 ||
            result.semanticStats.timedOut > 0
          ) {
            logInfo("Nightly member memory dedup completed.", {
              ...result,
              semanticJudgeEnabled: true,
              semanticTimeoutMs: memoryDedupSemanticTimeoutMs,
            });
          }
        } catch (error) {
          logWarn("Nightly member memory dedup failed for group.", {
            groupId: group.groupId,
            dateKey,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      logWarn("Nightly member memory dedup scheduler failed.", {
        dateKey,
        error: (error as Error).message,
      });
    } finally {
      this.memoryDedupTickRunning = false;
    }
  }

  private async runOpsAlertTick(options: { now?: Date; includeStartup?: boolean } = {}): Promise<void> {
    if (this.opsAlertTickRunning) {
      return;
    }

    this.opsAlertTickRunning = true;
    const now = options.now ?? new Date();

    try {
      const [groups, transportHealth] = await Promise.all([
        this.getEnabledGroupConfigs(),
        this.getTransportHealthStatus(),
      ]);
      const enabledGroups = groups.filter((group) => group.opsAlertsEnabled !== false);

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
    } finally {
      this.opsAlertTickRunning = false;
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

    if (!(await this.isAdmin(groupConfig, userId))) {
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

    if (!(await this.isAdmin(groupConfig, userId))) {
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

  private async handleVoiceReplyCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_VOICE_REPLY_NO_PERMISSION);
      return;
    }

    if (
      normalized === VOICE_REPLY_PREFIX ||
      normalized === `${VOICE_REPLY_PREFIX} 状态` ||
      normalized === `${VOICE_REPLY_PREFIX} 查看`
    ) {
      await this.sendText(
        groupId,
        [
          `语音功能：${groupConfig.voiceReplyEnabled === false ? "已关闭" : "已开启"}`,
          `默认语音回复：${groupConfig.defaultVoiceReplyEnabled === true ? "已开启" : "已关闭"}`,
          "说明：默认语音回复只影响普通 AI 回复，系统指令仍用文字返回。",
        ].join("\n"),
      );
      return;
    }

    if (
      normalized === `${VOICE_REPLY_PREFIX} 开启` ||
      normalized === `${VOICE_REPLY_PREFIX} 打开` ||
      normalized.toLowerCase() === `${VOICE_REPLY_PREFIX} on`.toLowerCase()
    ) {
      await this.groupConfigService.updateGroupConfig(groupId, {
        voiceReplyEnabled: true,
        defaultVoiceReplyEnabled: true,
      });
      await this.logAdminOperation(groupId, userId, "默认语音回复开启", undefined, "语音功能与默认语音回复均已开启");
      await this.sendText(groupId, "已开启语音功能和默认语音回复，普通 AI 回复会优先发送语音条。");
      return;
    }

    if (
      normalized === `${VOICE_REPLY_PREFIX} 关闭` ||
      normalized.toLowerCase() === `${VOICE_REPLY_PREFIX} off`.toLowerCase()
    ) {
      await this.groupConfigService.updateGroupConfig(groupId, { defaultVoiceReplyEnabled: false });
      await this.logAdminOperation(groupId, userId, "默认语音回复关闭", undefined, "普通 AI 回复恢复文字");
      await this.sendText(groupId, "已关闭默认语音回复，普通 AI 回复会恢复文字。");
      return;
    }

    await this.sendText(
      groupId,
      [
        "语音回复命令格式：",
        `${VOICE_REPLY_PREFIX} 状态`,
        `${VOICE_REPLY_PREFIX} 开启`,
        `${VOICE_REPLY_PREFIX} 关闭`,
      ].join("\n"),
    );
  }

  private async handleStatusCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_STATUS_NO_PERMISSION);
      return;
    }

    const [currentSkill, scheduledTasks, superAdminUserIds] = await Promise.all([
      this.skillService.getSkill(groupConfig.currentSkillId),
      this.scheduledReminderService.listGroupTasks(groupId),
      this.groupConfigService.getSuperAdminUserIds(),
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
        `语音回复：${groupConfig.voiceReplyEnabled === false ? "语音功能已关闭" : `语音功能已开启，默认语音${groupConfig.defaultVoiceReplyEnabled === true ? "已开启" : "已关闭"}`}`,
        `定时任务：${groupConfig.scheduledRemindersEnabled === false ? "已关闭" : "已开启"}，${scheduledTasks.length} 个`,
        `群聊日报：${groupConfig.dailyReportEnabled === false ? "已关闭" : `已开启，${groupConfig.dailyReportTime ?? "17:59"}`}`,
        `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : `已开启，${groupConfig.holidayCountdownTime ?? "09:00"}`}`,
        `黑名单：${blacklistedUsers.length > 0 ? `${blacklistedUsers.length} 人` : "无"}`,
        `管理员：本群 ${groupConfig.switcherUserIds.length} 人，超级 ${superAdminUserIds.length} 人`,
      ].join("\n"),
    );
  }

  private async handleHealthCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_HEALTH_NO_PERMISSION);
      return;
    }

    const [currentSkill, allowedSkills, scheduledTasks, transportHealth] = await Promise.all([
      this.skillService.getSkill(groupConfig.currentSkillId),
      Promise.all(groupConfig.allowedSkillIds.map((skillId) => this.skillService.getSkill(skillId))),
      this.scheduledReminderService.listGroupTasks(groupId),
      this.getTransportHealthStatus(),
    ]);
    const [profileHealth, modelSummary] = await Promise.all([
      this.getProfileHealthSummary(),
      this.getSystemModelSummary(),
    ]);
    const missingAllowedSkillIds = groupConfig.allowedSkillIds.filter((_, index) => !allowedSkills[index]);
    const nextTask = scheduledTasks
      .filter((task) => task.enabled !== false)
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0];

    await this.sendText(
      groupId,
      [
        `健康检查：群 ${groupId}`,
        `NapCat：${transportHealth.ok ? "正常" : "异常"}，${transportHealth.detail}`,
        profileHealth ? `画像/记忆模型：${profileHealth}` : "画像/记忆模型：未配置健康检查",
        modelSummary ? `系统模型配置：${modelSummary}` : "系统模型配置：未启用后台模型配置",
        `当前技能：${currentSkill ? `正常（${currentSkill.id} / ${currentSkill.name}）` : `异常，找不到 ${groupConfig.currentSkillId}`}`,
        `允许技能：${missingAllowedSkillIds.length === 0 ? `正常（${groupConfig.allowedSkillIds.length} 个）` : `异常，缺失 ${missingAllowedSkillIds.join("、")}`}`,
        `定时任务：${groupConfig.scheduledRemindersEnabled === false ? "总开关已关闭" : "总开关已开启"}，${scheduledTasks.length} 个${nextTask ? `，下次 ${formatLocalDateTime(new Date(nextTask.nextRunAt))}` : ""}`,
        `群聊日报：${groupConfig.dailyReportEnabled === false ? "已关闭" : `已开启，${groupConfig.dailyReportTime ?? "17:59"}`}`,
        `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : `已开启，${groupConfig.holidayCountdownTime ?? "09:00"}`}`,
        `管理员配置：本群 ${groupConfig.switcherUserIds.length} 人，黑名单 ${(groupConfig.blacklistedUserIds ?? []).length} 人`,
      ].join("\n"),
    );
  }

  private async getProfileHealthSummary(): Promise<string | undefined> {
    if (!this.profileReplyAiService) {
      return undefined;
    }
    try {
      const health = await this.profileReplyAiService.checkHealth({ cacheTtlMs: 60 * 1000 });
      const status = health.ok ? "正常" : "异常";
      const failure = health.failureKind ? `，类型 ${formatFailureKind(health.failureKind)}` : "";
      const latency = Number.isFinite(health.latencyMs) ? `，${health.latencyMs}ms` : "";
      return `${status}${failure}${latency}，${health.model}`;
    } catch (error) {
      return `异常，健康检查失败：${error instanceof Error ? error.message : String(error)}`;
    }
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

    if (!(await this.isAdmin(groupConfig, userId))) {
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

    if (!(await this.isAdmin(groupConfig, userId))) {
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

    if (!(await this.isAdmin(groupConfig, userId))) {
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
          `运维告警：${groupConfig.opsAlertsEnabled === false ? "已关闭" : "已开启"}`,
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
      await this.sendText(groupId, updated.opsAlertsEnabled === false ? "已关闭当前群运维告警" : "已开启当前群运维告警");
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

      if (!(await this.isAdmin(groupConfig, userId))) {
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

    const isAdmin = await this.isAdmin(groupConfig, userId);
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
    await this.sendText(groupId, `已拉黑 ${targetQq}，之后不会回复他的消息`);
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
      if (!(await this.isAdmin(groupConfig, userId))) {
        await this.sendText(groupId, MSG_DAILY_REPORT_NO_PERMISSION);
        return;
      }

      await this.groupLock.run(groupId, async () => {
        const report = await this.dailyReportService.buildReport(groupConfig, new Date());
        await this.sendText(groupId, report);
      });
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
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

    if (
      normalized === HOLIDAY_COUNTDOWN_PREFIX ||
      normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 查看` ||
      normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 状态`
    ) {
      const preview = await this.holidayCountdownService.buildCountdownMessage(new Date());
      const status = `节假日倒计时：${groupConfig.holidayCountdownEnabled === false ? "已关闭" : "已开启"}\n发送时间：${
        groupConfig.holidayCountdownTime ?? "09:00"
      }`;
      await this.sendText(groupId, `${status}\n\n${preview}`);
      return;
    }

    const manualRegex = new RegExp(`^${escapeRegex(HOLIDAY_COUNTDOWN_PREFIX)}\\s*(?:发送|预览)$`);
    if (manualRegex.test(normalized)) {
      if (!(await this.isAdmin(groupConfig, userId))) {
        await this.sendText(groupId, MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION);
        return;
      }

      await this.groupLock.run(groupId, async () => {
        const message = await this.holidayCountdownService.buildCountdownMessage(new Date());
        await this.sendText(groupId, message);
      });
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
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

      if (!(await this.isAdmin(groupConfig, userId))) {
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
    groupId: string,
    commandText: string,
    runtimeCommands: SystemCommandConfig[],
  ): Promise<void> {
    await this.sendText(groupId, buildFeatureListMessage(commandText, runtimeCommands));
  }

  private async handleAdminCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();
    const isAdmin = await this.isAdmin(groupConfig, userId);
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
      await this.conversationStore.clearUser(groupId, userId);
      await this.sendText(groupId, "已清空你在当前群的对话上下文");
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_CONVERSATION_NO_PERMISSION);
      return;
    }

    if (targetInput === "全部" || targetInput.toLowerCase() === "all") {
      await this.conversationStore.clearGroup(groupId);
      await this.logAdminOperation(groupId, userId, "清空对话", "全部");
      await this.sendText(groupId, "已清空当前群全部成员的对话上下文");
      return;
    }

    const targetQq = extractQqFromInput(targetInput);
    if (!targetQq) {
      await this.sendText(groupId, MSG_INVALID_QQ);
      return;
    }

    await this.conversationStore.clearUser(groupId, targetQq);
    await this.logAdminOperation(groupId, userId, "清空对话", targetQq);
    await this.sendText(groupId, `已清空 ${targetQq} 在当前群的对话上下文`);
  }

  private async handleClearGroupContextCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_CONVERSATION_NO_PERMISSION);
      return;
    }

    await this.conversationStore.clearGroup(groupId);
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
  ): Promise<void> {
    const options: ConversationOptions = typeof optionsOrAllowControlledMention === "boolean"
      ? { allowControlledMention: optionsOrAllowControlledMention }
      : optionsOrAllowControlledMention;
    const skill = await this.resolveSkill(groupConfig);
    const history = await this.conversationStore.getTurns(groupConfig.groupId, userId);
    const normalizedUserInput = userInput.trim() || "[图片消息]";
    const [groupMemories, knowledgeHits, napcatMembers] = await Promise.all([
      this.groupMemoryStore?.listEnabled(groupConfig.groupId, 20) ?? Promise.resolve([]),
      this.knowledgeBaseStore?.search(
        groupConfig.groupId,
        [
          normalizedUserInput,
          messageContext.replyContext?.text ?? "",
          ...messageContext.interactionTargets.flatMap((target) => target.names),
        ].join(" "),
        3,
      ).then((hits) => hits.map((hit) => hit.entry)) ?? Promise.resolve([]),
      this.safeListGroupMembers(groupConfig.groupId),
    ]);
    const memberProfiles = groupMemories.length > 0
      ? buildGroupMemberProfiles({
          groupConfig,
          napcatMembers,
          memories: groupMemories,
        })
      : [];
    const allImages = [
      ...images,
      ...(messageContext.replyContext?.images ?? []),
    ];
    const resolvedImages = this.transport.resolveImageInputs
      ? await this.transport.resolveImageInputs(allImages)
      : allImages.filter((image) => Boolean(image.url));
    const identityContext = {
      groupId: groupConfig.groupId,
      currentUserId: userId,
      botUserId: this.botQq,
      manualIdentities: groupConfig.manualIdentities,
      ...(memberProfiles.length > 0 ? { memberProfiles } : {}),
      ...(groupMemories.length > 0 ? { groupMemories } : {}),
      ...(knowledgeHits.length > 0 ? { knowledgeHits } : {}),
      ...(messageContext.interactionTargets.length > 0
        ? { interactionTargets: messageContext.interactionTargets }
        : {}),
      ...(messageContext.replyContext ? { replyContext: messageContext.replyContext } : {}),
    };
    const replyArgs = {
      skill,
      history,
      userInput: normalizedUserInput,
      images: resolvedImages,
      identityContext,
      ...(options.scenarioInstruction ? { scenarioInstruction: options.scenarioInstruction } : {}),
    };

    try {
      const { reply, usedMode, fallbackUsed } = await this.generateReplyWithSelectedModel(groupConfig, replyArgs);
      const resolvedMentionUserIds = await this.resolveMentionUserIds(
        groupConfig.groupId,
        prefixMentionUserIds,
      );
      const replyText = sanitizeMentionEcho(reply.text, buildSanitizeTargets(messageContext));
      const controlledMentionUserId =
        options.allowControlledMention === true && resolvedMentionUserIds.length === 0 && replyMode === "text"
          ? await this.resolveControlledMentionUserId({
              groupConfig,
              skill,
              history,
              userInput: normalizedUserInput,
              assistantReply: replyText,
              identityContext,
            })
          : undefined;
      const outgoingMentionUserIds = controlledMentionUserId
        ? [controlledMentionUserId]
        : resolvedMentionUserIds;

      const now = new Date().toISOString();
      const turns: ConversationTurn[] = [
        {
          groupId: groupConfig.groupId,
          role: "user",
          content:
            resolvedImages.length > 0 && normalizedUserInput !== "[图片消息]"
              ? `${normalizedUserInput} [附带${resolvedImages.length}张图片]`
              : normalizedUserInput,
          userId,
          timestamp: now,
        },
        {
          groupId: groupConfig.groupId,
          role: "assistant",
          content: replyText,
          timestamp: now,
        },
      ];

      await this.conversationStore.appendDialogue(
        groupConfig.groupId,
        userId,
        turns,
        skill.maxContextTurns * 2,
      );

      if (replyMode === "voice" || replyMode === "singing") {
        await this.handleVoiceReply(groupConfig.groupId, skill, replyText, replyMode);
        logInfo(replyMode === "singing" ? "Sent AI singing voice reply." : "Sent AI voice reply.", {
          groupId: groupConfig.groupId,
          skillId: skill.id,
          model: reply.model,
        });
        return;
      }

      const outgoingMessages = formatReplyMessages(skill, replyText);
      if (outgoingMessages.length === 0) {
        throw new Error("Formatted AI reply was empty.");
      }

      await this.sendTextMessages(groupConfig.groupId, outgoingMessages, outgoingMentionUserIds);

      logInfo("Sent AI reply.", {
        groupId: groupConfig.groupId,
        skillId: skill.id,
        model: reply.model,
        replyModelMode: usedMode,
        fallbackUsed,
        messageCount: outgoingMessages.length,
      });
    } catch (error) {
      logError("Failed to generate AI reply.", {
        groupId: groupConfig.groupId,
        error: (error as Error).message,
      });
      await this.sendText(groupConfig.groupId, MSG_AI_FAIL);
    }
  }

  private async resolveControlledMentionUserId(args: {
    groupConfig: GroupBotConfig;
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: {
      groupId: string;
      currentUserId: string;
      botUserId?: string;
      manualIdentities?: GroupBotConfig["manualIdentities"];
      interactionTargets?: AiInteractionTarget[];
      replyContext?: AiReplyContext;
    };
  }): Promise<string | undefined> {
    if (!args.groupConfig.manualIdentities || args.groupConfig.manualIdentities.length === 0) {
      return undefined;
    }

    const decision = await this.aiService.evaluateControlledMention?.({
      skill: args.skill,
      history: args.history,
      userInput: args.userInput,
      assistantReply: args.assistantReply,
      identityContext: args.identityContext,
    });

    const target = resolveManualIdentityTargetFromDecision(args.groupConfig, decision);
    if (!target?.userId) {
      return undefined;
    }

    return target.userId;
  }

  private async generateReplyWithSelectedModel(
    groupConfig: GroupBotConfig,
    args: {
      skill: SkillDefinition;
      history: ConversationTurn[];
      userInput: string;
      images?: MessageImageInput[];
      identityContext?: AiIdentityContext;
      scenarioInstruction?: string;
    },
  ): Promise<ReplyAiResult> {
    const route = await this.getReplyAiRoute(groupConfig);

    try {
      return {
        reply: await route.service.generateReply(args),
        usedMode: route.mode,
        fallbackUsed: false,
      };
    } catch (error) {
      if (!route.fallback || route.fallback.service === route.service) {
        throw error;
      }

      logWarn("Primary reply model failed; trying fallback reply model.", {
        groupId: groupConfig.groupId,
        primaryMode: route.mode,
        primaryLabel: route.label,
        fallbackMode: route.fallback.mode,
        fallbackLabel: route.fallback.label,
        error: (error as Error).message,
      });

      return {
        reply: await route.fallback.service.generateReply(args),
        usedMode: route.fallback.mode,
        fallbackUsed: true,
      };
    }
  }

  private async getReplyAiRoute(groupConfig: GroupBotConfig): Promise<ReplyAiRoute> {
    const mode = normalizeReplyModelMode(groupConfig.replyModelMode);
    const options = await this.getReplyModelOptions({ allowEnvironmentFallback: true });
    const primary = options.find((option) => option.mode === mode) ?? options.find((option) => option.mode === "gpt") ?? options[0]!;
    const fallback = options.find((option) => option.mode !== primary.mode);
    return {
      ...primary,
      ...(fallback ? { fallback } : {}),
    };
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
          label: this.formatConfiguredReplyModelLabel(model.id, model.shortName || model.name),
          service: new ConfiguredAiService(this.aiService, this.systemSettingsStore, "reply", undefined, model.id),
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
    };
  }

  private async formatReplyModelName(mode: ReplyModelMode): Promise<string> {
    const configured = await this.getRuntimeReplyModelLabel(mode) ?? this.replyModelLabels[mode]?.trim();
    if (configured) {
      return this.formatConfiguredReplyModelLabel(mode, configured);
    }
    return mode === "mimo" ? "Mimo（mimo-v2.5-pro）" : "GPT";
  }

  private formatConfiguredReplyModelLabel(mode: ReplyModelMode, name: string): string {
    if (mode === "mimo") return `Mimo（${name}）`;
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
        item.shortName.trim()
      );
      return model?.shortName.trim();
    } catch (error) {
      logWarn("Failed to load runtime reply model label.", {
        mode,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  private async handleVoiceReply(
    groupId: string,
    skill: SkillDefinition,
    replyText: string,
    mode: Exclude<ReplyOutputMode, "text"> = "voice",
  ): Promise<void> {
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const synthesis = await this.ttsService.synthesize(replyText, skill, {
        mode: mode === "singing" ? "singing" : "speech",
      });
      cleanup = synthesis.cleanup;
      await this.sendRecord(groupId, synthesis.recordFile);
      scheduleCleanup(synthesis.cleanup);
      return;
    } catch (error) {
      if (cleanup) {
        scheduleCleanup(cleanup);
      }
      logWarn("Primary TTS voice send failed.", {
        groupId,
        skillId: skill.id,
        error: (error as Error).message,
        ...formatTtsErrorMeta(error),
      });
    }

    if (mode === "singing") {
      await this.sendText(groupId, "当前 TTS 模型不支持唱歌，请切换到 mimo-v2.5-tts 后再试。");
      const outgoingMessages = formatReplyMessages(skill, replyText);
      await this.sendTextMessages(groupId, outgoingMessages);
      return;
    }

    if (!this.allowNapCatAiVoiceFallback) {
      await this.sendText(groupId, MSG_VOICE_FAIL);
      const outgoingMessages = formatReplyMessages(skill, replyText);
      await this.sendTextMessages(groupId, outgoingMessages);
      return;
    }

    try {
      await this.sendAiRecord(groupId, replyText);
    } catch (fallbackError) {
      logError("Voice fallback failed.", {
        groupId,
        skillId: skill.id,
        error: (fallbackError as Error).message,
      });
      await this.sendText(groupId, MSG_VOICE_FAIL);
      const outgoingMessages = formatReplyMessages(skill, replyText);
      await this.sendTextMessages(groupId, outgoingMessages);
    }
  }

  private async handleSkillCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();

    if (normalized === SKILL_PREFIX || normalized === `${SKILL_PREFIX} 列表`) {
      const allowedSkills = await this.getAllowedSkills(groupConfig);
      const lines = allowedSkills.map((skill) => {
        const activeMark = skill.id === groupConfig.currentSkillId ? " [当前]" : "";
        return `- ${skill.id}: ${skill.name}${activeMark}`;
      });
      await this.sendText(groupConfig.groupId, `可用技能列表：\n${lines.join("\n")}`);
      return;
    }

    const switchRegex = new RegExp(`^${escapeRegex(SKILL_PREFIX)}\\s*切换\\s+(.+)$`);
    const match = normalized.match(switchRegex);
    if (!match) {
      await this.sendText(groupConfig.groupId, "技能命令格式：#技能 列表 或 #技能 切换 <skillId>");
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupConfig.groupId, "你没有切换技能的权限");
      return;
    }

    const targetSkillId = match[1].trim();
    if (!groupConfig.allowedSkillIds.includes(targetSkillId)) {
      await this.sendText(groupConfig.groupId, `当前群不允许切换到技能 ${targetSkillId}`);
      return;
    }

    const skill = await this.skillService.getSkill(targetSkillId);
    if (!skill) {
      await this.sendText(groupConfig.groupId, `技能 ${targetSkillId} 不存在`);
      return;
    }

    await this.groupConfigService.updateCurrentSkill(groupConfig.groupId, targetSkillId);
    await this.conversationStore.clearGroup(groupConfig.groupId);
    await this.logAdminOperation(groupConfig.groupId, userId, "技能切换", targetSkillId, skill.name);
    await this.sendText(
      groupConfig.groupId,
      `已切换到技能 ${skill.name}（${skill.id}），并清空当前群上下文`,
    );
  }

  private async handleModelCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);
    const normalized = commandText.replace(/\s+/g, " ").trim();
    const currentMode = normalizeReplyModelMode(groupConfig.replyModelMode);
    const options = await this.getReplyModelOptions();
    const currentLabel = options.find((option) => option.mode === currentMode)?.label ?? await this.formatReplyModelName(currentMode);

    if (normalized === MODEL_PREFIX || normalized === `${MODEL_PREFIX}状态` || normalized === `${MODEL_PREFIX} 状态` || normalized === `${MODEL_PREFIX} 列表`) {
      const lines = options.map((option) => {
        const activeMark = option.mode === currentMode ? " [当前]" : "";
        return `- ${option.mode}: ${option.label}${activeMark}`;
      });
      await this.sendText(groupId, `当前群聊回复模型：${currentLabel}\n可切换模型：\n${lines.join("\n")}`);
      return;
    }

    const switchRegex = new RegExp(`^${escapeRegex(MODEL_PREFIX)}\\s*(?:切换\\s*)?(.+)$`, "i");
    const match = normalized.match(switchRegex);
    if (!match) {
      await this.sendText(groupId, `模型命令格式：#模型状态 或 #模型切换 <模型ID>\n可用模型：${options.map((option) => option.mode).join("、")}`);
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, "你没有切换群聊回复模型的权限");
      return;
    }

    const rawTarget = match[1]!.trim();
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

  private async handleMemoryStatusCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_STATUS_NO_PERMISSION);
      return;
    }

    const memories = this.groupMemoryStore ? await this.groupMemoryStore.list(groupId) : [];
    const pendingCandidates = this.groupMemoryCandidateService
      ? await this.groupMemoryCandidateService.list({ groupId, status: "pending" })
      : [];
    const enabledCount = memories.filter((memory) => memory.enabled).length;
    await this.sendText(
      groupId,
      [
        `群记忆状态：群 ${groupId}`,
        `长期记忆：${enabledCount}/${memories.length} 条启用`,
        `候选记忆：${pendingCandidates.length} 条待审核`,
        `后台：${this.adminPublicBaseUrl ?? "未配置"}`,
      ].join("\n"),
    );
  }

  private async handleKnowledgeStatusCommand(groupConfig: GroupBotConfig, event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = groupConfig.groupId;
    const userId = String(event.user_id);

    if (!(await this.isAdmin(groupConfig, userId))) {
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
        `检索方式：关键词 Top 3`,
        `后台：${this.adminPublicBaseUrl ?? "未配置"}`,
      ].join("\n"),
    );
  }

  private async handleYesterdayProfileCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    if (!this.dailyProfileReviewService || !this.groupMemoryStore) {
      await this.sendText(groupConfig.groupId, "画像功能未启用");
      return;
    }

    const requesterUserId = String(event.user_id);
    const target = await this.resolveProfileCommandTarget(groupConfig, requesterUserId, commandText, YESTERDAY_PROFILE_PREFIX);
    if (!target.userId) {
      await this.sendText(groupConfig.groupId, target.label ?? "没有找到这个成员，请用 QQ 号查询");
      return;
    }
    const members = await this.buildMemberProfiles(groupConfig);
    const dateKey = getYesterdayDateKey(new Date());
    const summary = await this.dailyProfileReviewService.getOrCreateYesterdaySummary({
      groupConfig,
      userId: target.userId,
      dateKey,
      members,
    });
    const label = buildProfileDisplayLabel(groupConfig, target.userId, members);
    if (!summary) {
      await this.sendText(groupConfig.groupId, `${label} 昨日没有新增画像记忆`);
      return;
    }

    await this.sendText(
      groupConfig.groupId,
      [
        `${label} 的昨日画像（${dateKey}）：`,
        await this.buildConfiguredProfileShortSummary(summary.content),
        await this.buildPublicProfileShareHint({
          groupConfig,
          userId: target.userId,
          type: "yesterday",
          summary: summary.content,
          sourceMemoryCount: 1,
          generatedAt: summary.updatedAt ?? summary.createdAt,
        }),
      ].join("\n"),
    );
  }

  private async handleGroupProfileCommand(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    commandText: string,
  ): Promise<void> {
    if (!this.dailyProfileReviewService || !this.groupMemoryStore) {
      await this.sendText(groupConfig.groupId, "画像功能未启用");
      return;
    }

    const requesterUserId = String(event.user_id);
    const target = await this.resolveProfileCommandTarget(groupConfig, requesterUserId, commandText, GROUP_PROFILE_PREFIX);
    if (!target.userId) {
      await this.sendText(groupConfig.groupId, target.label ?? "没有找到这个成员，请用 QQ 号查询");
      return;
    }
    const members = await this.buildMemberProfiles(groupConfig);
    const label = buildProfileDisplayLabel(groupConfig, target.userId, members);
    const summary = await this.dailyProfileReviewService.summarizeOverallProfile({
      groupConfig,
      userId: target.userId,
      members,
    });
    if (!summary) {
      await this.sendText(groupConfig.groupId, `${label} 暂无群聊画像`);
      return;
    }

    await this.sendText(
      groupConfig.groupId,
      [
        `${label} 的群聊画像：`,
        await this.buildConfiguredProfileShortSummary(summary),
        await this.buildPublicProfileShareHint({
          groupConfig,
          userId: target.userId,
          type: "overall",
          summary,
        }),
      ].join("\n"),
    );
  }

  private async buildPublicProfileShareHint(args: {
    groupConfig: GroupBotConfig;
    userId: string;
    type: "overall" | "yesterday";
    summary: string;
    sourceMemoryCount?: number;
    generatedAt?: string;
  }): Promise<string> {
    const label = args.type === "yesterday" ? "昨日画像" : "群聊画像";
    if (!this.profileRecordStore || !this.adminPublicBaseUrl) {
      return `完整${label}链接生成失败，请稍后重试`;
    }
    try {
      const record = await this.profileRecordStore.create({
        groupId: args.groupConfig.groupId,
        userId: args.userId,
        type: args.type,
        summary: args.summary,
        sourceMemoryCount: args.sourceMemoryCount ?? 0,
        generatedAt: args.generatedAt,
        createdBy: "bot_command",
      });
      if (!record.shareToken) {
        return `完整${label}链接生成失败，请稍后重试`;
      }
      return `完整${label}：${buildPublicProfileShareUrl(this.adminPublicBaseUrl, record.shareToken)}`;
    } catch (error) {
      logWarn("Failed to create public profile record.", {
        groupId: args.groupConfig.groupId,
        userId: args.userId,
        type: args.type,
        error: (error as Error).message,
      });
      return `完整${label}链接生成失败，请稍后重试`;
    }
  }

  private async recordDailyReportMessage(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    parsedMessage: ReturnType<typeof parseGroupMessage>,
  ): Promise<void> {
    if (groupConfig.dailyReportEnabled === false) {
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
    });
  }

  private async buildConfiguredProfileShortSummary(summary: string): Promise<string> {
    return buildProfileShortSummary(summary, await this.getProfileShortSummaryMaxChars());
  }

  private async getProfileShortSummaryMaxChars(): Promise<number> {
    if (!this.systemSettingsStore) {
      return 140;
    }
    try {
      const settings = await this.systemSettingsStore.get();
      return settings.profileShortSummaryMaxChars;
    } catch (error) {
      logWarn("Failed to load profile short summary limit; using default.", {
        error: (error as Error).message,
      });
      return 140;
    }
  }

  private isLiveChatUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return groupConfig.liveChatUserIds.includes(userId);
  }

  private isRoastModeUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return (groupConfig.roastModeUserIds ?? []).includes(userId);
  }

  private isActiveChatTrackedUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return this.isLiveChatUser(groupConfig, userId) || this.isRoastModeUser(groupConfig, userId);
  }

  private isBlacklistedUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return (groupConfig.blacklistedUserIds ?? []).includes(userId);
  }

  private queueMemoryCandidateMessage(
    groupConfig: GroupBotConfig,
    event: NapcatGroupMessageEvent,
    parsedMessage: ReturnType<typeof parseGroupMessage>,
  ): void {
    const userId = String(event.user_id);
    if (
      !this.groupMemoryCandidateService ||
      groupConfig.enabled === false ||
      (groupConfig.memoryDisabledUserIds ?? []).includes(userId) ||
      !parsedMessage.text ||
      parsedMessage.images.length > 0
    ) {
      return;
    }

    this.groupMemoryCandidateService.queueMessage({
      groupId: groupConfig.groupId,
      userId,
      userName: resolveSenderName(event),
      text: parsedMessage.text,
      timestamp: new Date().toISOString(),
    });
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

  private async isAdmin(groupConfig: GroupBotConfig, userId: string): Promise<boolean> {
    if (groupConfig.switcherUserIds.includes(userId)) {
      return true;
    }

    return this.groupConfigService.isSuperAdmin(userId);
  }

  private async resolveSkill(groupConfig: GroupBotConfig): Promise<SkillDefinition> {
    const skill = await this.skillService.getSkill(groupConfig.currentSkillId);
    if (!skill) {
      throw new Error(`Skill ${groupConfig.currentSkillId} not found.`);
    }
    return skill;
  }

  private async getAllowedSkills(groupConfig: GroupBotConfig): Promise<SkillDefinition[]> {
    const skills = await Promise.all(
      groupConfig.allowedSkillIds.map((skillId) => this.skillService.getSkill(skillId)),
    );
    return skills.filter((skill): skill is SkillDefinition => Boolean(skill));
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

  private async safeListGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    if (!this.transport.listGroupMembers) {
      return [];
    }

    try {
      return await this.transport.listGroupMembers(groupId);
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

  private async buildMemberProfiles(groupConfig: GroupBotConfig) {
    const [napcatMembers, memories, candidates] = await Promise.all([
      this.safeListGroupMembers(groupConfig.groupId),
      this.groupMemoryStore ? this.groupMemoryStore.list(groupConfig.groupId) : Promise.resolve([]),
      this.groupMemoryCandidateService ? this.groupMemoryCandidateService.list({ groupId: groupConfig.groupId }) : Promise.resolve([]),
    ]);
    return buildGroupMemberProfiles({
      groupConfig,
      napcatMembers,
      memories,
      candidates,
    });
  }

  private async resolveProfileCommandTarget(
    groupConfig: GroupBotConfig,
    requesterUserId: string,
    commandText: string,
    prefix: string,
  ): Promise<ProfileTargetResolution> {
    const rawTarget = commandText.slice(prefix.length).trim();
    if (!rawTarget) {
      return { status: "ok", userId: requesterUserId };
    }

    const members = await this.buildMemberProfiles(groupConfig);
    const resolution = resolveProfileTarget(groupConfig, members, rawTarget);
    if (resolution.status === "ambiguous") {
      return {
        ...resolution,
        label: `匹配到多个人：${(resolution.matches ?? []).join("、")}，请用 QQ 号查询`,
      };
    }
    if (resolution.status === "not_found") {
      return {
        ...resolution,
        label: "没有找到这个成员，请用 QQ 号查询",
      };
    }
    return resolution;
  }

  private async logAdminOperation(
    groupId: string,
    operatorUserId: string,
    action: string,
    target?: string,
    detail?: string,
  ): Promise<void> {
    try {
      await this.adminOperationLogService.record({
        groupId,
        operatorUserId,
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

    const superAdminUserIds = await this.groupConfigService.getSuperAdminUserIds();
    const textByGroup = new Map<string, string>();
    for (const group of args.groups) {
      const mentionUserIds = group.switcherUserIds.length > 0 ? group.switcherUserIds : superAdminUserIds;
      textByGroup.set(
        group.groupId,
        `${formatOpsAlertMentions(mentionUserIds)}【运维告警】${args.message}`.trim(),
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
    const groups = (await this.getEnabledGroupConfigs()).filter((group) => group.opsAlertsEnabled !== false);
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

    const groups = (await this.getEnabledGroupConfigs()).filter((group) => group.opsAlertsEnabled !== false);
    await this.sendOpsAlertToGroups({
      groups,
      type: "send-recovered",
      now: new Date(),
      message: `消息发送已恢复，之前连续失败 ${previousFailures} 次`,
    });
  }

  private async sendText(groupId: string, text: string): Promise<void> {
    try {
      await this.transport.sendGroupMessage(groupId, text);
      this.liveChatService.recordBotActivity(groupId);
      await this.handleSendSuccessRecovery();
    } catch (error) {
      await this.handleSendFailure(error);
      throw error;
    }
  }

  private async sendTextMessages(
    groupId: string,
    messages: string[],
    mentionUserIds: string[] = [],
  ): Promise<void> {
    for (const [index, message] of messages.entries()) {
      const outgoingText =
        index === 0 && mentionUserIds.length > 0
          ? prefixAtMentions(mentionUserIds, message)
          : message;
      await this.sendText(groupId, outgoingText);

      if (index < messages.length - 1) {
        await sleep(MULTI_MESSAGE_DELAY_MS);
      }
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
  ): Promise<MessageInteractionContext> {
    const interactionTargets = await this.resolveInteractionTargets(
      groupConfig,
      parsedMessage.mentionUserIds,
      "mention",
    );
    const replyContext = await this.resolveReplyContext(groupConfig, parsedMessage.replyMessageId);

    if (replyContext) {
      interactionTargets.push(
        ...buildInteractionTargetsFromReply(groupConfig, replyContext),
      );
    }

    return {
      interactionTargets: dedupeInteractionTargets(interactionTargets),
      replyContext,
    };
  }

  private async resolveInteractionTargets(
    groupConfig: GroupBotConfig,
    candidates: string[],
    source: AiInteractionTarget["source"],
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

  private async resolveReplyContext(
    groupConfig: GroupBotConfig,
    replyMessageId?: string,
  ): Promise<AiReplyContext | undefined> {
    if (!replyMessageId || !this.transport.getMessage) {
      return undefined;
    }

    try {
      const referenced = await this.transport.getMessage(replyMessageId);
      if (!referenced) {
        return undefined;
      }

      const manualTarget = referenced.userId
        ? resolveManualIdentityTarget(groupConfig, referenced.userId, "reply")
        : undefined;
      const primaryName =
        manualTarget?.names[0] ?? referenced.userName ?? referenced.userId;

      return {
        messageId: referenced.messageId,
        userId: referenced.userId,
        userName: primaryName,
        text: buildReferencedMessageText(referenced),
        images: referenced.images,
      };
    } catch (error) {
      logWarn("Failed to load referenced message context.", {
        groupId: groupConfig.groupId,
        replyMessageId,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  private async sendRecord(groupId: string, recordFile: string): Promise<void> {
    await this.transport.sendGroupRecord(groupId, recordFile);
    this.liveChatService.recordBotActivity(groupId);
  }

  private async sendAiRecord(groupId: string, text: string): Promise<void> {
    await this.transport.sendGroupAiRecord(groupId, text);
    this.liveChatService.recordBotActivity(groupId);
  }
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

function isHelpCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return HELP_PREFIXES.some((prefix) => new RegExp(`^${escapeRegex(prefix)}(?:\\s+.+)?$`).test(normalized));
}

function isStatusCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === STATUS_PREFIX || normalized === `${STATUS_PREFIX} 查看`;
}

function isHealthCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === HEALTH_PREFIX || normalized === SHORT_HEALTH_PREFIX;
}

function isOperationLogCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === OPERATION_LOG_PREFIX || normalized === `${OPERATION_LOG_PREFIX} 查看`;
}

function isServerCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === SERVER_PREFIX || normalized === `${SERVER_PREFIX} 状态` || normalized === `${SERVER_PREFIX} 查看`;
}

function isMemoryStatusCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === MEMORY_PREFIX || normalized === `${MEMORY_PREFIX} 状态` || normalized === `${MEMORY_PREFIX} 查看`;
}

function isKnowledgeStatusCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return normalized === KNOWLEDGE_PREFIX || normalized === `${KNOWLEDGE_PREFIX} 状态` || normalized === `${KNOWLEDGE_PREFIX} 查看`;
}

function resolveProfileTarget(
  groupConfig: GroupBotConfig,
  members: GroupMemberProfile[],
  target: string,
): ProfileTargetResolution {
  const normalized = normalizeProfileQuery(target);
  if (!normalized) {
    return { status: "not_found" };
  }

  const userIds = new Set<string>();
  for (const member of members) {
    userIds.add(member.userId);
  }
  for (const identity of groupConfig.manualIdentities ?? []) {
    for (const userId of identity.userIds) {
      userIds.add(userId);
    }
  }

  if (/^\d+$/.test(target.trim()) && userIds.has(target.trim())) {
    return { status: "ok", userId: target.trim() };
  }

  const candidates = [...userIds].map((userId) => {
    const member = members.find((item) => item.userId === userId);
    const identities = (groupConfig.manualIdentities ?? []).filter((identity) => identity.userIds.includes(userId));
    const texts = [
      userId,
      member?.displayName,
      member?.card,
      member?.nickname,
      member?.note,
      ...(member?.aliases ?? []),
      ...identities.flatMap((identity) => [identity.note, ...identity.names]),
    ].filter((value): value is string => Boolean(value?.trim()));
    return {
      userId,
      label: member ? buildMemberDisplayLabel(member) : `QQ ${userId}`,
      normalizedTexts: Array.from(new Set(texts.map(normalizeProfileQuery).filter(Boolean))),
    };
  });

  const exactMatches = candidates.filter((candidate) => candidate.normalizedTexts.includes(normalized));
  if (exactMatches.length === 1) {
    return { status: "ok", userId: exactMatches[0]!.userId };
  }
  if (exactMatches.length > 1) {
    return { status: "ambiguous", matches: exactMatches.map((match) => match.label) };
  }

  const fuzzyMatches = candidates.filter((candidate) =>
    candidate.normalizedTexts.some((text) => text.includes(normalized) || normalized.includes(text)),
  );
  if (fuzzyMatches.length === 1) {
    return { status: "ok", userId: fuzzyMatches[0]!.userId };
  }
  if (fuzzyMatches.length > 1) {
    return { status: "ambiguous", matches: fuzzyMatches.slice(0, 5).map((match) => match.label) };
  }

  return { status: "not_found" };
}

function buildProfileDisplayLabel(
  groupConfig: GroupBotConfig,
  userId: string,
  members: GroupMemberProfile[],
): string {
  const member = members.find((item) => item.userId === userId);
  if (member) {
    return buildMemberDisplayLabel(member);
  }

  const identity = groupConfig.manualIdentities?.find((item) => item.userIds.includes(userId));
  const name = identity?.names[0] ?? userId;
  return identity?.note ? `${name}（QQ ${userId}，备注：${identity.note}）` : `${name}（QQ ${userId}）`;
}

function buildMemberDisplayLabel(member: GroupMemberProfile): string {
  return member.note
    ? `${member.displayName}（QQ ${member.userId}，备注：${member.note}）`
    : `${member.displayName}（QQ ${member.userId}）`;
}

function normalizeProfileQuery(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function formatOpsAlertMentions(userIds: string[]): string {
  const mentions = userIds
    .map((userId) => userId.trim())
    .filter((userId) => /^\d+$/.test(userId))
    .map((userId) => `[CQ:at,qq=${userId}]`);
  return mentions.length > 0 ? `${mentions.join(" ")} ` : "";
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
  const replyContext = [...messages].reverse().find((message) => message.replyContext)?.replyContext;

  return {
    interactionTargets: dedupeInteractionTargets(interactionTargets),
    replyContext,
  };
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

function sanitizeMentionEcho(text: string, targets: AiInteractionTarget[]): string {
  let sanitized = text;

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

  const identity = groupConfig.manualIdentities?.find((item) => {
    const ids = item.userIds.map(normalizeIdentityCandidate);
    const names = item.names.map(normalizeIdentityCandidate);
    return ids.includes(normalizedCandidate) || names.includes(normalizedCandidate);
  });

  if (!identity) {
    return undefined;
  }

  return {
    userId: identity.userIds[0],
    names: normalizeNames(identity.names),
    source,
  };
}

function resolveManualIdentityTargetFromDecision(
  groupConfig: GroupBotConfig,
  decision?: ControlledMentionDecision,
): AiInteractionTarget | undefined {
  const target = decision?.target?.trim();
  if (!decision?.shouldMention || !target) {
    return undefined;
  }

  const matches =
    groupConfig.manualIdentities?.filter((identity) => {
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

function formatClockTime(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function isScheduledMinute(date: Date, hour: number, minute: number): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return get("hour") === hour && get("minute") === minute;
}

function isScheduledClockMinute(date: Date, time: string): boolean {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/.exec(time);
  if (!match?.groups) {
    return false;
  }
  return isScheduledMinute(date, Number(match.groups.hour), Number(match.groups.minute));
}

function getHongKongDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

function buildFeatureListMessage(commandText = "", commands: SystemCommandConfig[] = []): string {
  const topic = parseHelpTopic(commandText);
  const helper = createCommandHelpFormatter(commands);
  const sections = buildHelpSections(helper);

  if (!topic) {
    return buildHelpOverviewMessage(sections, helper);
  }

  const matchedSection = sections.find((section) => section.aliases.includes(topic));
  if (!matchedSection) {
    return [
      `没找到“${topic}”这个帮助分类`,
      "",
      "可用分类：对话、语音、技能、实时对话、定时任务、日报、节假日、管理员、权限",
      `示例：${helper("help")} 技能`,
      "",
      buildHelpOverviewMessage(sections, helper),
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
  title: string;
  aliases: string[];
  lines: string[];
};

function buildHelpSections(command: CommandHelpFormatter): HelpSection[] {
  return [
    {
      title: "对话",
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
    {
      title: "语音",
      aliases: ["语音", "tts", "voice"],
      lines: [
        `1. ${command("voice")} <内容>`,
        "2. @机器人 语音说 <内容>",
        `3. ${command("voice_reply")} 状态 / 开启 / 关闭（管理员）`,
        `4. ${command("sing")} <内容>`,
        "作用：一次性语音会先生成回复再转成语音；默认语音回复会让普通 AI 回复优先发送语音条；唱歌使用 MiMo 唱歌模式",
      ],
    },
    {
      title: "技能",
      aliases: ["技能", "skill", "skills"],
      lines: [
        `1. ${command("skill")} 列表`,
        `2. ${command("skill")} 切换 <skillId>`,
        "权限：切换技能需要群管理员或超级管理员",
      ],
    },
    {
      title: "实时对话",
      aliases: ["实时对话", "实时", "live", "livechat"],
      lines: [
        `1. ${command("live_chat")} 列表`,
        `2. ${command("live_chat")} 添加 <QQ号>`,
        `3. ${command("live_chat")} 移除 <QQ号>`,
        `4. ${command("live_chat")} 间隔 <分钟>`,
      ],
    },
    {
      title: "定时任务",
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
      title: "日报",
      aliases: ["日报", "report"],
      lines: [
        `1. ${command("daily_report")} 状态`,
        `2. ${command("daily_report")} 发送`,
        `3. ${command("daily_report")} 开启 / 关闭`,
        `4. ${command("daily_report")} 时间 <HH:mm>`,
      ],
    },
    {
      title: "节假日",
      aliases: ["节假日", "假日", "holiday"],
      lines: [
        `1. ${command("holiday_countdown")}`,
        `2. ${command("holiday_countdown")} 状态`,
        `3. ${command("holiday_countdown")} 发送`,
        `4. ${command("holiday_countdown")} 开启 / 关闭 / 时间 <HH:mm>`,
      ],
    },
    {
      title: "管理员",
      aliases: ["管理员", "管理", "admin"],
      lines: [
        `1. ${command("admin")} 列表`,
        `2. ${command("admin")} 添加 <QQ号>`,
        `3. ${command("admin")} 移除 <QQ号>`,
        `4. ${command("status")}`,
        `5. ${command("health")}`,
        `6. ${command("server")}`,
        `7. ${command("ops_alert")} 状态 / 开启 / 关闭`,
        `8. ${command("operation_log")}`,
        `9. ${command("blacklist")} <QQ号>`,
        `10. ${command("blacklist")} 解除 <QQ号>`,
        "说明：添加和移除管理员仅超级管理员可用；拉黑命令群管理员可用",
      ],
    },
    {
      title: "权限",
      aliases: ["权限", "auth", "permission"],
      lines: [
        "普通成员：可用对话、语音、唱歌、帮助和部分状态查询",
        "群管理员：可用全部系统指令",
        "超级管理员：拥有全部权限，并可增删群管理员",
      ],
    },
  ];
}

function buildHelpOverviewMessage(sections: HelpSection[], command: CommandHelpFormatter): string {
  return [
    "系统功能总览：",
    "1. 对话：群里 @机器人 可触发当前 skill 对话，支持图片理解",
    `2. 技能：${command("skill")} 列表、${command("skill")} 切换 <skillId>`,
    `3. 语音：${command("voice")} <内容>、${command("voice_reply")} 开启/关闭、${command("sing")} <内容>`,
    `4. 实时对话：${command("live_chat")} 列表、添加、移除、间隔 <分钟>`,
    `5. 定时任务：${command("scheduled_reminder")} 列表、添加、修改、删除、状态、开启、关闭`,
    `6. 日报：${command("daily_report")} 状态、发送、开启、关闭、时间 <HH:mm>`,
    `7. 节假日：${command("holiday_countdown")}、状态、发送、开启、关闭、时间 <HH:mm>`,
    `8. 管理员：${command("admin")} 列表、添加 <QQ号>、移除 <QQ号>`,
    `9. 状态：${command("status")}、${command("health")}、${command("server")}、${command("ops_alert")}、${command("operation_log")}（管理员）`,
    `10. 闭嘴：${command("mute", { includeAliases: true }).join(" / ")}（管理员）`,
    `11. 黑名单：${command("blacklist")} <QQ号>、${command("blacklist")} 解除 <QQ号>`,
    `12. 帮助：${command("help", { includeAliases: true }).join("、")} 都能调出本列表`,
    `分类帮助：${command("help")} 对话 / 语音 / 技能 / 实时对话 / 定时任务 / 日报 / 节假日 / 管理员 / 权限`,
    "定时任务限制：仅在工作日 9:00-18:00 范围内触发",
    "权限说明：普通成员可用对话、语音、唱歌、帮助和部分查询；群管理员可用全部系统指令；超级管理员额外可管理管理员",
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
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
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
  return Array.from(new Set([
    ...groupConfig.liveChatUserIds,
    ...(groupConfig.roastModeUserIds ?? []),
  ]));
}

function shouldBufferActiveChatMessage(
  parsedMessage: ReturnType<typeof parseGroupMessage>,
  commandText: string,
): boolean {
  return !parsedMessage.hasAtBot &&
    Boolean(parsedMessage.text.trim()) &&
    !commandText.trim().startsWith("#");
}

function formatLiveChatDelay(groupConfig: GroupBotConfig): string {
  const seconds = getLiveChatDelaySeconds(groupConfig);
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

function resolveDefaultReplyMode(groupConfig: GroupBotConfig): ReplyOutputMode {
  return groupConfig.defaultVoiceReplyEnabled === true && groupConfig.voiceReplyEnabled !== false
    ? "voice"
    : "text";
}

function buildProfileShortSummary(summary: string, maxChars = 140): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  const safeMaxChars = Math.max(40, Math.min(600, Math.floor(maxChars)));
  if (normalized.length <= safeMaxChars) {
    return normalized;
  }
  const clipped = normalized.slice(0, safeMaxChars);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("！"),
    clipped.lastIndexOf("？"),
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?"),
  );
  if (sentenceEnd >= Math.min(60, safeMaxChars)) {
    return clipped.slice(0, sentenceEnd + 1).trim();
  }
  return `${normalized.slice(0, safeMaxChars).replace(/[，,、；;：:\s]+[^，,、；;：:\s]*$/, "").trim()}。`;
}

function buildPublicProfileShareUrl(adminPublicBaseUrl: string, shareToken: string): string {
  const url = new URL(adminPublicBaseUrl);
  url.pathname = `/profile/${encodeURIComponent(shareToken)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeReplyModelMode(value: unknown): ReplyModelMode {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "gpt";
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

function formatTtsErrorMeta(error: unknown): Record<string, unknown> {
  if (!(error instanceof TtsServiceError)) {
    return {};
  }
  return {
    ...(error.details.systemModelId ? { ttsSystemModelId: error.details.systemModelId } : {}),
    ttsBaseUrl: error.details.baseUrl,
    ttsModel: error.details.model,
    ...(error.details.statusCode ? { ttsStatusCode: error.details.statusCode } : {}),
    ...(error.details.failureKind ? { ttsFailureKind: error.details.failureKind } : {}),
  };
}

function formatFailureKind(kind: string): string {
  const labels: Record<string, string> = {
    auth: "鉴权失败",
    rate_limit: "限流",
    unavailable: "上游不可用",
    timeout: "超时",
    network: "网络异常",
    format_error: "响应格式异常",
    unknown: "未知",
  };
  return labels[kind] ?? kind;
}

function formatModelPurpose(purpose: string): string {
  const labels: Record<string, string> = {
    reply: "回复",
    profile: "画像",
    memory: "记忆",
    dedup: "去重",
    summary: "总结",
    tts: "语音",
  };
  return labels[purpose] ?? purpose;
}

function scheduleCleanup(cleanup: () => Promise<void>): void {
  const timer = setTimeout(() => {
    void cleanup().catch((error) => {
      logWarn("Failed to cleanup temporary TTS audio file.", {
        error: (error as Error).message,
      });
    });
  }, 15000);
  timer.unref();
}
