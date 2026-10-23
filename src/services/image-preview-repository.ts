import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import type { SharedDb } from "../shared/sqlite.js";

export const IMAGE_PREVIEW_TOKEN_BYTES = 32;
export const IMAGE_PREVIEW_TOKEN_LENGTH = 43;
export const IMAGE_PREVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type ImagePreviewStatus = "available" | "expired" | "deleted";

export interface ImagePreviewRecord {
  id: string;
  groupId: string;
  creatorUserId: string;
  sourceMessageId: string;
  operation?: "generation" | "edit";
  referenceCount?: number;
  parentIds?: string[];
  outputSize?: string;
  outputMessageId?: string;

  prompt?: string;
  promptSummary: string;
  modelId: string;
  model: string;
  fallbackUsed: boolean;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  contentSha256: string;
  status: ImagePreviewStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  expiredAt?: number;
  deletedAt?: number;
}

export interface ImagePreviewListArgs {
  groupId?: string;
  visibleGroupIds?: string[];
  page?: number;
  pageSize?: number;
  status?: ImagePreviewStatus;
  /** Internal clock injection so an uncollected expiry is never listed as available. */
  now?: number;
}

interface ImagePreviewRow {
  id: string;
  group_id: string;
  creator_user_id: string;
  source_message_id: string;
  operation: "generation" | "edit";
  reference_count: number;
  parent_ids_json: string;
  output_size: string;
  output_message_id: string | null;
  prompt: string | null;
  prompt_summary: string;
  model_id: string;
  model: string;
  fallback_used: number;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  byte_size: number;
  content_sha256: string;
  status: ImagePreviewStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
  expired_at: number | null;
  deleted_at: number | null;
}

/**
 * SQLite authority for private generated-image preview metadata. The image
 * bytes live in an adjacent private directory keyed only by this token.
 */
export class ImagePreviewRepository {
  private transactionDepth = 0;

  constructor(private readonly sharedDb: SharedDb) {}

  runAtomically<T>(callback: () => T): T {
    return this.withImmediateTransaction(callback);
  }

  create(input: {
    id: string;
    groupId: string;
    creatorUserId: string;
    sourceMessageId: string;
    prompt: string;
    promptSummary: string;
    modelId: string;
    model: string;
    fallbackUsed: boolean;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    byteSize: number;
    contentSha256: string;
    now?: number;
    expiresAt?: number;
    operation?: "generation" | "edit";
    referenceCount?: number;
    parentIds?: string[];
    outputSize?: string;
  }): ImagePreviewRecord {
    const id = requirePreviewId(input.id);
    const groupId = requireIdentifier(input.groupId, "image_preview_group_id_invalid");
    const creatorUserId = requireIdentifier(input.creatorUserId, "image_preview_creator_user_id_invalid");
    const sourceMessageId = requireIdentifier(input.sourceMessageId, "image_preview_source_message_id_invalid");
    const prompt = normalizePrompt(input.prompt);
    const promptSummary = normalizePromptSummary(input.promptSummary);
    const modelId = requireIdentifier(input.modelId, "image_preview_model_id_invalid");
    const model = requireIdentifier(input.model, "image_preview_model_invalid");
    const byteSize = normalizeByteSize(input.byteSize);
    const contentSha256 = normalizeSha256(input.contentSha256);
    const operation = input.operation ?? "generation";
    const referenceCount = input.referenceCount ?? 0;
    const parentIds = input.parentIds ?? [];
    const outputSize = input.outputSize ?? "1024x1024";
    if (!["generation", "edit"].includes(operation) || !Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > 4 ||
        (operation === "edit") !== (referenceCount > 0) || parentIds.length > referenceCount || parentIds.some(id => !isImagePreviewToken(id)) ||
        !(outputSize === "auto" || /^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(outputSize))) throw new Error("image_preview_edit_metadata_invalid");
    const now = input.now ?? Date.now();
    const expiresAt = input.expiresAt ?? now + IMAGE_PREVIEW_RETENTION_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + IMAGE_PREVIEW_RETENTION_MS) {
      throw new Error("image_preview_expiry_invalid");
    }

    return this.withImmediateTransaction(() => {
      for (const parentId of parentIds) {
        const parent = this.get(parentId);
        if (!parent || parent.groupId !== groupId || parent.status !== "available" || parent.expiresAt <= now) throw new Error("image_preview_parent_unavailable");
      }
      const existing = this.getBySource(groupId, sourceMessageId);
      if (existing) throw new Error("image_preview_source_conflict");
      this.sharedDb.db.prepare(
        `INSERT INTO image_previews
           (id, group_id, creator_user_id, source_message_id, prompt, prompt_summary,
            model_id, model, fallback_used, mime_type, byte_size, content_sha256, status,
            created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
      ).run(
        id, groupId, creatorUserId, sourceMessageId, prompt, promptSummary,
        modelId, model, input.fallbackUsed ? 1 : 0, input.mimeType, byteSize, contentSha256,
        now, now, expiresAt,
      );
      this.sharedDb.db.prepare("UPDATE image_previews SET operation = ?, reference_count = ?, parent_ids_json = ?, output_size = ? WHERE id = ?")
        .run(operation, referenceCount, JSON.stringify(parentIds), outputSize, id);
      const stored = this.get(id);
      if (!stored) throw new Error("image_preview_create_readback_failed");
      return stored;
    });
  }

  get(id: string): ImagePreviewRecord | undefined {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return undefined;
    const row = this.sharedDb.db.prepare("SELECT * FROM image_previews WHERE id = ?").get(normalizedId) as ImagePreviewRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getByOutput(groupId: string, messageId: string): ImagePreviewRecord | undefined {
    const row = this.sharedDb.db.prepare("SELECT * FROM image_previews WHERE group_id = ? AND output_message_id = ?").get(groupId, messageId) as ImagePreviewRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getBySource(groupId: string, sourceMessageId: string): ImagePreviewRecord | undefined {
    const row = this.sharedDb.db.prepare(
      "SELECT * FROM image_previews WHERE group_id = ? AND source_message_id = ?",
    ).get(groupId, sourceMessageId) as ImagePreviewRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listPage(args: ImagePreviewListArgs = {}): {
    items: ImagePreviewRecord[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  } {
    const pageSize = Math.max(1, Math.min(100, Math.floor(args.pageSize ?? 20)));
    const requestedPage = Math.max(1, Math.floor(args.page ?? 1));
    const now = args.now ?? Date.now();
    const where: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (args.groupId?.trim()) {
      where.push("group_id = ?");
      parameters.push(args.groupId.trim());
    }
    if (args.visibleGroupIds) {
      const groups = [...new Set(args.visibleGroupIds.map(value => value.trim()).filter(Boolean))];
      if (groups.length === 0) {
        return { items: [], pagination: { page: 1, pageSize, total: 0, totalPages: 1 } };
      }
      where.push(`group_id IN (${groups.map(() => "?").join(", ")})`);
      parameters.push(...groups);
    }
    if (args.status === "available") {
      where.push("status = 'available' AND expires_at > ?");
      parameters.push(now);
    } else if (args.status === "expired") {
      where.push("(status = 'expired' OR (status = 'available' AND expires_at <= ?))");
      parameters.push(now);
    } else if (args.status === "deleted") {
      where.push("status = 'deleted'");
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.sharedDb.db.prepare(
      `SELECT COUNT(*) AS count FROM image_previews ${whereSql}`,
    ).get(...parameters) as { count: number }).count);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = this.sharedDb.db.prepare(
      `SELECT * FROM image_previews ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...parameters, pageSize, (page - 1) * pageSize) as unknown as ImagePreviewRow[];
    return { items: rows.map(fromRow), pagination: { page, pageSize, total, totalPages } };
  }

  listExpired(now = Date.now()): ImagePreviewRecord[] {
    const rows = this.sharedDb.db.prepare(
      `SELECT * FROM image_previews
       WHERE expires_at <= ? AND status = 'available'
       ORDER BY expires_at, id`,
    ).all(now) as unknown as ImagePreviewRow[];
    return rows.map(fromRow);
  }

  markExpired(id: string, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return false;
    const changed = this.sharedDb.db.prepare(
      `UPDATE image_previews
          SET prompt = NULL, prompt_summary = '', status = 'expired', expired_at = COALESCE(expired_at, ?),
              updated_at = ?
        WHERE id = ? AND status = 'available'`,
    ).run(now, now, normalizedId);
    return Number(changed.changes) === 1;
  }

  markDeleted(id: string, now = Date.now()): boolean {
    const normalizedId = normalizePreviewId(id);
    if (!normalizedId) return false;
    const changed = this.sharedDb.db.prepare(
      `UPDATE image_previews
          SET prompt = NULL, prompt_summary = '', status = 'deleted', deleted_at = COALESCE(deleted_at, ?),
              updated_at = ?
        WHERE id = ? AND status <> 'deleted'`,
    ).run(now, now, normalizedId);
    return Number(changed.changes) === 1;
  }

  listAvailableIds(): string[] {
    return (this.sharedDb.db.prepare(
      "SELECT id FROM image_previews WHERE status = 'available'",
    ).all() as Array<{ id: string }>).map(row => row.id);
  }

  /** Terminal records retain their ids so cleanup can retry their private bytes. */
  listIds(): string[] {
    return (this.sharedDb.db.prepare("SELECT id FROM image_previews").all() as Array<{ id: string }>).map(row => row.id);
  }

  listTerminal(): ImagePreviewRecord[] {
    const rows = this.sharedDb.db.prepare(
      "SELECT * FROM image_previews WHERE status IN ('expired', 'deleted') ORDER BY updated_at, id",
    ).all() as unknown as ImagePreviewRow[];
    return rows.map(fromRow);
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

export function isImagePreviewToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function createImagePreviewId(): string {
  const id = randomBytes(IMAGE_PREVIEW_TOKEN_BYTES).toString("base64url");
  if (!isImagePreviewToken(id) || id.length !== IMAGE_PREVIEW_TOKEN_LENGTH) {
    throw new Error("image_preview_token_generation_failed");
  }
  return id;
}

function normalizePreviewId(value: string): string | undefined {
  const id = value.trim();
  return isImagePreviewToken(id) ? id : undefined;
}

function requirePreviewId(value: string): string {
  const id = normalizePreviewId(value);
  if (!id) throw new Error("image_preview_id_invalid");
  return id;
}

function requireIdentifier(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error(errorCode);
  return normalized;
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || Array.from(prompt).length > 5_000) throw new Error("image_preview_prompt_invalid");
  return prompt;
}

function normalizePromptSummary(value: string): string {
  const summary = value.trim();
  if (!summary || Array.from(summary).length > 160) throw new Error("image_preview_prompt_summary_invalid");
  return summary;
}

function normalizeByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 20 * 1024 * 1024) {
    throw new Error("image_preview_byte_size_invalid");
  }
  return value;
}

function normalizeSha256(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("image_preview_content_hash_invalid");
  return sha;
}

function fromRow(row: ImagePreviewRow): ImagePreviewRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    creatorUserId: row.creator_user_id,
    sourceMessageId: row.source_message_id,
    operation: row.operation, referenceCount: row.reference_count,
    parentIds: JSON.parse(row.parent_ids_json), outputSize: row.output_size,
    ...(row.output_message_id ? { outputMessageId: row.output_message_id } : {}),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    promptSummary: row.prompt_summary,
    modelId: row.model_id,
    model: row.model,
    fallbackUsed: Boolean(row.fallback_used),
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(row.expired_at === null ? {} : { expiredAt: row.expired_at }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}
