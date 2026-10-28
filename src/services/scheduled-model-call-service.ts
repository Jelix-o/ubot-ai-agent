import OpenAI from "openai";
import type { SharedDb } from "../shared/sqlite.js";
import type { GroupBotConfig, ScheduledReminderTask, ScheduledModelCallRun, SystemModelConfig } from "../types.js";
import type { SystemSettingsStore } from "./system-settings-store.js";
import { instrumentCompletions, withModelOperation } from "./model-telemetry.js";
import { nextModelCallAt } from "./model-call-schedule.js";

const RUN_TYPE = "scheduled-model-call-run";
type Run = ScheduledModelCallRun & { taskId: string; groupId: string; outboxId?: number; notificationSuppressed?: boolean };
type ModelCaller = (model: SystemModelConfig, groupId: string) => Promise<{ model: string }>;

export class ScheduledModelCallService {
  private running = false;
  constructor(
    private readonly shared: SharedDb,
    private readonly settings: Pick<SystemSettingsStore, "getInternal">,
    private readonly groups: { getGroup(id: string): Promise<GroupBotConfig | undefined> },
    private readonly call: ModelCaller = callScheduledModelOnce,
    private readonly providerAllowed: (protocol: string) => boolean = () => true,
  ) {}

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Never repeat a request whose outcome was lost when the worker stopped.
      for (const run of this.runs()) {
        if (run.status === "running" && now.getTime() - Date.parse(run.startedAt) >= 90_000) {
          this.finish(run, "unknown", "运行中断，结果未确认", now);
        }
      }
      await this.notifyPending();
      const rows = this.shared.db.prepare(
        "SELECT task_json FROM v3_scheduled_reminders WHERE enabled = 1 AND next_run_at <= ? AND json_extract(task_json, '$.kind') = 'model_call' ORDER BY next_run_at, id",
      ).all(now.getTime()) as Array<{ task_json: string }>;
      for (const row of rows) {
        const task = JSON.parse(row.task_json) as ScheduledReminderTask;
        const group = await this.groups.getGroup(task.groupId);
        if (!group || group.enabled === false || group.scheduledRemindersEnabled === false) {
          this.advance(task, now);
          continue;
        }
        const run = this.claim(task, now);
        if (!run) continue;
        if (now.getTime() - Date.parse(run.scheduledAt) > 120_000) {
          this.finish(run, "missed", "已错过计划时间，未补调用", now);
          continue;
        }
        try {
          const settings = await this.settings.getInternal();
          const model = settings.models.find(m => m.id === task.modelId && m.purpose === "reply" && m.enabled && m.apiKey?.trim());
          if (!model || model.apiProtocol === "anthropic" || !this.providerAllowed(model.apiProtocol ?? "openai")) {
            this.finish(run, "failed", "指定文本模型未启用或不可用", new Date());
            continue;
          }
          run.model = model.model;
          this.save(run);
          // Re-read controls after asynchronous settings lookup, immediately before submission.
          const current = this.task(task.id);
          const currentGroup = await this.groups.getGroup(task.groupId);
          if (!current?.enabled || !currentGroup || currentGroup.enabled === false || currentGroup.scheduledRemindersEnabled === false || current.modelId !== task.modelId) {
            run.notificationSuppressed = true;
            this.finish(run, "skipped", "任务已关闭或修改，未调用", new Date());
            continue;
          }
          const result = await this.call(model, task.groupId);
          run.model = result.model || model.model;
          this.finish(run, "succeeded", undefined, new Date());
        } catch (error) {
          const code = (error as { status?: number }).status;
          // No provider error bodies, URLs or credentials are included in QQ notifications.
          this.finish(run, code ? "failed" : "unknown", code ? `上游返回 HTTP ${code}` : "请求中断或超时，结果未确认", new Date());
        }
      }
      await this.notifyPending();
    } finally { this.running = false; }
  }

  private key(run: Pick<Run, "taskId" | "scheduledAt">): string { return `${run.taskId}:${run.scheduledAt}`; }
  private runs(): Run[] {
    return (this.shared.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type = ?").all(RUN_TYPE) as Array<{ document_json: string }>).map(r => JSON.parse(r.document_json) as Run);
  }
  private task(id: string): ScheduledReminderTask | undefined {
    const row = this.shared.db.prepare("SELECT task_json FROM v3_scheduled_reminders WHERE id = ?").get(id) as { task_json: string } | undefined;
    return row && JSON.parse(row.task_json) as ScheduledReminderTask;
  }
  private save(run: Run): void {
    this.shared.db.prepare("INSERT INTO v3_state_documents (document_type, document_key, document_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(document_type, document_key) DO UPDATE SET document_json=excluded.document_json, updated_at=excluded.updated_at")
      .run(RUN_TYPE, this.key(run), JSON.stringify(run), Date.now());
  }
  private transaction<T>(action: () => T): T {
    this.shared.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.shared.db.exec("COMMIT"); return result; }
    catch (error) { this.shared.db.exec("ROLLBACK"); throw error; }
  }
  private advance(task: ScheduledReminderTask, now: Date): void {
    const nextRunAt = nextModelCallAt(task.scheduledTime!, now);
    // Compare-and-swap preserves edits and disabled tasks made by the admin process.
    this.shared.db.prepare("UPDATE v3_scheduled_reminders SET task_json=json_set(task_json, '$.nextRunAt', ?), next_run_at=?, updated_at=? WHERE id=? AND next_run_at=?")
      .run(nextRunAt, Date.parse(nextRunAt), now.getTime(), task.id, Date.parse(task.nextRunAt));
  }
  private claim(task: ScheduledReminderTask, now: Date): Run | undefined {
    return this.transaction(() => {
      const current = this.task(task.id);
      if (!current?.enabled || current.nextRunAt !== task.nextRunAt || current.modelId !== task.modelId) return undefined;
      const run: Run = { taskId: task.id, groupId: task.groupId, scheduledAt: task.nextRunAt, startedAt: now.toISOString(), status: "running", modelId: task.modelId! };
      const exists = this.shared.db.prepare("SELECT 1 FROM v3_state_documents WHERE document_type=? AND document_key=?").get(RUN_TYPE, this.key(run));
      this.advance(task, now);
      if (exists) return undefined;
      this.save(run);
      this.shared.db.prepare("UPDATE v3_scheduled_reminders SET task_json=json_set(task_json, '$.lastRun', json(?)) WHERE id=?").run(JSON.stringify(run), task.id);
      return run;
    });
  }
  private finish(run: Run, status: Run["status"], detail: string | undefined, now: Date): void {
    run.status = status;
    run.finishedAt = now.toISOString();
    run.durationMs = Math.max(0, now.getTime() - Date.parse(run.startedAt));
    if (detail) run.detail = detail;
    this.transaction(() => {
      this.save(run);
      this.shared.db.prepare("UPDATE v3_scheduled_reminders SET task_json=json_set(task_json, '$.lastRun', json(?)), updated_at=? WHERE id=?")
        .run(JSON.stringify(run), now.getTime(), run.taskId);
    });
  }
  private async notifyPending(): Promise<void> {
    for (const run of this.runs().filter(r => r.status !== "running" && r.outboxId === undefined && !r.notificationSuppressed)) {
      const group = await this.groups.getGroup(run.groupId);
      const task = this.task(run.taskId);
      if (!task?.enabled || !group || group.enabled === false || group.scheduledRemindersEnabled === false) {
        run.notificationSuppressed = true;
        this.save(run);
        continue;
      }
      this.transaction(() => {
        const saved = this.shared.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type=? AND document_key=?").get(RUN_TYPE, this.key(run)) as { document_json: string };
        const latest = JSON.parse(saved.document_json) as Run;
        if (latest.outboxId !== undefined || latest.notificationSuppressed) return;
        latest.outboxId = this.shared.enqueueOutbox(run.groupId, null, modelCallNotification(run), "text");
        this.save(latest);
      });
    }
  }
}

export function modelCallNotification(run: ScheduledModelCallRun): string {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(run.scheduledAt));
  const status = ({ running: "执行中", succeeded: "成功", failed: "失败", unknown: "结果未确认", missed: "错过", skipped: "跳过" } as const)[run.status];
  return `【定时调用】${time}｜${run.modelId}${run.model ? ` / ${run.model}` : ""}｜${status}${run.status === "succeeded" ? `｜耗时 ${((run.durationMs ?? 0) / 1000).toFixed(1)} 秒` : run.detail ? `｜${run.detail}` : ""}`;
}

export async function callScheduledModelOnce(model: SystemModelConfig, groupId: string): Promise<{ model: string }> {
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey, timeout: 60_000, maxRetries: 0 });
  return withModelOperation("scheduled_call", groupId, async () => {
    const completion = await instrumentCompletions(client.chat.completions, model.model).create({
      model: model.model, messages: [{ role: "user", content: "仅回复 OK" }], max_completion_tokens: 128, stream: false,
    }, { signal: AbortSignal.timeout(60_000), maxRetries: 0 });
    if (!completion.id || !completion.choices?.length) throw Object.assign(new Error("invalid_model_response"), { status: 502 });
    return { model: completion.model || model.model };
  }, model.id);
}
