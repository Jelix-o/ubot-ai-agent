import type { RecentGroupMessage } from "../types.js";

export interface GroupTranscriptMessageInput {
  groupId: string;
  userId: string;
  messageId: string;
  text: string;
  senderCard?: string;
  senderNickname?: string;
  now?: number;
}

const MAX_TRANSCRIPT_AGE_MS = 60 * 60 * 1000;
const MAX_MESSAGES_PER_GROUP = 120;
const MAX_MESSAGE_CHARS = 1_000;

export class GroupTranscriptService {
  private readonly messagesByGroup = new Map<string, RecentGroupMessage[]>();

  addMessage(input: GroupTranscriptMessageInput): void {
    const text = normalizeText(input.text);
    if (!text) {
      return;
    }

    const now = input.now ?? Date.now();
    const messages = this.messagesByGroup.get(input.groupId) ?? [];
    if (messages.some((message) => message.messageId === input.messageId)) {
      return;
    }

    const senderCard = normalizeDisplayText(input.senderCard);
    const senderNickname = normalizeDisplayText(input.senderNickname);

    messages.push({
      messageId: input.messageId,
      userId: input.userId,
      text: text.slice(0, MAX_MESSAGE_CHARS),
      timestamp: new Date(now).toISOString(),
      ...(senderCard ? { senderCard } : {}),
      ...(senderNickname ? { senderNickname } : {}),
    });
    this.messagesByGroup.set(input.groupId, messages);
    this.pruneGroup(input.groupId, now);
  }

  getRecentMessages(
    groupId: string,
    options: { excludeMessageId?: string; now?: number } = {},
  ): RecentGroupMessage[] {
    this.pruneGroup(groupId, options.now ?? Date.now());
    return (this.messagesByGroup.get(groupId) ?? [])
      .filter((message) => message.messageId !== options.excludeMessageId)
      .map((message) => ({ ...message }));
  }

  private pruneGroup(groupId: string, now: number): void {
    const messages = this.messagesByGroup.get(groupId);
    if (!messages) {
      return;
    }

    const cutoff = now - MAX_TRANSCRIPT_AGE_MS;
    const retained = messages
      .filter((message) => Date.parse(message.timestamp) >= cutoff)
      .slice(-MAX_MESSAGES_PER_GROUP);
    if (retained.length === 0) {
      this.messagesByGroup.delete(groupId);
      return;
    }
    this.messagesByGroup.set(groupId, retained);
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeDisplayText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}
