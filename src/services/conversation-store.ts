import { randomUUID } from "node:crypto";

import type {
  ConversationTurn,
  ConversationsFile,
  SharedConversationTopic,
  SharedConversationTurn,
} from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

const SHARED_TOPIC_IDLE_EXPIRY_MS = 30 * 60 * 1000;
const SHARED_TOPIC_MAX_TURNS = 32;
const SHARED_TOPIC_MAX_CHARS = 24_000;
const SHARED_TOPIC_TURN_MAX_CHARS = 4_000;

export interface AppendSharedDialogueInput {
  groupId: string;
  topicId?: string;
  userId: string;
  userContent: string;
  senderCard?: string;
  senderNickname?: string;
  assistantContent: string;
  sourceMessageId?: string;
  botMessageIds?: string[];
  now?: Date;
}

export class ConversationStore {
  private data!: ConversationsFile;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly flushIntervalMs = 5_000;

  constructor(private readonly filePath: string) {
    // 懒加载，构造函数不做额外操作
  }

  async getTurns(groupId: string, userId: string): Promise<ConversationTurn[]> {
    const data = await this.readData();
    return data.conversations[toConversationKey(groupId, userId)] ?? [];
  }

  async appendTurn(
    groupId: string,
    userId: string,
    turn: ConversationTurn,
    maxTurns: number,
  ): Promise<void> {
    const data = await this.readData();
    const key = toConversationKey(groupId, userId);
    const turns = data.conversations[key] ?? [];
    data.conversations[key] = [...turns, turn].slice(-maxTurns);
    this.scheduleFlush();
  }

  async appendDialogue(
    groupId: string,
    userId: string,
    turns: ConversationTurn[],
    maxTurns: number,
  ): Promise<void> {
    const data = await this.readData();
    const key = toConversationKey(groupId, userId);
    const existingTurns = data.conversations[key] ?? [];
    data.conversations[key] = [...existingTurns, ...turns].slice(-maxTurns);
    this.scheduleFlush();
  }

  async getSharedTopic(
    groupId: string,
    replyMessageId?: string,
    now = new Date(),
  ): Promise<SharedConversationTopic | undefined> {
    const data = await this.readData();
    this.pruneExpiredSharedTopics(data, now.getTime());

    if (replyMessageId) {
      const topicId = data.sharedTopicMessageIndex?.[toTopicMessageKey(groupId, replyMessageId)];
      const topic = topicId ? data.sharedTopics?.[topicId] : undefined;
      return topic?.groupId === groupId ? cloneTopic(topic) : undefined;
    }

    // Shared topics require an explicit reply-chain anchor to prevent topic bleed.
    return undefined;
  }

  async appendSharedDialogue(input: AppendSharedDialogueInput): Promise<SharedConversationTopic> {
    const data = await this.readData();
    const now = input.now ?? new Date();
    this.pruneExpiredSharedTopics(data, now.getTime());
    const sharedTopics = data.sharedTopics ?? (data.sharedTopics = {});
    const messageIndex = data.sharedTopicMessageIndex ?? (data.sharedTopicMessageIndex = {});
    const existing = input.topicId ? sharedTopics[input.topicId] : undefined;
    const topic = existing?.groupId === input.groupId
      ? existing
      : {
          id: createTopicId(input.groupId),
          groupId: input.groupId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          turns: [],
        } satisfies SharedConversationTopic;

    topic.turns = trimSharedTopicTurns([
      ...topic.turns,
      {
        role: "user",
        content: limitTurnContent(input.userContent),
        userId: input.userId,
        ...(normalizeSenderText(input.senderCard) ? { senderCard: normalizeSenderText(input.senderCard) } : {}),
        ...(normalizeSenderText(input.senderNickname) ? { senderNickname: normalizeSenderText(input.senderNickname) } : {}),
        timestamp: now.toISOString(),
      },
      {
        role: "assistant",
        content: limitTurnContent(input.assistantContent),
        timestamp: now.toISOString(),
      },
    ]);
    topic.updatedAt = now.toISOString();
    sharedTopics[topic.id] = topic;

    const messageIds = [input.sourceMessageId, ...(input.botMessageIds ?? [])]
      .filter((messageId): messageId is string => Boolean(messageId?.trim()));
    for (const messageId of messageIds) {
      messageIndex[toTopicMessageKey(input.groupId, messageId)] = topic.id;
    }

    this.scheduleFlush();
    return cloneTopic(topic);
  }

  async clearUser(groupId: string, userId: string): Promise<void> {
    const data = await this.readData();
    delete data.conversations[toConversationKey(groupId, userId)];
    this.scheduleFlush();
  }

  async clearGroup(groupId: string): Promise<void> {
    const data = await this.readData();
    const keyPrefix = `${groupId}:`;
    for (const key of Object.keys(data.conversations)) {
      if (key === groupId || key.startsWith(keyPrefix)) {
        delete data.conversations[key];
      }
    }
    for (const [topicId, topic] of Object.entries(data.sharedTopics ?? {})) {
      if (topic.groupId === groupId) {
        delete data.sharedTopics?.[topicId];
      }
    }
    for (const key of Object.keys(data.sharedTopicMessageIndex ?? {})) {
      if (key.startsWith(`${groupId}:`)) {
        delete data.sharedTopicMessageIndex?.[key];
      }
    }
    this.scheduleFlush();
  }

  /** 强制立即刷新到磁盘 */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty) {
      this.dirty = false;
      await writeJsonFileAtomic(this.filePath, this.data);
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  private pruneExpiredSharedTopics(data: ConversationsFile, now: number): void {
    const sharedTopics = data.sharedTopics ?? (data.sharedTopics = {});
    const messageIndex = data.sharedTopicMessageIndex ?? (data.sharedTopicMessageIndex = {});
    const expiresBefore = now - SHARED_TOPIC_IDLE_EXPIRY_MS;
    let changed = false;

    for (const [topicId, topic] of Object.entries(sharedTopics)) {
      if (toTimestamp(topic.updatedAt) < expiresBefore) {
        delete sharedTopics[topicId];
        changed = true;
      }
    }
    for (const [key, topicId] of Object.entries(messageIndex)) {
      if (!sharedTopics[topicId]) {
        delete messageIndex[key];
        changed = true;
      }
    }

    if (changed) {
      this.scheduleFlush();
    }
  }

  private async readData(): Promise<ConversationsFile> {
    if (this.data) {
      return this.data;
    }

    try {
      this.data = normalizeConversationsFile(await readJsonFile<ConversationsFile>(this.filePath));
      return this.data;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.data = { conversations: {}, sharedTopics: {}, sharedTopicMessageIndex: {} };
        return this.data;
      }
      throw error;
    }
  }
}

function normalizeConversationsFile(data: Partial<ConversationsFile>): ConversationsFile {
  const conversations: ConversationsFile["conversations"] = {};
  for (const [key, turns] of Object.entries(data?.conversations ?? {})) {
    if (Array.isArray(turns)) {
      conversations[key] = turns;
    }
  }

  const sharedTopics: Record<string, SharedConversationTopic> = {};
  for (const [topicId, topic] of Object.entries(data?.sharedTopics ?? {})) {
    const normalized = normalizeSharedTopic(topicId, topic);
    if (normalized) {
      sharedTopics[topicId] = normalized;
    }
  }

  const sharedTopicMessageIndex: Record<string, string> = {};
  for (const [key, topicId] of Object.entries(data?.sharedTopicMessageIndex ?? {})) {
    if (typeof topicId === "string" && sharedTopics[topicId]) {
      sharedTopicMessageIndex[key] = topicId;
    }
  }

  return { conversations, sharedTopics, sharedTopicMessageIndex };
}

function toConversationKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function toTopicMessageKey(groupId: string, messageId: string): string {
  return `${groupId}:${messageId.trim()}`;
}

function createTopicId(groupId: string): string {
  return `${groupId}:${randomUUID()}`;
}

function trimSharedTopicTurns(turns: SharedConversationTurn[]): SharedConversationTurn[] {
  let trimmed = turns.slice(-SHARED_TOPIC_MAX_TURNS);
  let chars = countTopicChars(trimmed);
  while (trimmed.length > 2 && chars > SHARED_TOPIC_MAX_CHARS) {
    const removed = trimmed.shift();
    chars -= removed ? removed.content.length : 0;
  }

  if (trimmed.length > 0 && chars > SHARED_TOPIC_MAX_CHARS) {
    const first = trimmed[0]!;
    const allowed = Math.max(1, SHARED_TOPIC_MAX_CHARS - (chars - first.content.length));
    trimmed = [{ ...first, content: first.content.slice(-allowed) }, ...trimmed.slice(1)];
  }
  return trimmed;
}

function countTopicChars(turns: SharedConversationTurn[]): number {
  return turns.reduce((total, turn) => total + turn.content.length, 0);
}

function limitTurnContent(content: string): string {
  const normalized = content.trim();
  return normalized.length > SHARED_TOPIC_TURN_MAX_CHARS
    ? normalized.slice(-SHARED_TOPIC_TURN_MAX_CHARS)
    : normalized;
}

function normalizeSenderText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

function normalizeSharedTopic(topicId: string, value: unknown): SharedConversationTopic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const topic = value as Partial<SharedConversationTopic>;
  if (
    topic.id !== topicId ||
    typeof topic.groupId !== "string" ||
    typeof topic.createdAt !== "string" ||
    typeof topic.updatedAt !== "string" ||
    !Array.isArray(topic.turns)
  ) {
    return undefined;
  }
  const turns = topic.turns.filter((turn): turn is SharedConversationTurn => (
    Boolean(turn) &&
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string" &&
    typeof turn.timestamp === "string" &&
    (turn.userId === undefined || typeof turn.userId === "string") &&
    (turn.senderCard === undefined || typeof turn.senderCard === "string") &&
    (turn.senderNickname === undefined || typeof turn.senderNickname === "string")
  ));
  return {
    id: topic.id,
    groupId: topic.groupId,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    turns: trimSharedTopicTurns(turns.map((turn) => ({
      ...turn,
      content: limitTurnContent(turn.content),
      ...(normalizeSenderText(turn.senderCard) ? { senderCard: normalizeSenderText(turn.senderCard) } : {}),
      ...(normalizeSenderText(turn.senderNickname) ? { senderNickname: normalizeSenderText(turn.senderNickname) } : {}),
    }))),
  };
}

function cloneTopic(topic: SharedConversationTopic): SharedConversationTopic {
  return { ...topic, turns: topic.turns.map((turn) => ({ ...turn })) };
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
