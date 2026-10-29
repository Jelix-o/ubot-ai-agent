import type { SharedDb } from "../shared/sqlite.js";
import type { ImageIntentMissingField } from "./image-intent-router-plugin.js";

/** Only source associations, offsets in sanitized source text, and enums are durable. */
export interface ImageIntentMaterialization {
  sourceRowIds: number[];
  target?: { sourceRowId: number; start: number; end: number };
  missingFields: ImageIntentMissingField[];
  pendingSourceRowId?: number;
  cancelled?: boolean;
}

export interface PendingImageRequest {
  sourceRowId: number;
  latestSourceRowId: number;
  expiresAt: number;
}

export class ImagePendingRequestRepository {
  constructor(private readonly shared: SharedDb) {}

  get(sourceRowId: number, now = Date.now()): PendingImageRequest | undefined {
    const row = this.shared.db.prepare(`SELECT p.* FROM image_pending_requests p
      JOIN messages original ON original.id = p.source_row_id JOIN messages current ON current.id = ?
      WHERE original.group_id = current.group_id AND original.user_id = current.user_id
        AND p.latest_source_row_id < current.id AND p.status = 'waiting' AND p.expires_at > ?
      ORDER BY p.latest_source_row_id DESC LIMIT 1`).get(sourceRowId, now) as {
        source_row_id: number; latest_source_row_id: number; expires_at: number;
      } | undefined;
    return row && { sourceRowId: row.source_row_id, latestSourceRowId: row.latest_source_row_id, expiresAt: row.expires_at };
  }

  /**
   * Called inside the route ledger transaction. Terminal rows also retain
   * ordering so a slow older classifier cannot restore a superseded wait.
   */
  settle(input: {
    sourceRowId: number;
    outcome: "waiting" | "completed" | "cancelled";
    continuation?: PendingImageRequest;
    now?: number;
  }): boolean {
    const { sourceRowId, outcome, continuation, now = Date.now() } = input;
    const db = this.shared.db;
    if (continuation) {
      const result = db.prepare(`UPDATE image_pending_requests SET latest_source_row_id = ?, status = ?
        WHERE source_row_id = ? AND latest_source_row_id = ? AND status = 'waiting' AND expires_at > ?
          AND latest_source_row_id < ? AND EXISTS (
            SELECT 1 FROM messages original JOIN messages current ON current.id = ?
            WHERE original.id = image_pending_requests.source_row_id
              AND original.group_id = current.group_id AND original.user_id = current.user_id)`)
        .run(sourceRowId, outcome, continuation.sourceRowId, continuation.latestSourceRowId, now, sourceRowId, sourceRowId);
      return Number(result.changes) === 1;
    }
    const newer = db.prepare(`SELECT 1 FROM image_pending_requests p
      JOIN messages original ON original.id = p.source_row_id JOIN messages current ON current.id = ?
      WHERE original.group_id = current.group_id AND original.user_id = current.user_id
        AND p.latest_source_row_id > current.id LIMIT 1`).get(sourceRowId);
    // A complete, independent request can still join the image queue, but
    // an older classifier must never overwrite a newer request's wait.
    if (newer) return outcome === "completed";
    db.prepare(`UPDATE image_pending_requests SET status = 'cancelled' WHERE status = 'waiting' AND source_row_id IN (
      SELECT p.source_row_id FROM image_pending_requests p JOIN messages original ON original.id = p.source_row_id
      JOIN messages current ON current.id = ? WHERE original.group_id = current.group_id AND original.user_id = current.user_id
        AND p.latest_source_row_id < current.id)`).run(sourceRowId);
    const result = db.prepare(`INSERT OR IGNORE INTO image_pending_requests (source_row_id, latest_source_row_id, status, expires_at)
      VALUES (?, ?, ?, ?)`).run(sourceRowId, sourceRowId, outcome, now + 120_000);
    if (Number(result.changes) === 1) return true;
    // Explicit commands may revisit the same source during queue handoff.
    const existing = db.prepare("SELECT latest_source_row_id, status FROM image_pending_requests WHERE source_row_id = ?")
      .get(sourceRowId) as { latest_source_row_id: number; status: string } | undefined;
    return existing?.latest_source_row_id === sourceRowId && existing.status === outcome;
  }
}

export function parseImageIntentMaterialization(json: string | null): ImageIntentMaterialization | undefined {
  if (!json) return undefined;
  try {
    return normalizeImageIntentMaterialization(JSON.parse(json) as unknown);
  } catch { return undefined; }
}

/** Serialize only normalized metadata, never arbitrary caller-supplied fields. */
export function serializeImageIntentMaterialization(value: ImageIntentMaterialization): string {
  const normalized = normalizeImageIntentMaterialization(value);
  if (!normalized) throw new Error("image_intent_materialization_invalid");
  return JSON.stringify(normalized);
}

function normalizeImageIntentMaterialization(value: unknown): ImageIntentMaterialization | undefined {
  if (!isPlainRecord(value) || Object.keys(value).some(key => !MATERIALIZATION_KEYS.has(key))) return undefined;
  const sourceRowIds = value.sourceRowIds;
  const missingFields = value.missingFields;
  if (!Array.isArray(sourceRowIds) || !sourceRowIds.length || sourceRowIds.length > 8 ||
      sourceRowIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(sourceRowIds).size !== sourceRowIds.length ||
      sourceRowIds.some((id, index) => index > 0 && id <= sourceRowIds[index - 1]!) ||
      !Array.isArray(missingFields) ||
      missingFields.some(field => field !== "target" && field !== "instruction" && field !== "reference") ||
      new Set(missingFields).size !== missingFields.length) return undefined;
  const normalizedSourceRowIds = sourceRowIds as number[];
  const normalizedMissingFields = missingFields as ImageIntentMissingField[];

  let target: ImageIntentMaterialization["target"];
  const targetValue = value.target;
  if (targetValue !== undefined) {
    if (!isPlainRecord(targetValue) || Object.keys(targetValue).some(key => !TARGET_KEYS.has(key))) return undefined;
    const targetSourceRowId = targetValue.sourceRowId;
    const start = targetValue.start;
    const end = targetValue.end;
    if (typeof targetSourceRowId !== "number" || !Number.isSafeInteger(targetSourceRowId) ||
        !normalizedSourceRowIds.includes(targetSourceRowId) || typeof start !== "number" ||
        !Number.isInteger(start) || typeof end !== "number" || !Number.isInteger(end) || start < 0 ||
        end <= start || end > 4_000) return undefined;
    target = { sourceRowId: targetSourceRowId, start, end };
  }
  const pendingSourceRowIdValue = value.pendingSourceRowId;
  if (pendingSourceRowIdValue !== undefined && (typeof pendingSourceRowIdValue !== "number" ||
      !Number.isSafeInteger(pendingSourceRowIdValue) || !normalizedSourceRowIds.includes(pendingSourceRowIdValue))) return undefined;
  const pendingSourceRowId = pendingSourceRowIdValue as number | undefined;
  const cancelled = value.cancelled;
  if (cancelled !== undefined && typeof cancelled !== "boolean") return undefined;
  return {
    sourceRowIds: [...normalizedSourceRowIds],
    ...(target === undefined ? {} : { target }),
    missingFields: [...normalizedMissingFields],
    ...(pendingSourceRowId === undefined ? {} : { pendingSourceRowId }),
    ...(cancelled === undefined ? {} : { cancelled }),
  };
}

const MATERIALIZATION_KEYS = new Set(["sourceRowIds", "target", "missingFields", "pendingSourceRowId", "cancelled"]);
const TARGET_KEYS = new Set(["sourceRowId", "start", "end"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
