import type { AiInteractionTarget, AiReplyContext } from "../types.js";

export interface BufferedMessageContext {
  interactionTargets?: AiInteractionTarget[];
  replyContext?: AiReplyContext;
  sourceMessageId?: string;
  replyMessageId?: string;
}

export interface BufferedMessage {
  text: string;
  userId: string;
  timestamp: string;
  interactionTargets?: AiInteractionTarget[];
  replyContext?: AiReplyContext;
  sourceMessageId?: string;
  replyMessageId?: string;
}

export interface LiveChatWindowCandidate {
  groupId: string;
  userId: string;
  messages: BufferedMessage[];
  lastTimestamp: string;
}

export interface LiveChatRuntimeState {
  enabled: boolean;
  trackedUserCount: number;
  delaySeconds: number;
  pendingUsers: Array<{
    userId: string;
    messageCount: number;
    state: "waiting" | "ready";
  }>;
}

const MAX_BUFFER_WINDOW_MS = 30 * 60 * 1000;

export class LiveChatService {
  private readonly buffers = new Map<string, BufferedMessage[]>();
  private readonly botActivities = new Map<string, number[]>();
  private readonly startedAt = Date.now();
  private lastPruneTime = Date.now();

  addMessage(
    groupId: string,
    userId: string,
    text: string,
    now = Date.now(),
    context: BufferedMessageContext = {},
  ): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const key = buildKey(groupId, userId);
    const messages = this.buffers.get(key) ?? [];
    messages.push({
      text: normalized,
      userId,
      timestamp: new Date(now).toISOString(),
      interactionTargets: context.interactionTargets,
      replyContext: context.replyContext,
      sourceMessageId: context.sourceMessageId,
      replyMessageId: context.replyMessageId,
    });

    const cutoff = now - MAX_BUFFER_WINDOW_MS;
    while (messages.length > 0 && toTimestamp(messages[0]!.timestamp) < cutoff) {
      messages.shift();
    }

    this.buffers.set(key, messages);
    this.maybePrune(now);
  }

  recordBotActivity(groupId: string, now = Date.now()): void {
    const activities = this.botActivities.get(groupId) ?? [];
    activities.push(now);

    const cutoff = now - MAX_BUFFER_WINDOW_MS;
    while (activities.length > 0 && activities[0]! < cutoff) {
      activities.shift();
    }

    this.botActivities.set(groupId, activities);
    this.maybePrune(now);
  }

  hasBotActivityBetween(groupId: string, startTime: number, endTime: number): boolean {
    const activities = this.botActivities.get(groupId) ?? [];
    return activities.some((timestamp) => timestamp >= startTime && timestamp <= endTime);
  }

  getLastBotActivity(groupId: string): number {
    const activities = this.botActivities.get(groupId) ?? [];
    return activities.length > 0 ? activities[activities.length - 1]! : this.startedAt;
  }

  getWindowCandidate(
    groupId: string,
    trackedUserIds: string[],
    startTime: number,
    endTime: number,
  ): LiveChatWindowCandidate | undefined {
    let bestCandidate: LiveChatWindowCandidate | undefined;

    for (const userId of trackedUserIds) {
      const messages = this.getMessagesBetween(groupId, userId, startTime, endTime);
      if (messages.length === 0) {
        continue;
      }

      const lastTimestamp = messages[messages.length - 1]!.timestamp;
      if (!bestCandidate || toTimestamp(lastTimestamp) > toTimestamp(bestCandidate.lastTimestamp)) {
        bestCandidate = { groupId, userId, messages, lastTimestamp };
      }
    }

    return bestCandidate;
  }

  getRuntimeState(
    groupId: string,
    trackedUserIds: string[],
    delaySeconds: number,
    now = Date.now(),
  ): LiveChatRuntimeState {
    const uniqueUserIds = [...new Set(trackedUserIds.filter(Boolean))];
    const lastBotActivity = this.getLastBotActivity(groupId);
    const ready = now >= lastBotActivity + delaySeconds * 1000;
    const pendingUsers = uniqueUserIds.flatMap((userId) => {
      const messageCount = this.getMessagesBetween(groupId, userId, lastBotActivity, now).length;
      return messageCount > 0
        ? [{ userId, messageCount, state: ready ? "ready" as const : "waiting" as const }]
        : [];
    });
    return {
      enabled: uniqueUserIds.length > 0,
      trackedUserCount: uniqueUserIds.length,
      delaySeconds,
      pendingUsers,
    };
  }

  discardMessagesBefore(groupId: string, userId: string, cutoffTime: number): void {
    const key = buildKey(groupId, userId);
    const remaining = (this.buffers.get(key) ?? []).filter(
      (message) => toTimestamp(message.timestamp) > cutoffTime,
    );

    if (remaining.length === 0) {
      this.buffers.delete(key);
      return;
    }

    this.buffers.set(key, remaining);
  }

  private getMessagesBetween(
    groupId: string,
    userId: string,
    startTime: number,
    endTime: number,
  ): BufferedMessage[] {
    const key = buildKey(groupId, userId);
    return (this.buffers.get(key) ?? []).filter((message) => {
      const timestamp = toTimestamp(message.timestamp);
      return timestamp >= startTime && timestamp <= endTime;
    });
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneTime < MAX_BUFFER_WINDOW_MS) {
      return;
    }

    this.lastPruneTime = now;
    const minimumTime = now - MAX_BUFFER_WINDOW_MS;

    for (const [key, messages] of this.buffers.entries()) {
      while (messages.length > 0 && toTimestamp(messages[0]!.timestamp) < minimumTime) {
        messages.shift();
      }
      if (messages.length === 0) {
        this.buffers.delete(key);
      }
    }

    for (const [groupId, timestamps] of this.botActivities.entries()) {
      while (timestamps.length > 0 && timestamps[0]! < minimumTime) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.botActivities.delete(groupId);
      }
    }
  }
}

function buildKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function toTimestamp(value: string): number {
  return Date.parse(value);
}
