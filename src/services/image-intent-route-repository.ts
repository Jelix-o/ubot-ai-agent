import { randomBytes } from "node:crypto";

import type { SharedDb } from "../shared/sqlite.js";

/** The only outcomes the intent model is allowed to select. */
export type ImageIntentRouteAction =
  | "chat"
  | "generate"
  | "edit"
  | "avatar_edit"
  | "clarification";

export type ImageIntentRouteStatus = "classifying" | "classified" | "unavailable";

/**
 * Non-content-bearing routing state for one persisted inbound message.
 *
 * The source-row foreign key is intentionally the only message association:
 * group IDs, QQ IDs, text, prompts, member names, and image references must
 * remain outside this durable routing table.
 */
export interface ImageIntentRouteRecord {
  sourceRowId: number;
  status: ImageIntentRouteStatus;
  action?: ImageIntentRouteAction;
  modelId?: string;
  model?: string;
  errorCode?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  classifiedAt?: number;
  unavailableAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImageIntentRouteClaimed {
  state: "claimed";
  route: ImageIntentRouteRecord;
  leaseToken: string;
  /** True when this call created the durable source-row record. */
  created: boolean;
}

export interface ImageIntentRouteResolved {
  state: "resolved";
  route: ImageIntentRouteRecord;
}

export interface ImageIntentRouteBusy {
  state: "busy";
  route: ImageIntentRouteRecord;
}

export type ImageIntentRouteClaim =
  | ImageIntentRouteClaimed
  | ImageIntentRouteResolved
  | ImageIntentRouteBusy;

interface ImageIntentRouteRow {
  source_row_id: number;
  status: ImageIntentRouteStatus;
  action: ImageIntentRouteAction | null;
  model_id: string | null;
  model: string | null;
  error_code: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  classified_at: number | null;
  unavailable_at: number | null;
  created_at: number;
  updated_at: number;
}

export const IMAGE_INTENT_ROUTE_DEFAULT_LEASE_MS = 30_000;

/**
 * Durable idempotency and ownership boundary for intent classification.
 *
 * A caller can submit a model request only after receiving `state: "claimed"`.
 * Terminal results are never rerouted. An expired in-progress classification
 * becomes a terminal `result_unknown` record rather than being submitted a
 * second time: after a process crash the upstream tool call may already have
 * happened, and ordinary chat is safer than duplicate classification.
 */
export class ImageIntentRouteRepository {
  private transactionDepth = 0;

  constructor(private readonly sharedDb: SharedDb) {}

  runAtomically<T>(callback: () => T): T {
    return this.withImmediateTransaction(callback);
  }

  /**
   * Atomically creates or takes ownership of an unfinished source-message
   * route. Model metadata is optional because the runtime may only discover
   * the selected model while it performs classification.
   */
  claim(input: {
    sourceRowId: number;
    modelId?: string;
    model?: string;
    now?: number;
    leaseMs?: number;
  }): ImageIntentRouteClaim {
    const sourceRowId = requireSourceRowId(input.sourceRowId);
    const model = normalizeModelMetadata(input);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_intent_route_claimed_at_invalid");
    const leaseMs = normalizeLeaseMs(input.leaseMs);

    return this.withImmediateTransaction(() => {
      const existing = this.getBySourceRow(sourceRowId);
      if (!existing) {
        this.assertSourceRow(sourceRowId);
        const leaseToken = createLeaseToken();
        const leaseExpiresAt = now + leaseMs;
        this.sharedDb.db.prepare(
          `INSERT INTO image_intent_routes
             (source_row_id, status, action, model_id, model, error_code,
              lease_token, lease_expires_at, classified_at, unavailable_at,
              created_at, updated_at)
           VALUES (?, 'classifying', NULL, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
        ).run(sourceRowId, model?.modelId ?? null, model?.model ?? null, leaseToken, leaseExpiresAt, now, now);
        const route = this.getBySourceRow(sourceRowId);
        if (!route) throw new Error("image_intent_route_claim_readback_failed");
        return { state: "claimed", route, leaseToken, created: true };
      }

      if (existing.status === "classified" || existing.status === "unavailable") {
        return { state: "resolved", route: existing };
      }

      if (existing.leaseExpiresAt === undefined || existing.leaseExpiresAt > now) {
        return { state: "busy", route: existing };
      }

      const expired = this.sharedDb.db.prepare(
        `UPDATE image_intent_routes
            SET status = 'unavailable', action = NULL,
                error_code = 'result_unknown', lease_token = NULL,
                lease_expires_at = NULL, unavailable_at = COALESCE(unavailable_at, ?),
                updated_at = ?
          WHERE source_row_id = ?
            AND status = 'classifying'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`,
      ).run(
        now,
        now,
        sourceRowId,
        now,
      );
      if (Number(expired.changes) !== 1) {
        const latest = this.getBySourceRow(sourceRowId);
        if (!latest) throw new Error("image_intent_route_recovery_readback_failed");
        if (latest.status === "classified" || latest.status === "unavailable") {
          return { state: "resolved", route: latest };
        }
        return { state: "busy", route: latest };
      }
      const route = this.getBySourceRow(sourceRowId);
      if (!route) throw new Error("image_intent_route_expiry_readback_failed");
      return { state: "resolved", route };
    });
  }

  getBySourceRow(sourceRowId: number): ImageIntentRouteRecord | undefined {
    if (!isSourceRowId(sourceRowId)) return undefined;
    const row = this.sharedDb.db.prepare(
      "SELECT * FROM image_intent_routes WHERE source_row_id = ?",
    ).get(sourceRowId) as ImageIntentRouteRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Extends a live claim before a slow classifier call reaches its deadline.
   * A terminal record can never be renewed by its old owner.
   */
  renewLease(input: {
    sourceRowId: number;
    leaseToken: string;
    now?: number;
    leaseMs?: number;
  }): boolean {
    const sourceRowId = requireSourceRowId(input.sourceRowId);
    const leaseToken = requireLeaseToken(input.leaseToken);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_intent_route_renewed_at_invalid");
    const leaseMs = normalizeLeaseMs(input.leaseMs);
    const result = this.sharedDb.db.prepare(
      `UPDATE image_intent_routes
          SET lease_expires_at = ?, updated_at = ?
        WHERE source_row_id = ?
          AND status = 'classifying'
          AND lease_token = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
    ).run(now + leaseMs, now, sourceRowId, leaseToken, now);
    return Number(result.changes) === 1;
  }

  /** Commits the validated model-selected action for the current lease owner. */
  complete(input: {
    sourceRowId: number;
    leaseToken: string;
    action: ImageIntentRouteAction;
    modelId?: string;
    model?: string;
    now?: number;
  }): ImageIntentRouteRecord | undefined {
    const sourceRowId = requireSourceRowId(input.sourceRowId);
    const leaseToken = requireLeaseToken(input.leaseToken);
    const action = normalizeAction(input.action);
    const model = normalizeModelMetadata(input);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_intent_route_classified_at_invalid");
    const result = this.sharedDb.db.prepare(
      `UPDATE image_intent_routes
          SET status = 'classified', action = ?,
              model_id = COALESCE(?, model_id), model = COALESCE(?, model),
              error_code = NULL, lease_token = NULL, lease_expires_at = NULL,
              classified_at = COALESCE(classified_at, ?), updated_at = ?
        WHERE source_row_id = ?
          AND status = 'classifying'
          AND lease_token = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
    ).run(action, model?.modelId ?? null, model?.model ?? null, now, now, sourceRowId, leaseToken, now);
    return Number(result.changes) === 1 ? this.getBySourceRow(sourceRowId) : undefined;
  }

  /**
   * Resolves a claimed route as unavailable after an expected classifier
   * failure. This is terminal so a replay falls back to normal conversation
   * instead of quietly retrying a model call.
   */
  markUnavailable(input: {
    sourceRowId: number;
    leaseToken: string;
    errorCode: string;
    modelId?: string;
    model?: string;
    now?: number;
  }): ImageIntentRouteRecord | undefined {
    const sourceRowId = requireSourceRowId(input.sourceRowId);
    const leaseToken = requireLeaseToken(input.leaseToken);
    const errorCode = normalizeErrorCode(input.errorCode);
    const model = normalizeModelMetadata(input);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_intent_route_unavailable_at_invalid");
    const result = this.sharedDb.db.prepare(
      `UPDATE image_intent_routes
          SET status = 'unavailable', action = NULL,
              model_id = COALESCE(?, model_id), model = COALESCE(?, model),
              error_code = ?, lease_token = NULL, lease_expires_at = NULL,
              unavailable_at = COALESCE(unavailable_at, ?), updated_at = ?
        WHERE source_row_id = ?
          AND status = 'classifying'
          AND lease_token = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
    ).run(
      model?.modelId ?? null,
      model?.model ?? null,
      errorCode,
      now,
      now,
      sourceRowId,
      leaseToken,
      now,
    );
    return Number(result.changes) === 1 ? this.getBySourceRow(sourceRowId) : undefined;
  }

  /**
   * Creates an immediate terminal result when no classifier can be selected.
   * It never overrides either a live claim or a completed decision.
   */
  recordUnavailable(input: {
    sourceRowId: number;
    errorCode: string;
    modelId?: string;
    model?: string;
    now?: number;
  }): { route: ImageIntentRouteRecord; created: boolean } {
    const sourceRowId = requireSourceRowId(input.sourceRowId);
    const errorCode = normalizeErrorCode(input.errorCode);
    const model = normalizeModelMetadata(input);
    const now = normalizeTimestamp(input.now ?? Date.now(), "image_intent_route_unavailable_at_invalid");

    return this.withImmediateTransaction(() => {
      const existing = this.getBySourceRow(sourceRowId);
      if (existing) return { route: existing, created: false };
      this.assertSourceRow(sourceRowId);
      this.sharedDb.db.prepare(
        `INSERT INTO image_intent_routes
           (source_row_id, status, action, model_id, model, error_code,
            lease_token, lease_expires_at, classified_at, unavailable_at,
            created_at, updated_at)
         VALUES (?, 'unavailable', NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(sourceRowId, model?.modelId ?? null, model?.model ?? null, errorCode, now, now, now);
      const route = this.getBySourceRow(sourceRowId);
      if (!route) throw new Error("image_intent_route_unavailable_readback_failed");
      return { route, created: true };
    });
  }

  private assertSourceRow(sourceRowId: number): void {
    const row = this.sharedDb.db.prepare("SELECT id FROM messages WHERE id = ?").get(sourceRowId) as { id: number } | undefined;
    if (!row) throw new Error("image_intent_route_source_row_not_found");
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

export function isSafeImageIntentRouteErrorCode(value: string): boolean {
  return /^[a-z0-9][a-z0-9_:-]{0,159}$/.test(value);
}

function fromRow(row: ImageIntentRouteRow): ImageIntentRouteRecord {
  return {
    sourceRowId: row.source_row_id,
    status: row.status,
    ...(row.action === null ? {} : { action: row.action }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.classified_at === null ? {} : { classifiedAt: row.classified_at }),
    ...(row.unavailable_at === null ? {} : { unavailableAt: row.unavailable_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSourceRowId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function requireSourceRowId(value: number): number {
  if (!isSourceRowId(value)) throw new Error("image_intent_route_source_row_id_invalid");
  return value;
}

function normalizeAction(value: ImageIntentRouteAction): ImageIntentRouteAction {
  if (value === "chat" || value === "generate" || value === "edit" || value === "avatar_edit" || value === "clarification") {
    return value;
  }
  throw new Error("image_intent_route_action_invalid");
}

function normalizeModelMetadata(input: { modelId?: string; model?: string }): { modelId: string; model: string } | undefined {
  if (input.modelId === undefined && input.model === undefined) return undefined;
  if (input.modelId === undefined || input.model === undefined) {
    throw new Error("image_intent_route_model_metadata_invalid");
  }
  return {
    modelId: requireBoundedText(input.modelId, "image_intent_route_model_id_invalid", 160),
    model: requireBoundedText(input.model, "image_intent_route_model_invalid", 256),
  };
}

function normalizeErrorCode(value: string): string {
  const code = value.trim();
  if (!isSafeImageIntentRouteErrorCode(code)) throw new Error("image_intent_route_error_code_invalid");
  return code;
}

function normalizeTimestamp(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(errorCode);
  return value;
}

function normalizeLeaseMs(value: number | undefined): number {
  if (value === undefined) return IMAGE_INTENT_ROUTE_DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new Error("image_intent_route_lease_invalid");
  }
  return value;
}

function requireLeaseToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("image_intent_route_lease_token_invalid");
  return token;
}

function createLeaseToken(): string {
  return randomBytes(24).toString("base64url");
}

function requireBoundedText(value: string, errorCode: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(errorCode);
  return normalized;
}
