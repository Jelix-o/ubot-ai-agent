import { beijingClock } from "./beijing-calendar.js";

export interface ChatSummaryRequest {
  label: string;
  startMinute: number;
  endMinute: number;
  mode: "named_period" | "custom_range" | "recent" | "relative_window";
  recentMessageCount?: number;
  dayOffset?: number;
  startDayOffset?: number;
  endDayOffset?: number;
  relativeDurationMinutes?: number;
}

type DayContext = {
  dayOffset: number;
  labelPrefix: string;
};

type ParsedTerm = {
  dayOffset: number;
  minute: number;
};

type PeriodDefinition = {
  key: string;
  start: number;
  end: number;
  aliases: string[];
};

const SUMMARY_KEYWORDS = [
  "总结",
  "汇总",
  "概括",
  "归纳",
  "盘一下",
  "盘一盘",
  "分析",
  "分析下",
  "分析一下",
  "回顾",
  "回顾一下",
];
const RECENT_WINDOW_MESSAGE_COUNT = 60;

const PERIOD_DEFINITIONS: PeriodDefinition[] = [
  {
    key: "凌晨",
    start: 0,
    end: 5 * 60 + 59,
    aliases: ["凌晨"],
  },
  {
    key: "早上",
    start: 5 * 60,
    end: 9 * 60 + 59,
    aliases: ["早上", "早晨", "清晨"],
  },
  {
    key: "上午",
    start: 5 * 60,
    end: 11 * 60 + 59,
    aliases: ["上午", "一上午", "这一上午", "整个上午"],
  },
  {
    key: "中午",
    start: 12 * 60,
    end: 13 * 60 + 59,
    aliases: ["中午", "午休", "午休那会儿", "午休那会", "中午那会儿", "中午那会"],
  },
  {
    key: "下午",
    start: 14 * 60,
    end: 17 * 60 + 59,
    aliases: ["下午", "一下午", "这一下午", "整个下午"],
  },
  {
    key: "傍晚",
    start: 17 * 60,
    end: 18 * 60 + 59,
    aliases: ["傍晚"],
  },
  {
    key: "白天",
    start: 6 * 60,
    end: 17 * 60 + 59,
    aliases: ["白天"],
  },
  {
    key: "晚上",
    start: 18 * 60,
    end: 23 * 60 + 59,
    aliases: ["晚上", "晚间"],
  },
  {
    key: "夜里",
    start: 0,
    end: 2 * 60 + 59,
    aliases: ["夜里"],
  },
  {
    key: "深夜",
    start: 23 * 60,
    end: 23 * 60 + 59,
    aliases: ["深夜"],
  },
  {
    key: "下班后",
    start: 18 * 60,
    end: 23 * 60 + 59,
    aliases: ["下班后", "下班"],
  },
];

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const DAY_CONTEXT_PATTERNS: Array<{ pattern: RegExp; dayOffset: number; labelPrefix: string }> = [
  { pattern: /大前天/, dayOffset: -3, labelPrefix: "大前天" },
  { pattern: /前天/, dayOffset: -2, labelPrefix: "前天" },
  { pattern: /(昨天|昨日|昨儿个?|昨晚|昨夜)/, dayOffset: -1, labelPrefix: "昨天" },
  { pattern: /(今天|今日|今儿个?|今早|今晚|刚刚|刚才|现在|目前)/, dayOffset: 0, labelPrefix: "今天" },
];

const SUMMARY_SUFFIX_PATTERN =
  /(的?(聊天信息|聊天记录|群聊记录|群里记录|消息记录|消息|聊天)|都聊了啥|聊了啥|说了啥)$/;

export function parseChatSummaryRequest(
  input: string,
  now = new Date(),
): ChatSummaryRequest | null {
  let normalized = normalizeInput(input);
  // Only short read-only report aliases default to today; work reports do not.
  if (/^(?:(?:请|帮我|给我|麻烦)?(?:看(?:看|一下)?|查看|查(?:看|一下)?|发(?:一下|一份)?|来(?:一份|个)?|总结(?:一下)?)?\s*)?(?:(?:今天|今日|昨天|昨日)的?)?(?:本群|群聊|群里|聊天)?(?:的|实时)?(?:日报|每日总结|今日总结|群聊总结|聊天总结)[呢吧吗呀？?。！!]*$/u.test(normalized) ||
      /^(?:请|帮我)?(?:总结|汇总|回顾)(?:一下|下)?(?:本群|群聊|群里)(?:的)?(?:聊天|消息|记录)?[吧呢？?。！!]*$/u.test(normalized)) {
    normalized = `${/(昨天|昨日)/u.test(normalized) ? "昨天" : "今天"}群里聊天总结`;
  }
  if (/(?:画|绘制|生成|制作).*(?:图|画|海报)|(?:图|画|海报).*(?:画|绘制|生成|制作)/u.test(normalized)) return null;
  if (!normalized || !hasSummaryIntent(normalized)) {
    return null;
  }

  const defaultDayContext = parseDayContext(normalized);

  const relativeWindow = parseRelativeWindow(normalized);
  if (relativeWindow) {
    return relativeWindow;
  }

  const explicitRange = parseExplicitRange(normalized, defaultDayContext, now);
  if (explicitRange) {
    return explicitRange;
  }

  const singleSidedRange = parseSingleSidedRange(normalized, defaultDayContext);
  if (singleSidedRange) {
    return singleSidedRange;
  }

  const namedPeriod = parseNamedPeriod(normalized, defaultDayContext);
  if (namedPeriod) {
    return namedPeriod;
  }

  const wholeDay = parseWholeDayRequest(normalized, defaultDayContext);
  if (wholeDay) {
    return wholeDay;
  }

  if (/(上面|上边|上面的|刚刚上面|前面那段|前面那些)/.test(normalized)) {
    return {
      label: "上面",
      startMinute: 0,
      endMinute: clockMinute(now),
      mode: "recent",
      recentMessageCount: RECENT_WINDOW_MESSAGE_COUNT,
      dayOffset: 0,
      startDayOffset: 0,
      endDayOffset: 0,
    };
  }

  return null;
}

function normalizeInput(value: string): string {
  return value.replace(/：/g, ":").replace(/\s+/g, " ").trim();
}

function clockMinute(now: Date): number {
  const [hour, minute] = beijingClock(now).split(":").map(Number);
  return hour! * 60 + minute!;
}

function hasSummaryIntent(input: string): boolean {
  if (SUMMARY_KEYWORDS.some((keyword) => input.includes(keyword))) {
    return true;
  }

  return [
    /(群里|聊天|消息).*(聊了些?什么|都聊了些?什么|聊了啥|都聊了啥|说了什么|都说了什么|发生了什么)/,
    /(聊了些?什么|都聊了些?什么|聊了啥|都聊了啥|说了什么|都说了什么|发生了什么).*(群里|聊天|消息)/,
    /(上面|上边|前面那段|前面那些).*(聊了些?什么|都聊了些?什么|聊了啥|都聊了啥|说了什么|都说了什么)/,
    /(今天|昨天|昨儿个?|前天|大前天|上午|中午|下午|晚上|白天|今早|昨晚).*(聊了些?什么|都聊了些?什么|聊了啥|都聊了啥|说了什么|都说了什么)/,
  ].some((pattern) => pattern.test(input));
}

function parseRelativeWindow(input: string): ChatSummaryRequest | null {
  const matchedText =
    input.match(/(?:最近|近|过去)\s*半小时/)?.[0] ??
    input.match(/(?:最近|近|过去)\s*[零一二两三四五六七八九十\d]+\s*(?:个)?小时/)?.[0] ??
    input.match(/(?:最近|近|过去)\s*[零一二两三四五六七八九十\d]+\s*分钟/)?.[0] ??
    input.match(/(?:最近|近|过去)\s*[零一二两三四五六七八九十\d]+\s*天/)?.[0];

  if (!matchedText) {
    return null;
  }

  const durationMinutes = parseRelativeDurationMinutes(
    matchedText.replace(/^(最近|近|过去)\s*/, ""),
  );
  if (durationMinutes === null) {
    return null;
  }

  return {
    label: matchedText.replace(/\s+/g, ""),
    startMinute: 0,
    endMinute: 0,
    mode: "relative_window",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
    relativeDurationMinutes: durationMinutes,
  };
}

function parseExplicitRange(
  input: string,
  defaultDayContext: DayContext,
  now: Date,
): ChatSummaryRequest | null {
  const rangeMatch = input.match(
    /(?:从)?(.+?)\s*(?:到|至|~|～|-)\s*(.+?)(?:的?(?:聊天信息|聊天记录|群聊记录|群里记录|消息记录|消息|聊天)|都聊了啥|聊了啥|说了啥)?$/,
  );
  if (!rangeMatch) {
    return null;
  }

  const startTerm = parseBoundaryTerm(rangeMatch[1], "start", defaultDayContext, now);
  const endTerm = parseBoundaryTerm(rangeMatch[2], "end", defaultDayContext, now);
  if (!startTerm || !endTerm) {
    return null;
  }

  if (compareParsedTerm(startTerm, endTerm) > 0) {
    return null;
  }

  return {
    label: buildRangeLabel(startTerm, endTerm),
    startMinute: startTerm.minute,
    endMinute: endTerm.minute,
    mode: "custom_range",
    dayOffset: startTerm.dayOffset,
    startDayOffset: startTerm.dayOffset,
    endDayOffset: endTerm.dayOffset,
  };
}

function parseSingleSidedRange(
  input: string,
  defaultDayContext: DayContext,
): ChatSummaryRequest | null {
  const afterMatch = input.match(
    /(.+?)\s*(?:后|以后|之后)\s*(?:的?(?:聊天信息|聊天记录|消息记录|消息|聊天))?$/,
  );
  if (afterMatch) {
    const cleanedAfterTerm = cleanupBoundaryTerm(afterMatch[1]);
    if (/下班$/.test(cleanedAfterTerm)) {
      return null;
    }

    const startTerm = parseBoundaryTerm(cleanedAfterTerm, "start", defaultDayContext);
    if (!startTerm) {
      return null;
    }

    return {
      label: `${formatDayOffsetLabel(startTerm.dayOffset)}${formatMinute(startTerm.minute)}之后`,
      startMinute: startTerm.minute,
      endMinute: 23 * 60 + 59,
      mode: "custom_range",
      dayOffset: startTerm.dayOffset,
      startDayOffset: startTerm.dayOffset,
      endDayOffset: startTerm.dayOffset,
    };
  }

  const beforeMatch = input.match(
    /(.+?)\s*(?:前|以前|之前)\s*(?:的?(?:聊天信息|聊天记录|消息记录|消息|聊天))?$/,
  );
  if (beforeMatch) {
    const endTerm = parseBoundaryTerm(beforeMatch[1], "end", defaultDayContext);
    if (!endTerm) {
      return null;
    }

    return {
      label: `${formatDayOffsetLabel(endTerm.dayOffset)}${formatMinute(endTerm.minute)}之前`,
      startMinute: 0,
      endMinute: endTerm.minute,
      mode: "custom_range",
      dayOffset: endTerm.dayOffset,
      startDayOffset: endTerm.dayOffset,
      endDayOffset: endTerm.dayOffset,
    };
  }

  return null;
}

function parseNamedPeriod(input: string, defaultDayContext: DayContext): ChatSummaryRequest | null {
  const special = parseSpecialNamedPeriod(input);
  if (special) {
    return special;
  }

  const period = findPeriodDefinitionByContains(input);
  if (!period) {
    return null;
  }

  const label = `${defaultDayContext.labelPrefix}${period.key}`.trim() || period.key;
  return {
    label,
    startMinute: period.start,
    endMinute: period.end,
    mode: "named_period",
    dayOffset: defaultDayContext.dayOffset,
    startDayOffset: defaultDayContext.dayOffset,
    endDayOffset: defaultDayContext.dayOffset,
  };
}

function parseWholeDayRequest(
  input: string,
  defaultDayContext: DayContext,
): ChatSummaryRequest | null {
  if (!hasExplicitDayContext(input)) {
    return null;
  }

  const cleaned = cleanupBoundaryTerm(input);
  if (findPeriodDefinitionByContains(cleaned) || /(上面|上边|前面那段|前面那些)/.test(cleaned)) {
    return null;
  }

  if (!/(聊天|群聊|消息|群里|记录|聊了|说了|发生了)/.test(input)) {
    return null;
  }

  return {
    label: defaultDayContext.labelPrefix || formatDayOffsetLabel(defaultDayContext.dayOffset),
    startMinute: 0,
    endMinute: 23 * 60 + 59,
    mode: "custom_range",
    dayOffset: defaultDayContext.dayOffset,
    startDayOffset: defaultDayContext.dayOffset,
    endDayOffset: defaultDayContext.dayOffset,
  };
}

function parseSpecialNamedPeriod(input: string): ChatSummaryRequest | null {
  const mapping: Array<{
    pattern: RegExp;
    label: string;
    dayOffset: number;
    startMinute: number;
    endMinute: number;
  }> = [
    {
      pattern: /(昨晚|昨夜|昨天晚上)/,
      label: "昨晚",
      dayOffset: -1,
      startMinute: 18 * 60,
      endMinute: 23 * 60 + 59,
    },
    {
      pattern: /(今早|今天早上|今天早晨)/,
      label: "今早",
      dayOffset: 0,
      startMinute: 5 * 60,
      endMinute: 9 * 60 + 59,
    },
    {
      pattern: /(今晚|今天晚上)/,
      label: "今晚",
      dayOffset: 0,
      startMinute: 18 * 60,
      endMinute: 23 * 60 + 59,
    },
  ];

  const matched = mapping.find((item) => item.pattern.test(input));
  if (!matched) {
    return null;
  }

  return {
    label: matched.label,
    startMinute: matched.startMinute,
    endMinute: matched.endMinute,
    mode: "named_period",
    dayOffset: matched.dayOffset,
    startDayOffset: matched.dayOffset,
    endDayOffset: matched.dayOffset,
  };
}

function parseBoundaryTerm(
  raw: string,
  boundary: "start" | "end",
  defaultDayContext: DayContext,
  now?: Date,
): ParsedTerm | null {
  const term = cleanupBoundaryTerm(raw);
  if (!term) {
    return null;
  }

  if (now && /^(现在|这会儿|这会|到现在|到现在为止)$/.test(term)) {
    return {
      dayOffset: 0,
      minute: clockMinute(now),
    };
  }

  const specialBoundary = parseSpecialBoundaryTerm(term, boundary);
  if (specialBoundary) {
    return specialBoundary;
  }

  const parsedDay = parseDayContext(term);
  const dayOffset = hasExplicitDayContext(term) ? parsedDay.dayOffset : defaultDayContext.dayOffset;

  const periodWindow = parseDirectPeriodWindow(term);
  if (periodWindow) {
    return {
      dayOffset,
      minute: boundary === "start" ? periodWindow.start : periodWindow.end,
    };
  }

  const specificMinute = parseSpecificTime(term);
  if (specificMinute !== null) {
    return {
      dayOffset,
      minute: specificMinute,
    };
  }

  if (/^(今天|今日|今儿个?|昨天|昨日|昨儿个?|前天|大前天)$/.test(term)) {
    return {
      dayOffset,
      minute: boundary === "start" ? 0 : 23 * 60 + 59,
    };
  }

  return null;
}

function parseSpecialBoundaryTerm(
  term: string,
  boundary: "start" | "end",
): ParsedTerm | null {
  const mappings: Array<{
    pattern: RegExp;
    dayOffset: number;
    start: number;
    end: number;
  }> = [
    {
      pattern: /^(昨晚|昨夜|昨天晚上)$/,
      dayOffset: -1,
      start: 18 * 60,
      end: 23 * 60 + 59,
    },
    {
      pattern: /^(今早|今天早上|今天早晨)$/,
      dayOffset: 0,
      start: 5 * 60,
      end: 9 * 60 + 59,
    },
    {
      pattern: /^(今晚|今天晚上)$/,
      dayOffset: 0,
      start: 18 * 60,
      end: 23 * 60 + 59,
    },
  ];

  const matched = mappings.find((item) => item.pattern.test(term));
  if (!matched) {
    return null;
  }

  return {
    dayOffset: matched.dayOffset,
    minute: boundary === "start" ? matched.start : matched.end,
  };
}

function cleanupBoundaryTerm(value: string): string {
  return value
    .replace(
      /^(帮我)?(总结一下|总结一波|总结一哈|总结|汇总一下|汇总|概括一下|概括|归纳一下|归纳|盘一下|盘一盘)/,
      "",
    )
    .replace(/^(一下|一波|一哈)/, "")
    .replace(SUMMARY_SUFFIX_PATTERN, "")
    .trim();
}

function parseDayContext(input: string): DayContext {
  for (const item of DAY_CONTEXT_PATTERNS) {
    if (item.pattern.test(input)) {
      return {
        dayOffset: item.dayOffset,
        labelPrefix: item.labelPrefix,
      };
    }
  }

  return { dayOffset: 0, labelPrefix: "" };
}

function hasExplicitDayContext(input: string): boolean {
  return /(大前天|前天|昨天|昨日|昨儿个?|今天|今日|今儿个?)/.test(input);
}

function parseDirectPeriodWindow(value: string): { start: number; end: number } | null {
  const normalized = stripDayContextPrefix(value);

  for (const period of getSortedPeriods()) {
    if (period.aliases.some((alias) => normalized === alias || normalized.endsWith(alias))) {
      return { start: period.start, end: period.end };
    }
  }

  return null;
}

function parseSpecificTime(value: string): number | null {
  const normalized = stripDayContextPrefix(value);
  const periodPrefix = parsePeriodPrefix(normalized);
  const bare = normalized.replace(/^(凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|晚间)/, "");

  let matched = bare.match(/^(\d{1,2}):(\d{1,2})$/);
  if (matched) {
    return applyPeriodToHour(Number(matched[1]), Number(matched[2]), periodPrefix);
  }

  matched = bare.match(/^([零一二两三四五六七八九十\d]{1,3})点半$/);
  if (matched) {
    return applyPeriodToHour(parseChineseOrArabicNumber(matched[1]), 30, periodPrefix);
  }

  matched = bare.match(
    /^([零一二两三四五六七八九十\d]{1,3})[点时]([零一二两三四五六七八九十\d]{1,3})分?$/,
  );
  if (matched) {
    return applyPeriodToHour(
      parseChineseOrArabicNumber(matched[1]),
      parseChineseOrArabicNumber(matched[2]),
      periodPrefix,
    );
  }

  matched = bare.match(/^([零一二两三四五六七八九十\d]{1,3})[点时]$/);
  if (matched) {
    return applyPeriodToHour(parseChineseOrArabicNumber(matched[1]), 0, periodPrefix);
  }

  matched = bare.match(/^([零一二两三四五六七八九十\d]{1,3})$/);
  if (matched) {
    return applyPeriodToHour(parseChineseOrArabicNumber(matched[1]), 0, periodPrefix);
  }

  return null;
}

function parsePeriodPrefix(value: string): string {
  const matched = value.match(/^(凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|晚间)/);
  return matched?.[1] ?? "";
}

function applyPeriodToHour(hour: number | null, minute: number | null, prefix: string): number | null {
  if (hour === null || minute === null) {
    return null;
  }

  let normalizedHour = hour;

  if (prefix === "凌晨" && normalizedHour === 12) {
    normalizedHour = 0;
  } else if (["下午", "傍晚", "晚上", "晚间"].includes(prefix) && normalizedHour < 12) {
    normalizedHour += 12;
  } else if (prefix === "中午" && normalizedHour >= 1 && normalizedHour <= 7) {
    normalizedHour += 12;
  }

  return toMinute(normalizedHour, minute);
}

function parseChineseOrArabicNumber(value: string): number | null {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  if (normalized === "十") {
    return 10;
  }

  const tenIndex = normalized.indexOf("十");
  if (tenIndex >= 0) {
    const left = normalized.slice(0, tenIndex);
    const right = normalized.slice(tenIndex + 1);
    const leftValue = left ? CHINESE_DIGITS[left] : 1;
    const rightValue = right ? CHINESE_DIGITS[right] : 0;
    if (leftValue === undefined || rightValue === undefined) {
      return null;
    }
    return leftValue * 10 + rightValue;
  }

  return CHINESE_DIGITS[normalized] ?? null;
}

function parseRelativeDurationMinutes(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "半小时") {
    return 30;
  }

  const dayMatch = normalized.match(/^([零一二两三四五六七八九十\d]+)天$/);
  if (dayMatch) {
    const days = parseChineseOrArabicNumber(dayMatch[1]);
    return days === null ? null : days * 24 * 60;
  }

  const hourMatch = normalized.match(/^([零一二两三四五六七八九十\d]+)\s*(?:个)?小时$/);
  if (hourMatch) {
    const hours = parseChineseOrArabicNumber(hourMatch[1]);
    return hours === null ? null : hours * 60;
  }

  const minuteMatch = normalized.match(/^([零一二两三四五六七八九十\d]+)分钟$/);
  if (minuteMatch) {
    return parseChineseOrArabicNumber(minuteMatch[1]);
  }

  return null;
}

function findPeriodDefinitionByContains(value: string): PeriodDefinition | null {
  for (const period of getSortedPeriods()) {
    if (period.aliases.some((alias) => value.includes(alias))) {
      return period;
    }
  }
  return null;
}

function getSortedPeriods(): PeriodDefinition[] {
  return [...PERIOD_DEFINITIONS].sort(
    (left, right) => longestAliasLength(right) - longestAliasLength(left),
  );
}

function longestAliasLength(period: PeriodDefinition): number {
  return Math.max(...period.aliases.map((alias) => alias.length));
}

function stripDayContextPrefix(value: string): string {
  return value
    .replace(/^(大前天|前天|昨天|昨日|昨儿个?|今天|今日|今儿个?)/, "")
    .trim();
}

function compareParsedTerm(left: ParsedTerm, right: ParsedTerm): number {
  if (left.dayOffset !== right.dayOffset) {
    return left.dayOffset - right.dayOffset;
  }

  return left.minute - right.minute;
}

function buildRangeLabel(start: ParsedTerm, end: ParsedTerm): string {
  if (start.dayOffset === end.dayOffset) {
    return `${formatDayOffsetLabel(start.dayOffset)}${formatMinute(start.minute)}-${formatMinute(end.minute)}`;
  }

  return `${formatDayOffsetLabel(start.dayOffset)}${formatMinute(start.minute)}到${formatDayOffsetLabel(end.dayOffset)}${formatMinute(end.minute)}`;
}

function formatDayOffsetLabel(dayOffset: number): string {
  if (dayOffset === -3) {
    return "大前天";
  }
  if (dayOffset === -2) {
    return "前天";
  }
  if (dayOffset === -1) {
    return "昨天";
  }
  if (dayOffset === 0) {
    return "今天";
  }
  if (dayOffset === 1) {
    return "明天";
  }
  return "";
}

function toMinute(hour: number, minute: number): number | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}

function formatMinute(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${`${hour}`.padStart(2, "0")}:${`${minute}`.padStart(2, "0")}`;
}
