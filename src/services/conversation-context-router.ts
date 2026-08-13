import { logInfo, logWarn } from "../logger.js";
import {
  ConversationContextRepository,
  type ConversationRoute,
  type ConversationRouteReason,
  type SaveMessageRouteInput,
} from "./conversation-context-repository.js";

const DEFAULT_AUTO_CONTINUE_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_EXPLICIT_REPLY_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;
const MAX_FOLLOW_UP_CHARACTERS = 40;

const FOLLOW_UP_PREFIXES = [
  "那",
  "然后",
  "所以",
  "继续",
  "展开",
  "详细",
  "具体",
  "为什么",
  "怎么说",
  "不对",
  "更正",
  "其实",
  "还有",
  "另外",
  "补充",
] as const;

const KEYWORD_STOPWORDS = new Set([
  "一个",
  "一下",
  "不是",
  "为什么",
  "什么",
  "介绍",
  "他们",
  "你们",
  "具体",
  "分析",
  "可以",
  "告诉",
  "问题",
  "如何",
  "帮我",
  "怎么",
  "怎么说",
  "情况",
  "我们",
  "所以",
  "更正",
  "有没有",
  "然后",
  "看法",
  "看看",
  "知道",
  "继续",
  "能不能",
  "补充",
  "觉得",
  "详细",
  "请问",
  "说说",
  "这个",
  "还有",
  "那个",
  "那就",
  "展开",
  "另外",
]);

export interface ConversationContextRouterOptions {
  autoContinueWindowMs?: number;
  explicitReplyWindowMs?: number;
  similarityThreshold?: number;
}

export interface ConversationRouteInput {
  sourceRowId: number;
  groupId: string;
  userId: string;
  sourceMessageId: string;
  replyToMessageId?: string;
  text: string;
  hasImages?: boolean;
  nowMs?: number;
}

/**
 * Resolves every inbound message exactly once against the persisted causal
 * context. The repository remains the source of truth across processes and
 * restarts; this class only applies the routing policy.
 */
export class ConversationContextRouter {
  private readonly autoContinueWindowMs: number;
  private readonly explicitReplyWindowMs: number;
  private readonly similarityThreshold: number;

  constructor(
    private readonly repository: ConversationContextRepository,
    options: ConversationContextRouterOptions = {},
  ) {
    this.autoContinueWindowMs = positiveDuration(
      options.autoContinueWindowMs,
      DEFAULT_AUTO_CONTINUE_WINDOW_MS,
    );
    this.explicitReplyWindowMs = positiveDuration(
      options.explicitReplyWindowMs,
      DEFAULT_EXPLICIT_REPLY_WINDOW_MS,
    );
    this.similarityThreshold = normalizeThreshold(
      options.similarityThreshold,
      DEFAULT_SIMILARITY_THRESHOLD,
    );
  }

  resolve(input: ConversationRouteInput): ConversationRoute {
    const nowMs = input.nowMs ?? Date.now();
    try {
      const persisted = this.repository.getRouteBySourceRowId(input.sourceRowId);
      if (persisted) {
        this.logRoute(persisted, { duplicate: true });
        return persisted;
      }

      const replyToMessageId = input.replyToMessageId?.trim();
      if (replyToMessageId) {
        return this.resolveExplicitReply(input, replyToMessageId, nowMs);
      }
      return this.resolveUnquoted(input, nowMs);
    } catch (error) {
      logWarn("Conversation route resolution failed closed.", {
        groupId: input.groupId,
        sourceRowId: input.sourceRowId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      try {
        return this.save(input, nowMs, "fail-closed");
      } catch (persistenceError) {
        logWarn("Conversation fail-closed route could not be persisted.", {
          groupId: input.groupId,
          sourceRowId: input.sourceRowId,
          errorType: persistenceError instanceof Error ? persistenceError.name : typeof persistenceError,
        });
        return ephemeralFailClosedRoute(input);
      }
    }
  }

  private resolveExplicitReply(
    input: ConversationRouteInput,
    replyToMessageId: string,
    nowMs: number,
  ): ConversationRoute {
    const anchor = this.repository.getMessageContext(input.groupId, replyToMessageId);
    const anchorAgeMs = anchor ? nowMs - anchor.createdAt : undefined;
    const anchorState = anchor === undefined
      ? "miss"
      : anchor.turnId === undefined
        ? "invalid"
        : anchorAgeMs! < 0
          ? "future"
          : anchorAgeMs! > this.explicitReplyWindowMs
            ? "stale"
            : "hit";

    if (anchorState !== "hit" || !anchor || anchor.turnId === undefined) {
      const route = this.save(input, nowMs, "explicit-reply-miss", { replyToMessageId });
      this.logRoute(route, { anchorState, anchorAgeMs });
      return route;
    }

    const route = this.save(input, nowMs, "explicit-reply", {
      replyToMessageId,
      topicId: anchor.topicId,
      branchId: anchor.branchId,
      parentTurnId: anchor.turnId,
    });
    this.logRoute(route, { anchorState, anchorAgeMs });
    return route;
  }

  private resolveUnquoted(input: ConversationRouteInput, nowMs: number): ConversationRoute {
    const text = normalizeText(input.text);
    if (!text) {
      const route = this.save(input, nowMs, "new-topic");
      this.logRoute(route, {
        autoContinue: false,
        emptyText: true,
        pureImage: Boolean(input.hasImages),
      });
      return route;
    }

    const active = this.repository.getActiveRoute(input.groupId, input.userId);
    if (!active) {
      const route = this.save(input, nowMs, "new-topic");
      this.logRoute(route, { autoContinue: false, activeRoute: "miss" });
      return route;
    }

    if (active.headTurnId === undefined) {
      const route = this.save(input, nowMs, "new-topic");
      this.logRoute(route, { autoContinue: false, activeRoute: "invalid" });
      return route;
    }

    const turns = this.repository.getCausalTurns(active.branchId, active.headTurnId);
    const previousUserTurn = [...turns].reverse().find((turn) => turn.role === "user");
    if (!previousUserTurn || previousUserTurn.userId !== input.userId) {
      const route = this.save(input, nowMs, "new-topic");
      this.logRoute(route, {
        autoContinue: false,
        activeRoute: previousUserTurn ? "advanced-by-other-user" : "invalid",
      });
      return route;
    }

    const activeAgeMs = nowMs - previousUserTurn.createdAt;
    if (activeAgeMs < 0) {
      const route = this.save(input, nowMs, "fail-closed");
      this.logRoute(route, { autoContinue: false, activeRoute: "future", activeAgeMs });
      return route;
    }
    if (activeAgeMs > this.autoContinueWindowMs) {
      const route = this.save(input, nowMs, "new-topic");
      this.logRoute(route, {
        autoContinue: false,
        activeRoute: "stale",
        activeAgeMs,
      });
      return route;
    }

    if (isDirectFollowUp(text)) {
      const route = this.save(input, nowMs, "same-user-follow-up", {
        topicId: active.topicId,
        branchId: active.branchId,
        parentTurnId: active.headTurnId,
      });
      this.logRoute(route, { autoContinue: true, activeAgeMs });
      return route;
    }

    const previousUserText = previousUserTurn.content;
    const similarity = characterJaccard(text, previousUserText);
    const keywordOverlap = hasEffectiveKeywordOverlap(text, previousUserText);
    if (similarity >= this.similarityThreshold && keywordOverlap) {
      const route = this.save(input, nowMs, "same-user-similar", {
        topicId: active.topicId,
        branchId: active.branchId,
        parentTurnId: active.headTurnId,
      });
      this.logRoute(route, {
        autoContinue: true,
        activeAgeMs,
        similarity: Number(similarity.toFixed(3)),
        keywordOverlap: true,
      });
      return route;
    }

    const route = this.save(input, nowMs, "new-topic");
    this.logRoute(route, {
      autoContinue: false,
      activeAgeMs,
      similarity: Number(similarity.toFixed(3)),
      keywordOverlap,
    });
    return route;
  }

  private save(
    input: ConversationRouteInput,
    nowMs: number,
    routeReason: ConversationRouteReason,
    context: Pick<SaveMessageRouteInput, "replyToMessageId" | "topicId" | "branchId" | "parentTurnId"> = {},
  ): ConversationRoute {
    return this.repository.saveMessageRoute({
      sourceRowId: input.sourceRowId,
      groupId: input.groupId,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      routeReason,
      content: input.text,
      createdAt: nowMs,
      title: normalizeText(input.text),
      keywords: extractEffectiveKeywords(input.text),
      ...context,
    });
  }

  private logRoute(
    route: ConversationRoute,
    meta: Record<string, string | number | boolean | undefined>,
  ): void {
    logInfo("Conversation route resolved.", {
      sourceRowId: route.sourceRowId,
      topicId: route.topicId,
      branchId: route.branchId,
      routeReason: route.routeReason,
      branchFork: route.routeReason === "explicit-reply-fork",
      ...meta,
    });
  }
}

export function isDirectFollowUp(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  const compatibleQuestionMark = normalized.normalize("NFKC");
  if (compatibleQuestionMark === "?") {
    return true;
  }
  if ([...normalized].length > MAX_FOLLOW_UP_CHARACTERS) {
    return false;
  }
  return FOLLOW_UP_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function characterJaccard(left: string, right: string): number {
  const leftCharacters = new Set(normalizeComparableCharacters(left));
  const rightCharacters = new Set(normalizeComparableCharacters(right));
  if (leftCharacters.size === 0 || rightCharacters.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const character of leftCharacters) {
    if (rightCharacters.has(character)) {
      shared += 1;
    }
  }
  return shared / new Set([...leftCharacters, ...rightCharacters]).size;
}

export function extractEffectiveKeywords(text: string): string[] {
  const normalized = (text ?? "").normalize("NFKC").toLowerCase();
  const keywords = new Set<string>();

  for (const token of normalized.match(/[a-z0-9][a-z0-9_+.-]*/g) ?? []) {
    if (token.length >= 2 && !KEYWORD_STOPWORDS.has(token)) {
      keywords.add(token);
    }
  }

  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const keyword = run.slice(index, index + size);
        if (!KEYWORD_STOPWORDS.has(keyword)) {
          keywords.add(keyword);
        }
      }
    }
  }
  return [...keywords];
}

function hasEffectiveKeywordOverlap(left: string, right: string): boolean {
  const leftKeywords = extractEffectiveKeywords(left);
  if (leftKeywords.length === 0) {
    return false;
  }
  const rightKeywords = new Set(extractEffectiveKeywords(right));
  return leftKeywords.some((keyword) => rightKeywords.has(keyword));
}

function normalizeText(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function normalizeComparableCharacters(text: string): string[] {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]/gu) ?? [];
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function ephemeralFailClosedRoute(input: ConversationRouteInput): ConversationRoute {
  const isolatedId = `${encodeURIComponent(input.groupId)}:${input.sourceRowId}`;
  return {
    topicId: `topic:fail-closed:${isolatedId}`,
    branchId: `branch:fail-closed:${isolatedId}`,
    sourceMessageId: input.sourceMessageId,
    ...(input.replyToMessageId?.trim() ? { replyToMessageId: input.replyToMessageId.trim() } : {}),
    routeReason: "fail-closed",
    sourceRowId: input.sourceRowId,
    turnId: -Math.max(1, Math.abs(Math.trunc(input.sourceRowId))),
  };
}
