import { randomUUID } from "node:crypto";
export { revision } from "./state-mutation.js";
import type { SharedDb } from "../shared/sqlite.js";
import type { AdminTaskStore } from "./admin-task-store.js";

export class BulkError extends Error { constructor(public readonly code: string, public readonly status = 400) { super(code); } }
export interface BulkTarget { id: string; groupId: string; label: string; revision: string; before: unknown; after: unknown }
export interface BulkPayload { resource: string; action: string; groupId?: string; ids: string[]; patch?: Record<string, unknown>; targets: BulkTarget[] }
export interface BulkPreview { id: string; expiresAt: string; resource: string; action: string; targets: BulkTarget[] }
interface BulkAdapter {
  read(id: string, payload: BulkPayload): Promise<BulkTarget | undefined>;
  authorize(groupId: string, payload: BulkPayload): Promise<boolean>;
  apply(target: BulkTarget, payload: BulkPayload, committed?: () => void): Promise<void>;
  audit(target: BulkTarget, payload: BulkPayload): Promise<void>;
}
export type BulkResult = { id: string; groupId: string; label: string; status: "succeeded" | "failed" | "skipped"; error?: string };
export class AdminBulkService {
  private applying = new Map<string, Promise<string>>();
  private active = new Set<string>();
  private running = new Map<string, Promise<void>>();
  constructor(private readonly db: SharedDb, private readonly tasks: AdminTaskStore, private readonly now = Date.now) {}
  async interruptPreviousRuns(): Promise<void> {
    const rows = this.db.db.prepare("SELECT task_id FROM admin_bulk_runs WHERE status IN ('queued','running')").all() as { task_id: string }[];
    for (const row of rows) {
      if (this.active.has(row.task_id)) continue;
      this.db.db.prepare("UPDATE admin_bulk_runs SET status='interrupted',updated_at=? WHERE task_id=?").run(this.now(), row.task_id);
      const preview = this.db.db.prepare("SELECT p.payload_json FROM admin_bulk_previews p JOIN admin_bulk_runs r ON p.id=r.preview_id WHERE r.task_id=?").get(row.task_id) as { payload_json: string };
      const payload: BulkPayload = JSON.parse(preview.payload_json);
      const items = this.interruptedResults(row.task_id, payload);
      await this.tasks.update(row.task_id, { status: "failed", error: "进程中断；已完成项保留，请重新预览未完成项。", finishedAt: new Date(this.now()).toISOString(), result: this.taskResult(payload, items) });
    }
  }
  async preview(operatorId: string, payload: Omit<BulkPayload, "targets">, adapter: BulkAdapter): Promise<BulkPreview> {
    if (!payload.ids.length || payload.ids.length > (payload.resource === "group-config" ? 100 : 500)) throw new BulkError("invalid_target_count");
    const targets: BulkTarget[] = [];
    for (const id of [...new Set(payload.ids)]) {
      const target = await adapter.read(id, { ...payload, targets: [] });
      if (!target) throw new BulkError("target_not_found", 404);
      if (!await adapter.authorize(target.groupId, { ...payload, targets: [] })) throw new BulkError("forbidden", 403);
      targets.push(target);
    }
    const id = randomUUID(), expires = this.now() + 600_000;
    this.db.db.prepare("DELETE FROM admin_bulk_previews WHERE expires_at < ? AND task_id IS NULL").run(this.now());
    this.db.db.prepare("INSERT INTO admin_bulk_previews(id,operator_id,expires_at,payload_json) VALUES(?,?,?,?)").run(id, operatorId, expires, JSON.stringify({ ...payload, targets }));
    return { id, expiresAt: new Date(expires).toISOString(), resource: payload.resource, action: payload.action, targets };
  }
  async execute(id: string, operatorId: string, adapter: BulkAdapter): Promise<string> {
    // One local promise plus an SQLite conditional claim prevents duplicate execution.
    const lockKey = `${operatorId}:${id}`;
    const existing = this.applying.get(lockKey); if (existing) return existing;
    const pending = this.claim(id, operatorId, adapter); this.applying.set(lockKey, pending);
    try { return await pending; } finally { this.applying.delete(lockKey); }
  }
  private async claim(id: string, operatorId: string, adapter: BulkAdapter): Promise<string> {
    const row = this.db.db.prepare("SELECT * FROM admin_bulk_previews WHERE id=? AND operator_id=?").get(id, operatorId) as { expires_at: number; payload_json: string; task_id: string | null } | undefined;
    if (!row) throw new BulkError("preview_not_found", 404);
    const payload: BulkPayload = JSON.parse(row.payload_json);
    for (const target of payload.targets) if (!await adapter.authorize(target.groupId, payload)) throw new BulkError("forbidden", 403);
    if (row.task_id) return row.task_id;
    if (row.expires_at <= this.now()) throw new BulkError("preview_expired", 409);
    for (const target of payload.targets) { const current = await adapter.read(target.id, payload); if (!current || current.revision !== target.revision) throw new BulkError("target_changed", 409); }
    const groups = [...new Set(payload.targets.map(t => t.groupId))];
    const task = await this.tasks.create({ type: "bulk-operation", title: `批量 ${payload.resource} · ${payload.targets.length} 项`, operatorUserId: operatorId, ...(groups.length === 1 && groups[0] ? { groupId: groups[0] } : {}) });
    const claimed = this.db.db.prepare("UPDATE admin_bulk_previews SET task_id=? WHERE id=? AND task_id IS NULL").run(task.id, id);
    if (!claimed.changes) { await this.tasks.update(task.id, { status: "cancelled", detail: "重复提交已合并" }); return (this.db.db.prepare("SELECT task_id FROM admin_bulk_previews WHERE id=?").get(id) as { task_id: string }).task_id; }
    this.db.db.prepare("INSERT INTO admin_bulk_runs(task_id,preview_id,status,updated_at) VALUES(?,?,'queued',?)").run(task.id, id, this.now());
    this.active.add(task.id);
    const running = this.run(task.id, payload, adapter).finally(() => { this.active.delete(task.id); this.running.delete(task.id); });
    this.running.set(task.id, running);
    return task.id;
  }
  async waitForIdle(taskId: string): Promise<void> { await this.running.get(taskId); }
  private async run(taskId: string, payload: BulkPayload, adapter: BulkAdapter): Promise<void> {
    const results: BulkResult[] = [];
    try {
      this.db.db.prepare("UPDATE admin_bulk_runs SET status='running',updated_at=? WHERE task_id=?").run(this.now(), taskId);
      await this.tasks.update(taskId, { status: "running", startedAt: new Date(this.now()).toISOString() });
      for (const target of payload.targets) {
        const state = this.db.db.prepare("SELECT cancel_requested FROM admin_bulk_runs WHERE task_id=?").get(taskId) as { cancel_requested: number };
        if (state.cancel_requested) { results.push(...payload.targets.slice(results.length).map(t => ({ id: t.id, groupId: t.groupId, label: t.label, status: "skipped" as const, error: "cancelled" }))); for (const item of results) this.saveResult(taskId, item); break; }
        try {
          if (!await adapter.authorize(target.groupId, payload)) throw new BulkError("forbidden", 403);
          const current = await adapter.read(target.id, payload); if (!current || current.revision !== target.revision) throw new BulkError("target_changed", 409);
          const item: BulkResult = { id: target.id, groupId: target.groupId, label: target.label, status: "succeeded" };
          let persisted = false;
          await adapter.apply(target, payload, () => { this.saveResult(taskId, item); persisted = true; });
          results.push(item);
          if (!persisted) { await adapter.audit(target, payload); this.saveResult(taskId, item); }
        } catch (error) {
          const committed = this.resultRows(taskId).find(item => item.id === target.id);
          if (committed) results.push(committed);
          else { const item: BulkResult = { id: target.id, groupId: target.groupId, label: target.label, status: "failed", error: error instanceof Error ? error.message : "operation_failed" }; results.push(item); this.saveResult(taskId, item); }
        }
        await this.tasks.update(taskId, { progress: Math.round(results.length / payload.targets.length * 100), detail: `已处理 ${results.length}/${payload.targets.length}`, result: this.taskResult(payload, results) });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const cancelled = results.some(r => r.error === "cancelled"); const failed = results.some(r => r.status === "failed");
      const status = cancelled ? "cancelled" : failed ? "failed" : "succeeded";
      this.db.db.prepare("UPDATE admin_bulk_runs SET status=?,updated_at=? WHERE task_id=?").run(status, this.now(), taskId);
      await this.tasks.update(taskId, { status, progress: 100, finishedAt: new Date(this.now()).toISOString(), result: this.taskResult(payload, results), ...(failed ? { error: "部分目标执行失败，请查看逐项结果。" } : {}) });
    } catch {
      this.db.db.prepare("UPDATE admin_bulk_runs SET status='interrupted',updated_at=? WHERE task_id=?").run(this.now(), taskId);
      const items = this.interruptedResults(taskId, payload);
      await this.tasks.update(taskId, { status: "failed", error: "执行中断；请重新预览未完成项。", result: this.taskResult(payload, items), finishedAt: new Date(this.now()).toISOString() }).catch(() => {});
    }
  }
  private interruptedResults(taskId: string, payload: BulkPayload): BulkResult[] {
    const persisted = new Map(this.resultRows(taskId).map(item => [item.id, item]));
    return payload.targets.map(target => {
      const existing = persisted.get(target.id);
      if (existing) return existing;
      const item: BulkResult = { id: target.id, groupId: target.groupId, label: target.label, status: "skipped", error: "interrupted" };
      this.saveResult(taskId, item);
      return item;
    });
  }
  private saveResult(taskId: string, item: BulkResult): void { this.db.db.prepare("INSERT OR REPLACE INTO admin_bulk_results(task_id,target_id,result_json) VALUES(?,?,?)").run(taskId, item.id, JSON.stringify(item)); }
  private resultRows(taskId: string): BulkResult[] { return (this.db.db.prepare("SELECT result_json FROM admin_bulk_results WHERE task_id=? ORDER BY rowid").all(taskId) as { result_json: string }[]).map(row => JSON.parse(row.result_json)); }
  private taskResult(payload: BulkPayload, items: BulkResult[]) { return { resource: payload.resource, action: payload.action, targets: payload.targets.map(t => ({ id: t.id, groupId: t.groupId, label: t.label })), items, counts: { succeeded: items.filter(i => i.status === "succeeded").length, failed: items.filter(i => i.status === "failed").length, skipped: items.filter(i => i.status === "skipped").length } }; }
  async cancel(taskId: string, operatorId: string, superAdmin: boolean): Promise<void> {
    const task = await this.tasks.get(taskId); if (!task || (!superAdmin && task.operatorUserId !== operatorId)) throw new BulkError("forbidden", 403);
    const run = this.db.db.prepare("SELECT status FROM admin_bulk_runs WHERE task_id=?").get(taskId) as { status: string } | undefined;
    if (!run) throw new BulkError("not_a_bulk_task");
    this.db.db.prepare("UPDATE admin_bulk_runs SET cancel_requested=1 WHERE task_id=? AND status IN ('queued','running')").run(taskId);
  }
}
