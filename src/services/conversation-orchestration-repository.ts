import type { SharedDb } from "../shared/sqlite.js";
import type { AmbientGroupContextMessage, MessageImageInput, ReferencedMessage } from "../types.js";
import type { ConversationContextTurn, ConversationRoute } from "./conversation-context-repository.js";
import {
  emptyConversationState, mergeConversationState, sanitizeConversationUpdate,
  type ContextResolution, type ConversationState, type ConversationTopicCandidate,
} from "./conversation-state.js";

export interface MediaCandidate {
  sourceRowId: number;
  sourceMessageId: string;
  userId: string;
  images: MessageImageInput[];
  branchId?: string;
}

export class ConversationOrchestrationRepository {
  constructor(private readonly sharedDb: SharedDb) {}

  sourceReceivedAt(sourceRowId: number): number | undefined {
    return (this.sharedDb.db.prepare("SELECT created_at FROM messages WHERE id = ?").get(sourceRowId) as { created_at: number } | undefined)?.created_at;
  }

  isReferenceRetracted(groupId: string, messageId: string): boolean {
    return this.sharedDb.isRetracted(groupId, messageId);
  }

  reference(groupId: string, messageId: string, beforeSourceRowId = Number.MAX_SAFE_INTEGER, excludedUserIds: string[] = []): ReferencedMessage | undefined {
    if (this.sharedDb.isRetracted(groupId, messageId)) return undefined;
    const member = this.sharedDb.db.prepare(`SELECT user_id, text, images_json FROM messages WHERE group_id = ? AND msg_id = ? AND id < ?
      AND (processable = 1 OR drop_reason = 'rate_limited') LIMIT 1`).get(groupId, messageId, beforeSourceRowId) as { user_id: string; text: string; images_json: string } | undefined;
    if (member) return excludedUserIds.includes(member.user_id) ? undefined : { messageId, userId: member.user_id, text: member.text, images: parseImages(member.images_json) };
    // An acknowledged bot reply has no member author to exclude. It remains a
    // valid same-group quote anchor even when another member opted out.
    const bot = this.sharedDb.db.prepare("SELECT text FROM outbox WHERE group_id = ? AND platform_message_id = ? AND status = 'sent' AND kind = 'text' LIMIT 1")
      .get(groupId, messageId) as { text: string } | undefined;
    return bot ? { messageId, text: bot.text, images: [] } : undefined;
  }

  getResolution(sourceRowId: number): ContextResolution | undefined {
    const row = this.sharedDb.db.prepare("SELECT resolution_json FROM conversation_reply_plans WHERE source_row_id = ?").get(sourceRowId) as { resolution_json: string } | undefined;
    return row ? JSON.parse(row.resolution_json) : undefined;
  }

  saveResolution(sourceRowId: number, groupId: string, userId: string, resolution: ContextResolution): ContextResolution {
    this.sharedDb.db.prepare(`INSERT INTO conversation_reply_plans (source_row_id, group_id, user_id, resolution_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_row_id) DO NOTHING`).run(sourceRowId, groupId, userId, JSON.stringify(resolution), Date.now());
    return this.getResolution(sourceRowId)!;
  }

  /**
   * A transient remote quote read can fail before the worker reaches the
   * handler. Replace only that known placeholder when a later recovery has
   * supplied the actual same-group quote; never overwrite another decision.
   */
  replaceUnavailableQuoteResolution(
    sourceRowId: number,
    unavailableClarification: string,
    replacement: ContextResolution,
  ): ContextResolution | undefined {
    const row = this.sharedDb.db.prepare("SELECT resolution_json FROM conversation_reply_plans WHERE source_row_id = ?")
      .get(sourceRowId) as { resolution_json: string } | undefined;
    if (!row) return undefined;
    let current: ContextResolution;
    try {
      current = JSON.parse(row.resolution_json) as ContextResolution;
    } catch {
      return undefined;
    }
    if (current.clarification !== unavailableClarification) return current;
    this.sharedDb.db.prepare(`UPDATE conversation_reply_plans
      SET resolution_json = ?, created_at = ?
      WHERE source_row_id = ? AND resolution_json = ?`)
      .run(JSON.stringify(replacement), Date.now(), sourceRowId, row.resolution_json);
    return this.getResolution(sourceRowId);
  }

  listCandidates(groupId: string, beforeSourceRowId: number, now: number, excludedUserIds: string[] = []): ConversationTopicCandidate[] {
    const branches = this.sharedDb.db.prepare(`SELECT b.branch_id, b.topic_id, b.owner_user_id, t.title, b.updated_at
      FROM conversation_branches b JOIN conversation_topics t ON t.topic_id = b.topic_id
      WHERE b.group_id = ? AND b.created_at <= ? AND b.updated_at >= ?
      ORDER BY b.updated_at DESC LIMIT 24`).all(groupId, now, now - 60 * 60_000) as Array<{
        branch_id: string; topic_id: string; owner_user_id: string; title: string; updated_at: number;
      }>;
    return branches.filter(branch => !excludedUserIds.includes(branch.owner_user_id)).flatMap(branch => {
      const user = this.sharedDb.db.prepare(`SELECT t.content FROM conversation_turns t JOIN conversation_message_routes r ON r.turn_id = t.id
        WHERE t.branch_id = ? AND t.role = 'user' AND t.user_id = ? AND r.source_row_id < ? ORDER BY t.id DESC LIMIT 1`)
        .get(branch.branch_id, branch.owner_user_id, beforeSourceRowId) as { content: string } | undefined;
      if (!user) return [];
      const reply = this.sharedDb.db.prepare(`SELECT content, delivery_id, id FROM conversation_turns
        WHERE branch_id = ? AND role = 'assistant' AND created_at <= ? ORDER BY id DESC LIMIT 8`)
        .all(branch.branch_id, now) as Array<{ content: string; delivery_id: string | null; id: number }>;
      const visible = excludedUserIds.length ? undefined : reply.map(turn => this.deliveredText(turn.id, turn.content, turn.delivery_id, now)).find(Boolean);
      const pending = this.sharedDb.db.prepare(`SELECT source_row_id FROM conversation_reply_tasks
        WHERE branch_id = ? AND source_row_id < ? AND status IN ('queued','running','awaiting_delivery')
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE source_turn_id = conversation_reply_tasks.source_turn_id AND status IN ('sent','sending')) LIMIT 1`)
        .get(branch.branch_id, beforeSourceRowId);
      return [{ id: branch.branch_id, topicId: branch.topic_id, ownerUserId: branch.owner_user_id,
        title: excludedUserIds.length ? "" : branch.title, lastUserInput: user.content, lastReply: visible ?? "", updatedAt: branch.updated_at, pendingTask: Boolean(pending) }];
    }).slice(0, 8);
  }

  /** Return only acknowledged bubbles; queued/failed assistant drafts are invisible. */
  deliveredText(turnId: number, original: string, deliveryId?: string | null, beforeMs = Infinity): string | undefined {
    if (!deliveryId?.startsWith("outbox:")) return original;
    const rows = this.sharedDb.db.prepare(`SELECT text, sent_at FROM outbox WHERE turn_id = ? AND status = 'sent' ORDER BY id`).all(turnId) as Array<{ text: string; sent_at: number }>;
    const sent = rows.filter(row => row.sent_at <= beforeMs);
    return sent.length ? sent.map(row => row.text).join("\n\n") : undefined;
  }

  readState(turns: ConversationContextTurn[], excludedUserIds: string[] = []): ConversationState {
    let state = emptyConversationState();
    // Assistant text can quote any ancestor. Without provenance for each
    // phrase, withhold derived state when this chain contains an excluded user.
    if (turns.some(turn => turn.userId && excludedUserIds.includes(turn.userId))) return state;
    const sources = new Map<string, string>();
    for (const turn of turns) {
      if (turn.role === "user" && turn.sourceMessageId && turn.userId && !excludedUserIds.includes(turn.userId)) {
        sources.set(turn.sourceMessageId, turn.userId);
      }
    }
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const visible = this.deliveredText(turn.id, turn.content, turn.deliveryId);
      if (!visible) continue;
      const row = this.sharedDb.db.prepare(`SELECT s.update_json, s.group_id, s.source_turn_id, t.content FROM conversation_state_updates s
        JOIN conversation_turns t ON t.id = s.turn_id WHERE s.turn_id = ?`).get(turn.id) as { update_json: string; group_id: string; source_turn_id: number; content: string } | undefined;
      // The exact delivered content is always available even if a provider did
      // not produce a structured update, or a restart interrupted enrichment.
      const raw = row && visible === row.content ? JSON.parse(row.update_json) : {};
      // Shared-topic facts can be grounded in selected ambient/reference
      // messages outside this causal branch. Revalidate those exact sources,
      // rather than losing them on restart or importing arbitrary group facts.
      if (row) {
        const ids = new Set<string>([
          ...(Array.isArray(raw.knownFacts) ? raw.knownFacts : []).flatMap((fact: any) =>
            Array.isArray(fact?.sourceMessageIds) ? fact.sourceMessageIds : []),
          ...(Array.isArray(raw.conclusion?.evidenceIds) ? raw.conclusion.evidenceIds : []),
          ...(Array.isArray(raw.mediaObservations) ? raw.mediaObservations : []).map((item: any) => item?.sourceMessageId),
        ].filter((id: unknown) => typeof id === "string"));
        for (const id of [...ids].slice(0, 64)) {
          if (sources.has(id)) continue;
          const source = this.sharedDb.db.prepare(`SELECT m.user_id FROM messages m WHERE m.group_id = ? AND m.msg_id = ?
            AND m.id <= (SELECT source_row_id FROM conversation_message_routes WHERE turn_id = ?)
            AND m.is_bot_msg = 0 AND (m.processable = 1 OR m.drop_reason = 'rate_limited') LIMIT 1`)
            .get(row.group_id, id, row.source_turn_id) as { user_id: string } | undefined;
          if (source && !excludedUserIds.includes(source.user_id) && !this.sharedDb.isRetracted(row.group_id, id)) sources.set(id, source.user_id);
        }
      }
      const update = sanitizeConversationUpdate(raw, sources);
      update.coveredPoints = [...update.coveredPoints, visible.slice(0, 1_200)];
      state = mergeConversationState(state, update, turn.id);
    }
    return state;
  }

  saveStateUpdate(turnId: number, route: ConversationRoute, value: unknown, sources: Map<string, string>, expectedRevision: number): void {
    const groupId = (this.sharedDb.db.prepare("SELECT group_id FROM conversation_branches WHERE branch_id = ?").get(route.branchId) as { group_id: string } | undefined)?.group_id;
    const verifiedSources = new Map<string, string>();
    for (const [messageId, userId] of sources) {
      const source = this.sharedDb.db.prepare(`SELECT user_id FROM messages WHERE group_id = ? AND msg_id = ? AND id <= ?
        AND is_bot_msg = 0 AND (processable = 1 OR drop_reason = 'rate_limited') LIMIT 1`)
        .get(groupId ?? "", messageId, route.sourceRowId) as { user_id: string } | undefined;
      if (source?.user_id === userId && !this.sharedDb.isRetracted(groupId ?? "", messageId)) verifiedSources.set(messageId, userId);
    }
    const update = sanitizeConversationUpdate(value, verifiedSources);
    update.mediaObservations = update.mediaObservations.filter(item => {
      const row = this.sharedDb.db.prepare("SELECT images_json FROM messages WHERE msg_id = ? AND group_id = ? LIMIT 1")
        .get(item.sourceMessageId, groupId ?? "") as { images_json: string } | undefined;
      return row && parseImages(row.images_json).length > 0;
    });
    // The immutable assistant-turn association is the version boundary. A
    // stale task cannot replace another branch's/latest task's state.
    if (!this.isTaskCurrent(route.sourceRowId)) return;
    this.sharedDb.db.prepare(`INSERT INTO conversation_state_updates (turn_id, group_id, branch_id, source_turn_id, revision, update_json, created_at)
      SELECT ?, group_id, ?, ?, ?, ?, ? FROM conversation_branches WHERE branch_id = ?
      ON CONFLICT(turn_id) DO NOTHING`).run(turnId, route.branchId, route.turnId, expectedRevision + 1, JSON.stringify(update), Date.now(), route.branchId);
  }

  sourceMap(turns: ConversationContextTurn[], messages: AmbientGroupContextMessage[], currentMessageId: string, userId: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const turn of turns) if (turn.role === "user" && turn.sourceMessageId && turn.userId) result.set(turn.sourceMessageId, turn.userId);
    for (const message of messages) if (message.role === "member" && message.messageId && message.userId) result.set(message.messageId, message.userId);
    result.set(currentMessageId, userId);
    return result;
  }

  recentMedia(groupId: string, userId: string, beforeSourceRowId: number, now: number): MediaCandidate[] {
    const rows = this.sharedDb.db.prepare(`SELECT m.id, m.msg_id, m.user_id, m.images_json, r.branch_id FROM messages m
      LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
      WHERE m.group_id = ? AND m.user_id = ? AND m.id < ? AND m.created_at >= ? AND m.created_at <= ?
        AND m.is_bot_msg = 0 AND (m.processable = 1 OR m.drop_reason = 'rate_limited') AND m.images_json <> '[]'
      ORDER BY m.id DESC LIMIT 8`).all(groupId, userId, beforeSourceRowId, now - 120_000, now) as Array<{
        id: number; msg_id: string; user_id: string; images_json: string; branch_id: string | null;
      }>;
    return rows.filter(row => !this.sharedDb.isRetracted(groupId, row.msg_id)).flatMap(row => {
      const images = parseImages(row.images_json);
      return images.length ? [{ sourceRowId: row.id, sourceMessageId: row.msg_id, userId: row.user_id, images, ...(row.branch_id ? { branchId: row.branch_id } : {}) }] : [];
    });
  }

  mediaByIds(groupId: string, ids: string[], beforeSourceRowId: number, excludedUserIds: string[] = []): MediaCandidate[] {
    return ids.slice(0, 6).flatMap(id => {
      const row = this.sharedDb.db.prepare(`SELECT m.id, m.user_id, m.images_json, r.branch_id FROM messages m
        LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
        WHERE m.group_id = ? AND m.msg_id = ? AND m.id < ? AND m.is_bot_msg = 0
          AND (m.processable = 1 OR m.drop_reason = 'rate_limited') LIMIT 1`).get(groupId, id, beforeSourceRowId) as {
            id: number; user_id: string; images_json: string; branch_id: string | null;
          } | undefined;
      if (!row || excludedUserIds.includes(row.user_id) || this.sharedDb.isRetracted(groupId, id)) return [];
      const images = parseImages(row.images_json);
      return images.length ? [{ sourceRowId: row.id, sourceMessageId: id, userId: row.user_id, images, ...(row.branch_id ? { branchId: row.branch_id } : {}) }] : [];
    });
  }

  /** Called at arrival, before the serial consumer waits for the old task. */
  registerTask(route: ConversationRoute, groupId: string, userId: string, relation: ContextResolution["relation"]): void {
    if (this.sharedDb.db.prepare("SELECT source_row_id FROM conversation_reply_tasks WHERE source_row_id = ?").get(route.sourceRowId)) return;
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = relation === "supplement" ? this.sharedDb.db.prepare(`SELECT source_row_id, source_turn_id, merged_source_ids_json FROM conversation_reply_tasks
        WHERE group_id = ? AND user_id = ? AND branch_id = ? AND source_row_id < ?
          AND status IN ('queued','running','awaiting_delivery','failed') ORDER BY source_row_id DESC LIMIT 1`)
        .get(groupId, userId, route.branchId, route.sourceRowId) as { source_row_id: number; source_turn_id: number; merged_source_ids_json: string } | undefined : undefined;
      let merged = [route.sourceRowId];
      if (previous) {
        const committed = this.sharedDb.db.prepare(`SELECT id FROM outbox WHERE branch_id = ? AND source_turn_id = ? AND status IN ('sent','sending')
          UNION ALL SELECT id FROM conversation_turns WHERE branch_id = ? AND parent_turn_id = ? AND role = 'assistant'
            AND (delivery_id IS NULL OR delivery_id NOT LIKE 'outbox:%') LIMIT 1`)
          .get(route.branchId, previous.source_turn_id, route.branchId, previous.source_turn_id);
        if (!committed) {
          merged = [...new Set<number>([...JSON.parse(previous.merged_source_ids_json), route.sourceRowId])].sort((a, b) => a - b);
          this.sharedDb.db.prepare("UPDATE conversation_reply_tasks SET status = 'superseded', replacement_row_id = ? WHERE source_row_id = ?").run(route.sourceRowId, previous.source_row_id);
          this.sharedDb.db.prepare(`UPDATE outbox SET status = 'cancelled', retry_after = NULL, updated_at = ? WHERE branch_id = ? AND source_turn_id = ?
            AND (status IN ('preparing','pending') OR (status = 'failed' AND retry_after IS NOT NULL))`)
            .run(Date.now(), route.branchId, previous.source_turn_id);
          this.sharedDb.requestCancel(`${groupId}:${route.branchId}`);
        }
      }
      this.sharedDb.db.prepare(`INSERT INTO conversation_reply_tasks
        (source_row_id, group_id, user_id, branch_id, source_turn_id, status, merged_source_ids_json, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(route.sourceRowId, groupId, userId, route.branchId, route.turnId, JSON.stringify(merged), Date.now());
      this.sharedDb.db.exec("COMMIT");
    } catch (error) { this.sharedDb.db.exec("ROLLBACK"); throw error; }
  }

  isTaskCurrent(sourceRowId: number): boolean {
    const task = this.sharedDb.db.prepare("SELECT status FROM conversation_reply_tasks WHERE source_row_id = ?").get(sourceRowId) as { status: string } | undefined;
    return task?.status !== "superseded";
  }

  setTaskStatus(sourceRowId: number, status: "running" | "awaiting_delivery" | "failed"): void {
    this.sharedDb.db.prepare("UPDATE conversation_reply_tasks SET status = ?, updated_at = ? WHERE source_row_id = ? AND status <> 'superseded'").run(status, Date.now(), sourceRowId);
  }

  pendingMedia(route: ConversationRoute, excludedUserIds: string[] = []): ConversationState["pendingMedia"] {
    const tasks = this.sharedDb.db.prepare(`SELECT source_turn_id, status, merged_source_ids_json FROM conversation_reply_tasks
      WHERE branch_id = ? AND source_row_id <= ? AND status <> 'superseded' ORDER BY source_row_id DESC LIMIT 12`)
      .all(route.branchId, route.sourceRowId) as Array<{ source_turn_id: number; status: string; merged_source_ids_json: string }>;
    return tasks.flatMap(task => {
      const outbox = this.sharedDb.db.prepare("SELECT status FROM outbox WHERE branch_id = ? AND source_turn_id = ?")
        .all(route.branchId, task.source_turn_id) as Array<{ status: string }>;
      if (outbox.length && outbox.every(row => row.status === "sent")) return [];
      if (!outbox.length && this.sharedDb.db.prepare("SELECT id FROM conversation_turns WHERE branch_id = ? AND parent_turn_id = ? AND role = 'assistant'")
        .get(route.branchId, task.source_turn_id)) return [];
      const status = task.status === "failed" || outbox.some(row => ["failed", "cancelled", "outcome_unknown"].includes(row.status)) ? "failed"
        : task.status === "running" ? "processing" : outbox.length ? "awaiting_delivery" : "queued";
      const ids: number[] = JSON.parse(task.merged_source_ids_json);
      return ids.slice(-12).flatMap(id => {
        const message = this.sharedDb.db.prepare("SELECT msg_id, images_json, user_id, group_id FROM messages WHERE id = ?").get(id) as { msg_id: string; images_json: string; user_id: string; group_id: string } | undefined;
        if (!message || excludedUserIds.includes(message.user_id) || parseImages(message.images_json).length === 0 || this.sharedDb.isRetracted(message.group_id, message.msg_id)) return [];
        return [{ sourceMessageId: message.msg_id, status: status as ConversationState["pendingMedia"][number]["status"] }];
      });
    }).slice(0, 6);
  }

  mergedInput(sourceRowId: number, groupId: string, userId: string): { text?: string; images: MessageImageInput[] } {
    const task = this.sharedDb.db.prepare("SELECT merged_source_ids_json FROM conversation_reply_tasks WHERE source_row_id = ?").get(sourceRowId) as { merged_source_ids_json: string } | undefined;
    const ids: number[] = task ? JSON.parse(task.merged_source_ids_json) : [];
    if (ids.length <= 1) return { images: [] };
    const rows = ids.slice(-12).flatMap(id => {
      const row = this.sharedDb.db.prepare("SELECT text, images_json, msg_id FROM messages WHERE id = ? AND group_id = ? AND user_id = ? AND processable = 1").get(id, groupId, userId) as { text: string; images_json: string; msg_id: string } | undefined;
      return row && !this.sharedDb.isRetracted(groupId, row.msg_id) ? [row] : [];
    });
    return { text: rows.map(row => row.text).filter(Boolean).join("\n"), images: rows.flatMap(row => parseImages(row.images_json)) };
  }

  clear(groupId: string, userId?: string): void {
    this.sharedDb.db.prepare("DELETE FROM conversation_state_updates WHERE group_id = ?").run(groupId);
    for (const table of ["conversation_reply_plans", "conversation_reply_tasks"]) {
      this.sharedDb.db.prepare(`DELETE FROM ${table} WHERE group_id = ?${userId ? " AND user_id = ?" : ""}`).run(groupId, ...(userId ? [userId] : []));
    }
  }
}

function parseImages(raw: string): MessageImageInput[] {
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter(image => image && typeof image === "object" && (typeof image.url === "string" || typeof image.file === "string")).slice(0, 6) : []; }
  catch { return []; }
}
