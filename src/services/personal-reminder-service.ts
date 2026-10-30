import { createHash, randomUUID } from "node:crypto";
import type { ScheduledReminderTask } from "../types.js";
import { containsSensitiveCredential } from "./explicit-memory-service.js";
import { beijingTime } from "./personal-reminder-parser.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export function personalReminderNotice(task: ScheduledReminderTask, now: number): { text: string; missed: boolean } {
  const delay = now - Date.parse(task.nextRunAt), missed = delay > 300_000;
  return { missed, text: missed
    ? `【个人提醒】${task.creatorUserId} 的提醒 ${task.id.slice(9,17)} 已错过超过五分钟，未补发。计划：${beijingTime(task.nextRunAt)}（北京时间）`
    : `【个人提醒】@${task.creatorUserId} ${task.topic}${delay >= 60_000 ? "（延迟送达）" : ""}\n计划：${beijingTime(task.nextRunAt)}（北京时间）｜${task.id.slice(9,17)}` };
}

export class PersonalReminderService {
  constructor(private readonly repo: V3StateRepository) {}

  create(groupId: string, userId: string, dueAt: string, topic: string, now = Date.now(), sourceMessageId?: string): ScheduledReminderTask {
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due) || due <= now || due - now > 366 * 86_400_000) throw new Error("invalid_time");
    const content = topic.trim();
    if (!content || [...content].length > 300 || containsSensitiveCredential(content)) throw new Error("invalid_content");
    return this.repo.runAtomically(() => {
      this.checkAccess(groupId, userId);
      const id = `personal-${sourceMessageId ? createHash("sha256").update(JSON.stringify([groupId,userId,sourceMessageId])).digest("hex").slice(0,32) : randomUUID()}`;
      const previous = this.repo.getScheduledReminder(id);
      if (previous) return previous;
      const active = this.repo.listScheduledReminders(groupId, false).filter(t => t.kind === "personal_reminder");
      if (active.length >= 50 || active.filter(t => t.creatorUserId === userId).length >= 5) throw new Error("reminder_limit");
      const task: ScheduledReminderTask = { id, kind: "personal_reminder", groupId, creatorUserId: userId,
        timezone: "Asia/Shanghai", intervalMinutes: 0, topic: content, createdAt: new Date(now).toISOString(), nextRunAt: dueAt, enabled: true, recentMessages: [], personalRevision: 1 };
      this.repo.saveScheduledReminder(task);
      return task;
    });
  }
  list(groupId: string, userId: string): ScheduledReminderTask[] {
    this.checkAccess(groupId, userId);
    return this.repo.listScheduledReminders(groupId, false).filter(t => t.kind === "personal_reminder" && t.creatorUserId === userId).sort((a,b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }
  cancel(groupId: string, userId: string, selector: string): boolean {
    return this.repo.runAtomically(() => {
      this.checkAccess(groupId,userId);
      const tasks = this.repo.listScheduledReminders(groupId,true).filter(t => t.kind === "personal_reminder" && t.creatorUserId === userId && (t.id === selector || t.id.slice(9).startsWith(selector)));
      if (selector.length < 8 || tasks.length !== 1) return false;
      this.cancelTask(groupId,userId,tasks[0]!.id);
      return true;
    });
  }
  own(groupId: string, userId: string, id: string): ScheduledReminderTask {
    this.checkAccess(groupId,userId);
    const task=this.repo.getScheduledReminder(id);
    if (!task || task.groupId!==groupId || task.creatorUserId!==userId || task.kind!=="personal_reminder") throw new Error("reminder_not_owned");
    return task;
  }
  private releasePending(task: ScheduledReminderTask): void {
    if (task.personalOutboxId) {
      const row=this.repo.sharedDb.db.prepare("SELECT status FROM outbox WHERE id=? AND group_id=?").get(task.personalOutboxId,task.groupId) as {status:string}|undefined;
      if (row?.status === "sent") throw new Error("reminder_already_sent");
      if (row && row.status !== "pending" && row.status !== "cancelled") throw new Error("reminder_delivery_unconfirmed");
      if (row?.status === "pending") this.repo.sharedDb.db.prepare("UPDATE outbox SET status='cancelled',retry_after=NULL,updated_at=? WHERE id=? AND status='pending'").run(Date.now(),task.personalOutboxId);
    } else if (!task.enabled) throw new Error("reminder_already_settled");
  }
  cancelTask(groupId: string,userId: string,id: string): ScheduledReminderTask {
    return this.repo.runAtomically(()=>{
      const task=this.own(groupId,userId,id);this.releasePending(task);
      const next={...task,enabled:false,personalResult:"cancelled" as const,personalRevision:(task.personalRevision??0)+1};
      this.repo.saveScheduledReminder(next);return next;
    });
  }
  changeTime(groupId: string,userId: string,id: string,dueAt: string,now=Date.now()): ScheduledReminderTask {
    if (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt)<=now || Date.parse(dueAt)-now>366*86_400_000) throw new Error("invalid_time");
    return this.repo.runAtomically(()=>{
      const task=this.own(groupId,userId,id);
      if (!task.enabled) { const active=this.list(groupId,userId);const all=this.repo.listScheduledReminders(groupId,false).filter(t=>t.kind==="personal_reminder");if(active.length>=5||all.length>=50)throw new Error("reminder_limit"); }
      this.releasePending(task);
      const next={...task,nextRunAt:dueAt,enabled:true,personalOutboxId:undefined,personalResult:undefined,personalRevision:(task.personalRevision??0)+1};
      this.repo.saveScheduledReminder(next);return next;
    });
  }
  /** Claim, terminal state and outbox are committed together: crashes cannot replay a reminder. */
  tick(now = new Date()): void {
    this.repo.runAtomically(() => {
      const rows = this.repo.sharedDb.db.prepare("SELECT task_json FROM v3_scheduled_reminders WHERE enabled=1 AND next_run_at<=? AND json_extract(task_json,'$.kind')='personal_reminder'").all(now.getTime()) as Array<{task_json:string}>;
      for (const row of rows) {
        const task = JSON.parse(row.task_json) as ScheduledReminderTask;
        try { this.checkAccess(task.groupId, task.creatorUserId); }
        catch { this.repo.saveScheduledReminder({ ...task, enabled: false, personalResult: "skipped" }); continue; }
        const { text, missed } = personalReminderNotice(task, now.getTime());
        const outboxId = this.repo.sharedDb.enqueueOutbox(task.groupId, null, JSON.stringify({ taskId: task.id, text }), "personal_reminder_notice");
        this.repo.saveScheduledReminder({ ...task, enabled: false, personalResult: missed ? "missed" : "queued", personalOutboxId: outboxId });
      }
    });
  }
  private checkAccess(groupId: string, userId: string): void {
    const group = this.repo.getGroup(groupId);
    if (!group || group.enabled === false || group.personalRemindersEnabled !== true || group.botMuted || group.blacklistedUserIds?.includes(userId)) throw new Error("reminder_unavailable");
  }
}
