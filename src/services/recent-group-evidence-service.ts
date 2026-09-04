import type { SharedDb } from "../shared/sqlite.js";
import type { RecentGroupEvidenceMessage } from "../types.js";

export interface RecentGroupEvidenceQuery {
  groupId: string;
  beforeSourceRowId: number;
  sinceMs: number;
  excludedUserIds?: string[];
  limit?: number;
}

export class RecentGroupEvidenceService {
  constructor(private readonly sharedDb: SharedDb) {}

  list(query: RecentGroupEvidenceQuery): RecentGroupEvidenceMessage[] {
    return this.sharedDb.listRecentGroupEvidence(query)
      .map((row): RecentGroupEvidenceMessage | undefined => {
        const text = row.text.replace(/\s+/g, " ").trim() || (hasImages(row.images_json) ? "[图片消息]" : "");
        if (!text) return undefined;
        return {
          role: row.role,
          text,
          timestamp: new Date(row.occurred_at).toISOString(),
          ...(row.user_id ? { userId: row.user_id } : {}),
          ...(row.sender_card?.trim() ? { senderCard: row.sender_card.trim() } : {}),
          ...(row.sender_nickname?.trim() ? { senderNickname: row.sender_nickname.trim() } : {}),
        };
      })
      .filter((message): message is RecentGroupEvidenceMessage => Boolean(message));
  }
}

function hasImages(imagesJson: string): boolean {
  try {
    const images = JSON.parse(imagesJson) as unknown;
    return Array.isArray(images) && images.length > 0;
  } catch {
    return false;
  }
}
