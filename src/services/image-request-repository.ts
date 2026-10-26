import { randomUUID } from "node:crypto";

import type { SharedDb } from "../shared/sqlite.js";

/** Durable operation class, independent of the user-facing wording. */
export type ImageRequestKind = "generation" | "edit" | "avatar_edit";
export type ImageRequestTriggerSource = "command" | "natural";
export type ImageRequestStatus =
  | "accepted"
  | "submitting"
  | "generated"
  | "queued"
  | "delivered"
  | "failed"
  | "outcome_unknown"
  | "delivery_unknown";

export type ImageRequestMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * Internal record. `stagedFilePath` and `upstreamRequestKey` must never cross
 * an admin or user-facing boundary.
 */
export interface ImageRequestRecord {
  id: string;
  groupId: string;
  sourceMessageId: string;
  sourceRowId?: number;
  creatorUserId: string;
  requestKind: ImageRequestKind;
  triggerSource: ImageRequestTriggerSource;
  status: ImageRequestStatus;
  upstreamRequestKey: string;
  stagedFilePath?: string;
  modelId?: string;
  model?: string;
  fallbackUsed?: boolean;
  mimeType?: ImageRequestMimeType;
  byteSize?: number;
  outputSize?: string;
  imagePreviewId?: string;
  outboxId?: number;
  errorCode?: string;
  submittedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Safe projection for the image detail/list APIs. */
export type ImageRequestSafeStatus = Omit<ImageRequestRecord, "upstreamRequestKey" | "stagedFilePath">;

export interface ImageRequestClaim {
  request: ImageRequestRecord;
  /** True only for the one caller that inserted the source-message record. */
  created: boolean;
}

interface ImageRequestRow {
  id: string;
  group_id: string;
  source_message_id: string;
  source_row_id: number | null;
  creator_user_id: string;
  request_kind: ImageRequestKind;
  trigger_source: ImageRequestTriggerSource;
  status: ImageRequestStatus;
  upstream_request_key: string;
  staged_file_path: string | null;
  model_id: string | null;
  model: string | null;
  fallback_used: number | null;
  mime_type: ImageRequestMimeType | null;
  byte_size: number | null;
  output_size: string | null;
  image_preview_id: string | null;
  outbox_id: number | null;
  error_code: string | null;
  submitted_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * SQLite authority for image-request idempotency. The source group/message
 * pair is the durable deduplication key; callers submit upstream work only
 * when `claim().created` is true and `beginSubmission()` succeeds.
 */
export class ImageRequestRepository {
  private transactionDepth = 0;

  constructor(private readonly sharedDb: SharedDb) {}

  runAtomically<T>(callback: () => T): T {
    return this.withImmediateTransaction(callback);
  }

  claim(input: {
    groupId: string;
    sourceMessageId: string;
    /** The durable inbound row when the request comes through Worker. */
    sourceRowId?: number;
    creatorUserId: string;
    requestKind: ImageRequestKind;
    triggerSource: ImageRequestTriggerSource;
    now?: number;
  }): ImageRequestClaim {
    const groupId = requireIdentifier(input.groupId, "image_request_group_id_invalid");
    const sourceMessageId = requireIdentifier(input.sourceMessageId, "image_request_source_message_id_invalid");
    const creatorUserId = requireIdentifier(input.creatorUserId, "image_request_creator_user_id_invalid");
    const sourceRowId = normalizeSourceRowId(input.sourceRowId);
    const requestKind = normalizeRequestKind(input.requestKind);
    const triggerSource = normalizeTriggerSource(input.triggerSource);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_request_created_at_invalid");

    return this.withImmediateTransaction(() => {
      if (sourceRowId !== undefined) {
        this.assertSourceRow(sourceRowId, groupId, sourceMessageId);
        const byRow = this.getBySourceRow(sourceRowId);
        if (byRow) {
          if (byRow.groupId !== groupId || byRow.sourceMessageId !== sourceMessageId) {
            throw new Error("image_request_source_row_conflict");
          }
          return { request: byRow, created: false };
        }
      }
      const existing = this.getBySource(groupId, sourceMessageId);
      if (existing) {
        if (sourceRowId !== undefined && existing.sourceRowId !== undefined && existing.sourceRowId !== sourceRowId) {
          throw new Error("image_request_source_conflict");
        }
        return {
          request: sourceRowId !== undefined && existing.sourceRowId === undefined
            ? this.bindSourceRow(existing, sourceRowId, now)
            : existing,
          created: false,
        };
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const id = createImageRequestId();
        const upstreamRequestKey = createUpstreamRequestKey();
        try {
          this.sharedDb.db.prepare(
            `INSERT INTO image_requests
               (id, group_id, source_message_id, source_row_id, creator_user_id,
                request_kind, trigger_source, status, upstream_request_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
          ).run(
            id,
            groupId,
            sourceMessageId,
            sourceRowId ?? null,
            creatorUserId,
            requestKind,
            triggerSource,
            upstreamRequestKey,
            now,
            now,
          );
          const request = this.get(id);
          if (!request) throw new Error("image_request_claim_readback_failed");
          return { request, created: true };
        } catch (error) {
          const concurrent = this.getBySource(groupId, sourceMessageId);
          if (concurrent) {
            return {
              request: sourceRowId !== undefined && concurrent.sourceRowId === undefined
                ? this.bindSourceRow(concurrent, sourceRowId, now)
                : concurrent,
              created: false,
            };
          }
          if (!isUniqueConstraintError(error)) throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("image_request_claim_failed");
    });
  }

  get(id: string): ImageRequestRecord | undefined {
    const normalizedId = normalizeRequestId(id);
    if (!normalizedId) return undefined;
    const row = this.sharedDb.db.prepare("SELECT * FROM image_requests WHERE id = ?").get(normalizedId) as ImageRequestRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getSafe(id: string): ImageRequestSafeStatus | undefined {
    const record = this.get(id);
    return record ? toSafeStatus(record) : undefined;
  }

  getBySource(groupId: string, sourceMessageId: string): ImageRequestRecord | undefined {
    const normalizedGroupId = normalizeIdentifier(groupId);
    const normalizedSourceMessageId = normalizeIdentifier(sourceMessageId);
    if (!normalizedGroupId || !normalizedSourceMessageId) return undefined;
    const row = this.sharedDb.db.prepare(
      "SELECT * FROM image_requests WHERE group_id = ? AND source_message_id = ?",
    ).get(normalizedGroupId, normalizedSourceMessageId) as ImageRequestRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getSafeBySource(groupId: string, sourceMessageId: string): ImageRequestSafeStatus | undefined {
    const record = this.getBySource(groupId, sourceMessageId);
    return record ? toSafeStatus(record) : undefined;
  }

  getBySourceRow(sourceRowId: number): ImageRequestRecord | undefined {
    if (!Number.isSafeInteger(sourceRowId) || sourceRowId <= 0) return undefined;
    const row = this.sharedDb.db.prepare("SELECT * FROM image_requests WHERE source_row_id = ?").get(sourceRowId) as ImageRequestRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Safe image-detail lookup. The group check keeps cross-group callers bounded. */
  getForImagePreview(groupId: string, imagePreviewId: string): ImageRequestSafeStatus | undefined {
    const normalizedGroupId = normalizeIdentifier(groupId);
    const previewId = normalizePreviewId(imagePreviewId);
    if (!normalizedGroupId || !previewId) return undefined;
    const row = this.sharedDb.db.prepare(
      "SELECT * FROM image_requests WHERE group_id = ? AND image_preview_id = ?",
    ).get(normalizedGroupId, previewId) as ImageRequestRow | undefined;
    return row ? toSafeStatus(fromRow(row)) : undefined;
  }

  /**
   * Atomically crosses the pre-network boundary. It never reacquires an old
   * record, so replayed messages cannot submit the model request a second time.
   */
  beginSubmission(id: string, now = Date.now()): ImageRequestRecord | undefined {
    const normalizedId = normalizeRequestId(id);
    if (!normalizedId) return undefined;
    const timestamp = normalizeTimestamp(now, "image_request_submitted_at_invalid");
    const changed = this.sharedDb.db.prepare(
      `UPDATE image_requests
          SET status = 'submitting', submitted_at = COALESCE(submitted_at, ?),
              updated_at = ?, error_code = NULL
        WHERE id = ? AND status = 'accepted'`,
    ).run(timestamp, timestamp, normalizedId);
    return Number(changed.changes) === 1 ? this.get(normalizedId) : undefined;
  }

  /** Stores only non-content generation metadata after a definite model result. */
  recordGenerated(input: {
    id: string;
    stagedFilePath: string;
    modelId: string;
    model: string;
    fallbackUsed: boolean;
    mimeType: ImageRequestMimeType;
    byteSize: number;
    outputSize?: string;
    now?: number;
  }): ImageRequestRecord | undefined {
    const id = normalizeRequestId(input.id);
    if (!id) return undefined;
    const stagedFilePath = requireBoundedText(input.stagedFilePath, "image_request_staged_path_invalid", 4_096);
    const modelId = requireIdentifier(input.modelId, "image_request_model_id_invalid");
    const model = requireIdentifier(input.model, "image_request_model_invalid");
    const mimeType = normalizeMimeType(input.mimeType);
    const byteSize = normalizeByteSize(input.byteSize);
    const outputSize = normalizeOutputSize(input.outputSize);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_request_generated_at_invalid");
    const changed = this.sharedDb.db.prepare(
      `UPDATE image_requests
          SET status = 'generated', staged_file_path = ?, model_id = ?, model = ?, fallback_used = ?,
              mime_type = ?, byte_size = ?, output_size = ?, completed_at = COALESCE(completed_at, ?),
              updated_at = ?, error_code = NULL
        WHERE id = ? AND status = 'submitting'`,
    ).run(stagedFilePath, modelId, model, input.fallbackUsed ? 1 : 0, mimeType, byteSize, outputSize, now, now, id);
    return Number(changed.changes) === 1 ? this.get(id) : undefined;
  }

  /**
   * Binds a previously archived preview to this request. The worker normally
   * calls SharedDb.enqueueGeneratedImageOutboxForRequest next, which binds the
   * preview and creates the outbox row in the same transaction.
   */
  linkPreview(id: string, imagePreviewId: string, now = Date.now()): ImageRequestRecord | undefined {
    const normalizedId = normalizeRequestId(id);
    const previewId = normalizePreviewId(imagePreviewId);
    if (!normalizedId || !previewId) return undefined;
    const timestamp = normalizeTimestamp(now, "image_request_preview_linked_at_invalid");
    return this.withImmediateTransaction(() => {
      const request = this.get(normalizedId);
      if (!request || !["generated", "queued", "delivered", "delivery_unknown"].includes(request.status)) return undefined;
      this.assertPreviewBelongsToRequest(request, previewId, timestamp);
      if (request.imagePreviewId && request.imagePreviewId !== previewId) {
        throw new Error("image_request_preview_conflict");
      }
      if (request.imagePreviewId === previewId) return request;
      const result = this.sharedDb.db.prepare(
        `UPDATE image_requests
            SET image_preview_id = ?, updated_at = ?
          WHERE id = ? AND image_preview_id IS NULL`,
      ).run(previewId, timestamp, normalizedId);
      if (Number(result.changes) !== 1) throw new Error("image_request_preview_link_failed");
      const updated = this.get(normalizedId);
      if (!updated) throw new Error("image_request_preview_readback_failed");
      return updated;
    });
  }

  /** Marks a request terminal before any generated image is publicly delivered. */
  markFailed(id: string, errorCode: string, now = Date.now()): ImageRequestRecord | undefined {
    return this.markTerminal(id, "failed", errorCode, now);
  }

  /**
   * Use for a timeout, process crash, cancellation after submit, or any state
   * where the upstream may have accepted the request. It is intentionally not
   * retried automatically.
   */
  markOutcomeUnknown(id: string, errorCode = "result_unknown", now = Date.now()): ImageRequestRecord | undefined {
    return this.markTerminal(id, "outcome_unknown", errorCode, now);
  }

  /** Safe state only; local image path and upstream idempotency key are absent. */
  listSafe(args: { groupId?: string; limit?: number } = {}): ImageRequestSafeStatus[] {
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 100)));
    const groupId = args.groupId === undefined ? undefined : normalizeIdentifier(args.groupId);
    if (args.groupId !== undefined && !groupId) return [];
    const rows = groupId
      ? this.sharedDb.db.prepare(
        "SELECT * FROM image_requests WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      ).all(groupId, limit) as unknown as ImageRequestRow[]
      : this.sharedDb.db.prepare(
        "SELECT * FROM image_requests ORDER BY created_at DESC, id DESC LIMIT ?",
      ).all(limit) as unknown as ImageRequestRow[];
    return rows.map(row => toSafeStatus(fromRow(row)));
  }

  private markTerminal(
    id: string,
    status: "failed" | "outcome_unknown",
    errorCode: string,
    now: number,
  ): ImageRequestRecord | undefined {
    const normalizedId = normalizeRequestId(id);
    if (!normalizedId) return undefined;
    const normalizedErrorCode = normalizeErrorCode(errorCode);
    const timestamp = normalizeTimestamp(now, "image_request_terminal_at_invalid");
    const result = this.sharedDb.db.prepare(
      `UPDATE image_requests
          SET status = ?, error_code = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('accepted', 'submitting', 'generated')`,
    ).run(status, normalizedErrorCode, timestamp, timestamp, normalizedId);
    return Number(result.changes) === 1 ? this.get(normalizedId) : undefined;
  }

  private assertSourceRow(sourceRowId: number, groupId: string, sourceMessageId: string): void {
    const row = this.sharedDb.db.prepare(
      "SELECT group_id, msg_id FROM messages WHERE id = ?",
    ).get(sourceRowId) as { group_id: string; msg_id: string } | undefined;
    if (!row) throw new Error("image_request_source_row_not_found");
    if (row.group_id !== groupId || row.msg_id !== sourceMessageId) {
      throw new Error("image_request_source_row_mismatch");
    }
  }

  private bindSourceRow(record: ImageRequestRecord, sourceRowId: number, now: number): ImageRequestRecord {
    const result = this.sharedDb.db.prepare(
      `UPDATE image_requests
          SET source_row_id = ?, updated_at = ?
        WHERE id = ? AND source_row_id IS NULL`,
    ).run(sourceRowId, now, record.id);
    if (Number(result.changes) !== 1) {
      const current = this.get(record.id);
      if (current && current.sourceRowId === sourceRowId) return current;
      throw new Error("image_request_source_row_conflict");
    }
    const updated = this.get(record.id);
    if (!updated) throw new Error("image_request_source_row_readback_failed");
    return updated;
  }

  private assertPreviewBelongsToRequest(request: ImageRequestRecord, previewId: string, now: number): void {
    const preview = this.sharedDb.db.prepare(
      "SELECT group_id, source_message_id, status, expires_at FROM image_previews WHERE id = ?",
    ).get(previewId) as {
      group_id: string;
      source_message_id: string;
      status: string;
      expires_at: number;
    } | undefined;
    if (!preview || preview.group_id !== request.groupId || preview.source_message_id !== request.sourceMessageId ||
        preview.status !== "available" || preview.expires_at <= now) {
      throw new Error("image_request_preview_invalid");
    }
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

export function createImageRequestId(): string {
  return `imgreq_${randomUUID()}`;
}

export function createUpstreamRequestKey(): string {
  return randomUUID();
}

export function isSafeImageRequestErrorCode(value: string): boolean {
  return /^[a-z0-9][a-z0-9_:-]{0,159}$/.test(value);
}

function normalizeRequestId(value: string): string | undefined {
  const id = value.trim();
  return /^imgreq_[a-f0-9-]{36}$/.test(id) ? id : undefined;
}

function normalizePreviewId(value: string): string | undefined {
  const id = value.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : undefined;
}

function normalizeIdentifier(value: string): string | undefined {
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : undefined;
}

function requireIdentifier(value: string, errorCode: string): string {
  const normalized = normalizeIdentifier(value);
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function requireBoundedText(value: string, errorCode: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(errorCode);
  return normalized;
}

function normalizeSourceRowId(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("image_request_source_row_id_invalid");
  return value;
}

function normalizeRequestKind(value: ImageRequestKind): ImageRequestKind {
  if (value === "generation" || value === "edit" || value === "avatar_edit") return value;
  throw new Error("image_request_kind_invalid");
}

function normalizeTriggerSource(value: ImageRequestTriggerSource): ImageRequestTriggerSource {
  if (value === "command" || value === "natural") return value;
  throw new Error("image_request_trigger_source_invalid");
}

function normalizeMimeType(value: ImageRequestMimeType): ImageRequestMimeType {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
  throw new Error("image_request_mime_type_invalid");
}

function normalizeByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 20 * 1024 * 1024) {
    throw new Error("image_request_byte_size_invalid");
  }
  return value;
}

function normalizeOutputSize(value: string | undefined): string | null {
  if (value === undefined) return null;
  const size = value.trim();
  if (size === "auto" || /^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size)) return size;
  throw new Error("image_request_output_size_invalid");
}

function normalizeErrorCode(value: string): string {
  const code = value.trim();
  if (!isSafeImageRequestErrorCode(code)) throw new Error("image_request_error_code_invalid");
  return code;
}

function normalizeTimestamp(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(errorCode);
  return value;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

function fromRow(row: ImageRequestRow): ImageRequestRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    sourceMessageId: row.source_message_id,
    ...(row.source_row_id === null ? {} : { sourceRowId: row.source_row_id }),
    creatorUserId: row.creator_user_id,
    requestKind: row.request_kind,
    triggerSource: row.trigger_source,
    status: row.status,
    upstreamRequestKey: row.upstream_request_key,
    ...(row.staged_file_path === null ? {} : { stagedFilePath: row.staged_file_path }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.fallback_used === null ? {} : { fallbackUsed: Boolean(row.fallback_used) }),
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.byte_size === null ? {} : { byteSize: row.byte_size }),
    ...(row.output_size === null ? {} : { outputSize: row.output_size }),
    ...(row.image_preview_id === null ? {} : { imagePreviewId: row.image_preview_id }),
    ...(row.outbox_id === null ? {} : { outboxId: row.outbox_id }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSafeStatus(record: ImageRequestRecord): ImageRequestSafeStatus {
  const { upstreamRequestKey: _upstreamRequestKey, stagedFilePath: _stagedFilePath, ...safe } = record;
  return safe;
}
