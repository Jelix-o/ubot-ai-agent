import type { ConversationContextRepository } from "./conversation-context-repository.js";

/**
 * V3 has no JSON conversation authority. ConversationContextRepository owns
 * short-term context in SQLite; this narrow adapter preserves the legacy
 * BotApplication dependency shape without reopening conversations.json.
 */
export class SqliteConversationStore {
  constructor(private readonly contextRepository: ConversationContextRepository) {}

  async clearUser(groupId: string, userId: string): Promise<void> {
    this.contextRepository.clearUser(groupId, userId);
  }

  async clearGroup(groupId: string): Promise<void> {
    this.contextRepository.clearGroup(groupId);
  }

  async flush(): Promise<void> {
    // SQLite writes are committed synchronously by the context repository.
  }
}
