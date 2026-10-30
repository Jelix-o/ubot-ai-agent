import type { OutboxRow } from "../shared/sqlite.js";
import type { V3StateRepository } from "./v3-state-repository.js";
type Stage = "queued" | "processing" | "awaiting_delivery" | "completed" | "failed" | "unknown";
interface TrackedRequest {
    sourceRowId: number;
    groupId: string;
    userId: string;
    kind: "conversation" | "image";
    createdAt: number;
    progressOutboxId?: number;
    failed?: boolean;
    finishedAt?: number;
}
export interface RequestStatus {
    sourceRowId: number;
    kind: TrackedRequest["kind"];
    stage: Stage;
    elapsedSeconds: number;
    updatedAt: number;
}
const TYPE = "request-feedback";
const TERMINAL = new Set<Stage>(["completed", "failed", "unknown"]);
const LABELS: Record<Stage, string> = { queued: "排队中", processing: "处理中", awaiting_delivery: "等待发送", completed: "已完成", failed: "未完成", unknown: "结果未确认" };
export class RequestFeedbackService {
    constructor(private readonly repo: V3StateRepository) { }
    private allowed(item: TrackedRequest): boolean {
        const group = this.repo.getGroup(item.groupId);
        return Boolean(group?.interactionAssistanceEnabled && group.groupExperienceEnabled && group.enabled !== false && !group.botMuted && !group.blacklistedUserIds?.includes(item.userId));
    }
    track(sourceRowId: number, kind: TrackedRequest["kind"], now = Date.now()): void {
        const message = this.repo.sharedDb.db.prepare("SELECT group_id,user_id,created_at FROM messages WHERE id=? AND is_bot_msg=0").get(sourceRowId) as {
            group_id: string;
            user_id: string;
            created_at: number;
        } | undefined;
        if (!message)
            return;
        const item: TrackedRequest = { sourceRowId, groupId: message.group_id, userId: message.user_id, kind, createdAt: message.created_at };
        if (!this.allowed(item))
            return;
        this.repo.updateDocument<TrackedRequest>(TYPE, String(sourceRowId), item, current => current, now);
    }
    fail(sourceRowId: number): void { const item = this.repo.getDocument<TrackedRequest | null>(TYPE, String(sourceRowId), null); if (item)
        this.repo.saveDocument(TYPE, String(sourceRowId), { ...item, failed: true, finishedAt: Date.now() }); }
    finish(sourceRowId: number): void { const item = this.repo.getDocument<TrackedRequest | null>(TYPE, String(sourceRowId), null); if (item)
        this.repo.saveDocument(TYPE, String(sourceRowId), { ...item, finishedAt: Date.now() }); }
    private snapshot(item: TrackedRequest, now: number): RequestStatus | undefined {
        const db = this.repo.sharedDb;
        const source = db.db.prepare("SELECT msg_id FROM messages WHERE id=? AND group_id=? AND user_id=?").get(item.sourceRowId, item.groupId, item.userId) as {
            msg_id: string;
        } | undefined;
        if (!source || db.isRetracted(item.groupId, source.msg_id))
            return;
        let stage: Stage = "queued", updatedAt = item.finishedAt ?? item.createdAt;
        if (item.kind === "image") {
            const image = db.db.prepare("SELECT status,updated_at FROM image_requests WHERE source_row_id=? AND group_id=? AND creator_user_id=?").get(item.sourceRowId, item.groupId, item.userId) as {
                status: string;
                updated_at: number;
            } | undefined;
            if (image) {
                stage = ({ accepted: "queued", submitting: "processing", generated: "awaiting_delivery", queued: "awaiting_delivery", delivered: "completed", failed: "failed", outcome_unknown: "unknown", delivery_unknown: "unknown" } as Record<string, Stage>)[image.status] ?? "unknown";
                updatedAt = image.updated_at;
            }
            else if (item.finishedAt)
                return;
        }
        else {
            const task = db.db.prepare("SELECT branch_id,source_turn_id,status,updated_at FROM conversation_reply_tasks WHERE source_row_id=? AND group_id=? AND user_id=?").get(item.sourceRowId, item.groupId, item.userId) as {
                branch_id: string;
                source_turn_id: number;
                status: string;
                updated_at: number;
            } | undefined;
            if (!task || task.status === "superseded")
                return;
            const rows = db.db.prepare("SELECT status,retry_after,updated_at FROM outbox WHERE branch_id=? AND source_turn_id=? AND kind<>'request_progress'").all(task.branch_id, task.source_turn_id) as Array<{
                status: string;
                retry_after: number | null;
                updated_at: number;
            }>;
            if (rows.some(r => r.status === "cancelled"))
                return;
            if (rows.some(r => r.status === "outcome_unknown" || r.status === "failed" && r.retry_after === null))
                stage = "unknown";
            else if (rows.length && rows.every(r => r.status === "sent"))
                stage = "completed";
            else if (rows.length && rows.some(r => ["pending", "sending", "failed"].includes(r.status)))
                stage = "awaiting_delivery";
            else if (task.status === "failed")
                stage = "failed";
            else if (task.status === "running")
                stage = "processing";
            else if (item.finishedAt)
                return;
            updatedAt = Math.max(task.updated_at, ...rows.map(r => r.updated_at ?? 0));
        }
        if (item.failed && stage !== "unknown")
            stage = "failed";
        return { sourceRowId: item.sourceRowId, kind: item.kind, stage, updatedAt, elapsedSeconds: Math.max(0, Math.floor(((TERMINAL.has(stage) ? updatedAt : now) - item.createdAt) / 1000)) };
    }
    list(groupId: string, userId: string, now = Date.now()): RequestStatus[] {
        return this.repo.listDocuments<TrackedRequest>(TYPE).filter(d => d.value.groupId === groupId && d.value.userId === userId && this.allowed(d.value))
            .flatMap(d => { const state = this.snapshot(d.value, now); return state && (!TERMINAL.has(state.stage) || now - state.updatedAt <= 600000) ? [state] : []; })
            .sort((a, b) => Number(TERMINAL.has(a.stage)) - Number(TERMINAL.has(b.stage)) || b.sourceRowId - a.sourceRowId).slice(0, 10);
    }
    hasActive(groupId: string, userId: string): boolean { return this.list(groupId, userId).some(r => !TERMINAL.has(r.stage)); }
    describe(groupId: string, userId: string, now = Date.now()): string {
        const list = this.list(groupId, userId, now);
        return list.length ? "你在本群的请求进度：\n" + list.map(r => `${r.kind === "image" ? "图片" : "对话"}｜${LABELS[r.stage]}｜${TERMINAL.has(r.stage) ? "用时" : "已等"} ${r.elapsedSeconds} 秒`).join("\n") + "\n已完成结果只展示最近十分钟；不会重新执行请求。" : "你在本群没有进行中的请求或最近十分钟的完成记录。";
    }
    enqueueQuery(groupId: string, userId: string, now = Date.now()): void {
        if (!/^\d+$/.test(userId) || !this.allowed({ groupId, userId, sourceRowId: 0, kind: "conversation", createdAt: now }))
            return;
        this.repo.sharedDb.enqueueOutbox(groupId, null, JSON.stringify({ queryUserId: userId, expiresAt: now + 30000 }), "request_progress");
    }
    tick(now = Date.now()): void {
        this.repo.runAtomically(() => {
            for (const doc of this.repo.listDocuments<TrackedRequest>(TYPE)) {
                const item = doc.value;
                if (now - item.createdAt > 86400000) {
                    this.repo.deleteDocument(TYPE, doc.key);
                    continue;
                }
                if (item.progressOutboxId || now - item.createdAt < 8000 || !this.allowed(item))
                    continue;
                const status = this.snapshot(item, now);
                if (!status || TERMINAL.has(status.stage))
                    continue;
                const outboxId = this.repo.sharedDb.enqueueOutbox(item.groupId, null, JSON.stringify({ sourceRowId: item.sourceRowId, expiresAt: now + 30000 }), "request_progress");
                this.repo.saveDocument(TYPE, doc.key, { ...item, progressOutboxId: outboxId }, now);
            }
        });
    }
    validate(row: Pick<OutboxRow, "id" | "text" | "group_id">, now = Date.now()): string {
        const notice = JSON.parse(row.text) as {
            sourceRowId: number;
            expiresAt: number;
            queryUserId?: string;
        };
        if (!Number.isFinite(notice.expiresAt) || now > notice.expiresAt)
            throw new Error("request_progress_expired");
        if (notice.queryUserId !== undefined) {
            if (typeof notice.queryUserId !== "string" || !/^\d+$/.test(notice.queryUserId) || !this.allowed({ groupId: row.group_id, userId: notice.queryUserId, sourceRowId: 0, kind: "conversation", createdAt: now }))
                throw new Error("request_progress_unavailable");
            return this.describe(row.group_id, notice.queryUserId, now);
        }
        if (!Number.isSafeInteger(notice.sourceRowId))
            throw new Error("request_progress_unavailable");
        const item = this.repo.getDocument<TrackedRequest | null>(TYPE, String(notice.sourceRowId), null);
        if (!item || item.groupId !== row.group_id || item.progressOutboxId !== row.id || !this.allowed(item))
            throw new Error("request_progress_unavailable");
        const state = this.snapshot(item, now);
        if (!state || TERMINAL.has(state.stage))
            throw new Error("request_progress_finished");
        if (item.kind === "conversation") {
            const sent = this.repo.sharedDb.db.prepare("SELECT 1 FROM outbox o JOIN conversation_reply_tasks t ON o.branch_id=t.branch_id AND o.source_turn_id=t.source_turn_id WHERE t.source_row_id=? AND o.kind<>'request_progress' AND o.status IN ('sent','sending') LIMIT 1").get(item.sourceRowId);
            if (sent)
                throw new Error("request_progress_finished");
        }
        if(state.stage==="awaiting_delivery")return "结果已就绪，正在等待发送。";
        return state.stage === "queued" ? "还在排队，轮到你就处理。" : "还在处理这条，完成后直接回你。";
    }
}
