import { randomUUID } from "node:crypto";

import type { SharedDb } from "../shared/sqlite.js";

const DEFAULT_MAX_TURNS = 32;
const DEFAULT_MAX_CHARS = 24_000;

export type ConversationRouteReason =
  | "explicit-reply"
  | "explicit-reply-fork"
  | "explicit-reply-miss"
  | "same-user-follow-up"
  | "same-user-similar"
  | "new-topic"
  | "fail-closed"
  | string;

export interface ConversationRoute {
  topicId: string;
  branchId: string;
  sourceMessageId: string;
  replyToMessageId?: string;
  routeReason: ConversationRouteReason;
  sourceRowId: number;
  parentTurnId?: number;
  turnId: number;
}

export interface MessageContextBinding {
  groupId: string;
  platformMessageId: string;
  topicId: string;
  branchId: string;
  turnId?: number;
  direction: "user" | "assistant";
  createdAt: number;
}

export interface ActiveConversationRoute {
  groupId: string;
  userId: string;
  topicId: string;
  branchId: string;
  updatedAt: number;
  headTurnId?: number;
}

export interface ConversationBranch {
  branchId: string;
  topicId: string;
  groupId: string;
  ownerUserId: string;
  parentBranchId?: string;
  forkedFromTurnId?: number;
  headTurnId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationContextTurn {
  id: number;
  topicId: string;
  branchId: string;
  parentTurnId?: number;
  role: "user" | "assistant";
  userId?: string;
  content: string;
  sourceMessageId?: string;
  deliveryId?: string;
  platformMessageId?: string;
  createdAt: number;
}

export interface SaveMessageRouteInput {
  sourceRowId: number;
  groupId: string;
  userId: string;
  sourceMessageId: string;
  replyToMessageId?: string;
  routeReason: ConversationRouteReason;
  content: string;
  createdAt: number;
  topicId?: string;
  branchId?: string;
  parentTurnId?: number;
  title?: string;
  keywords?: string[];
}

export interface AppendAssistantTurnInput {
  topicId: string;
  branchId: string;
  content: string;
  createdAt: number;
  parentTurnId?: number;
  deliveryId?: string;
  platformMessageId?: string;
  deliveryIds?: string[];
}

interface RouteRow {
  source_row_id: number;
  group_id: string;
  user_id: string;
  source_message_id: string;
  reply_to_message_id: string | null;
  topic_id: string;
  branch_id: string;
  route_reason: string;
  parent_turn_id: number | null;
  turn_id: number;
  created_at: number;
}

interface BindingRow {
  group_id: string;
  platform_message_id: string;
  topic_id: string;
  branch_id: string;
  turn_id: number | null;
  direction: "user" | "assistant";
  created_at: number;
}

interface BranchRow {
  branch_id: string;
  topic_id: string;
  group_id: string;
  owner_user_id: string;
  parent_branch_id: string | null;
  forked_from_turn_id: number | null;
  head_turn_id: number | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: number;
  topic_id: string;
  branch_id: string;
  parent_turn_id: number | null;
  role: "user" | "assistant";
  user_id: string | null;
  content: string;
  source_message_id: string | null;
  delivery_id: string | null;
  platform_message_id: string | null;
  created_at: number;
}

/** Persistent, process-safe short-term conversation state. */
export class ConversationContextRepository {
  constructor(private readonly sharedDb: SharedDb) {}

  getSourceRowId(groupId: string, sourceMessageId: string): number | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT id FROM messages WHERE group_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1")
      .get(groupId, sourceMessageId.trim()) as { id: number } | undefined;
    return row?.id;
  }

  getRouteBySourceRowId(sourceRowId: number): ConversationRoute | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT * FROM conversation_message_routes WHERE source_row_id = ?")
      .get(sourceRowId) as RouteRow | undefined;
    return row ? toRoute(row) : undefined;
  }

  getMessageContext(groupId: string, platformMessageId: string): MessageContextBinding | undefined {
    const row = this.sharedDb.db
      .prepare(
        `SELECT * FROM conversation_message_context
          WHERE group_id = ? AND platform_message_id = ?`,
      )
      .get(groupId, platformMessageId.trim()) as BindingRow | undefined;
    return row ? toBinding(row) : undefined;
  }

  getActiveRoute(groupId: string, userId: string): ActiveConversationRoute | undefined {
    const row = this.sharedDb.db
      .prepare(
        `SELECT a.group_id, a.user_id, a.topic_id, a.branch_id, a.updated_at,
                b.head_turn_id
           FROM conversation_user_active_routes a
           JOIN conversation_branches b ON b.branch_id = a.branch_id
          WHERE a.group_id = ? AND a.user_id = ?`,
      )
      .get(groupId, userId) as {
        group_id: string;
        user_id: string;
        topic_id: string;
        branch_id: string;
        updated_at: number;
        head_turn_id: number | null;
      } | undefined;
    return row
      ? {
          groupId: row.group_id,
          userId: row.user_id,
          topicId: row.topic_id,
          branchId: row.branch_id,
          updatedAt: row.updated_at,
          ...(row.head_turn_id === null ? {} : { headTurnId: row.head_turn_id }),
        }
      : undefined;
  }

  getBranch(branchId: string): ConversationBranch | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT * FROM conversation_branches WHERE branch_id = ?")
      .get(branchId) as BranchRow | undefined;
    return row ? toBranch(row) : undefined;
  }

  /**
   * Saves one inbound route and its user turn. A duplicate source DB row always
   * returns the first route. Continuing from a non-head anchor automatically
   * forks, preventing sibling replies from sharing history.
   */
  saveMessageRoute(input: SaveMessageRouteInput): ConversationRoute {
    return this.withImmediateTransaction(() => {
      const existing = this.getRouteBySourceRowId(input.sourceRowId);
      if (existing) {
        return existing;
      }

      const now = input.createdAt;
      let branchId = input.branchId?.trim() || createId("branch");
      let routeReason = input.routeReason;
      let parentBranchId: string | undefined;
      let forkedFromTurnId: number | undefined;

      const existingBranch = input.branchId ? this.getBranch(input.branchId) : undefined;
      let topicId = input.topicId?.trim() || existingBranch?.topicId || createId("topic");
      let parentTurnId = input.parentTurnId ?? existingBranch?.headTurnId;
      if (existingBranch) {
        if (existingBranch.groupId !== input.groupId || existingBranch.topicId !== topicId) {
          throw new Error("Conversation branch does not belong to the requested group/topic");
        }
        if (
          input.parentTurnId !== undefined &&
          existingBranch.headTurnId !== undefined &&
          input.parentTurnId !== existingBranch.headTurnId
        ) {
          parentBranchId = existingBranch.branchId;
          forkedFromTurnId = input.parentTurnId;
          branchId = createId("branch");
          routeReason = input.routeReason === "explicit-reply" ? "explicit-reply-fork" : input.routeReason;
        }
      } else if (input.branchId) {
        throw new Error(`Conversation branch ${input.branchId} does not exist`);
      }

      const existingTopic = this.sharedDb.db
        .prepare("SELECT group_id FROM conversation_topics WHERE topic_id = ?")
        .get(topicId) as { group_id: string } | undefined;
      if (existingTopic && existingTopic.group_id !== input.groupId) {
        throw new Error("Conversation topic does not belong to the requested group");
      }
      this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_topics
             (topic_id, group_id, owner_user_id, title, keywords_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(topic_id) DO UPDATE SET
             updated_at = MAX(conversation_topics.updated_at, excluded.updated_at)`,
        )
        .run(
          topicId,
          input.groupId,
          input.userId,
          normalizeTitle(input.title ?? input.content),
          JSON.stringify(normalizeKeywords(input.keywords ?? [])),
          now,
          now,
        );

      if (!existingBranch || branchId !== existingBranch.branchId) {
        this.sharedDb.db
          .prepare(
            `INSERT INTO conversation_branches
               (branch_id, topic_id, group_id, owner_user_id, parent_branch_id,
                forked_from_turn_id, head_turn_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            branchId,
            topicId,
            input.groupId,
            input.userId,
            parentBranchId ?? null,
            forkedFromTurnId ?? null,
            now,
            now,
          );
      }

      const turnResult = this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_turns
             (topic_id, branch_id, parent_turn_id, role, user_id, content,
              source_message_id, created_at)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
        )
        .run(
          topicId,
          branchId,
          parentTurnId ?? null,
          input.userId,
          input.content,
          input.sourceMessageId,
          now,
        );
      const turnId = Number(turnResult.lastInsertRowid);

      this.sharedDb.db
        .prepare("UPDATE conversation_branches SET head_turn_id = ?, updated_at = ? WHERE branch_id = ?")
        .run(turnId, now, branchId);
      this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_message_context
             (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
           VALUES (?, ?, ?, ?, ?, 'user', ?)`,
        )
        .run(input.groupId, input.sourceMessageId, topicId, branchId, turnId, now);
      this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_message_routes
             (source_row_id, group_id, user_id, source_message_id, reply_to_message_id,
              topic_id, branch_id, route_reason, parent_turn_id, turn_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sourceRowId,
          input.groupId,
          input.userId,
          input.sourceMessageId,
          input.replyToMessageId ?? null,
          topicId,
          branchId,
          routeReason,
          parentTurnId ?? null,
          turnId,
          now,
        );
      this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_user_active_routes
             (group_id, user_id, topic_id, branch_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(group_id, user_id) DO UPDATE SET
             topic_id = excluded.topic_id,
             branch_id = excluded.branch_id,
             updated_at = excluded.updated_at`,
        )
        .run(input.groupId, input.userId, topicId, branchId, now);

      return {
        topicId,
        branchId,
        sourceMessageId: input.sourceMessageId,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        routeReason,
        sourceRowId: input.sourceRowId,
        ...(parentTurnId === undefined ? {} : { parentTurnId }),
        turnId,
      };
    });
  }

  /**
   * Resolves an explicit QQ reply and persists the route in one call. Missing
   * or stale anchors fail closed into a fresh topic without hidden history.
   */
  saveExplicitReplyRoute(
    input: Omit<SaveMessageRouteInput, "routeReason" | "topicId" | "branchId" | "parentTurnId">,
    maxAnchorAgeMs: number,
  ): ConversationRoute {
    const replyToMessageId = input.replyToMessageId?.trim();
    if (!replyToMessageId) {
      return this.saveMessageRoute({ ...input, routeReason: "explicit-reply-miss" });
    }
    const anchor = this.getMessageContext(input.groupId, replyToMessageId);
    if (!anchor || input.createdAt - anchor.createdAt > maxAnchorAgeMs || anchor.createdAt > input.createdAt) {
      return this.saveMessageRoute({ ...input, replyToMessageId, routeReason: "explicit-reply-miss" });
    }
    return this.saveMessageRoute({
      ...input,
      replyToMessageId,
      routeReason: "explicit-reply",
      topicId: anchor.topicId,
      branchId: anchor.branchId,
      parentTurnId: anchor.turnId,
    });
  }

  /** Replaces the active pointer without changing an existing branch. */
  setActiveRoute(
    groupId: string,
    userId: string,
    topicId: string,
    branchId: string,
    updatedAt: number,
  ): void {
    const branch = this.getBranch(branchId);
    if (!branch || branch.groupId !== groupId || branch.topicId !== topicId) {
      throw new Error("Conversation branch does not belong to the requested group/topic");
    }
    this.sharedDb.db
      .prepare(
        `INSERT INTO conversation_user_active_routes
           (group_id, user_id, topic_id, branch_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET
           topic_id = excluded.topic_id,
           branch_id = excluded.branch_id,
           updated_at = excluded.updated_at`,
      )
      .run(groupId, userId, topicId, branchId, updatedAt);
  }

  appendAssistantTurn(input: AppendAssistantTurnInput): ConversationContextTurn {
    return this.withImmediateTransaction(() => {
      const branch = this.getBranch(input.branchId);
      if (!branch || branch.topicId !== input.topicId) {
        throw new Error("Conversation branch does not belong to the requested topic");
      }
      const parentTurnId = input.parentTurnId ?? branch.headTurnId;
      const result = this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_turns
             (topic_id, branch_id, parent_turn_id, role, content, delivery_id,
              platform_message_id, created_at)
           VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)`,
        )
        .run(
          input.topicId,
          input.branchId,
          parentTurnId ?? null,
          input.content,
          input.deliveryId ?? null,
          input.platformMessageId ?? null,
          input.createdAt,
        );
      const turnId = Number(result.lastInsertRowid);
      const deliveryIds = [...new Set((input.deliveryIds ?? []).map((id) => id.trim()).filter(Boolean))];
      for (const deliveryId of deliveryIds) {
        const outboxId = parseOutboxDeliveryId(deliveryId);
        const row = this.sharedDb.db
          .prepare(
            `SELECT id, topic_id, branch_id, turn_id, status
               FROM outbox
              WHERE delivery_id = ? OR id = ?`,
          )
          .get(deliveryId, outboxId ?? -1) as {
            id: number;
            topic_id: string | null;
            branch_id: string | null;
            turn_id: number | null;
            status: string;
          } | undefined;
        if (!row) {
          throw new Error(`Outbox delivery ${deliveryId} does not exist`);
        }
        if (
          (row.topic_id && row.topic_id !== input.topicId) ||
          (row.branch_id && row.branch_id !== input.branchId) ||
          (row.turn_id !== null && row.turn_id !== turnId)
        ) {
          throw new Error(`Outbox delivery ${deliveryId} belongs to a different conversation route`);
        }
        if (row.status !== "preparing" && row.status !== "pending") {
          throw new Error(`Outbox delivery ${deliveryId} is not publishable from status ${row.status}`);
        }
        this.sharedDb.db
          .prepare(
            `UPDATE outbox
                SET delivery_id = ?, topic_id = ?, branch_id = ?, turn_id = ?,
                    status = 'pending', updated_at = ?
              WHERE id = ?`,
          )
          .run(`outbox:${row.id}`, input.topicId, input.branchId, turnId, input.createdAt, row.id);
      }
      if (parentTurnId !== undefined) {
        // A worker may route several same-branch messages from one poll batch
        // before the first model reply is available. Splice that reply between
        // its user turn and an already-routed implicit continuation. Explicit
        // replies keep their exact quoted parent: they must not gain access to
        // a bot answer that did not exist when the reply was sent.
        this.sharedDb.db
          .prepare(
            `UPDATE conversation_turns
                SET parent_turn_id = ?
              WHERE id IN (
                SELECT turn_id
                  FROM conversation_message_routes
                 WHERE branch_id = ?
                   AND parent_turn_id = ?
                   AND route_reason IN ('same-user-follow-up', 'same-user-similar')
              )`,
          )
          .run(turnId, input.branchId, parentTurnId);
        this.sharedDb.db
          .prepare(
            `UPDATE conversation_message_routes
                SET parent_turn_id = ?
              WHERE branch_id = ?
                AND parent_turn_id = ?
                AND route_reason IN ('same-user-follow-up', 'same-user-similar')`,
          )
          .run(turnId, input.branchId, parentTurnId);
      }
      this.sharedDb.db
        .prepare(
          `UPDATE conversation_branches
              SET head_turn_id = CASE
                    WHEN head_turn_id IS NULL OR head_turn_id = ? THEN ?
                    ELSE head_turn_id
                  END,
                  updated_at = MAX(updated_at, ?)
            WHERE branch_id = ?`,
        )
        .run(parentTurnId ?? null, turnId, input.createdAt, input.branchId);
      this.sharedDb.db
        .prepare("UPDATE conversation_topics SET updated_at = MAX(updated_at, ?) WHERE topic_id = ?")
        .run(input.createdAt, input.topicId);
      this.sharedDb.db
        .prepare("UPDATE conversation_user_active_routes SET updated_at = MAX(updated_at, ?) WHERE branch_id = ?")
        .run(input.createdAt, input.branchId);
      if (input.platformMessageId) {
        this.insertMessageBinding({
          groupId: branch.groupId,
          platformMessageId: input.platformMessageId,
          topicId: input.topicId,
          branchId: input.branchId,
          turnId,
          direction: "assistant",
          createdAt: input.createdAt,
        });
      }
      return {
        id: turnId,
        topicId: input.topicId,
        branchId: input.branchId,
        ...(parentTurnId === undefined ? {} : { parentTurnId }),
        role: "assistant",
        content: input.content,
        ...(input.deliveryId ?? deliveryIds[0] ? { deliveryId: input.deliveryId ?? deliveryIds[0] } : {}),
        ...(input.platformMessageId ? { platformMessageId: input.platformMessageId } : {}),
        createdAt: input.createdAt,
      };
    });
  }

  bindPlatformMessage(binding: MessageContextBinding): void {
    this.withImmediateTransaction(() => this.insertMessageBinding(binding));
  }

  getCausalTurns(
    branchId: string,
    headTurnId?: number,
    options: { maxTurns?: number; maxChars?: number } = {},
  ): ConversationContextTurn[] {
    const branch = this.getBranch(branchId);
    const head = headTurnId ?? branch?.headTurnId;
    if (!branch || head === undefined) {
      return [];
    }
    const rows = this.sharedDb.db
      .prepare(
        `WITH RECURSIVE chain(
           id, topic_id, branch_id, parent_turn_id, role, user_id, content,
           source_message_id, delivery_id, platform_message_id, created_at, depth
         ) AS (
           SELECT id, topic_id, branch_id, parent_turn_id, role, user_id, content,
                  source_message_id, delivery_id, platform_message_id, created_at, 0
             FROM conversation_turns
            WHERE id = ? AND topic_id = ?
           UNION ALL
           SELECT parent.id, parent.topic_id, parent.branch_id, parent.parent_turn_id,
                  parent.role, parent.user_id, parent.content, parent.source_message_id,
                  parent.delivery_id, parent.platform_message_id, parent.created_at,
                  chain.depth + 1
             FROM conversation_turns parent
             JOIN chain ON parent.id = chain.parent_turn_id
            WHERE chain.depth < 255 AND parent.topic_id = ?
         )
         SELECT id, topic_id, branch_id, parent_turn_id, role, user_id, content,
                source_message_id, delivery_id, platform_message_id, created_at
           FROM chain
          ORDER BY depth DESC`,
      )
      .all(head, branch.topicId, branch.topicId) as unknown as TurnRow[];
    return trimTurns(
      rows.map(toTurn),
      options.maxTurns ?? DEFAULT_MAX_TURNS,
      options.maxChars ?? DEFAULT_MAX_CHARS,
    );
  }

  /** Reads the live parent chain of a routed user turn. */
  getCausalTurnsBeforeTurn(
    branchId: string,
    turnId: number,
    options: { maxTurns?: number; maxChars?: number } = {},
  ): ConversationContextTurn[] {
    const row = this.sharedDb.db
      .prepare(
        `SELECT parent_turn_id
           FROM conversation_turns
          WHERE id = ? AND branch_id = ? AND role = 'user'`,
      )
      .get(turnId, branchId) as { parent_turn_id: number | null } | undefined;
    if (!row || row.parent_turn_id === null) {
      return [];
    }
    return this.getCausalTurns(branchId, row.parent_turn_id, options);
  }

  hasAssistantReplyForTurn(branchId: string, userTurnId: number): boolean {
    return Boolean(
      this.sharedDb.db
        .prepare(
          `SELECT 1 AS ok
             FROM conversation_turns
            WHERE branch_id = ? AND parent_turn_id = ? AND role = 'assistant'
            LIMIT 1`,
        )
        .get(branchId, userTurnId),
    );
  }

  clearUser(groupId: string, userId: string): void {
    this.withImmediateTransaction(() => {
      this.sharedDb.db
        .prepare("DELETE FROM conversation_user_active_routes WHERE group_id = ? AND user_id = ?")
        .run(groupId, userId);

      const ownedRows = this.sharedDb.db
        .prepare(
          `SELECT b.branch_id
             FROM conversation_branches b
            WHERE b.group_id = ? AND b.owner_user_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM conversation_turns tr
                 WHERE tr.branch_id = b.branch_id
                   AND tr.role = 'user'
                   AND tr.user_id IS NOT NULL
                   AND tr.user_id != ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM conversation_user_active_routes a
                 WHERE a.branch_id = b.branch_id AND a.user_id != ?
              )`,
        )
        .all(groupId, userId, userId, userId) as Array<{ branch_id: string }>;
      const deletable = new Set(ownedRows.map((row) => row.branch_id));

      // A private branch cannot be removed while a retained child branch or
      // turn still depends on one of its anchors.
      let changed = true;
      while (changed) {
        changed = false;
        for (const branchId of [...deletable]) {
          const childBranches = this.sharedDb.db
            .prepare("SELECT branch_id FROM conversation_branches WHERE parent_branch_id = ?")
            .all(branchId) as Array<{ branch_id: string }>;
          const externalTurnBranches = this.sharedDb.db
            .prepare(
              `SELECT DISTINCT child.branch_id
                 FROM conversation_turns parent
                 JOIN conversation_turns child ON child.parent_turn_id = parent.id
                WHERE parent.branch_id = ? AND child.branch_id != ?`,
            )
            .all(branchId, branchId) as Array<{ branch_id: string }>;
          if (
            childBranches.some((row) => !deletable.has(row.branch_id)) ||
            externalTurnBranches.some((row) => !deletable.has(row.branch_id))
          ) {
            deletable.delete(branchId);
            changed = true;
          }
        }
      }

      if (deletable.size > 0) {
        const branchIds = [...deletable];
        const placeholders = branchIds.map(() => "?").join(",");
        this.sharedDb.db
          .prepare(
            `UPDATE outbox
                SET status = CASE WHEN status = 'sent' THEN status ELSE 'cancelled' END,
                    retry_after = NULL, topic_id = NULL, branch_id = NULL,
                    source_turn_id = NULL, turn_id = NULL,
                    updated_at = ?
              WHERE branch_id IN (${placeholders})`,
          )
          .run(Date.now(), ...branchIds);
        this.sharedDb.db
          .prepare(`DELETE FROM conversation_message_routes WHERE branch_id IN (${placeholders})`)
          .run(...branchIds);
        this.sharedDb.db
          .prepare(`DELETE FROM conversation_message_context WHERE branch_id IN (${placeholders})`)
          .run(...branchIds);
        this.sharedDb.db
          .prepare(`DELETE FROM conversation_user_active_routes WHERE branch_id IN (${placeholders})`)
          .run(...branchIds);
        for (const branchId of branchIds) {
          this.sharedDb.db.prepare("DELETE FROM inflight WHERE key = ?").run(`${groupId}:${branchId}`);
        }
        this.sharedDb.db
          .prepare(`DELETE FROM conversation_turns WHERE branch_id IN (${placeholders})`)
          .run(...branchIds);
        this.sharedDb.db
          .prepare(`DELETE FROM conversation_branches WHERE branch_id IN (${placeholders})`)
          .run(...branchIds);
        this.sharedDb.db.prepare(
          `DELETE FROM conversation_topics
            WHERE group_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM conversation_branches b
                 WHERE b.topic_id = conversation_topics.topic_id
              )`,
        ).run(groupId);
      }
    });
  }

  clearGroup(groupId: string): void {
    this.withImmediateTransaction(() => {
      const topics = this.sharedDb.db
        .prepare("SELECT topic_id FROM conversation_topics WHERE group_id = ?")
        .all(groupId) as Array<{ topic_id: string }>;
      for (const { topic_id: topicId } of topics) {
        this.deleteTopic(topicId);
      }
      this.sharedDb.db.prepare("DELETE FROM conversation_message_routes WHERE group_id = ?").run(groupId);
      this.sharedDb.db.prepare("DELETE FROM conversation_message_context WHERE group_id = ?").run(groupId);
      this.sharedDb.db.prepare("DELETE FROM conversation_user_active_routes WHERE group_id = ?").run(groupId);
      this.sharedDb.db
        .prepare("DELETE FROM inflight WHERE key = ? OR key LIKE ? ESCAPE '\\'")
        .run(groupId, `${escapeLike(groupId)}:%`);
    });
  }

  /** Starts the new context epoch without deleting retained inbound audit rows. */
  cutoverShortTermContext(cutoverMessageId?: number): number {
    return this.withImmediateTransaction(() => {
      const row = this.sharedDb.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages").get() as { id: number };
      const cutover = cutoverMessageId ?? row.id;
      this.sharedDb.db.prepare(
        `UPDATE outbox
            SET status = CASE WHEN status = 'sent' THEN status ELSE 'cancelled' END,
                retry_after = NULL, topic_id = NULL, branch_id = NULL,
                source_turn_id = NULL, turn_id = NULL, updated_at = ?`,
      ).run(Date.now());
      this.sharedDb.db.exec(`
        DELETE FROM conversation_message_routes;
        DELETE FROM conversation_message_context;
        DELETE FROM conversation_user_active_routes;
        DELETE FROM conversation_turns;
        DELETE FROM conversation_branches;
        DELETE FROM conversation_topics;
        DELETE FROM inflight;
        DELETE FROM bot_messages;
        DELETE FROM consumer_completed_messages;
      `);
      this.sharedDb.db
        .prepare(
          `INSERT INTO conversation_context_meta (key, value)
           VALUES ('cutover_message_id', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(cutover));
      return cutover;
    });
  }

  private insertMessageBinding(binding: MessageContextBinding): void {
    const existing = this.getMessageContext(binding.groupId, binding.platformMessageId);
    if (
      existing &&
      (existing.topicId !== binding.topicId ||
        existing.branchId !== binding.branchId ||
        (existing.turnId !== undefined && binding.turnId !== undefined && existing.turnId !== binding.turnId))
    ) {
      throw new Error("Platform message id is already bound to a different conversation route");
    }
    this.sharedDb.db
      .prepare(
        `INSERT INTO conversation_message_context
           (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, platform_message_id) DO UPDATE SET
           turn_id = COALESCE(conversation_message_context.turn_id, excluded.turn_id)`,
      )
      .run(
        binding.groupId,
        binding.platformMessageId.trim(),
        binding.topicId,
        binding.branchId,
        binding.turnId ?? null,
        binding.direction,
        binding.createdAt,
      );
  }

  private deleteTopic(topicId: string): void {
    this.sharedDb.db
      .prepare(
        `UPDATE outbox
            SET status = CASE WHEN status = 'sent' THEN status ELSE 'cancelled' END,
                retry_after = NULL, topic_id = NULL, branch_id = NULL,
                source_turn_id = NULL, turn_id = NULL, updated_at = ?
          WHERE topic_id = ?`,
      )
      .run(Date.now(), topicId);
    this.sharedDb.db
      .prepare("DELETE FROM conversation_message_routes WHERE topic_id = ?")
      .run(topicId);
    this.sharedDb.db
      .prepare("DELETE FROM conversation_message_context WHERE topic_id = ?")
      .run(topicId);
    this.sharedDb.db
      .prepare("DELETE FROM conversation_user_active_routes WHERE topic_id = ?")
      .run(topicId);
    this.sharedDb.db.prepare("DELETE FROM conversation_turns WHERE topic_id = ?").run(topicId);
    this.sharedDb.db.prepare("DELETE FROM conversation_branches WHERE topic_id = ?").run(topicId);
    this.sharedDb.db.prepare("DELETE FROM conversation_topics WHERE topic_id = ?").run(topicId);
  }

  private withImmediateTransaction<T>(callback: () => T): T {
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.sharedDb.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function createId(kind: "topic" | "branch"): string {
  return `${kind}:${randomUUID()}`;
}

function toRoute(row: RouteRow): ConversationRoute {
  return {
    topicId: row.topic_id,
    branchId: row.branch_id,
    sourceMessageId: row.source_message_id,
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
    routeReason: row.route_reason,
    sourceRowId: row.source_row_id,
    ...(row.parent_turn_id === null ? {} : { parentTurnId: row.parent_turn_id }),
    turnId: row.turn_id,
  };
}

function toBinding(row: BindingRow): MessageContextBinding {
  return {
    groupId: row.group_id,
    platformMessageId: row.platform_message_id,
    topicId: row.topic_id,
    branchId: row.branch_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    direction: row.direction,
    createdAt: row.created_at,
  };
}

function toBranch(row: BranchRow): ConversationBranch {
  return {
    branchId: row.branch_id,
    topicId: row.topic_id,
    groupId: row.group_id,
    ownerUserId: row.owner_user_id,
    ...(row.parent_branch_id ? { parentBranchId: row.parent_branch_id } : {}),
    ...(row.forked_from_turn_id === null ? {} : { forkedFromTurnId: row.forked_from_turn_id }),
    ...(row.head_turn_id === null ? {} : { headTurnId: row.head_turn_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurn(row: TurnRow): ConversationContextTurn {
  return {
    id: row.id,
    topicId: row.topic_id,
    branchId: row.branch_id,
    ...(row.parent_turn_id === null ? {} : { parentTurnId: row.parent_turn_id }),
    role: row.role,
    ...(row.user_id ? { userId: row.user_id } : {}),
    content: row.content,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
    createdAt: row.created_at,
  };
}

function trimTurns(turns: ConversationContextTurn[], maxTurns: number, maxChars: number): ConversationContextTurn[] {
  const limitedTurns = Math.max(1, Math.floor(maxTurns));
  const limitedChars = Math.max(1, Math.floor(maxChars));
  const result = turns.slice(-limitedTurns);
  let chars = result.reduce((total, turn) => total + turn.content.length, 0);
  while (result.length > 1 && chars > limitedChars) {
    chars -= result.shift()!.content.length;
  }
  if (result.length === 1 && chars > limitedChars) {
    result[0] = { ...result[0]!, content: result[0]!.content.slice(-limitedChars) };
  }
  return result;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 32);
}

function parseOutboxDeliveryId(deliveryId: string): number | undefined {
  const match = /^outbox:(\d+)$/.exec(deliveryId);
  return match ? Number(match[1]) : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}
