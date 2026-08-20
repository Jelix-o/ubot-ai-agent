import type { SkillDefinition } from "../types.js";
import type { ReplyFormatBudget } from "./reply-format.js";

const EXPLICIT_LONG_DEFAULT_MAX_CHARS = 500;
const EXPLICIT_LONG_DEFAULT_MAX_TOTAL_CHARS = 3_000;
const EXPLICIT_LONG_DEFAULT_MAX_MESSAGES = 8;
const MAX_CONFIGURED_CHARS_PER_MESSAGE = 4_000;
const MAX_CONFIGURED_TOTAL_CHARS = 8_000;
const MAX_CONFIGURED_MESSAGES = 20;

const NUMERIC_LENGTH_PATTERN = /([0-9０-９]{1,6}|[零〇一二两三四五六七八九十百千万]{1,12})\s*(?:个)?(?:字|字符)/u;
const LONG_FORM_PATTERN = /(?:长文|长篇|写完整|完整写完|直接写完发出来|展开写|详细写|越详细越好|一次写完)/u;
const CONTINUATION_PATTERN = /^(?:发|继续|接着写|往下写|写完|没写完|还没写完|直接写|直接写完|直接写完发出来|你到底写不写|写完了吗)[了啊呀吧呢？?!！。\s]*$/u;

export type ReplyLengthIntentKind = "target" | "minimum" | "maximum" | "long-form";

export interface ReplyLengthIntent {
  kind: ReplyLengthIntentKind;
  requestedChars?: number;
  inherited: boolean;
  priorAssistantChars: number;
  sourceText: string;
}

export interface ReplyLengthHistoryTurn {
  role: "user" | "assistant";
  content: string;
  userId?: string;
}

export interface ExplicitReplyLengthPlan {
  intent: ReplyLengthIntent;
  budget: ReplyFormatBudget;
  targetChars?: number;
}

export function parseReplyLengthIntent(text: string): ReplyLengthIntent | undefined {
  const normalized = normalizeText(text);
  const match = normalized.match(NUMERIC_LENGTH_PATTERN);
  if (match) {
    const requestedChars = parseLengthNumber(match[1] ?? "");
    if (requestedChars && requestedChars > 0) {
      const before = normalized.slice(0, match.index ?? 0);
      const after = normalized.slice((match.index ?? 0) + match[0].length);
      const nearby = `${before.slice(-12)}${after.slice(0, 8)}`;
      const kind: ReplyLengthIntentKind = /(?:最多|至多|不超过|不多于|以内|之内)/u.test(nearby)
        ? "maximum"
        : /(?:至少|起码|最低|不少于|不低于|写满|写够)/u.test(nearby)
          ? "minimum"
          : "target";
      return {
        kind,
        requestedChars,
        inherited: false,
        priorAssistantChars: 0,
        sourceText: normalized,
      };
    }
  }

  if (LONG_FORM_PATTERN.test(normalized)) {
    return {
      kind: "long-form",
      inherited: false,
      priorAssistantChars: 0,
      sourceText: normalized,
    };
  }
  return undefined;
}

export function resolveReplyLengthIntent(
  currentText: string,
  history: readonly ReplyLengthHistoryTurn[],
  currentUserId: string,
): ReplyLengthIntent | undefined {
  const currentNumericIntent = parseNumericReplyLengthIntent(currentText);
  if (currentNumericIntent) {
    return currentNumericIntent;
  }

  if (isContinuationRequest(currentText)) {
    const inherited = findInheritedIntent(history, currentUserId);
    if (inherited) {
      return inherited;
    }
  }

  return parseReplyLengthIntent(currentText);
}

export function buildExplicitReplyLengthPlan(
  skill: SkillDefinition,
  intent: ReplyLengthIntent,
): ExplicitReplyLengthPlan | undefined {
  const maxChars = clampInteger(
    skill.maxReplyCharsPerMessage,
    EXPLICIT_LONG_DEFAULT_MAX_CHARS,
    20,
    MAX_CONFIGURED_CHARS_PER_MESSAGE,
  );
  const configuredTotal = clampInteger(
    skill.maxTotalReplyChars,
    EXPLICIT_LONG_DEFAULT_MAX_TOTAL_CHARS,
    20,
    MAX_CONFIGURED_TOTAL_CHARS,
  );
  const maxMessages = clampInteger(
    skill.maxReplyMessages,
    EXPLICIT_LONG_DEFAULT_MAX_MESSAGES,
    1,
    MAX_CONFIGURED_MESSAGES,
  );
  const configuredCapacity = Math.min(configuredTotal, maxChars * maxMessages);
  const requested = intent.requestedChars;
  const requestedWithinCapacity = requested === undefined
    ? configuredCapacity
    : Math.min(requested, configuredCapacity);
  const remainingTarget = intent.inherited && intent.kind !== "maximum"
    ? requestedWithinCapacity - intent.priorAssistantChars
    : requestedWithinCapacity;

  if (remainingTarget <= 0 && intent.kind !== "maximum") {
    return undefined;
  }

  const maxTotalChars = intent.kind === "maximum"
    ? requestedWithinCapacity
    : Math.max(20, remainingTarget);
  return {
    intent,
    budget: {
      maxChars: Math.min(maxChars, maxTotalChars),
      maxTotalChars,
      maxMessages,
      preferredMaxMessages: maxMessages,
    },
    ...(intent.kind === "maximum" ? {} : { targetChars: maxTotalChars }),
  };
}

export function buildExplicitReplyLengthInstruction(plan: ExplicitReplyLengthPlan): string {
  const { intent, budget, targetChars } = plan;
  const requestedLabel = intent.requestedChars
    ? `用户要求的篇幅是 ${intent.requestedChars} 字`
    : "用户明确要求输出长文";
  const targetLabel = intent.kind === "maximum"
    ? `本轮只把 ${budget.maxTotalChars} 字作为上限，不要求写满`
    : `本轮尽量输出接近 ${targetChars ?? budget.maxTotalChars} 字的完整正文`;
  const continuationLabel = intent.inherited
    ? `这是对同一长文任务的继续要求；此前已回复约 ${intent.priorAssistantChars} 字，请直接续完剩余正文，不要重新征求确认`
    : "这是当前轮的明确长度要求";

  return [
    "本轮启用显式长文本模式，此规则覆盖默认的短回复偏好。",
    requestedLabel + "；" + targetLabel + "。",
    continuationLabel + "。",
    `必须在这一次回复里直接输出正文；不得只给提纲、预告、承诺，不得要求用户再回复“发”或“继续”。`,
    `输出会由系统自动拆成 QQ 消息：每条最多 ${budget.maxChars} 字，总正文最多 ${budget.maxTotalChars} 字，最多 ${budget.maxMessages} 条。不要自行添加“第一段发送完毕”等传输说明。`,
  ].join("\n");
}

function parseNumericReplyLengthIntent(text: string): ReplyLengthIntent | undefined {
  const parsed = parseReplyLengthIntent(text);
  return parsed?.requestedChars !== undefined ? parsed : undefined;
}

function findInheritedIntent(
  history: readonly ReplyLengthHistoryTurn[],
  currentUserId: string,
): ReplyLengthIntent | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn || turn.role !== "user" || turn.userId !== currentUserId) {
      continue;
    }
    const parsed = parseReplyLengthIntent(turn.content);
    if (parsed) {
      let priorAssistantChars = 0;
      let lastUserId = currentUserId;
      for (const item of history.slice(index + 1)) {
        if (item.role === "user") {
          lastUserId = item.userId ?? "";
        } else if (lastUserId === currentUserId) {
          priorAssistantChars += item.content.length;
        }
      }
      return {
        ...parsed,
        inherited: true,
        priorAssistantChars,
      };
    }
    if (!isContinuationRequest(turn.content)) {
      break;
    }
  }
  return undefined;
}

function isContinuationRequest(text: string): boolean {
  return CONTINUATION_PATTERN.test(normalizeText(text));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseLengthNumber(value: string): number | undefined {
  const ascii = value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(ascii)) {
    const parsed = Number(ascii);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return parseChineseInteger(ascii);
}

function parseChineseInteger(value: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
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
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000, 万: 10_000 };
  let section = 0;
  let total = 0;
  let number = 0;
  let sawValue = false;
  for (const char of value) {
    if (Object.hasOwn(digits, char)) {
      number = digits[char]!;
      sawValue = true;
      continue;
    }
    const unit = units[char];
    if (!unit) return undefined;
    sawValue = true;
    if (unit === 10_000) {
      section += number;
      total += (section || 1) * unit;
      section = 0;
      number = 0;
    } else {
      section += (number || 1) * unit;
      number = 0;
    }
  }
  const result = total + section + number;
  return sawValue && result > 0 ? result : undefined;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}
