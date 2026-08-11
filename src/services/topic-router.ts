import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { logInfo, logWarn } from "../logger.js";

/**
 * Topic router (plan section 5): assigns a topic_id to each @bot message so
 * the worker can route the (group, user, topic) triple.
 *
 * Rules (plan 5.1):
 *  1. Has reply_to (QQ 引用) → inherit the referenced message's topic.
 *  2. No reply_to and @bot → cosine-similarity against the active topics
 *     (30min window); similarity > 0.55 AND an overlapping topic keyword →
 *     join that topic; otherwise open a NEW topic.
 *  3. Free chat (no @bot) never produces a topic — it only feeds the
 *     atmosphere layer (L5).
 *
 * Embeddings are local char n-gram vectors (no external vector service).
 */
export interface TopicRecord {
  id: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  keywords: string[];
  lastActivityAt: number;
}

export interface TopicAssignResult {
  topicId: string;
  action: "inherit" | "join" | "new";
  title: string;
}

export interface TopicRouterOptions {
  /** Active window for topic matching (ms). */
  activeWindowMs?: number;
  /**
   * Character-set Jaccard threshold to join an active topic. The plan's 0.55
   * assumed dense embedding cosine; char Jaccard runs 0.2-0.4 for genuinely
   * related Chinese topics and <0.1 for unrelated ones. The keyword-overlap
   * gate is the primary selector.
   */
  joinThreshold?: number;
  /** Whether a shared (non-stopword) keyword is required in addition to Jaccard. */
  requireKeywordOverlap?: boolean;
}

const DEFAULT_OPTIONS = {
  activeWindowMs: 30 * 60 * 1000,
  joinThreshold: 0.1,
  requireKeywordOverlap: true,
};

export class TopicRouter {
  private readonly options: Required<TopicRouterOptions>;
  private topics: TopicRecord[] = [];

  constructor(
    private readonly dataDir: string,
    options: TopicRouterOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.topics = this.loadTopics();
  }

  /** Assigns a topic to an incoming @bot message. */
  assignTopic(input: {
    groupId: string;
    userId: string;
    text: string;
    replyToMessageId?: string;
    replyToTopicId?: string;
    nowMs?: number;
  }): TopicAssignResult {
    const nowMs = input.nowMs ?? Date.now();
    this.pruneInactive(nowMs);

    // Rule 1: reply chain inherits the topic.
    if (input.replyToTopicId) {
      const topic = this.topics.find((item) => item.id === input.replyToTopicId);
      if (topic) {
        this.touch(topic, nowMs);
        return { topicId: topic.id, action: "inherit", title: topic.title };
      }
    }

    // Rule 2: char-set Jaccard vs active topics, with keyword overlap gate.
    const keywords = extractKeywords(input.text);
    const active = this.topics.filter((topic) => topic.groupId === input.groupId);
    let best: { topic: TopicRecord; score: number } | undefined;
    for (const topic of active) {
      const score = charJaccard(input.text, topic.title);
      if (best === undefined || score > best.score) {
        best = { topic, score };
      }
    }

    if (
      best &&
      best.score > this.options.joinThreshold &&
      (!this.options.requireKeywordOverlap || hasKeywordOverlap(keywords, best.topic.keywords))
    ) {
      this.touch(best.topic, nowMs);
      logInfo("Message joined active topic.", {
        groupId: input.groupId,
        topicId: best.topic.id,
        score: Number(best.score.toFixed(3)),
      });
      return { topicId: best.topic.id, action: "join", title: best.topic.title };
    }

    // Rule 3: open a new topic.
    const topic = this.createTopic(input.groupId, input.text, keywords, nowMs);
    logInfo("Opened new topic.", {
      groupId: input.groupId,
      topicId: topic.id,
      keywords: topic.keywords.slice(0, 5),
    });
    return { topicId: topic.id, action: "new", title: topic.title };
  }

  /** Tracks a referenced message → topic mapping (the worker persists this to conversation store). */
  noteMessageTopic(input: {
    groupId: string;
    messageId: string;
    topicId: string;
  }): void {
    const topic = this.topics.find((item) => item.id === input.topicId);
    if (topic) {
      this.touch(topic, Date.now());
    }
  }

  getActiveTopics(groupId: string, nowMs = Date.now()): TopicRecord[] {
    this.pruneInactive(nowMs);
    return this.topics
      .filter((topic) => topic.groupId === groupId)
      .map((topic) => ({ ...topic, keywords: [...topic.keywords] }));
  }

  private createTopic(groupId: string, text: string, keywords: string[], nowMs: number): TopicRecord {
    const topic: TopicRecord = {
      id: `${groupId}:${randomUUID()}`,
      groupId,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      title: deriveTopicTitle(text, keywords),
      keywords,
      lastActivityAt: nowMs,
    };
    this.topics.push(topic);
    this.persistTopics();
    return topic;
  }

  private touch(topic: TopicRecord, nowMs: number): void {
    topic.lastActivityAt = nowMs;
    topic.updatedAt = new Date(nowMs).toISOString();
    this.persistTopics();
  }

  private pruneInactive(nowMs: number): void {
    const cutoff = nowMs - this.options.activeWindowMs;
    const before = this.topics.length;
    this.topics = this.topics.filter((topic) => topic.lastActivityAt >= cutoff);
    if (this.topics.length !== before) {
      this.persistTopics();
    }
  }

  private topicsPath(): string {
    return join(this.dataDir, "shared", "topics.json");
  }

  private loadTopics(): TopicRecord[] {
    try {
      const raw = readFileSync(this.topicsPath(), "utf8");
      const parsed = JSON.parse(raw) as TopicRecord[] | { topics: TopicRecord[] };
      const list = Array.isArray(parsed) ? parsed : parsed.topics;
      return Array.isArray(list)
        ? list.filter((topic) => topic && typeof topic.id === "string")
        : [];
    } catch {
      return [];
    }
  }

  private persistTopics(): void {
    try {
      mkdirSync(dirname(this.topicsPath()), { recursive: true });
      writeFileSync(this.topicsPath(), `${JSON.stringify({ topics: this.topics }, null, 2)}\n`, "utf8");
    } catch (error) {
      logWarn("Failed to persist topics.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---- local n-gram vector utilities ----

const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "这个", "那个", "什么", "怎么", "为什么", "可以", "一下", "然后", "我们", "你们",
  "他们", "她们", "还是", "已经", "知道", "觉得", "帮我", "请问", "请问一下",
  "机器", "机器人", "大家", "有没有", "是不是", "会不会", "真的", "其实", "然后", "反正", "那个",
  "怎样", "如何", "吗", "呢", "吧", "啊", "呀", "啥", "嘛",
]);

/** One shared 2-char stopword fragment (e.g. 行情-行情) should NOT satisfy the overlap gate alone. */
const OVERLAP_STOPWORDS = new Set([
  "行情", "工作", "情况", "看法", "想法", "意思", "问题", "东西", "时候", "觉得", "感觉",
  "知道", "了解", "看看", "问问", "打听", "听说", "知道",
]);

export function extractKeywords(text: string, max = 12): string[] {
  const normalized = (text ?? "").toLowerCase().replace(/\s+/g, "");
  if (!normalized) {
    return [];
  }
  const candidates = new Set<string>();

  const tokens = normalized.match(/[\p{Script=Han}]{2,}|[a-z0-9_]{3,}/gu) ?? [];
  for (const token of tokens) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      candidates.add(token);
      const prefix = token.slice(0, 2);
      if (!STOPWORDS.has(prefix) && !OVERLAP_STOPWORDS.has(prefix)) {
        candidates.add(prefix);
      }
    } else if (!STOPWORDS.has(token) && token.length >= 2) {
      candidates.add(token);
    }
  }

  return [...candidates].sort((left, right) => right.length - left.length).slice(0, max);
}

/**
 * Character-set Jaccard similarity: |chars(A) ∩ chars(B)| / |chars(A) ∪ chars(B)|.
 * Robust without a tokenizer: "前端就业形势严峻" and "前端行情不好找" share
 * {前, 端} → Jaccard ≈ 0.25, while "前端行情" vs "后端行情" share {端, 行, 情}
 * of a much larger union — the gate below filters the rest.
 */
export function charJaccard(left: string, right: string): number {
  const leftChars = new Set((left ?? "").toLowerCase().replace(/\s+/g, ""));
  const rightChars = new Set((right ?? "").toLowerCase().replace(/\s+/g, ""));
  if (leftChars.size === 0 || rightChars.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const char of leftChars) {
    if (rightChars.has(char)) {
      shared += 1;
    }
  }
  const union = new Set([...leftChars, ...rightChars]).size;
  return shared / union;
}

function toVector(terms: string[]): Map<string, number> {
  const vector = new Map<string, number>();
  for (const term of terms) {
    vector.set(term, (vector.get(term) ?? 0) + 1);
  }
  return vector;
}

/** |A ∩ B| / min(|A|, |B|) — how much of the smaller keyword set is shared. */
export function overlapCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const shared = left.filter((term) => rightSet.has(term)).length;
  return shared / Math.min(left.length, right.length);
}

export function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, value] of left) {
    dot += value * (right.get(term) ?? 0);
    leftNorm += value * value;
  }
  for (const value of right.values()) {
    rightNorm += value * value;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** True when any non-stopword keyword of either side appears as a substring of the other side's keywords. */
export function hasKeywordOverlap(left: string[], right: string[]): boolean {
  for (const term of left) {
    if (OVERLAP_STOPWORDS.has(term) || term.length < 2) {
      continue;
    }
    for (const other of right) {
      if (other.length >= 2 && (other.includes(term) || term.includes(other))) {
        // Reject pure stopword substrings ("行情" overlapping "后端行情" only).
        const common = term.length <= other.length ? term : other;
        if (OVERLAP_STOPWORDS.has(common)) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

function deriveTopicTitle(text: string, keywords: string[]): string {
  const head = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (head) {
    return head;
  }
  return keywords.slice(0, 3).join("、") || "未命名话题";
}
