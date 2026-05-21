import { logError, logInfo, logWarn } from "./logger.js";
import type { AiService } from "./services/ai-service.js";
import type { ConversationStore } from "./services/conversation-store.js";
import type { DailyReportService } from "./services/daily-report-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupLock } from "./services/group-lock.js";
import type { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import type { BufferedMessage, LiveChatService } from "./services/live-chat-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { TtsService } from "./services/tts-service.js";
import type {
  ConversationTurn,
  GroupBotConfig,
  MessageImageInput,
  NapcatGroupMessageEvent,
  SkillDefinition,
} from "./types.js";
import { parseChatSummaryRequest } from "./utils/chat-summary-request.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import { formatReplyMessages } from "./utils/reply-format.js";
import { parseVoiceCommand } from "./utils/voice-command.js";

const SKILL_PREFIX = "#技能";
const VOICE_PREFIX = "#语音";
const LIVE_CHAT_PREFIX = "#实时对话";
const DAILY_REPORT_PREFIX = "#日报";
const HOLIDAY_COUNTDOWN_PREFIX = "#节假日";
const ADMIN_PREFIX = "#管理员";
const HELP_PREFIXES = ["#功能", "#帮助", "#命令"];
const LIVE_CHAT_TICK_MS = 15 * 1000;
const DAILY_REPORT_TICK_MS = 30 * 1000;
const HOLIDAY_COUNTDOWN_TICK_MS = 30 * 1000;
const MULTI_MESSAGE_DELAY_MS = 1000;

const MSG_BUSY = "我还在处理上一条消息，请稍后再 @ 我";
const MSG_AI_FAIL = "我刚刚思考超时了，请稍后再试一次";
const MSG_VOICE_FAIL = "语音发送失败，我先用文字回复你";
const MSG_LIVE_CHAT_NO_PERMISSION = "你没有管理实时对话的权限";
const MSG_INVALID_QQ = "请提供有效的 QQ 号";
const MSG_DAILY_REPORT_NO_PERMISSION = "你没有管理群聊日报的权限";
const MSG_DAILY_REPORT_BUSY = "当前群消息还在处理中，稍后再试日报命令";
const MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION = "你没有管理节假日倒计时的权限";
const MSG_HOLIDAY_COUNTDOWN_BUSY = "当前群消息还在处理中，稍后再试节假日命令";
const MSG_ADMIN_NO_PERMISSION = "你没有管理管理员的权限";

export interface MessageTransport {
  sendGroupMessage(groupId: string, text: string): Promise<void>;
  sendGroupRecord(groupId: string, recordFile: string): Promise<void>;
  sendGroupAiRecord(groupId: string, text: string): Promise<void>;
  resolveImageInputs?(images: MessageImageInput[]): Promise<MessageImageInput[]>;
  resolveMentionTargets?(groupId: string, candidates: string[]): Promise<string[]>;
}

export class BotApplication {
  private liveChatTimer?: NodeJS.Timeout;
  private dailyReportTimer?: NodeJS.Timeout;
  private holidayCountdownTimer?: NodeJS.Timeout;
  private liveChatTickRunning = false;
  private dailyReportTickRunning = false;
  private holidayCountdownTickRunning = false;

  constructor(
    private readonly transport: MessageTransport,
    private readonly groupConfigService: GroupConfigService,
    private readonly skillService: SkillService,
    private readonly conversationStore: ConversationStore,
    private readonly aiService: AiService,
    private readonly ttsService: TtsService,
    private readonly dailyReportService: DailyReportService,
    private readonly holidayCountdownService: HolidayCountdownService,
    private readonly groupLock: GroupLock,
    private readonly liveChatService: LiveChatService,
    private readonly botQq: string,
    private readonly allowNapCatAiVoiceFallback = false,
  ) {}

  start(): void {
    if (this.liveChatTimer || this.dailyReportTimer || this.holidayCountdownTimer) {
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

    if (
      (typeof event.message === "string" && event.message.trim() === "") ||
      (Array.isArray(event.message) && event.message.length === 0)
    ) {
      return;
    }

    const commandText = extractCommandText(event.message);

    if (commandText.startsWith(LIVE_CHAT_PREFIX)) {
      await this.handleLiveChatCommand(groupConfig, event, commandText);
      return;
    }

    if (isHelpCommand(commandText)) {
      await this.handleHelpCommand(groupConfig.groupId, commandText);
      return;
    }

    if (commandText.startsWith(ADMIN_PREFIX)) {
      await this.handleAdminCommand(groupConfig, event, commandText);
      return;
    }

    if (commandText.startsWith(SKILL_PREFIX)) {
      await this.handleSkillCommand(groupConfig, event, commandText);
      return;
    }

    if (commandText.startsWith(DAILY_REPORT_PREFIX)) {
      await this.handleDailyReportCommand(groupConfig, event, commandText);
      return;
    }

    if (commandText.startsWith(HOLIDAY_COUNTDOWN_PREFIX)) {
      await this.handleHolidayCountdownCommand(groupConfig, event, commandText);
      return;
    }

    const parsedMessage = parseGroupMessage(event.message, this.botQq);
    const voiceCommand = parseVoiceCommand(commandText, parsedMessage.text, parsedMessage.hasAtBot);

    if (voiceCommand.matched) {
      if (!voiceCommand.valid) {
        await this.sendText(
          groupId,
          voiceCommand.errorMessage ?? `语音命令格式：${VOICE_PREFIX} <内容>`,
        );
        return;
      }

      if (!this.groupLock.tryAcquire(groupId)) {
        await this.sendText(groupId, MSG_BUSY);
        return;
      }

      try {
        await this.handleConversation(
          groupConfig,
          userId,
          voiceCommand.userInput ?? "",
          parsedMessage.images,
          "voice",
          parsedMessage.mentionUserIds,
        );
      } finally {
        this.groupLock.release(groupId);
      }
      return;
    }

    const chatSummaryRequest = parsedMessage.hasAtBot
      ? parseChatSummaryRequest(parsedMessage.text, new Date())
      : null;

    if (chatSummaryRequest) {
      if (!this.groupLock.tryAcquire(groupId)) {
        await this.sendText(groupId, MSG_BUSY);
        return;
      }

      try {
        const summary = await this.dailyReportService.buildChatSummary({
          groupId,
          request: chatSummaryRequest,
          now: new Date(),
        });
        await this.sendText(groupId, summary);
      } finally {
        this.groupLock.release(groupId);
      }
      return;
    }

    await this.recordDailyReportMessage(groupConfig, event, parsedMessage);

    if (this.isLiveChatUser(groupConfig, userId) && !parsedMessage.hasAtBot && parsedMessage.text) {
      this.liveChatService.addMessage(groupId, userId, parsedMessage.text);
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

    if (!this.groupLock.tryAcquire(groupId)) {
      await this.sendText(groupId, MSG_BUSY);
      return;
    }

    try {
      await this.handleConversation(
        groupConfig,
        userId,
        parsedMessage.text,
        parsedMessage.images,
        "text",
        parsedMessage.mentionUserIds,
      );
    } finally {
      this.groupLock.release(groupId);
    }
  }

  private async runLiveChatTick(): Promise<void> {
    if (this.liveChatTickRunning) {
      return;
    }

    this.liveChatTickRunning = true;
    const now = Date.now();

    try {
      const groups = await this.groupConfigService.getAll();

      for (const groupConfig of groups) {
        const trackedUserIds = groupConfig.liveChatUserIds;
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

        if (!this.groupLock.tryAcquire(groupId)) {
          logInfo("Skipped live chat because group is busy.", { groupId });
          consumeWindow();
          continue;
        }

        try {
          await this.handleConversation(
            groupConfig,
            candidate.userId,
            formatBufferedMessages(candidate.messages),
            [],
            "text",
            [candidate.userId],
          );
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
          this.groupLock.release(groupId);
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
      const groups = await this.groupConfigService.getAll();

      for (const groupConfig of groups) {
        if (!(await this.dailyReportService.shouldSendScheduledReport(groupConfig, now))) {
          continue;
        }

        if (!this.groupLock.tryAcquire(groupConfig.groupId)) {
          logInfo("Skipped daily report because group is busy.", {
            groupId: groupConfig.groupId,
          });
          continue;
        }

        try {
          const report = await this.dailyReportService.buildReport(groupConfig, now);
          await this.sendText(groupConfig.groupId, report);
          await this.dailyReportService.markSent(groupConfig.groupId, now);
          logInfo("Sent daily group report.", {
            groupId: groupConfig.groupId,
            time: formatClockTime(now),
          });
        } catch (error) {
          logError("Daily report tick failed.", {
            groupId: groupConfig.groupId,
            error: (error as Error).message,
          });
        } finally {
          this.groupLock.release(groupConfig.groupId);
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
      const groups = await this.groupConfigService.getAll();

      for (const groupConfig of groups) {
        if (!(await this.holidayCountdownService.shouldSendScheduledMessage(groupConfig, now))) {
          continue;
        }

        if (!this.groupLock.tryAcquire(groupConfig.groupId)) {
          logInfo("Skipped holiday countdown because group is busy.", {
            groupId: groupConfig.groupId,
          });
          continue;
        }

        try {
          const message = await this.holidayCountdownService.buildCountdownMessage(now);
          await this.sendText(groupConfig.groupId, message);
          await this.holidayCountdownService.markSent(groupConfig.groupId, now);
          logInfo("Sent holiday countdown.", {
            groupId: groupConfig.groupId,
            time: formatClockTime(now),
          });
        } catch (error) {
          logError("Holiday countdown tick failed.", {
            groupId: groupConfig.groupId,
            error: (error as Error).message,
          });
        } finally {
          this.groupLock.release(groupConfig.groupId);
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

      if (!this.groupLock.tryAcquire(groupId)) {
        await this.sendText(groupId, MSG_DAILY_REPORT_BUSY);
        return;
      }

      try {
        const report = await this.dailyReportService.buildReport(groupConfig, new Date());
        await this.sendText(groupId, report);
      } finally {
        this.groupLock.release(groupId);
      }
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_DAILY_REPORT_NO_PERMISSION);
      return;
    }

    if (normalized === `${DAILY_REPORT_PREFIX} 开启`) {
      const updated = await this.groupConfigService.updateDailyReportEnabled(groupId, true);
      await this.sendText(groupId, `已开启群聊日报，工作日 ${updated.dailyReportTime ?? "17:59"} 自动发送`);
      return;
    }

    if (normalized === `${DAILY_REPORT_PREFIX} 关闭`) {
      await this.groupConfigService.updateDailyReportEnabled(groupId, false);
      await this.sendText(groupId, "已关闭群聊日报");
      return;
    }

    const timeMatch = normalized.match(
      new RegExp(`^${escapeRegex(DAILY_REPORT_PREFIX)}\\s*时间\\s+([01]?\\d|2[0-3]):([0-5]\\d)$`),
    );
    if (timeMatch) {
      const time = `${timeMatch[1]}:${timeMatch[2]}`;
      const updated = await this.groupConfigService.updateDailyReportTime(groupId, time);
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

      if (!this.groupLock.tryAcquire(groupId)) {
        await this.sendText(groupId, MSG_HOLIDAY_COUNTDOWN_BUSY);
        return;
      }

      try {
        const message = await this.holidayCountdownService.buildCountdownMessage(new Date());
        await this.sendText(groupId, message);
      } finally {
        this.groupLock.release(groupId);
      }
      return;
    }

    if (!(await this.isAdmin(groupConfig, userId))) {
      await this.sendText(groupId, MSG_HOLIDAY_COUNTDOWN_NO_PERMISSION);
      return;
    }

    if (normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 开启`) {
      const updated = await this.groupConfigService.updateHolidayCountdownEnabled(groupId, true);
      await this.sendText(
        groupId,
        `已开启节假日倒计时，每天 ${updated.holidayCountdownTime ?? "09:00"} 自动发送`,
      );
      return;
    }

    if (normalized === `${HOLIDAY_COUNTDOWN_PREFIX} 关闭`) {
      await this.groupConfigService.updateHolidayCountdownEnabled(groupId, false);
      await this.sendText(groupId, "已关闭节假日倒计时");
      return;
    }

    const timeMatch = normalized.match(
      new RegExp(`^${escapeRegex(HOLIDAY_COUNTDOWN_PREFIX)}\\s*时间\\s+([01]?\\d|2[0-3]):([0-5]\\d)$`),
    );
    if (timeMatch) {
      const time = `${timeMatch[1]}:${timeMatch[2]}`;
      const updated = await this.groupConfigService.updateHolidayCountdownTime(groupId, time);
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

  private async handleHelpCommand(groupId: string, commandText: string): Promise<void> {
    await this.sendText(groupId, buildFeatureListMessage(commandText));
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

  private async handleConversation(
    groupConfig: GroupBotConfig,
    userId: string,
    userInput: string,
    images: MessageImageInput[],
    replyMode: "text" | "voice" = "text",
    mentionUserIds: string[] = [],
  ): Promise<void> {
    const skill = await this.resolveSkill(groupConfig);
    const history = await this.conversationStore.getTurns(groupConfig.groupId);
    const normalizedUserInput = userInput.trim() || "[图片消息]";
    const resolvedImages = this.transport.resolveImageInputs
      ? await this.transport.resolveImageInputs(images)
      : images.filter((image) => Boolean(image.url));

    try {
      const reply = await this.aiService.generateReply({
        skill,
        history,
        userInput: normalizedUserInput,
        images: resolvedImages,
      });
      const resolvedMentionUserIds = await this.resolveMentionUserIds(
        groupConfig.groupId,
        mentionUserIds,
      );
      const replyText = sanitizeMentionEcho(reply.text, resolvedMentionUserIds);

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
        turns,
        skill.maxContextTurns * 2,
      );

      if (replyMode === "voice") {
        await this.handleVoiceReply(groupConfig.groupId, skill, replyText);
        logInfo("Sent AI voice reply.", {
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

      await this.sendTextMessages(groupConfig.groupId, outgoingMessages, resolvedMentionUserIds);

      logInfo("Sent AI reply.", {
        groupId: groupConfig.groupId,
        skillId: skill.id,
        model: reply.model,
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

  private async handleVoiceReply(
    groupId: string,
    skill: SkillDefinition,
    replyText: string,
  ): Promise<void> {
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const synthesis = await this.ttsService.synthesize(replyText, skill);
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
      });
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
    await this.sendText(
      groupConfig.groupId,
      `已切换到技能 ${skill.name}（${skill.id}），并清空当前群上下文`,
    );
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

  private isLiveChatUser(groupConfig: GroupBotConfig, userId: string): boolean {
    return groupConfig.liveChatUserIds.includes(userId);
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

  private async sendText(groupId: string, text: string): Promise<void> {
    await this.transport.sendGroupMessage(groupId, text);
    this.liveChatService.recordBotActivity(groupId);
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
      return await this.transport.resolveMentionTargets(groupId, uniqueCandidates);
    } catch (error) {
      logWarn("Failed to resolve mention targets. Falling back to plain reply.", {
        groupId,
        error: (error as Error).message,
        candidateCount: uniqueCandidates.length,
      });
      return [];
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHelpCommand(commandText: string): boolean {
  const normalized = commandText.replace(/\s+/g, " ").trim();
  return HELP_PREFIXES.some((prefix) => new RegExp(`^${escapeRegex(prefix)}(?:\\s+.+)?$`).test(normalized));
}

function extractQqFromInput(input: string): string {
  return input.trim().replace(/\D/g, "");
}

function formatBufferedMessages(messages: BufferedMessage[]): string {
  if (messages.length === 1) {
    return messages[0]!.text;
  }

  return messages.map((message, index) => `${index + 1}. ${message.text}`).join("\n");
}

function prefixAtMentions(userIds: string[], message: string): string {
  const prefix = userIds.map((userId) => `[CQ:at,qq=${userId}]`).join(" ");
  const normalized = message.trim();
  return normalized ? `${prefix} ${normalized}` : prefix;
}

function sanitizeMentionEcho(text: string, mentionUserIds: string[]): string {
  let sanitized = text;

  for (const userId of mentionUserIds) {
    const escapedUserId = escapeRegex(userId);
    sanitized = sanitized
      .replace(new RegExp(`@${escapedUserId}(?!\\d)`, "g"), " ")
      .replace(new RegExp(`(?<!\\d)${escapedUserId}(?!\\d)`, "g"), " ");
  }

  return sanitized
    .replace(/\s+/g, " ")
    .replace(/[ \t]+([，。！？；,.!?;:])/g, "$1")
    .trim();
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

function buildFeatureListMessage(commandText = ""): string {
  const topic = parseHelpTopic(commandText);
  const sections = buildHelpSections();

  if (!topic) {
    return buildHelpOverviewMessage(sections);
  }

  const matchedSection = sections.find((section) => section.aliases.includes(topic));
  if (!matchedSection) {
    return [
      `没找到“${topic}”这个帮助分类`,
      "",
      "可用分类：对话、语音、技能、实时对话、日报、节假日、管理员、权限",
      "示例：#功能 技能",
      "",
      buildHelpOverviewMessage(sections),
    ].join("\n");
  }

  return [
    `帮助分类：${matchedSection.title}`,
    ...matchedSection.lines,
    "",
    "更多帮助：#功能 / #帮助 / #命令",
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

function buildHelpSections(): HelpSection[] {
  return [
    {
      title: "对话",
      aliases: ["对话", "聊天", "chat"],
      lines: [
        "1. @机器人 <内容>",
        "作用：使用当前 skill 进行文本对话",
        "说明：普通群消息不会触发，必须 @机器人",
      ],
    },
    {
      title: "语音",
      aliases: ["语音", "tts", "voice"],
      lines: [
        "1. #语音 <内容>",
        "2. @机器人 语音说 <内容>",
        "作用：先生成回复，再把回复转成语音发送",
      ],
    },
    {
      title: "技能",
      aliases: ["技能", "skill", "skills"],
      lines: [
        "1. #技能 列表",
        "2. #技能 切换 <skillId>",
        "权限：切换技能需要群管理员或超级管理员",
      ],
    },
    {
      title: "实时对话",
      aliases: ["实时对话", "实时", "live", "livechat"],
      lines: [
        "1. #实时对话 列表",
        "2. #实时对话 添加 <QQ号>",
        "3. #实时对话 移除 <QQ号>",
        "4. #实时对话 间隔 <分钟>",
      ],
    },
    {
      title: "日报",
      aliases: ["日报", "report"],
      lines: [
        "1. #日报 状态",
        "2. #日报 发送",
        "3. #日报 开启 / 关闭",
        "4. #日报 时间 <HH:mm>",
      ],
    },
    {
      title: "节假日",
      aliases: ["节假日", "假日", "holiday"],
      lines: [
        "1. #节假日",
        "2. #节假日 状态",
        "3. #节假日 发送",
        "4. #节假日 开启 / 关闭 / 时间 <HH:mm>",
      ],
    },
    {
      title: "管理员",
      aliases: ["管理员", "管理", "admin"],
      lines: [
        "1. #管理员 列表",
        "2. #管理员 添加 <QQ号>",
        "3. #管理员 移除 <QQ号>",
        "说明：添加和移除管理员仅超级管理员可用",
      ],
    },
    {
      title: "权限",
      aliases: ["权限", "auth", "permission"],
      lines: [
        "普通成员：可用对话、语音、帮助和部分状态查询",
        "群管理员：可用全部系统指令",
        "超级管理员：拥有全部权限，并可增删群管理员",
      ],
    },
  ];
}

function buildHelpOverviewMessage(sections: HelpSection[]): string {
  return [
    "系统功能总览：",
    "1. 对话：群里 @机器人 可触发当前 skill 对话，支持图片理解",
    "2. 技能：#技能 列表、#技能 切换 <skillId>",
    "3. 语音：#语音 <内容> 或 @机器人 语音说 <内容>",
    "4. 实时对话：#实时对话 列表、添加、移除、间隔 <分钟>",
    "5. 日报：#日报 状态、发送、开启、关闭、时间 <HH:mm>",
    "6. 节假日：#节假日、状态、发送、开启、关闭、时间 <HH:mm>",
    "7. 管理员：#管理员 列表、添加 <QQ号>、移除 <QQ号>",
    "8. 帮助：#功能、#帮助、#命令 都能调出本列表",
    "分类帮助：#功能 对话 / 语音 / 技能 / 实时对话 / 日报 / 节假日 / 管理员 / 权限",
    "权限说明：普通成员可用对话、语音、帮助和部分查询；群管理员可用全部系统指令；超级管理员额外可管理管理员",
    "提示：#功能 / #帮助 / #命令 只会回帮助信息，不会主动触发日报或节假日发送",
    `可用分类：${sections.map((section) => section.title).join("、")}`,
  ].join("\n");
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

function formatLiveChatDelay(groupConfig: GroupBotConfig): string {
  const seconds = getLiveChatDelaySeconds(groupConfig);
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
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
