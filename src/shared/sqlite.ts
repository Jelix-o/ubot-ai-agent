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
  reply_to: string | null;
  has_at_bot: number;
  is_bot_msg: number;
  created_at: number;
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
  updated_at: number | null;
  created_at: number;
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
  reply_to TEXT,
  has_at_bot INTEGER NOT NULL DEFAULT 0,
  is_bot_msg INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS consumers (
  key TEXT PRIMARY KEY,
  watermark_id INTEGER NOT NULL DEFAULT 0
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
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrateSchema();
  }

  /** 轻量 schema 迁移：旧库缺列时补齐（CREATE TABLE IF NOT EXISTS 不会改已有表）。 */
  private migrateSchema(): void {
    const outboxCols = this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    if (!outboxCols.some((col) => col.name === "updated_at")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN updated_at INTEGER");
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
              reply_to, has_at_bot, is_bot_msg, created_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.groupId,
          row.userId,
          row.selfId,
          row.msgId,
          row.msgTime,
          row.text,
          row.imagesJson,
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

  /**
   * Earliest pending message for a consumer key.
   * Ordered by QQ-side msg_time (then id) so out-of-order WS delivery does not
   * scramble topic chains (plan §2.1: 不信任 WS 到达顺序). The watermark stays
   * monotonic on id via MAX() so a retried old message never re-delivers newer
   * ones.
   */
  pollMessages(key: string, limit: number): IngressMessageRow[] {
    this.ensureConsumer(key);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.group_id, m.user_id, m.self_id, m.msg_id, m.msg_time, m.text,
                m.images_json, m.reply_to, m.has_at_bot, m.is_bot_msg, m.created_at
           FROM messages m
           JOIN consumers c ON c.key = ?
           WHERE m.id > c.watermark_id
           ORDER BY m.msg_time ASC, m.id ASC
           LIMIT ?`,
      )
      .all(key, limit) as unknown as IngressMessageRow[];
    return rows;
  }

  /** Advances the watermark but never backwards (a retried old message must not re-deliver newer ones). */
  advanceWatermark(key: string, messageId: number): void {
    this.db
      .prepare("UPDATE consumers SET watermark_id = MAX(watermark_id, ?) WHERE key = ?")
      .run(messageId, key);
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

  clearInflight(key: string): void {
    this.db.prepare("DELETE FROM inflight WHERE key = ?").run(key);
  }

  // ---- outbox (worker → emitter) ----

  enqueueOutbox(groupId: string, replyTo: string | null, text: string, kind = "text"): number {
    const result = this.db
      .prepare("INSERT INTO outbox (group_id, reply_to, kind, text, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(groupId, replyTo, kind, text, Date.now());
    return Number(result.lastInsertRowid);
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
  claimOutbox(limit: number, nowMs = Date.now(), sendingTimeoutMs = 10_000): OutboxRow[] {
    const candidates = this.db
      .prepare(
        `SELECT * FROM outbox
           WHERE status = 'pending'
              OR (status = 'failed' AND retry_after IS NOT NULL AND retry_after <= ?)
              OR (status = 'sending' AND updated_at IS NOT NULL AND updated_at <= ?)
           ORDER BY id ASC LIMIT ?`,
      )
      .all(nowMs, nowMs - sendingTimeoutMs, limit) as unknown as OutboxRow[];
    for (const row of candidates) {
      this.db
        .prepare("UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status != 'sent'")
        .run(nowMs, row.id);
    }
    return this.db
      .prepare("SELECT * FROM outbox WHERE id IN (" + candidates.map(() => "?").join(",") + ") AND status = 'sending' ORDER BY id")
      .all(...candidates.map((row) => row.id)) as unknown as OutboxRow[];
  }

  markOutboxSent(id: number): void {
    this.db.prepare("UPDATE outbox SET status = 'sent', retry_after = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
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

  // ---- bot self messages (used to filter self-referencing chains) ----

  recordBotMessage(groupId: string, msgId: string, sentAtMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO bot_messages (group_id, msg_id, sent_at) VALUES (?, ?, ?)")
      .run(groupId, msgId, sentAtMs);
  }

  pruneBotMessages(beforeMs: number): void {
    this.db.prepare("DELETE FROM bot_messages WHERE sent_at < ?").run(beforeMs);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/** Opens the shared DB at the conventional location under a `data/shared` directory. */
export function openSharedDb(dataDir: string): SharedDb {
  return new SharedDb(`${dataDir}${dataDir.endsWith("/") || dataDir.endsWith("\\") ? "" : "/"}shared/bot-shared.db`);
}
