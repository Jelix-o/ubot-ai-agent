import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import type { SharedDb } from "../shared/sqlite.js";

export const HTML_PREVIEW_TOKEN_BYTES = 32;
export const HTML_PREVIEW_TOKEN_LENGTH = 43;
export const HTML_PREVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const HTML_PREVIEW_DEFAULT_LEASE_MS = 2 * 60 * 1_000;

export type HtmlPreviewStorageStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "expired"
  | "deleted";

export type HtmlPreviewVisibleStatus = Exclude<HtmlPreviewStorageStatus, "processing">;

/**
 * Internal publication metadata. It deliberately never contains the original
 * request or generated source; those remain only in short-lived message/files
 * respectively.
 */
export interface HtmlPreviewRecord {
  id: string;
  groupId: string;
  creatorUserId: string;
  sourceMessageId: string;
  title: string;
  contentSha256?: string;
  byteSize?: number;
  status: HtmlPreviewStorageStatus;
  leaseToken?: string;
  leaseExpiresAt?: number;
  announcementOutboxId?: number;
  announcementCreatedAt?: number;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  failedAt?: number;
  expiresAt: number;
  deletedAt?: number;
}

export interface HtmlPreviewClaim {
  page: HtmlPreviewRecord;
  leaseToken: string;
}

export interface HtmlPreviewListArgs {
  groupId?: string;
  visibleGroupIds?: string[];
  page?: number;
  pageSize?: number;
  /** pending also includes an actively leased record in the UI. */
  status?: HtmlPreviewVisibleStatus;
}

interface HtmlPreviewRow {
  id: string;
  group_id: string;
  creator_user_id: string;
  source_message_id: string;
  title: string;
  content_sha256: string | null;
  byte_size: number | null;
  status: HtmlPreviewStorageStatus;
  lease_token: string | null;
  lease_expires_at: number | null;
  announcement_outbox_id: number | null;
  announcement_created_at: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  failed_at: number | null;
  expires_at: number;
  deleted_at: number | null;
}

/**
 * SQLite authority for preview work. Every mutating queue operation is an
 * IMMEDIATE transaction, so different worker processes cannot claim the same
 * publication or skip an older request from the same group.
 */
export class HtmlPreviewRepository {
  private transactionDepth = 0;

  constructor(private readonly sharedDb: SharedDb) {}

  enqueue(input: {
    groupId: string;
    creatorUserId: string;
    sourceMessageId: string;
    now?: number;
    expiresAt?: number;
  }): { page: HtmlPreviewRecord; created: boolean } {
    const groupId = requireIdentifier(input.groupId, "html_preview_group_id_invalid");
    const creatorUserId = requireIdentifier(input.creatorUserId, "html_preview_creator_user_id_invalid");
    const sourceMessageId = requireIdentifier(input.sourceMessageId, "html_preview_source_message_id_invalid");
    const now = input.now ?? Date.now();
    const expiresAt = input.expiresAt ?? now + HTML_PREVIEW_RETENTION_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("html_preview_expiry_invalid");
    }

    return this.withImmediateTransaction(() => {
      const existing = this.getBySource(groupId, sourceMessageId);
      if (existing) {
        return { page: existing, created: false };
      }

      const id = createPreviewId();
      this.sharedDb.db.prepare(
        `INSERT INTO html_previews
           (id, group_id, creator_user_id, source_message_id, title, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, '网页预览', 'pending', ?, ?, ?)`,
      ).run(id, groupId, creatorUserId, sourceMessageId, now, now, expiresAt);
      const page = this.get(id);
      if (!page) {
        throw new Error("html_preview_enqueue_readback_failed");
      }
      return { page, created: true };
    });
  }

  get(id: string): HtmlPreviewRecord | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return undefined;
    const row = this.sharedDb.db.prepare("SELECT * FROM html_previews WHERE id = ?").get(normalizedId) as HtmlPreviewRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getBySource(groupId: string, sourceMessageId: string): HtmlPreviewRecord | undefined {
    const row = this.sharedDb.db.prepare(
      "SELECT * FROM html_previews WHERE group_id = ? AND source_message_id = ?",
    ).get(groupId, sourceMessageId) as HtmlPreviewRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Claims one queue record, preserving FIFO order within each group. */
  claimNext(options: { id?: string; groupId?: string; now?: number; leaseMs?: number } = {}): HtmlPreviewClaim | undefined {
    const now = options.now ?? Date.now();
    const leaseMs = normalizeLeaseMs(options.leaseMs);
    const requestedId = options.id ? normalizePreviewId(options.id) : undefined;
    if (options.id && !requestedId) return undefined;
    const requestedGroupId = options.groupId?.trim();
    if (options.groupId !== undefined && !requestedGroupId) return undefined;

    return this.withImmediateTransaction(() => {
      const candidate = this.findClaimableCandidate(requestedId, requestedGroupId, now);
      if (!candidate) return undefined;
      const leaseToken = createLeaseToken();
      const leaseExpiresAt = now + leaseMs;
      const changed = this.sharedDb.db.prepare(
        `UPDATE html_previews
            SET status = 'processing', lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND expires_at > ?
            AND (
              status = 'pending'
              OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            )`,
      ).run(leaseToken, leaseExpiresAt, now, candidate.id, now, now);
      if (Number(changed.changes) !== 1) return undefined;
      const page = this.get(candidate.id);
      if (!page) throw new Error("html_preview_claim_readback_failed");
      return { page, leaseToken };
    });
  }

  /** Claims a published page only to finish a durable, missing announcement. */
  claimAnnouncement(id: string, options: { now?: number; leaseMs?: number } = {}): HtmlPreviewClaim | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return undefined;
    const now = options.now ?? Date.now();
    const leaseMs = normalizeLeaseMs(options.leaseMs);
    return this.withImmediateTransaction(() => {
      const leaseToken = createLeaseToken();
      const result = this.sharedDb.db.prepare(
        `UPDATE html_previews
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND status = 'published'
            AND announcement_outbox_id IS NULL
            AND expires_at > ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).run(leaseToken, now + leaseMs, now, normalizedId, now, now);
      if (Number(result.changes) !== 1) return undefined;
      const page = this.get(normalizedId);
      if (!page) throw new Error("html_preview_announcement_claim_readback_failed");
      return { page, leaseToken };
    });
  }

  publish(input: {
    id: string;
    leaseToken: string;
    title: string;
    contentSha256: string;
    byteSize: number;
    now?: number;
  }): HtmlPreviewRecord | undefined {
    const id = normalizePreviewId(input.id);
    if (!id || !input.leaseToken.trim()) return undefined;
    const now = input.now ?? Date.now();
    const title = normalizeTitle(input.title);
    const contentSha256 = normalizeSha256(input.contentSha256);
    const byteSize = normalizeByteSize(input.byteSize);
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET title = ?, content_sha256 = ?, byte_size = ?, status = 'published',
              error_code = NULL, published_at = COALESCE(published_at, ?),
              updated_at = ?, failed_at = NULL
        WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    ).run(title, contentSha256, byteSize, now, now, id, input.leaseToken);
    return Number(result.changes) === 1 ? this.get(id) : undefined;
  }

  fail(id: string, leaseToken: string, errorCode: string, now = Date.now()): HtmlPreviewRecord | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId || !leaseToken.trim()) return undefined;
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET status = 'failed', error_code = ?, failed_at = ?, updated_at = ?,
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    ).run(normalizeErrorCode(errorCode), now, now, normalizedId, leaseToken);
    return Number(result.changes) === 1 ? this.get(normalizedId) : undefined;
  }

  release(id: string, leaseToken: string, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId || !leaseToken.trim()) return false;
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    ).run(now, normalizedId, leaseToken);
    return Number(result.changes) === 1;
  }

  /**
   * Adds the program-generated group announcement and links it in one SQLite
   * transaction. A retry observes announcement_outbox_id and therefore never
   * emits a second preview URL.
   */
  enqueueAnnouncement(id: string, leaseToken: string, text: string, now = Date.now()): number | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId || !leaseToken.trim() || !text.trim()) return undefined;
    return this.withImmediateTransaction(() => {
      const page = this.get(normalizedId);
      if (!page || page.status !== "published") return undefined;
      if (page.announcementOutboxId !== undefined) return page.announcementOutboxId;
      if (page.leaseToken !== leaseToken) return undefined;

      const inserted = this.sharedDb.db.prepare(
        `INSERT INTO outbox (group_id, reply_to, kind, text, status, created_at)
         VALUES (?, NULL, 'text', ?, 'pending', ?)`,
      ).run(page.groupId, text, now);
      const outboxId = Number(inserted.lastInsertRowid);
      this.sharedDb.db.prepare("UPDATE outbox SET delivery_id = ? WHERE id = ?").run(`outbox:${outboxId}`, outboxId);
      this.sharedDb.db.prepare(
        `UPDATE html_previews
            SET announcement_outbox_id = ?, announcement_created_at = ?,
                lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'published' AND lease_token = ? AND announcement_outbox_id IS NULL`,
      ).run(outboxId, now, now, normalizedId, leaseToken);
      return outboxId;
    });
  }

  /** A terminal generation failure is announced once through the same Outbox. */
  enqueueFailureNotice(id: string, text: string, now = Date.now()): number | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId || !text.trim()) return undefined;
    return this.withImmediateTransaction(() => {
      const page = this.get(normalizedId);
      if (!page || page.status !== "failed") return undefined;
      if (page.announcementOutboxId !== undefined) return page.announcementOutboxId;
      const inserted = this.sharedDb.db.prepare(
        `INSERT INTO outbox (group_id, reply_to, kind, text, status, created_at)
         VALUES (?, NULL, 'text', ?, 'pending', ?)`,
      ).run(page.groupId, text, now);
      const outboxId = Number(inserted.lastInsertRowid);
      this.sharedDb.db.prepare("UPDATE outbox SET delivery_id = ? WHERE id = ?").run(`outbox:${outboxId}`, outboxId);
      this.sharedDb.db.prepare(
        `UPDATE html_previews
            SET announcement_outbox_id = ?, announcement_created_at = ?, updated_at = ?
          WHERE id = ? AND status = 'failed' AND announcement_outbox_id IS NULL`,
      ).run(outboxId, now, now, normalizedId);
      return outboxId;
    });
  }

  /** For integrations that already inserted a durable outbox row themselves. */
  recordAnnouncement(id: string, leaseToken: string, outboxId: number, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId || !leaseToken.trim() || !Number.isSafeInteger(outboxId) || outboxId <= 0) return false;
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET announcement_outbox_id = ?, announcement_created_at = ?,
              lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'published' AND lease_token = ? AND announcement_outbox_id IS NULL`,
    ).run(outboxId, now, now, normalizedId, leaseToken);
    return Number(result.changes) === 1;
  }

  listPage(args: HtmlPreviewListArgs = {}): {
    items: HtmlPreviewRecord[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  } {
    const pageSize = Math.max(1, Math.min(100, Math.floor(args.pageSize ?? 20)));
    const requestedPage = Math.max(1, Math.floor(args.page ?? 1));
    const where: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (args.groupId?.trim()) {
      where.push("group_id = ?");
      parameters.push(args.groupId.trim());
    }
    if (args.visibleGroupIds) {
      const groups = [...new Set(args.visibleGroupIds.map((value) => value.trim()).filter(Boolean))];
      if (groups.length === 0) {
        return { items: [], pagination: { page: 1, pageSize, total: 0, totalPages: 1 } };
      }
      where.push(`group_id IN (${groups.map(() => "?").join(", ")})`);
      parameters.push(...groups);
    }
    if (args.status) {
      if (args.status === "pending") {
        where.push("status IN ('pending', 'processing')");
      } else {
        where.push("status = ?");
        parameters.push(args.status);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.sharedDb.db.prepare(
      `SELECT COUNT(*) AS count FROM html_previews ${whereSql}`,
    ).get(...parameters) as { count: number }).count);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = this.sharedDb.db.prepare(
      `SELECT * FROM html_previews ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...parameters, pageSize, (page - 1) * pageSize) as unknown as HtmlPreviewRow[];
    return {
      items: rows.map(fromRow),
      pagination: { page, pageSize, total, totalPages },
    };
  }

  listExpired(now = Date.now()): HtmlPreviewRecord[] {
    const rows = this.sharedDb.db.prepare(
      `SELECT * FROM html_previews
        WHERE expires_at <= ? AND status NOT IN ('expired', 'deleted')
        ORDER BY expires_at, id`,
    ).all(now) as unknown as HtmlPreviewRow[];
    return rows.map(fromRow);
  }

  markExpired(id: string, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return false;
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET status = 'expired', lease_token = NULL, lease_expires_at = NULL,
              deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE id = ? AND status NOT IN ('expired', 'deleted')`,
    ).run(now, now, normalizedId);
    return Number(result.changes) === 1;
  }

  markDeleted(id: string, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return false;
    const result = this.sharedDb.db.prepare(
      `UPDATE html_previews
          SET status = 'deleted', lease_token = NULL, lease_expires_at = NULL,
              deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE id = ? AND status <> 'deleted'`,
    ).run(now, now, normalizedId);
    return Number(result.changes) === 1;
  }

  listIds(): string[] {
    return (this.sharedDb.db.prepare("SELECT id FROM html_previews").all() as Array<{ id: string }>).map((row) => row.id);
  }

  private findClaimableCandidate(
    requestedId: string | undefined,
    requestedGroupId: string | undefined,
    now: number,
  ): { id: string } | undefined {
    const idClause = requestedId ? "AND p.id = ?" : "";
    const groupClause = requestedGroupId ? "AND p.group_id = ?" : "";
    const parameters: SQLInputValue[] = [now, now, now];
    if (requestedId) parameters.push(requestedId);
    if (requestedGroupId) parameters.push(requestedGroupId);
    return this.sharedDb.db.prepare(
      `SELECT p.id
         FROM html_previews p
        WHERE p.expires_at > ?
          AND (
            p.status = 'pending'
            OR (p.status = 'processing' AND p.lease_expires_at IS NOT NULL AND p.lease_expires_at <= ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM html_previews earlier
             WHERE earlier.group_id = p.group_id
               AND (earlier.created_at < p.created_at OR (earlier.created_at = p.created_at AND earlier.id < p.id))
               AND (
                 earlier.status = 'pending'
                 OR (earlier.status = 'processing' AND (earlier.lease_expires_at IS NULL OR earlier.lease_expires_at > ?))
               )
          )
          ${idClause}
          ${groupClause}
        ORDER BY p.created_at, p.id
        LIMIT 1`,
    ).get(...parameters) as { id: string } | undefined;
  }

  private withImmediateTransaction<T>(callback: () => T): T {
    if (this.transactionDepth > 0) return callback();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.sharedDb.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

export function isHtmlPreviewToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function createPreviewId(): string {
  const id = randomBytes(HTML_PREVIEW_TOKEN_BYTES).toString("base64url");
  if (!isHtmlPreviewToken(id) || id.length !== HTML_PREVIEW_TOKEN_LENGTH) {
    throw new Error("html_preview_token_generation_failed");
  }
  return id;
}

function createLeaseToken(): string {
  return randomBytes(18).toString("base64url");
}

function normalizePreviewId(value: string): string | undefined {
  const id = value.trim();
  return isHtmlPreviewToken(id) ? id : undefined;
}

function requireIdentifier(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error(errorCode);
  return normalized;
}

function normalizeLeaseMs(value: number | undefined): number {
  const result = Math.floor(value ?? HTML_PREVIEW_DEFAULT_LEASE_MS);
  return Math.max(10_000, Math.min(10 * 60 * 1_000, Number.isFinite(result) ? result : HTML_PREVIEW_DEFAULT_LEASE_MS));
}

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim().slice(0, 160);
  return title || "网页预览";
}

function normalizeSha256(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("html_preview_content_hash_invalid");
  return sha;
}

function normalizeByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 512 * 1024) {
    throw new Error("html_preview_byte_size_invalid");
  }
  return value;
}

function normalizeErrorCode(value: string): string {
  return value.trim().replace(/[^a-z0-9_:-]/gi, "_").slice(0, 120) || "html_preview_failed";
}

function fromRow(row: HtmlPreviewRow): HtmlPreviewRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    creatorUserId: row.creator_user_id,
    sourceMessageId: row.source_message_id,
    title: row.title,
    ...(row.content_sha256 ? { contentSha256: row.content_sha256 } : {}),
    ...(row.byte_size === null ? {} : { byteSize: row.byte_size }),
    status: row.status,
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.announcement_outbox_id === null ? {} : { announcementOutboxId: row.announcement_outbox_id }),
    ...(row.announcement_created_at === null ? {} : { announcementCreatedAt: row.announcement_created_at }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
    expiresAt: row.expires_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}
