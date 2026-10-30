export type PersonalReminderParse = { dueAt: string; topic: string } | { question: string };
const BEIJING_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
export function beijingTime(value: string | Date): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

/** Pure, bounded grammar: no model inference and no silently guessed date. */
export function parsePersonalReminder(input: string, now = new Date()): PersonalReminderParse {
  let text = input.normalize("NFKC").trim().replace(/^#提醒\s*/u, "");
  text = text.replace(/^(?:请|帮我|请帮我)\s*/u, "");
  // Both "明天9点提醒我开会" and "提醒我 明天9点 开会" are explicit requests.
  text = text.replace(/^(?:设置)?提醒(?:我)?\s*/u, "");
  const relative = /^(\d{1,6})\s*(分钟|小时|天)后/u.exec(text);
  let due: number | undefined;
  let rest = text;
  if (relative) {
    const amount = Number(relative[1]);
    if (amount < 1) return { question: "需要多久后提醒？例如 #提醒 10分钟后 喝水。" };
    due = now.getTime() + amount * ({ 分钟: 60_000, 小时: 3_600_000, 天: DAY } as const)[relative[2] as "分钟"];
    rest = text.slice(relative[0].length);
  } else {
    const localNow = new Date(now.getTime() + BEIJING_OFFSET);
    let year = localNow.getUTCFullYear(), month = localNow.getUTCMonth(), day = localNow.getUTCDate();
    let dateKnown = false;
    const absolute = /^(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日|号)?\s*/u.exec(text);
    const relativeDay = /^(今天|明天|后天)\s*/u.exec(text);
    const week = /^(本周|这周|下周)([一二三四五六日天])\s*/u.exec(text);
    if (absolute) {
      year = Number(absolute[1]); month = Number(absolute[2]) - 1; day = Number(absolute[3]); rest = text.slice(absolute[0].length); dateKnown = true;
    } else if (relativeDay) {
      const target = new Date(Date.UTC(year, month, day) + ["今天", "明天", "后天"].indexOf(relativeDay[1]!) * DAY);
      year = target.getUTCFullYear(); month = target.getUTCMonth(); day = target.getUTCDate();
      rest = text.slice(relativeDay[0].length); dateKnown = true;
    } else if (week) {
      const targetDay = "一二三四五六日".indexOf(week[2] === "天" ? "日" : week[2]!);
      const mondayOffset = (localNow.getUTCDay() + 6) % 7;
      const target = new Date(Date.UTC(year, month, day) + (targetDay - mondayOffset + (week[1] === "下周" ? 7 : 0)) * DAY);
      year = target.getUTCFullYear(); month = target.getUTCMonth(); day = target.getUTCDate();
      rest = text.slice(week[0].length); dateKnown = true;
    }
    if (!dateKnown) return { question: "需要哪一天、几点提醒？请用 #提醒 明天9点 开会，或 #提醒 10分钟后 喝水。" };
    const clock = /^(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分?|半)?|时(?:(\d{1,2})分?)?)\s*/u.exec(rest);
    if (!clock) return { question: "这一天具体几点提醒？请补全，例如 #提醒 明天下午3点 开会。" };
    let hour = Number(clock[2]);
    const minute = clock[0].includes("半") ? 30 : Number(clock[3] ?? clock[4] ?? clock[5] ?? 0);
    if (["下午", "晚上"].includes(clock[1] ?? "") && hour < 12) hour += 12;
    if (clock[1] === "中午" && hour < 11) hour += 12;
    if (hour > 23 || minute > 59 || month < 0 || month > 11 || day < 1 || day > 31) return { question: "时间无效，请给出完整的北京时间，例如 #提醒 2026-11-02 15:30 开会。" };
    const local = new Date(Date.UTC(year, month, day, hour, minute));
    if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day) return { question: "这一天不存在，请检查日期。" };
    due = local.getTime() - BEIJING_OFFSET; rest = rest.slice(clock[0].length);
  }
  const topic = rest.replace(/^[\s,，:：]*(?:提醒(?:我)?|叫我)?[\s,，:：]*/u, "").trim();
  if (!topic) return { question: "到时要提醒你什么？例如 #提醒 明天9点 开会。" };
  if ([...topic].length > 300) return { question: "提醒内容请控制在 300 个字以内。" };
  if (!Number.isFinite(due) || due <= now.getTime()) return { question: "这个时间已经过去，请给出将来的日期和时间。" };
  if (due - now.getTime() > 366 * DAY) return { question: "一次性提醒最多可提前 366 天设置。" };
  return { dueAt: new Date(due).toISOString(), topic };
}
