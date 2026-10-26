import { createHash } from "node:crypto";
import type { SharedDb, IngressMessageRow } from "../shared/sqlite.js";
import type { GroupBotConfig } from "../types.js";

export interface GroupPokeEvent {
  post_type: "notice";
  notice_type: "notify";
  sub_type: "poke";
  group_id: number | string;
  user_id: number | string;
  target_id: number | string;
  self_id: number | string;
  time: number;
}

export function isInteractionQuietHour(now: number): boolean {
  const hour = new Date(now + 8 * 3600_000).getUTCHours();
  return hour >= 1 && hour < 7;
}

/** Durable group-level guards shared by automatic chat and transport events. */
export class GroupInteractionService {
  constructor(private readonly db: SharedDb, private readonly botQq: string, private readonly random = Math.random) {}

  private last(key: string): number {
    return (this.db.db.prepare("SELECT last_at FROM interaction_cooldowns WHERE key = ?").get(key) as { last_at: number } | undefined)?.last_at ?? 0;
  }

  private touch(key: string, now: number): void {
    this.db.db.prepare("INSERT INTO interaction_cooldowns(key,last_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET last_at=excluded.last_at").run(key, now);
  }

  hasPendingReply(groupId: string): boolean {
    return Boolean(this.db.db.prepare("SELECT 1 FROM inflight WHERE key LIKE ? LIMIT 1").get(`${groupId}:%`)) ||
      Boolean(this.db.db.prepare("SELECT 1 FROM outbox WHERE group_id=? AND status IN ('preparing','pending','sending') LIMIT 1").get(groupId));
  }

  lastBotActivity(groupId: string): number {
    return Math.max(
      (this.db.db.prepare("SELECT MAX(sent_at) AS last FROM bot_messages WHERE group_id=?").get(groupId) as { last: number | null }).last ?? 0,
      this.last(`automatic:${groupId}`),
    );
  }

  isSourceAvailable(source: IngressMessageRow): boolean {
    return !this.db.isRetracted(source.group_id, source.msg_id) && Boolean(this.db.db.prepare("SELECT 1 FROM messages WHERE id=? AND processable=1").get(source.id));
  }

  isSourceHandled(groupId: string, messageId: string): boolean {
    return this.last(this.sourceKey(groupId, messageId)) > 0;
  }

  private sourceKey(groupId: string, messageId: string): string {
    return "handled:" + createHash("sha256").update(JSON.stringify([groupId, messageId])).digest("hex");
  }

  ambientCandidate(group: GroupBotConfig, now = Date.now()): IngressMessageRow[] {
    if (!group.ambientReplyEnabled || group.enabled === false || group.botMuted || isInteractionQuietHour(now) || this.hasPendingReply(group.groupId)) return [];
    if (now - this.lastBotActivity(group.groupId) < 60_000 || now - this.last(`ambient:${group.groupId}`) < (group.ambientReplyCooldownSeconds ?? 600) * 1000 || now - this.last(`evaluate:${group.groupId}`) < 60_000) return [];
    const rows = this.db.db.prepare(`SELECT * FROM messages WHERE group_id=? AND msg_time>=? AND created_at>=?
      AND is_bot_msg=0 AND processable=1 ORDER BY id DESC LIMIT 20`).all(group.groupId, now - 120_000, now - 120_000) as unknown as IngressMessageRow[];
    const candidate = rows.reverse().filter(row => row.user_id !== this.botQq && !group.blacklistedUserIds?.includes(row.user_id) && !group.memoryDisabledUserIds?.includes(row.user_id)
      && row.text.trim() && !row.text.trim().startsWith("#") && !row.has_at_bot && !this.db.isRetracted(row.group_id, row.msg_id) && !this.isSourceHandled(row.group_id, row.msg_id));
    if (candidate.length < 3 || new Set(candidate.map(row => row.user_id)).size < 2) return [];
    const newest = candidate[candidate.length - 1]!;
    if (now - newest.msg_time > 60_000 || newest.id <= this.last(`source:${group.groupId}`)) return [];
    return this.db.withImmediateTransaction(() => {
      if (now - this.last(`evaluate:${group.groupId}`) < 60_000) return [];
      this.touch(`evaluate:${group.groupId}`, now);
      this.touch(`source:${group.groupId}`, newest.id);
      return candidate;
    });
  }

  claimAutomaticReply(group: GroupBotConfig, ambient: boolean, now = Date.now(), sourceMessageIds: string[] = []): boolean {
    return this.db.withImmediateTransaction(() => {
      if (group.enabled === false || group.botMuted) return false;
      if (ambient ? !group.ambientReplyEnabled : group.participationMode !== "selected_members") return false;
      const cooldownMs = ambient ? 60_000 : (group.liveChatDelaySeconds ?? (group.liveChatDelayMinutes ?? 5) * 60) * 1000;
      if (this.hasPendingReply(group.groupId) || now - this.lastBotActivity(group.groupId) < cooldownMs) return false;
      if (ambient && (isInteractionQuietHour(now) || now - this.last(`ambient:${group.groupId}`) < (group.ambientReplyCooldownSeconds ?? 600) * 1000)) return false;
      const sources = [...new Set(sourceMessageIds.filter(Boolean))];
      if (sources.some(id => this.isSourceHandled(group.groupId, id))) return false;
      this.db.db.prepare("DELETE FROM interaction_cooldowns WHERE key LIKE 'handled:%' AND last_at<?").run(now - 24 * 3600_000);
      for (const id of sources) this.touch(this.sourceKey(group.groupId, id), now);
      this.touch(`automatic:${group.groupId}`, now);
      if (ambient) this.touch(`ambient:${group.groupId}`, now);
      return true;
    });
  }

  queuePoke(event: GroupPokeEvent, group: GroupBotConfig | undefined, now = Date.now()): boolean {
    const groupId = String(event.group_id), userId = String(event.user_id);
    if (!group || group.groupId !== groupId || group.enabled === false || group.botMuted || !group.pokeReplyEnabled ||
      event.post_type !== "notice" || event.notice_type !== "notify" || event.sub_type !== "poke" ||
      String(event.self_id) !== this.botQq || String(event.target_id) !== this.botQq || userId === this.botQq ||
      !/^\d+$/.test(userId) || group.blacklistedUserIds?.includes(userId) || !Number.isFinite(event.time) ||
      event.time * 1000 > now + 5000 || now - event.time * 1000 > 60_000) return false;
    const key = createHash("sha256").update([event.self_id, groupId, userId, event.target_id, event.time].join(":")).digest("hex");
    return this.db.withImmediateTransaction(() => {
      const inserted = this.db.db.prepare("INSERT OR IGNORE INTO poke_events(event_key,created_at) VALUES(?,?)").run(key, now);
      if (!inserted.changes) return false;
      if (now - this.last(`poke-group:${groupId}`) < (group.pokeReplyGroupCooldownSeconds ?? 30) * 1000 ||
        now - this.last(`poke-user:${groupId}:${userId}`) < (group.pokeReplyUserCooldownSeconds ?? 60) * 1000 ||
        this.random() * 100 >= (group.pokeReplyProbabilityPercent ?? 25)) return false;
      this.touch(`poke-group:${groupId}`, now);
      this.touch(`poke-user:${groupId}:${userId}`, now);
      this.db.enqueueOutbox(groupId, null, userId, "poke");
      return true;
    });
  }
}
