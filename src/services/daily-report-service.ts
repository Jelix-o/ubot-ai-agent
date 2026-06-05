import type { GroupBotConfig } from "../types.js";
import type { ChatSummaryRequest } from "../utils/chat-summary-request.js";
import { isScheduleDateRuleMatched } from "../utils/schedule-date-rule.js";
import type { AiService } from "./ai-service.js";
import type { DailyReportMessageRecord } from "./daily-report-store.js";
import { DailyReportStore } from "./daily-report-store.js";

type DailyReportAiService = Pick<AiService, "generateBroadcastQuip" | "generateChatPeriodSummary">;

export class DailyReportService {
  constructor(
    private readonly store: DailyReportStore,
    private readonly aiService: DailyReportAiService,
  ) {}

  async recordMessage(args: {
    groupId: string;
    userId: string;
    userName: string;
    text: string;
    timestamp?: string;
  }): Promise<void> {
    const normalized = args.text.trim();
    if (!normalized) {
      return;
    }

    await this.store.appendMessage({
      groupId: args.groupId,
      userId: args.userId,
      userName: args.userName.trim() || args.userId,
      text: normalized,
      timestamp: args.timestamp ?? new Date().toISOString(),
    });
  }

  async shouldSendScheduledReport(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    if (groupConfig.dailyReportEnabled === false) {
      return false;
    }

    if (!isScheduleDateRuleMatched(groupConfig.dailyReportDateRule, groupConfig.dailyReportWeekdays, now)) {
      return false;
    }

    const todayKey = toLocalDateKey(now);
    const lastSentDate = await this.store.getLastSentDate(groupConfig.groupId);
    if (lastSentDate === todayKey) {
      return false;
    }

    return isScheduledMinute(now, parseScheduleMinute(groupConfig.dailyReportTime));
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    await this.store.markSent(groupId, toLocalDateKey(now));
  }

  async buildReport(groupConfig: GroupBotConfig, now = new Date()): Promise<string> {
    const dayKey = toLocalDateKey(now);
    const messages = await this.store.getMessages(groupConfig.groupId, dayKey);
    const topUserCount = normalizeTopUserCount(groupConfig.dailyReportTopUserCount);
    const header = buildBroadcastHeader(now);
    const quip = await this.aiService.generateBroadcastQuip("daily_report_evening");
    const openingLine = `下班了，该回家了，别磨磨叽叽的，${quip}`;

    if (messages.length === 0) {
      return [
        header,
        openingLine,
        "今日消息 0 条",
        "活跃人数 0 人",
        "最热时段 暂无",
        `发言 TOP${topUserCount}`,
        "今天群里还没人卷出存在感",
      ].join("\n");
    }

    const stats = buildDailyStats(messages, topUserCount);

    const lines = [
      header,
      openingLine,
      `今日消息 ${stats.totalMessages} 条`,
      `活跃人数 ${stats.participantCount} 人`,
      `最热时段 ${stats.peakHourLabel}`,
      `发言 TOP${topUserCount}`,
      ...stats.topUsers.map((user, index) => {
        return `${index + 1}. ${user.userName} ${user.messageCount} 条`;
      }),
    ];

    return lines.join("\n");
  }

  async buildChatSummary(args: {
    groupId: string;
    request: ChatSummaryRequest;
    now?: Date;
  }): Promise<string> {
    const now = args.now ?? new Date();
    const { dayKey, messages } = await this.loadMessagesForRequest(
      args.groupId,
      args.request,
      now,
    );

    if (messages.length === 0) {
      return `${args.request.label}这段时间没有可总结的聊天记录`;
    }

    const stats = buildChatSummaryStats(messages, args.request);
    const aiSummary = await this.aiService.generateChatPeriodSummary({
      dateLabel: dayKey,
      periodLabel: args.request.label,
      rangeLabel: stats.rangeLabel,
      totalMessages: stats.totalMessages,
      participantCount: stats.participantCount,
      topUsers: stats.topUsers.map((user) => ({
        userName: user.userName,
        messageCount: user.messageCount,
      })),
      sampleMessages: pickSummarySamples(messages),
    });

    if (aiSummary && isUsefulChatSummary(aiSummary)) {
      return aiSummary;
    }

    return buildFallbackChatSummary(args.request, stats, messages);
  }

  private async loadMessagesForRequest(
    groupId: string,
    request: ChatSummaryRequest,
    now: Date,
  ): Promise<{ dayKey: string; messages: DailyReportMessageRecord[] }> {
    if (request.mode === "relative_window") {
      const durationMinutes = request.relativeDurationMinutes ?? 30;
      const start = new Date(now.getTime() - durationMinutes * 60 * 1000);
      const dayKeys = buildDayKeysBetween(start, now);
      const batches = await Promise.all(
        dayKeys.map((dayKey) => this.store.getMessages(groupId, dayKey)),
      );
      const messages = batches
        .flat()
        .filter((message) => {
          const timestamp = new Date(message.timestamp).getTime();
          return timestamp >= start.getTime() && timestamp <= now.getTime();
        })
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

      return {
        dayKey: toLocalDateKey(now),
        messages,
      };
    }

    if (request.mode === "recent") {
      const recentStart = shiftDate(now, -6);
      recentStart.setHours(0, 0, 0, 0);
      const dayKeys = buildDayKeysBetween(recentStart, now);
      const batches = await Promise.all(
        dayKeys.map((dayKey) => this.store.getMessages(groupId, dayKey)),
      );
      const messages = batches
        .flat()
        .filter((message) => new Date(message.timestamp).getTime() <= now.getTime())
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-(request.recentMessageCount ?? 60));

      return {
        dayKey: toLocalDateKey(now),
        messages,
      };
    }

    const { start, end } = buildAbsoluteWindow(request, now);
    const dayKeys = buildDayKeysBetween(start, end);
    const batches = await Promise.all(
      dayKeys.map((dayKey) => this.store.getMessages(groupId, dayKey)),
    );
    const messages = batches
      .flat()
      .filter((message) => {
        const timestamp = new Date(message.timestamp).getTime();
        return timestamp >= start.getTime() && timestamp <= end.getTime();
      })
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    return {
      dayKey: toLocalDateKey(end),
      messages,
    };
  }
}

type TopUserStat = {
  userId: string;
  userName: string;
  messageCount: number;
  sampleMessages: string[];
  latestTimestamp: string;
};

type DailyStats = {
  totalMessages: number;
  participantCount: number;
  peakHourLabel: string;
  topUsers: TopUserStat[];
};

type ChatSummaryStats = {
  rangeLabel: string;
  totalMessages: number;
  participantCount: number;
  topUsers: TopUserStat[];
};

type SummarySample = {
  userName: string;
  text: string;
  timestamp: string;
};

function buildDailyStats(messages: DailyReportMessageRecord[], topUserCount: number): DailyStats {
  const messageCountByUser = new Map<string, TopUserStat>();
  const participantIds = new Set<string>();
  const hourCounter = new Map<number, number>();

  for (const message of messages) {
    participantIds.add(message.userId);
    const hour = new Date(message.timestamp).getHours();
    hourCounter.set(hour, (hourCounter.get(hour) ?? 0) + 1);

    const existing = messageCountByUser.get(message.userId);
    if (!existing) {
      messageCountByUser.set(message.userId, {
        userId: message.userId,
        userName: message.userName,
        messageCount: 1,
        sampleMessages: message.text ? [message.text] : [],
        latestTimestamp: message.timestamp,
      });
      continue;
    }

    existing.messageCount += 1;
    existing.userName = pickBetterUserName(existing.userName, message.userName, message.userId);
    existing.latestTimestamp =
      existing.latestTimestamp > message.timestamp ? existing.latestTimestamp : message.timestamp;

    if (message.text && existing.sampleMessages.length < 3 && !existing.sampleMessages.includes(message.text)) {
      existing.sampleMessages.push(message.text);
    }
  }

  const topUsers = [...messageCountByUser.values()]
    .sort(
      (left, right) =>
        right.messageCount - left.messageCount ||
        right.latestTimestamp.localeCompare(left.latestTimestamp),
    )
    .slice(0, topUserCount);

  return {
    totalMessages: messages.length,
    participantCount: participantIds.size,
    peakHourLabel: pickPeakHourLabel(hourCounter),
    topUsers,
  };
}

function buildChatSummaryStats(
  messages: DailyReportMessageRecord[],
  request: ChatSummaryRequest,
): ChatSummaryStats {
  const messageCountByUser = new Map<string, TopUserStat>();
  const participantIds = new Set<string>();

  for (const message of messages) {
    participantIds.add(message.userId);

    const existing = messageCountByUser.get(message.userId);
    if (!existing) {
      messageCountByUser.set(message.userId, {
        userId: message.userId,
        userName: message.userName,
        messageCount: 1,
        sampleMessages: message.text ? [message.text] : [],
        latestTimestamp: message.timestamp,
      });
      continue;
    }

    existing.messageCount += 1;
    existing.userName = pickBetterUserName(existing.userName, message.userName, message.userId);
    existing.latestTimestamp =
      existing.latestTimestamp > message.timestamp ? existing.latestTimestamp : message.timestamp;

    if (message.text && existing.sampleMessages.length < 3 && !existing.sampleMessages.includes(message.text)) {
      existing.sampleMessages.push(message.text);
    }
  }

  return {
    rangeLabel:
      request.mode === "recent" || request.mode === "relative_window"
        ? buildActualRangeLabel(messages)
        : `${formatMinute(request.startMinute)}-${formatMinute(request.endMinute)}`,
    totalMessages: messages.length,
    participantCount: participantIds.size,
    topUsers: [...messageCountByUser.values()]
      .sort(
        (left, right) =>
          right.messageCount - left.messageCount ||
          right.latestTimestamp.localeCompare(left.latestTimestamp),
      )
      .slice(0, 3),
  };
}

function pickSummarySamples(
  messages: DailyReportMessageRecord[],
): SummarySample[] {
  const cleaned = messages
    .filter((message) => message.text.trim())
    .map((message) => ({
      userName: message.userName,
      text: message.text.trim().slice(0, 120),
      timestamp: message.timestamp,
    }));

  if (cleaned.length <= 24) {
    return cleaned;
  }

  const samples: SummarySample[] = [];
  const step = (cleaned.length - 1) / 23;
  const indexes = new Set<number>();

  for (let index = 0; index < 24; index += 1) {
    indexes.add(Math.round(index * step));
  }

  for (const index of [...indexes].sort((left, right) => left - right)) {
    const message = cleaned[index];
    if (message) {
      samples.push(message);
    }
  }

  return samples;
}

function buildFallbackChatSummary(
  request: ChatSummaryRequest,
  stats: ChatSummaryStats,
  messages: DailyReportMessageRecord[],
): string {
  const topUsersText =
    stats.topUsers.length > 0
      ? stats.topUsers.map((user) => `${user.userName}${user.messageCount}条`).join("、")
      : "暂无明显活跃成员";
  const topicLine = buildFallbackTopicLine(messages);
  const sampleLine = buildRepresentativeSampleLine(messages);

  return [
    `${request.label}聊天总结`,
    `主要在聊：${topicLine}`,
    `比较活跃：${topUsersText}`,
    sampleLine
      ? `典型内容：${sampleLine}`
      : `整体感觉：这段时间共 ${stats.totalMessages} 条消息，${stats.participantCount} 人参与，聊天集中在 ${stats.rangeLabel}`,
  ].join("\n");
}

function buildFallbackTopicLine(messages: DailyReportMessageRecord[]): string {
  const snippets = extractTopicSnippets(messages).slice(0, 3);
  if (snippets.length === 0) {
    return "这段时间有人接着聊，但记录里没留下特别清晰的话题词";
  }

  if (snippets.length === 1) {
    return `看起来主要围绕“${snippets[0]}”在展开`;
  }

  if (snippets.length === 2) {
    return `看起来主要围绕“${snippets[0]}”和“${snippets[1]}”在展开`;
  }

  return `看起来主要围绕“${snippets[0]}”、“${snippets[1]}”、“${snippets[2]}”这些内容在聊`;
}

function buildRepresentativeSampleLine(messages: DailyReportMessageRecord[]): string {
  const sourceMessages = getTopicSourceMessages(messages);
  const picked: Array<{ userName: string; text: string }> = [];
  const usedUsers = new Set<string>();

  for (const message of sourceMessages) {
    const snippet = cleanupSnippet(stripMentions(message.text));
    if (!snippet) {
      continue;
    }

    if (usedUsers.has(message.userName) && picked.length > 0) {
      continue;
    }

    picked.push({
      userName: message.userName,
      text: snippet,
    });
    usedUsers.add(message.userName);

    if (picked.length >= 2) {
      break;
    }
  }

  return picked
    .map((item) => `${item.userName}提到“${item.text}”`)
    .join("；");
}

function extractTopicSnippets(messages: DailyReportMessageRecord[]): string[] {
  const snippetWeights = new Map<string, number>();

  for (const message of getTopicSourceMessages(messages)) {
    const candidates = extractSnippetCandidates(message.text);
    const uniqueCandidates = new Set(candidates);

    for (const candidate of uniqueCandidates) {
      snippetWeights.set(candidate, (snippetWeights.get(candidate) ?? 0) + 1);
    }
  }

  return [...snippetWeights.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        right[0].length - left[0].length ||
        left[0].localeCompare(right[0], "zh-Hans-CN"),
    )
    .map(([snippet]) => snippet)
    .filter((snippet, index, list) => !list.slice(0, index).some((picked) => picked.includes(snippet) || snippet.includes(picked)))
    .slice(0, 5);
}

function extractSnippetCandidates(text: string): string[] {
  const normalized = stripMentions(text)
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/[，。！？；：,.!?;:\s]+/)
    .map((part) => cleanupSnippet(part))
    .filter((part): part is string => Boolean(part));

  return parts.filter((part) => {
    if (part.length < 2 || part.length > 18) {
      return false;
    }

    if (/^\d+$/.test(part)) {
      return false;
    }

    return !GENERIC_TOPIC_STOPWORDS.has(part);
  });
}

function cleanupSnippet(text: string): string {
  return text
    .replace(/^[@＠][^\s，,。！？!；;、:：]+/g, " ")
    .replace(/^(帮我|给我)?(总结一下|总结|分析一下|分析|回顾一下|回顾|评价一下|评价)\s*/g, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[“”"'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22);
}

function isUsefulChatSummary(summary: string): boolean {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const topicLine = lines.find((line) => line.startsWith("主要在聊："));

  if (!topicLine) {
    return false;
  }

  return !/主要在聊：.*(这段时间共|消息|参与|聊天集中在|一直有人接话|比较热闹|大家在聊天)/.test(topicLine);
}

const GENERIC_TOPIC_STOPWORDS = new Set([
  "今天",
  "昨天",
  "刚刚",
  "现在",
  "上面",
  "群里",
  "聊天",
  "消息",
  "大家",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "一下",
  "一会",
  "一会儿",
  "真的",
  "可以",
  "感觉",
  "就是",
  "然后",
  "还有",
  "因为",
  "所以",
  "怎么",
  "什么",
  "为什么",
  "不是",
  "没有",
  "有点",
  "直接",
  "先下了",
  "大家早啊",
  "分析一下",
  "总结一下",
  "聊天记录",
  "群里都聊了什么",
  "聊了些什么",
  "评价一下",
  "这个id",
  "id",
]);

function getTopicSourceMessages(messages: DailyReportMessageRecord[]): SummarySample[] {
  const filtered = pickSummarySamples(messages).filter((message) => {
    const normalized = stripMentions(message.text)
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized || normalized.length < 4) {
      return false;
    }

    if (isMetaSummaryMessage(normalized)) {
      return false;
    }

    if (/^(图片消息|\d+|哦|嗯|啊|草|6|1|2|3|4|5)$/.test(normalized)) {
      return false;
    }

    return true;
  });

  return filtered.length > 0 ? filtered : pickSummarySamples(messages);
}

function isMetaSummaryMessage(text: string): boolean {
  return [
    /(总结|分析|回顾).*(聊天记录|群里|聊了什么|聊了些什么|说了什么)/,
    /(聊了什么|聊了些什么|说了什么).*(总结|分析|回顾)/,
    /你能分析出来吗/,
    /我只能看到你跟我聊的这些/,
  ].some((pattern) => pattern.test(text));
}

function stripMentions(text: string): string {
  return text.replace(/[@＠][^\s，,。！？!；;、:：]+/g, " ");
}

function shiftDate(value: Date, dayOffset: number): Date {
  const shifted = new Date(value);
  shifted.setDate(shifted.getDate() + dayOffset);
  return shifted;
}

function buildDayKeysBetween(start: Date, end: Date): string[] {
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  const limit = new Date(end);
  limit.setHours(0, 0, 0, 0);

  const dayKeys: string[] = [];
  while (cursor.getTime() <= limit.getTime()) {
    dayKeys.push(toLocalDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dayKeys;
}

function buildAbsoluteWindow(
  request: ChatSummaryRequest,
  now: Date,
): { start: Date; end: Date } {
  const startDayOffset = request.startDayOffset ?? request.dayOffset ?? 0;
  const endDayOffset = request.endDayOffset ?? request.dayOffset ?? startDayOffset;

  const startDate = shiftDate(now, startDayOffset);
  startDate.setHours(0, 0, 0, 0);
  startDate.setMinutes(request.startMinute, 0, 0);

  const endDate = shiftDate(now, endDayOffset);
  endDate.setHours(0, 0, 0, 0);
  endDate.setMinutes(request.endMinute, 59, 999);

  return {
    start: startDate,
    end: endDate,
  };
}

function pickPeakHourLabel(counter: Map<number, number>): string {
  let bestHour = 0;
  let bestCount = 0;

  for (const [hour, count] of counter.entries()) {
    if (count > bestCount) {
      bestHour = hour;
      bestCount = count;
    }
  }

  return `${`${bestHour}`.padStart(2, "0")}:00-${`${bestHour}`.padStart(2, "0")}:59，共 ${bestCount} 条`;
}

function normalizeTopUserCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5;
  }

  return Math.max(1, Math.min(5, Math.floor(value)));
}

function parseScheduleMinute(value: string | undefined): number {
  const normalized = (value ?? "17:59").trim();
  const matched = normalized.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!matched) {
    return 17 * 60 + 59;
  }

  return Number(matched[1]) * 60 + Number(matched[2]);
}

function isWeekday(now: Date): boolean {
  const day = now.getDay();
  return day >= 1 && day <= 5;
}

function isScheduledMinute(now: Date, scheduleMinute: number): boolean {
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  return currentMinute === scheduleMinute;
}

function toLocalDateKey(value: Date): string {
  return [
    value.getFullYear(),
    `${value.getMonth() + 1}`.padStart(2, "0"),
    `${value.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function pickBetterUserName(current: string, incoming: string, fallback: string): string {
  const currentName = current.trim();
  const incomingName = incoming.trim();

  if (!currentName || currentName === fallback) {
    return incomingName || fallback;
  }

  if (incomingName && incomingName !== fallback && incomingName.length >= currentName.length) {
    return incomingName;
  }

  return currentName;
}

function formatClockTime(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function formatMinute(value: number): string {
  return `${`${Math.floor(value / 60)}`.padStart(2, "0")}:${`${value % 60}`.padStart(2, "0")}`;
}

function buildActualRangeLabel(messages: DailyReportMessageRecord[]): string {
  const first = messages[0];
  const last = messages.at(-1);
  if (!first || !last) {
    return "最近";
  }

  return `${first.timestamp.slice(11, 16)}-${last.timestamp.slice(11, 16)}`;
}

function buildBroadcastHeader(now: Date): string {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()]!;
  return `${now.getFullYear()}年${`${now.getMonth() + 1}`.padStart(2, "0")}月${`${now.getDate()}`.padStart(2, "0")}日 ${formatClockTime(now)} 星期${weekday} ${resolveTimePeriod(now)}好，摸鱼人`;
}

function resolveTimePeriod(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) {
    return "早上";
  }
  if (hour < 14) {
    return "中午";
  }
  if (hour < 18) {
    return "下午";
  }
  return "晚上";
}
