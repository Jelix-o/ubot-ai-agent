import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { logWarn } from "../logger.js";

/**
 * SQLite-backed shared state for the multi-process bot.
 *
 * The process boundary is:
 *   [ingress] NapCat reverse WS → dedupe → write `messages` table
 *   [worker]  poll `messages` via `consumers` watermarks → reply → write `outbox`
 *   [admin]   read-only state (metrics, health)
 *
 * All tables live in a single WAL-mode database under `data/shared/bot-shared.db`
 * so each process can open its own connection without network.
 */

export interface IngressMessageRow {
  id: number;
  group_id: string;
  user_id: string;
  self_id: string;
  msg_id: string;
  msg_time: number;
  text: string;
  images_json: string;
  sender_card: string | null;
  sender_nickname: string | null;
  reply_to: string | null;
  has_at_bot: number;
  is_bot_msg: number;
  created_at: number;
  context_topic_id: string | null;
  context_branch_id: string | null;
  context_route_reason: string | null;
}

export interface InflightRow {
  key: string;
  task_id: string;
  started_at: number;
  cancel_token: string;
  cancel_requested: number;
  merged_reply: string | null;
}

export interface OutboxRow {
  id: number;
  group_id: string;
  reply_to: string | null;
  kind: string;
  text: string;
  status: string;
  retry_after: number | null;
  topic_id: string | null;
  branch_id: string | null;
  source_turn_id: number | null;
  turn_id: number | null;
  delivery_id: string | null;
  platform_message_id: string | null;
  sent_at: number | null;
  updated_at: number | null;
  created_at: number;
}

export interface OutboxContext {
  topicId: string;
  branchId: string;
  sourceTurnId?: number;
  turnId?: number;
}

export interface RecentGroupMessageRow {
  group_id: string;
  user_id: string;
  msg_id: string;
  msg_time: number;
  text: string;
  images_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  self_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  msg_time INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  sender_card TEXT,
  sender_nickname TEXT,
  reply_to TEXT,
  has_at_bot INTEGER NOT NULL DEFAULT 0,
  is_bot_msg INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS conversation_topics (
  topic_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_topics_group_updated
  ON conversation_topics (group_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_branches (
  branch_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_turn_id INTEGER,
  head_turn_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_topic
  ON conversation_branches (topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_owner
  ON conversation_branches (group_id, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_turn_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  user_id TEXT,
  content TEXT NOT NULL,
  source_message_id TEXT,
  delivery_id TEXT,
  platform_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_branch
  ON conversation_turns (branch_id, id);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_parent
  ON conversation_turns (parent_turn_id);

CREATE TABLE IF NOT EXISTS conversation_message_context (
  group_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  turn_id INTEGER,
  direction TEXT NOT NULL CHECK (direction IN ('user', 'assistant')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, platform_message_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_message_context_branch
  ON conversation_message_context (branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_message_routes (
  source_row_id INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  route_reason TEXT NOT NULL,
  parent_turn_id INTEGER,
  turn_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_message_routes_group_source
  ON conversation_message_routes (group_id, source_message_id);

CREATE TABLE IF NOT EXISTS conversation_user_active_routes (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversation_context_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumers (
  key TEXT PRIMARY KEY,
  watermark_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consumer_completed_messages (
  consumer_key TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (consumer_key, message_id)
);

CREATE TABLE IF NOT EXISTS inflight (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  cancel_token TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  merged_reply TEXT
);

CREATE TABLE IF NOT EXISTS retracted (
  msg_key TEXT PRIMARY KEY,
  retracted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS msg_lock (
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  lock_owner TEXT NOT NULL,
  locked_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  reply_to TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_after INTEGER,
  topic_id TEXT,
  branch_id TEXT,
  source_turn_id INTEGER,
  turn_id INTEGER,
  delivery_id TEXT,
  platform_message_id TEXT,
  sent_at INTEGER,
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_messages (
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);
`;

export class SharedDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrateSchema();
  }

  /** 轻量 schema 迁移：旧库缺列时补齐（CREATE TABLE IF NOT EXISTS 不会改已有表）。 */
  private migrateSchema(): void {
    const messageCols = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    for (const [name, sqlType] of [
      ["sender_card", "TEXT"],
      ["sender_nickname", "TEXT"],
    ] as const) {
      if (!messageCols.some((col) => col.name === name)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${sqlType}`);
      }
    }

    const outboxCols = this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    const additions: Array<[string, string]> = [
      ["updated_at", "INTEGER"],
      ["topic_id", "TEXT"],
      ["branch_id", "TEXT"],
      ["source_turn_id", "INTEGER"],
      ["turn_id", "INTEGER"],
      ["delivery_id", "TEXT"],
      ["platform_message_id", "TEXT"],
      ["sent_at", "INTEGER"],
      ["retry_after", "INTEGER"],
    ];
    for (const [name, sqlType] of additions) {
      if (!outboxCols.some((col) => col.name === name)) {
        this.db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${sqlType}`);
      }
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  // ---- messages (written by ingress, polled by workers) ----

  /** Idempotent insert keyed on (self_id, group_id, msg_id). Returns row id or 0 when duplicate. */
  insertMessage(row: {
    groupId: string;
    userId: string;
    selfId: string;
    msgId: string;
    msgTime: number;
    text: string;
    imagesJson: string;
    senderCard?: string;
    senderNickname?: string;
    replyTo?: string;
    hasAtBot: boolean;
    isBotMsg: boolean;
    createdAt: number;
  }): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages
             (group_id, user_id, self_id, msg_id, msg_time, text, images_json,
              sender_card, sender_nickname, reply_to, has_at_bot, is_bot_msg, created_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.groupId,
          row.userId,
          row.selfId,
          row.msgId,
          row.msgTime,
          row.text,
          row.imagesJson,
          normalizeOptionalText(row.senderCard),
          normalizeOptionalText(row.senderNickname),
          row.replyTo ?? null,
          row.hasAtBot ? 1 : 0,
          row.isBotMsg ? 1 : 0,
          row.createdAt,
          `${row.selfId}:${row.groupId}:${row.msgId}`,
        );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return 0;
      }
      throw error;
    }
  }

  /** Number of messages by group within the trailing window; used for per-group token bucket. */
  countMessagesSince(groupId: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND msg_time >= ?")
      .get(groupId, sinceMs) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Raw rows are exposed only to the local atmosphere summarizer. */
  listRecentGroupMessages(groupId: string, sinceMs: number, limit = 200): RecentGroupMessageRow[] {
    return this.db
      .prepare(
        `SELECT group_id, user_id, msg_id, msg_time, text, images_json
           FROM messages
          WHERE group_id = ? AND msg_time >= ? AND is_bot_msg = 0
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(groupId, sinceMs, Math.max(1, Math.min(500, limit)))
      .reverse() as unknown as RecentGroupMessageRow[];
  }

  /**
   * Earliest pending message for a consumer key.
   * Ordered by SQLite's autoincrement id. The watermark uses the same order,
   * so timestamp skew cannot make a message disappear between batches.
   */
  pollMessages(key: string, limit: number): IngressMessageRow[] {
    this.ensureConsumer(key);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.group_id, m.user_id, m.self_id, m.msg_id, m.msg_time, m.text,
                m.images_json, m.sender_card, m.sender_nickname, m.reply_to,
                m.has_at_bot, m.is_bot_msg, m.created_at,
                r.topic_id AS context_topic_id,
                r.branch_id AS context_branch_id,
                r.route_reason AS context_route_reason
           FROM messages m
           JOIN consumers c ON c.key = ?
           LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
           WHERE m.id > MAX(
             c.watermark_id,
             COALESCE((
               SELECT CAST(value AS INTEGER)
                 FROM conversation_context_meta
                WHERE key = 'cutover_message_id'
             ), 0)
           )
             AND NOT EXISTS (
               SELECT 1
                 FROM consumer_completed_messages completed
                WHERE completed.consumer_key = ?
                  AND completed.message_id = m.id
             )
           ORDER BY m.id ASC
           LIMIT ?`,
      )
      .all(key, key, limit) as unknown as IngressMessageRow[];
    return rows;
  }

  /** Advances the watermark but never backwards (a retried old message must not re-deliver newer ones). */
  advanceWatermark(key: string, messageId: number): void {
    this.db
      .prepare("UPDATE consumers SET watermark_id = MAX(watermark_id, ?) WHERE key = ?")
      .run(messageId, key);
  }

  /**
   * Marks one message complete and advances only across the contiguous prefix.
   * This lets different branch keys finish out of order without skipping an
   * earlier task that still has to survive a worker restart.
   */
  completeConsumerMessage(key: string, messageId: number, completedAt = Date.now()): void {
    this.withImmediateTransaction(() => {
      this.ensureConsumer(key);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO consumer_completed_messages
             (consumer_key, message_id, completed_at)
           VALUES (?, ?, ?)`,
        )
        .run(key, messageId, completedAt);

      const consumer = this.db
        .prepare("SELECT watermark_id FROM consumers WHERE key = ?")
        .get(key) as { watermark_id: number };
      const cutover = this.db
        .prepare(
          `SELECT CAST(value AS INTEGER) AS cutover_id
             FROM conversation_context_meta
            WHERE key = 'cutover_message_id'`,
        )
        .get() as { cutover_id: number } | undefined;
      // Rows at or before the context cutover remain in `messages` for audit,
      // but they are no longer part of the consumable sequence. Start the
      // contiguous-completion walk at the same effective boundary as polling.
      let watermark = Math.max(consumer.watermark_id, cutover?.cutover_id ?? 0);
      while (true) {
        const nextMessage = this.db
          .prepare("SELECT id FROM messages WHERE id > ? ORDER BY id ASC LIMIT 1")
          .get(watermark) as { id: number } | undefined;
        if (!nextMessage) {
          break;
        }
        const completed = this.db
          .prepare(
            `SELECT 1 AS ok FROM consumer_completed_messages
              WHERE consumer_key = ? AND message_id = ?`,
          )
          .get(key, nextMessage.id) as { ok: number } | undefined;
        if (!completed) {
          break;
        }
        watermark = nextMessage.id;
      }

      this.db.prepare("UPDATE consumers SET watermark_id = ? WHERE key = ?").run(watermark, key);
      this.db
        .prepare("DELETE FROM consumer_completed_messages WHERE consumer_key = ? AND message_id <= ?")
        .run(key, watermark);
    });
  }

  isConsumerMessageCompleted(key: string, messageId: number): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS ok FROM consumer_completed_messages WHERE consumer_key = ? AND message_id = ?")
        .get(key, messageId),
    );
  }

  /**
   * 清表兜底（生产事故根因之一）：messages 被外部清空/重建后，水位可能指向
   * 不存在的 id。worker 启动时调用，水位超过当前最大 id 则重置为 0，避免
   * "水位错乱 → 每条消息异常处理 → 乱回复"。
   */
  resetWatermarkIfStale(key: string): void {
    const maxId = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages").get() as { n: number };
    const watermark = this.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get(key) as { watermark_id: number } | undefined;
    if (watermark && watermark.watermark_id > maxId.n) {
      this.db.prepare("UPDATE consumers SET watermark_id = 0 WHERE key = ?").run(key);
      logWarn("Consumer watermark reset because messages were cleared.", {
        key,
        oldWatermark: watermark.watermark_id,
        maxMessageId: maxId.n,
      });
    }
  }

  private ensureConsumer(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO consumers (key, watermark_id) VALUES (?, 0)").run(key);
  }

  // ---- retracted (recall) ----

  markRetracted(groupId: string, msgId: string, nowMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO retracted (msg_key, retracted_at) VALUES (?, ?)")
      .run(`${groupId}:${msgId}`, nowMs);
  }

  isRetracted(groupId: string, msgId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM retracted WHERE msg_key = ?")
      .get(`${groupId}:${msgId}`) as { found: number } | undefined;
    return Boolean(row);
  }

  pruneRetracted(beforeMs: number): void {
    this.db.prepare("DELETE FROM retracted WHERE retracted_at < ?").run(beforeMs);
  }

  // ---- in-flight registry (per key) ----

  registerInflight(key: string, taskId: string, startedAtMs: number, cancelToken: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inflight (key, task_id, started_at, cancel_token, cancel_requested, merged_reply)
         VALUES (?, ?, ?, ?, 0, NULL)`,
      )
      .run(key, taskId, startedAtMs, cancelToken);
  }

  getInflight(key: string): InflightRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM inflight WHERE key = ?")
      .get(key) as InflightRow | undefined;
    return row;
  }

  requestCancel(key: string): void {
    this.db
      .prepare("UPDATE inflight SET cancel_requested = 1 WHERE key = ?")
      .run(key);
  }

  clearInflight(key: string, taskId?: string): void {
    if (taskId) {
      this.db.prepare("DELETE FROM inflight WHERE key = ? AND task_id = ?").run(key, taskId);
      return;
    }
    this.db.prepare("DELETE FROM inflight WHERE key = ?").run(key);
  }

  // ---- outbox (worker → emitter) ----

  enqueueOutbox(
    groupId: string,
    replyTo: string | null,
    text: string,
    kind = "text",
    context?: OutboxContext,
  ): number {
    const status = context && context.turnId === undefined ? "preparing" : "pending";
    const result = this.db
      .prepare(
        `INSERT INTO outbox
           (group_id, reply_to, kind, text, status, topic_id, branch_id,
            source_turn_id, turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        replyTo,
        kind,
        text,
        status,
        context?.topicId ?? null,
        context?.branchId ?? null,
        context?.sourceTurnId ?? null,
        context?.turnId ?? null,
        Date.now(),
      );
    const id = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE outbox SET delivery_id = ? WHERE id = ?").run(`outbox:${id}`, id);
    return id;
  }

  /**
   * Atomically claims pending rows for delivery: each row is flipped to
   * 'sending' before the network call, so a crash/retry can never double-send
   * the same outbox row (plan §6 red line: duplicate_reply_rate must be 0).
   * 'sending' rows older than `sendingTimeoutMs` are reclaimed (the sender may
   * have died mid-flight; the message may or may not have been delivered —
   * on reconnect the transport itself rejects in-flight actions, and the
   * reclaim window is long enough that a double-send is avoided in practice).
   */
  claimOutbox(limit: number, nowMs = Date.now()): OutboxRow[] {
    return this.withImmediateTransaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM outbox
             WHERE status = 'pending'
                OR (status = 'failed' AND retry_after IS NOT NULL AND retry_after <= ?)
             ORDER BY id ASC LIMIT ?`,
        )
        .all(nowMs, limit) as Array<{ id: number }>;
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE outbox
              SET status = 'sending', updated_at = ?
            WHERE id IN (${placeholders})
              AND (status = 'pending'
                OR (status = 'failed' AND retry_after IS NOT NULL AND retry_after <= ?))`,
        )
        .run(nowMs, ...ids, nowMs);
      return this.db
        .prepare(`SELECT * FROM outbox WHERE id IN (${placeholders}) AND status = 'sending' ORDER BY id`)
        .all(...ids) as unknown as OutboxRow[];
    });
  }

  markOutboxSent(id: number): void {
    const now = Date.now();
    this.db
      .prepare("UPDATE outbox SET status = 'sent', retry_after = NULL, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  /** Atomically stores the real platform id and makes it available as a reply anchor. */
  ackOutboxDelivery(id: number, platformMessageId: string, sentAtMs = Date.now()): void {
    const normalizedMessageId = platformMessageId.trim();
    if (!normalizedMessageId) {
      throw new Error("platformMessageId must not be empty");
    }
    this.withImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
      if (!row) {
        throw new Error(`Outbox row ${id} does not exist`);
      }
      if (row.platform_message_id && row.platform_message_id !== normalizedMessageId) {
        throw new Error(`Outbox row ${id} was already acknowledged with a different platform message id`);
      }
      const sentAt = row.sent_at ?? sentAtMs;
      this.db
        .prepare(
          `UPDATE outbox
              SET status = 'sent', retry_after = NULL, platform_message_id = ?, sent_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(normalizedMessageId, sentAt, sentAtMs, id);
      this.db
        .prepare("INSERT OR REPLACE INTO bot_messages (group_id, msg_id, sent_at) VALUES (?, ?, ?)")
        .run(row.group_id, normalizedMessageId, sentAt);
      this.syncOutboxConversationContext(
        { ...row, platform_message_id: normalizedMessageId, sent_at: sentAt },
        sentAt,
      );
    });
  }

  /**
   * Attaches the causal context after enqueue. If delivery already completed,
   * the real QQ id is exposed as an anchor in the same transaction.
   */
  attachOutboxContext(deliveryId: string, context: OutboxContext): void {
    this.attachOutboxContexts([deliveryId], context);
  }

  /** Attaches every multipart row and exposes them for sending in one transaction. */
  attachOutboxContexts(deliveryIds: string[], context: OutboxContext): void {
    const normalizedIds = [...new Set(deliveryIds.map((id) => id.trim()).filter(Boolean))];
    if (normalizedIds.length === 0) {
      return;
    }
    if (context.turnId === undefined) {
      throw new Error("A persisted assistant turn is required before outbox delivery");
    }
    this.withImmediateTransaction(() => {
      for (const normalizedDeliveryId of normalizedIds) {
        this.attachOneOutboxContext(normalizedDeliveryId, context);
      }
    });
  }

  private attachOneOutboxContext(normalizedDeliveryId: string, context: OutboxContext): void {
    const row = this.findOutboxByDeliveryId(normalizedDeliveryId);
    if (!row) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} does not exist`);
    }
    if (
      (row.topic_id && row.topic_id !== context.topicId) ||
      (row.branch_id && row.branch_id !== context.branchId) ||
      (row.turn_id !== null && context.turnId !== undefined && row.turn_id !== context.turnId)
    ) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} is already attached to a different conversation route`);
    }
    const canonicalDeliveryId = `outbox:${row.id}`;
    if (row.delivery_id && row.delivery_id !== normalizedDeliveryId && row.delivery_id !== canonicalDeliveryId) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} does not match its stored delivery id`);
    }
    this.db
      .prepare(
        `UPDATE outbox
            SET delivery_id = COALESCE(delivery_id, ?),
                topic_id = COALESCE(topic_id, ?),
                branch_id = COALESCE(branch_id, ?),
                turn_id = COALESCE(turn_id, ?),
                status = CASE WHEN status = 'preparing' THEN 'pending' ELSE status END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        canonicalDeliveryId,
        context.topicId,
        context.branchId,
        context.turnId ?? null,
        Date.now(),
        row.id,
      );
    const attached = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(row.id) as unknown as OutboxRow;
    this.syncOutboxConversationContext(attached, attached.sent_at ?? Date.now());
  }

  markOutboxFailed(id: number, retryAfterMs: number | null = 2_000): void {
    if (retryAfterMs === null) {
      this.db.prepare("UPDATE outbox SET status = 'failed', retry_after = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
      return;
    }
    this.db
      .prepare("UPDATE outbox SET status = 'failed', retry_after = ?, updated_at = ? WHERE id = ?")
      .run(Date.now() + retryAfterMs, Date.now(), id);
  }

  /** Removes worker-only drafts that have never become visible to the emitter. */
  discardPreparingOutbox(deliveryIds: string[]): number {
    const ids = [...new Set(deliveryIds.map(parseOutboxDeliveryId).filter((id): id is number => id !== undefined))];
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM outbox WHERE id IN (${placeholders}) AND status = 'preparing'`)
      .run(...ids);
    return Number(result.changes);
  }

  /** Removes drafts left by a crashed attempt of this exact routed user turn. */
  discardPreparingOutboxForSource(
    topicId: string,
    branchId: string,
    sourceTurnId: number,
  ): number {
    const result = this.db
      .prepare(
        `DELETE FROM outbox
          WHERE status = 'preparing'
            AND topic_id = ?
            AND branch_id = ?
            AND source_turn_id = ?`,
      )
      .run(topicId, branchId, sourceTurnId);
    return Number(result.changes);
  }

  // ---- bot self messages (used to filter self-referencing chains) ----

  recordBotMessage(groupId: string, msgId: string, sentAtMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO bot_messages (group_id, msg_id, sent_at) VALUES (?, ?, ?)")
      .run(groupId, msgId, sentAtMs);
  }

  pruneBotMessages(beforeMs: number): void {
    this.db.prepare("DELETE FROM bot_messages WHERE sent_at < ?").run(beforeMs);
  }

  private findOutboxByDeliveryId(deliveryId: string): OutboxRow | undefined {
    const direct = this.db.prepare("SELECT * FROM outbox WHERE delivery_id = ?").get(deliveryId) as OutboxRow | undefined;
    if (direct) {
      return direct;
    }
    const match = /^outbox:(\d+)$/.exec(deliveryId);
    if (!match) {
      return undefined;
    }
    return this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(Number(match[1])) as OutboxRow | undefined;
  }

  private syncOutboxConversationContext(row: OutboxRow, createdAt: number): void {
    if (!row.topic_id || !row.branch_id || !row.platform_message_id) {
      return;
    }
    const existingContext = this.db
      .prepare(
        `SELECT topic_id, branch_id, turn_id
           FROM conversation_message_context
          WHERE group_id = ? AND platform_message_id = ?`,
      )
      .get(row.group_id, row.platform_message_id) as {
        topic_id: string;
        branch_id: string;
        turn_id: number | null;
      } | undefined;
    if (
      existingContext &&
      (existingContext.topic_id !== row.topic_id ||
        existingContext.branch_id !== row.branch_id ||
        (existingContext.turn_id !== null && row.turn_id !== null && existingContext.turn_id !== row.turn_id))
    ) {
      throw new Error("Platform message id is already bound to a different conversation route");
    }
    this.db
      .prepare(
        `INSERT INTO conversation_message_context
           (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
         VALUES (?, ?, ?, ?, ?, 'assistant', ?)
         ON CONFLICT(group_id, platform_message_id) DO UPDATE SET
           topic_id = excluded.topic_id,
           branch_id = excluded.branch_id,
           turn_id = COALESCE(conversation_message_context.turn_id, excluded.turn_id),
           direction = excluded.direction`,
      )
      .run(row.group_id, row.platform_message_id, row.topic_id, row.branch_id, row.turn_id, createdAt);
    if (row.turn_id !== null) {
      this.db
        .prepare(
          `UPDATE conversation_turns
              SET platform_message_id = COALESCE(platform_message_id, ?),
                  delivery_id = COALESCE(delivery_id, ?)
            WHERE id = ? AND topic_id = ? AND branch_id = ?`,
        )
        .run(row.platform_message_id, row.delivery_id, row.turn_id, row.topic_id, row.branch_id);
    }
  }

  private withImmediateTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseOutboxDeliveryId(value: string): number | undefined {
  const match = /^outbox:(\d+)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/** Opens the shared DB at the conventional location under a `data/shared` directory. */
export function openSharedDb(dataDir: string): SharedDb {
  return new SharedDb(`${dataDir}${dataDir.endsWith("/") || dataDir.endsWith("\\") ? "" : "/"}shared/bot-shared.db`);
}
