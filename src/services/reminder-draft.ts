import { parsePersonalReminder } from "./personal-reminder-parser.js";
export interface ReminderFields {
    date?: string;
    clock?: string;
    dueAt?: string;
    topic?: string;
}
export interface ReminderDraftParse {
    fields: ReminderFields;
    question?: string;
    complete?: {
        dueAt: string;
        topic: string;
    };
}
const NUM = "[零〇一二两三四五六七八九十百0-9]+";
function number(text: string): number {
    if (/^\d+$/.test(text))
        return Number(text);
    const digits = "零一二三四五六七八九";
    let total = 0, current = 0;
    for (const char of text.replace(/〇/g, "零").replace(/两/g, "二")) {
        if (char === "十" || char === "百") {
            total += (current || 1) * (char === "十" ? 10 : 100);
            current = 0;
        }
        else
            current = digits.indexOf(char);
    }
    return total + current;
}
function absoluteDate(value: string, receivedAt: number): string {
    const local = new Date(receivedAt + 8 * 3600000), base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    let offset = ["今天", "明天", "后天"].indexOf(value);
    const week = /^(本周|这周|下周)([一二三四五六日天])$/u.exec(value);
    if (week)
        offset = "一二三四五六日".indexOf(week[2] === "天" ? "日" : week[2]!) - (local.getUTCDay() + 6) % 7 + (week[1] === "下周" ? 7 : 0);
    return offset >= 0 || week ? new Date(base + offset * 86400000).toISOString().slice(0, 10) : value;
}
/** Convert temporal prefixes only; names and reminder content are left intact. */
export function normalizeReminderTime(input: string): string {
    let text = input.normalize("NFKC").trim();
    text = text.replace(new RegExp(`^(${NUM})个?半小时后`, "u"), (_, n: string) => `${number(n) * 60 + 30}分钟后`)
        .replace(/^半个?小时后/u, "30分钟后");
    text = text.replace(new RegExp(`^(${NUM})(分钟|小时|天)后`, "u"), (_, n: string, unit: string) => `${number(n)}${unit}后`);
    return text.replace(new RegExp(`^((?:(?:今天|明天|后天|(?:本周|这周|下周)[一二三四五六日天]|\\d{4}[-年/]\\d{1,2}[-月/]\\d{1,2}(?:日|号)?)\\s*)?(?:凌晨|早上|上午|中午|下午|晚上)?\\s*)(${NUM})(点|时)(?:(${NUM})(分)?)?`, "u"), (_, prefix: string, hour: string, unit: string, minute?: string, suffix?: string) => `${prefix}${number(hour)}${unit}${minute ? number(minute) + (suffix ?? "") : ""}`);
}
export function parseReminderDraft(input: string, receivedAt: number, previous: ReminderFields = {}): ReminderDraftParse {
    let text = input.trim().replace(/^#提醒\s*/u, "").replace(/^(?:请帮我|帮我|请)\s*/u, "")
        .replace(/^(?:设置)?提醒(?:我)?\s*/u, "");
    text = normalizeReminderTime(text);
    const fields = { ...previous };
    const relative = /^(\d+)\s*(分钟|小时|天)后\s*/u.exec(text);
    const date = /^(?:\d{4}[-年/]\d{1,2}[-月/]\d{1,2}(?:日|号)?|今天|明天|后天|(?:本周|这周|下周)[一二三四五六日天])\s*/u.exec(text);
    let rest = text;
    let question: string | undefined;
    if (relative) {
        delete fields.dueAt;
        const parsed = parsePersonalReminder(relative[0] + " 待补充", new Date(receivedAt));
        if ("question" in parsed)
            question = parsed.question;
        else
            fields.dueAt = parsed.dueAt;
        delete fields.date;
        delete fields.clock;
        rest = text.slice(relative[0].length);
    }
    else {
        if (date) {
            fields.date = absoluteDate(date[0].trim(), receivedAt);
            delete fields.dueAt;
            rest = text.slice(date[0].length);
        }
        const clock = /^(?:(?:凌晨|早上|上午|中午|下午|晚上)\s*)?\d{1,2}(?::\d{2}|点(?:(?:\d{1,2})分?|半)?|时(?:\d{1,2}分?)?)\s*/u.exec(rest);
        if (clock) {
            fields.clock = clock[0].trim();
            delete fields.dueAt;
            rest = rest.slice(clock[0].length);
        }
        if (fields.date && fields.clock) {
            const parsed = parsePersonalReminder(`${fields.date} ${fields.clock} 待补充`, new Date(receivedAt));
            if ("question" in parsed)
                question = parsed.question;
            else
                fields.dueAt = parsed.dueAt;
        }
    }
    const topic = rest.replace(/^[\s,，:：]*(?:再提醒(?:我)?|提醒(?:我)?|叫我)?[\s,，:：]*/u, "").trim();
    if (topic)
        fields.topic = topic;
    if (question)
        return { fields, question };
    if (!fields.dueAt)
        return { fields, question: fields.date ? "具体几点提醒？回复这条消息补充，例如“下午三点半”。" : "需要哪一天、几点提醒？回复这条消息补充，例如“明天下午三点”。" };
    if (Date.parse(fields.dueAt) <= receivedAt)
        return { fields, question: "这个时间已经过去，请补充将来的日期和时间。" };
    if (!fields.topic)
        return { fields, question: "到时要提醒你什么？回复这条消息补充内容即可。" };
    if ([...fields.topic].length > 300)
        return { fields, question: "提醒内容请控制在 300 个字以内。" };
    return { fields, complete: { dueAt: fields.dueAt, topic: fields.topic } };
}
