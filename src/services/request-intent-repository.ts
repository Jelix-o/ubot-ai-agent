import { randomUUID } from "node:crypto";
import type { SharedDb, IngressMessageRow } from "../shared/sqlite.js";
import { REQUEST_ACTIONS, REQUEST_MISSING_FIELDS, requestMediaSourceRowIds, type RequestUnderstanding } from "./request-understanding.js";

interface RouteRow { source_row_id: number; status: "classifying" | "classified" | "unavailable"; lease_token: string | null; lease_expires_at: number | null; result_json: string | null; error_code: string | null }
export class RequestIntentRepository {
  constructor(private readonly shared: SharedDb) {}
  get(sourceRowId: number): { status: RouteRow["status"]; result?: RequestUnderstanding; errorCode?: string } | undefined {
    const row = this.shared.db.prepare("SELECT * FROM request_intent_routes WHERE source_row_id=?").get(sourceRowId) as unknown as RouteRow | undefined;
    if (!row) return;
    let result: RequestUnderstanding | undefined;
    try {
      const value = row.result_json ? JSON.parse(row.result_json) : undefined;
      if (value && REQUEST_ACTIONS.includes(value.action) && ["new", "follow_up", "supplement"].includes(value.relation) &&
          Array.isArray(value.sourceRowIds) && value.sourceRowIds.length <= 12 && value.sourceRowIds.every(Number.isSafeInteger) &&
          Array.isArray(value.missingFields) && value.missingFields.every((field: unknown) => REQUEST_MISSING_FIELDS.includes(field as never)) &&
          (value.mediaSourceRowId === undefined || Number.isSafeInteger(value.mediaSourceRowId)) &&
          (value.mediaSourceRowIds === undefined || (Array.isArray(value.mediaSourceRowIds) && value.mediaSourceRowIds.length <= 2 && value.mediaSourceRowIds.every(Number.isSafeInteger))) &&
          (value.opinionAnchorRowId === undefined || Number.isSafeInteger(value.opinionAnchorRowId)) &&
          typeof value.modelId === "string" && typeof value.model === "string") {
        const mediaSourceRowIds = requestMediaSourceRowIds(value);
        const normalized = { ...value } as RequestUnderstanding;
        if (mediaSourceRowIds.length) {
          normalized.mediaSourceRowIds = mediaSourceRowIds;
          normalized.mediaSourceRowId = mediaSourceRowIds[0];
        } else {
          delete normalized.mediaSourceRowIds;
          delete normalized.mediaSourceRowId;
        }
        result = normalized;
      }
    } catch { /* A corrupt decision cannot authorize execution. */ }
    return { status: row.status, result, ...(row.error_code ? { errorCode: row.error_code } : {}) };
  }
  claim(sourceRowId: number, now = Date.now()): { state: "claimed"; token: string } | { state: "busy" | "resolved" } {
    const token = randomUUID();
    const inserted = this.shared.db.prepare("INSERT OR IGNORE INTO request_intent_routes(source_row_id,status,lease_token,lease_expires_at,created_at,updated_at) VALUES(?,'classifying',?,?,?,?)").run(sourceRowId, token, now + 30000, now, now);
    if (Number(inserted.changes)) return { state: "claimed", token };
    this.shared.db.prepare("UPDATE request_intent_routes SET status='unavailable',error_code='result_unknown',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE source_row_id=? AND status='classifying' AND lease_expires_at<=?").run(now, sourceRowId, now);
    return { state: this.get(sourceRowId)?.status === "classifying" ? "busy" : "resolved" };
  }
  complete(sourceRowId: number, token: string, result: RequestUnderstanding, now?: number): boolean {
    // Acquire the writer before reading evidence: a deferred read snapshot cannot
    // be upgraded after ingress or another worker commits to the WAL.
    this.shared.db.exec("BEGIN IMMEDIATE");
    try {
      // busy_timeout may have waited for another writer. Never use the time from
      // before that wait to authorize a lease that has since expired.
      const completedAt = now ?? Date.now();
      const source = this.shared.db.prepare("SELECT text FROM messages WHERE id=?").get(sourceRowId) as { text: string } | undefined;
      if (!source?.text.trim() && result.sourceRowIds.some(id => id !== sourceRowId && this.shared.db.prepare("SELECT 1 FROM request_intent_evidence WHERE evidence_row_id=? AND source_row_id<>?").get(id, sourceRowId))) {
        result = { action: "chat", relation: "new", sourceRowIds: [sourceRowId], missingFields: [], modelId: "host", model: "host" };
      }
      const changed = Number(this.shared.db.prepare("UPDATE request_intent_routes SET status='classified',result_json=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE source_row_id=? AND status='classifying' AND lease_token=? AND lease_expires_at>?")
        .run(JSON.stringify(result), completedAt, sourceRowId, token, completedAt).changes) === 1;
      if (changed && !result.missingFields.length && result.action !== "clarify") this.consume(sourceRowId, result.sourceRowIds);
      this.shared.db.exec("COMMIT");
      return changed;
    } catch (error) { this.shared.db.exec("ROLLBACK"); throw error; }
  }
  fail(sourceRowId: number, token: string, now = Date.now()): void {
    this.shared.db.prepare("UPDATE request_intent_routes SET status='unavailable',error_code='unavailable',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE source_row_id=? AND status='classifying' AND lease_token=? AND lease_expires_at>?").run(now, sourceRowId, token, now);
  }
  /** A non-idempotent adapter may be entered once. A crash after dispatch is not permission to repeat it. */
  beginExecution(sourceRowId: number): "started" | "settled" | "unknown" {
    if (Number(this.shared.db.prepare("UPDATE request_intent_routes SET execution_status='running',updated_at=? WHERE source_row_id=? AND execution_status='pending'").run(Date.now(), sourceRowId).changes)) return "started";
    const changed = this.shared.db.prepare("UPDATE request_intent_routes SET execution_status='unknown',updated_at=? WHERE source_row_id=? AND execution_status='running'").run(Date.now(), sourceRowId);
    return Number(changed.changes) ? "unknown" : "settled";
  }
  finishExecution(sourceRowId: number, failed = false): void {
    this.shared.db.prepare("UPDATE request_intent_routes SET execution_status=?,updated_at=? WHERE source_row_id=? AND execution_status='running'").run(failed ? "failed" : "completed", Date.now(), sourceRowId);
  }
  private listCandidates(message: IngressMessageRow, readOnly: boolean): IngressMessageRow[] {
    const unansweredFilter = readOnly ? "" : `AND NOT EXISTS (SELECT 1 FROM conversation_message_routes r JOIN outbox o ON o.branch_id=r.branch_id AND o.source_turn_id=r.turn_id WHERE r.source_row_id=m.id AND o.status IN ('sent','sending'))
      AND NOT EXISTS (SELECT 1 FROM request_intent_evidence e WHERE e.evidence_row_id=m.id)`;
    const rows = this.shared.db.prepare(`SELECT m.* FROM messages m WHERE m.group_id=? AND m.user_id=? AND m.id<? AND m.created_at>=? AND m.created_at<=? AND m.is_bot_msg=0
      AND (m.processable=1 OR m.drop_reason='rate_limited')
      ${unansweredFilter}
      ORDER BY m.id DESC`).iterate(message.group_id, message.user_id, message.id, message.created_at - 120000, message.created_at);
    const selected: IngressMessageRow[] = [];
    for (const value of rows) {
      const row = value as unknown as IngressMessageRow;
      if (this.shared.isRetracted(row.group_id, row.msg_id)) continue;
      // Empty mentions never revive a decided task; explicit follow-ups may read it without executing it.
      if (!readOnly && (this.get(row.id) || this.shared.db.prepare("SELECT 1 FROM image_requests WHERE source_row_id=?").get(row.id))) continue;
      selected.push(row);
      if (selected.length === 12) break;
    }
    return selected.reverse();
  }
  /** Acknowledged replies consume only the selected evidence, including passive image/text rows. */
  candidates(message: IngressMessageRow): IngressMessageRow[] {
    return this.listCandidates(message, false);
  }
  /** Explicit self-follow-ups may reread answered evidence, never re-execute its old action. */
  followUpCandidates(message: IngressMessageRow): IngressMessageRow[] {
    return this.listCandidates(message, true);
  }
  consume(sourceRowId: number, evidenceIds: number[]): void {
    for (const evidenceId of evidenceIds) if (evidenceId !== sourceRowId) this.shared.db.prepare("INSERT OR IGNORE INTO request_intent_evidence(source_row_id,evidence_row_id) VALUES(?,?)").run(sourceRowId, evidenceId);
  }
  pending(groupId: string, userId: string, now: number): { sourceRowId: number; result: RequestUnderstanding } | undefined {
    const row = this.shared.db.prepare("SELECT source_row_id FROM request_intent_pending WHERE group_id=? AND user_id=? AND expires_at>?").get(groupId, userId, now) as { source_row_id: number } | undefined;
    const result = row && this.get(row.source_row_id)?.result;
    return row && result && !this.shared.isRetracted(groupId, (this.shared.db.prepare("SELECT msg_id FROM messages WHERE id=?").get(row.source_row_id) as { msg_id: string }).msg_id) ? { sourceRowId: row.source_row_id, result } : undefined;
  }
  settle(groupId: string, userId: string, sourceRowId: number, waiting: boolean, now: number): void {
    if (waiting) this.shared.db.prepare("INSERT INTO request_intent_pending(group_id,user_id,source_row_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET source_row_id=excluded.source_row_id,expires_at=excluded.expires_at").run(groupId, userId, sourceRowId, now + 120000);
    else this.shared.db.prepare("DELETE FROM request_intent_pending WHERE group_id=? AND user_id=?").run(groupId, userId);
  }
}
