import { randomUUID, createHash } from "node:crypto";
import type { ScheduledReminderTask } from "../types.js";
import { containsSensitiveCredential } from "./explicit-memory-service.js";
import { beijingTime } from "./personal-reminder-parser.js";
import { PersonalReminderService } from "./personal-reminder-service.js";
import { parseReminderDraft, type ReminderFields } from "./reminder-draft.js";
import type { V3StateRepository } from "./v3-state-repository.js";
import type { SharedDb, OutboxRow } from "../shared/sqlite.js";
interface Draft {
    token: string;
    groupId: string;
    userId: string;
    fields: ReminderFields;
    expiresAt: number;
    taskId?: string;
}
export interface ReminderInteractionInput {
    groupId: string;
    userId: string;
    messageId: string;
    text: string;
    explicit: boolean;
    hasAtBot: boolean;
    replyTo?: string;
    receivedAt: number;
}
interface Anchor {
    taskId?: string;
    draftToken?: string;
    userId?: string;
    notice?: boolean;
}
const TYPE = "reminder-draft";
function onlyTime(input: ReminderInteractionInput): boolean {
    const { fields } = parseReminderDraft(input.text, input.receivedAt);
    return Boolean((fields.date || fields.clock || fields.dueAt) && !fields.topic);
}
export function validateReminderControl(db: SharedDb, row: Pick<OutboxRow, "group_id" | "text" | "created_at">, now = Date.now()): string {
    const notice = JSON.parse(row.text) as {
        text: string;
        userId: string;
        taskId?: string;
        draftToken?: string;
    };
    if (typeof notice.text !== "string" || notice.text.length > 1500 || !/^\d+$/.test(notice.userId))
        throw new Error("invalid_reminder_control");
    const saved = db.db.prepare("SELECT config_json FROM v3_groups WHERE group_id=?").get(row.group_id) as {
        config_json: string;
    } | undefined;
    const group = saved ? JSON.parse(saved.config_json) : undefined;
    if (!group?.interactionAssistanceEnabled || !group.personalRemindersEnabled || group.enabled === false || group.botMuted || group.blacklistedUserIds?.includes(notice.userId))
        throw new Error("reminder_control_disabled");
    if (notice.draftToken) {
        const saved = db.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type=? AND document_key=?").get(TYPE, `${row.group_id}:${notice.userId}`) as {
            document_json: string;
        } | undefined;
        const draft = saved ? JSON.parse(saved.document_json) as Draft : undefined;
        if (!draft || draft.token !== notice.draftToken || draft.expiresAt <= now || now - row.created_at > 30000)
            throw new Error("reminder_question_expired");
    }
    if (notice.taskId) {
        const saved = db.db.prepare("SELECT task_json FROM v3_scheduled_reminders WHERE id=? AND group_id=?").get(notice.taskId, row.group_id) as {
            task_json: string;
        } | undefined;
        const task = saved ? JSON.parse(saved.task_json) as ScheduledReminderTask : undefined;
        if (!task || task.kind !== "personal_reminder" || task.creatorUserId !== notice.userId)
            throw new Error("invalid_reminder_control");
    }
    return notice.text;
}
export class ReminderInteractionService {
    private readonly reminders: PersonalReminderService;
    constructor(private readonly repo: V3StateRepository) { this.reminders = new PersonalReminderService(repo); }
    receivedAt(groupId: string, userId: string, messageId: string, fallback: number): number {
        const row = this.repo.sharedDb.db.prepare("SELECT created_at FROM messages WHERE group_id=? AND user_id=? AND msg_id=? AND is_bot_msg=0 LIMIT 1").get(groupId, userId, messageId) as {
            created_at: number;
        } | undefined;
        return row?.created_at ?? fallback;
    }
    private draft(groupId: string, userId: string, now = Date.now()): Draft | undefined {
        const draft = this.repo.getDocument<Draft | null>(TYPE, `${groupId}:${userId}`, null);
        return draft && draft.expiresAt > now ? draft : undefined;
    }
    private anchor(groupId: string, replyTo?: string): Anchor | undefined {
        if (!replyTo)
            return;
        const row = this.repo.sharedDb.db.prepare("SELECT text,kind FROM outbox WHERE group_id=? AND platform_message_id=? AND status='sent' AND kind IN ('reminder_control','personal_reminder_notice') LIMIT 1").get(groupId, replyTo) as {
            text: string;
            kind: string;
        } | undefined;
        if (!row)
            return;
        try {
            const value = JSON.parse(row.text) as Anchor;
            return { ...value, notice: row.kind === "personal_reminder_notice" };
        }
        catch {
            return;
        }
    }
    canHandle(input: ReminderInteractionInput, now = Date.now()): boolean {
        if (input.explicit)
            return !/^(?:列表|我的|取消\s+\S)/u.test(input.text);
        if (input.text.startsWith("#"))
            return false;
        const anchor = this.anchor(input.groupId, input.replyTo), draft = this.draft(input.groupId, input.userId, now);
        if (input.replyTo && /^(?:取消这个|取消这条|取消|改到|改成|.*后再提醒)/u.test(input.text))
            return true;
        if (anchor?.draftToken)
            return true;
        if (anchor?.taskId && onlyTime(input))
            return true;
        if (input.hasAtBot && /(?:提醒我|叫我)/u.test(input.text))
            return true;
        return Boolean(draft && input.hasAtBot && !input.replyTo);
    }
    handle(input: ReminderInteractionInput, now = Date.now()): void {
        this.repo.runAtomically(() => {
            const group = this.repo.getGroup(input.groupId);
            if (!group?.interactionAssistanceEnabled || !group.personalRemindersEnabled || group.enabled === false || group.botMuted || group.blacklistedUserIds?.includes(input.userId))
                return;
            const key = createHash("sha256").update(JSON.stringify([input.groupId, input.userId, input.messageId])).digest("hex");
            if (this.repo.getDocument("reminder-interaction-result", key, null))
                return;
            const reply = (text: string, extra: Anchor = {}) => this.repo.sharedDb.enqueueOutbox(input.groupId, input.messageId, JSON.stringify({ text, userId: input.userId, ...extra }), "reminder_control");
            try {
                const anchor = this.anchor(input.groupId, input.replyTo), existing = this.draft(input.groupId, input.userId, now);
                let draft: Draft | undefined, fields: ReminderFields = {}, taskId: string | undefined;
                if (anchor?.draftToken) {
                    if (anchor.userId !== input.userId || !existing || anchor.draftToken !== existing.token)
                        throw new Error("draft_expired");
                    draft = existing;
                    fields = draft.fields;
                    taskId = draft.taskId;
                }
                else if (anchor?.taskId && (/^(?:取消这个|取消这条|取消|改到|改成|.*后再提醒)/u.test(input.text) || onlyTime(input))) {
                    const task = this.reminders.own(input.groupId, input.userId, anchor.taskId);
                    if (/^(?:取消这个|取消这条|取消)[。！!]?$/u.test(input.text)) {
                        this.reminders.cancelTask(input.groupId, input.userId, task.id);
                        reply("已取消这条个人提醒。", { taskId: task.id });
                        return;
                    }
                    if (/后再提醒(?:我)?[。！!]?$/u.test(input.text)) {
                        const delivered = task.personalOutboxId ? this.repo.sharedDb.db.prepare("SELECT status FROM outbox WHERE id=?").get(task.personalOutboxId) as {
                            status: string;
                        } | undefined : undefined;
                        if (!anchor.notice || delivered?.status !== "sent" || task.personalResult === "missed")
                            throw new Error("reminder_not_delivered");
                        fields = { topic: task.topic };
                    }
                    else {
                        const date = beijingTime(task.nextRunAt).split(" ")[0]!.replaceAll("/", "-");
                        fields = { date, topic: task.topic };
                        taskId = task.id;
                    }
                }
                else if (input.replyTo && /^(?:取消这个|取消这条|取消|改到|改成|.*后再提醒)/u.test(input.text))
                    throw new Error("invalid_reminder_quote");
                else if (!input.explicit && existing && !input.replyTo) {
                    const imagePending = this.repo.sharedDb.db.prepare("SELECT 1 FROM image_pending_requests p JOIN messages m ON m.id=p.source_row_id WHERE m.group_id=? AND m.user_id=? AND p.status='waiting' AND p.expires_at>? LIMIT 1").get(input.groupId, input.userId, now);
                    if (imagePending) {
                        reply("你还有图片和提醒两项待补充，请引用对应的追问回复。已经填写的提醒信息会保留两分钟。");
                        return;
                    }
                    draft = existing;
                    fields = draft.fields;
                    taskId = draft.taskId;
                }
                if (/^(?:取消|算了|不用了)[。！!]?$/u.test(input.text) && draft) {
                    this.repo.deleteDocument(TYPE, `${input.groupId}:${input.userId}`);
                    reply("已取消这次提醒填写。");
                    return;
                }
                const text = input.text.replace(/^(?:改到|改成)\s*/u, "");
                const parsed = parseReminderDraft(text, input.receivedAt, fields);
                if (parsed.fields.topic && containsSensitiveCredential(parsed.fields.topic))
                    throw new Error("invalid_content");
                if (parsed.complete) {
                    let task: ScheduledReminderTask;
                    if (taskId)
                        task = this.reminders.changeTime(input.groupId, input.userId, taskId, parsed.complete.dueAt, now);
                    else {
                        task = this.reminders.create(input.groupId, input.userId, parsed.complete.dueAt, parsed.complete.topic, now, input.messageId);
                        if (anchor?.notice && anchor.taskId) {
                            task = { ...task, parentReminderId: anchor.taskId };
                            this.repo.saveScheduledReminder(task);
                        }
                    }
                    const outboxId = reply(`已${taskId ? "修改" : "设置"}一次性提醒：${beijingTime(task.nextRunAt)}（北京时间）\n${task.topic}\n可以引用这条消息说“取消这个”或“改到明天九点”。`, { taskId: task.id });
                    this.repo.saveScheduledReminder({ ...task, confirmationOutboxId: outboxId });
                    this.repo.deleteDocument(TYPE, `${input.groupId}:${input.userId}`);
                }
                else {
                    const next: Draft = { token: randomUUID(), groupId: input.groupId, userId: input.userId, fields: parsed.fields, expiresAt: now + 120000, ...(taskId ? { taskId } : {}) };
                    this.repo.saveDocument(TYPE, `${input.groupId}:${input.userId}`, next, now);
                    reply(parsed.question + "（两分钟内有效）", { draftToken: next.token });
                }
            }
            catch (error) {
                const code = (error as Error).message;
                const messages: Record<string, string> = { draft_expired: "这条补充提示已过期或不属于你，请重新发起提醒。", reminder_not_owned: "只能操作你本人在本群的提醒。", invalid_reminder_quote: "请引用我真实发送的提醒确认或提醒通知。", reminder_already_sent: "这条提醒已经送达，无法取消或修改；可以引用提醒通知说“十分钟后再提醒”。", reminder_delivery_unconfirmed: "这条提醒正在发送或结果未确认，暂时不能修改或取消。", reminder_already_settled: "这条提醒已经结束，请重新设置。", reminder_not_delivered: "只有已经送达的提醒通知可以“稍后再提醒”。", reminder_limit: "提醒数量已到上限：每人五条、每群五十条。", invalid_time: "这个时间无效或已经过去，请补充将来的时间。", invalid_content: "提醒内容需要在三百字以内，不能包含密码或密钥。" };
                reply(messages[code] ?? "这次提醒操作没有完成，请稍后再试。");
            }
            finally {
                this.repo.saveDocument("reminder-interaction-result", key, { at: now }, now);
            }
        });
    }
    cleanup(now = Date.now()): void {
        this.repo.sharedDb.db.prepare("DELETE FROM v3_state_documents WHERE (document_type=? AND json_extract(document_json,'$.expiresAt')<=?) OR (document_type='reminder-interaction-result' AND updated_at<?)").run(TYPE, now, now - 7 * 86400000);
    }
}
