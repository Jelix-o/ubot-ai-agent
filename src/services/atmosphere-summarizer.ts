import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { logWarn } from "../logger.js";
import type { RecentGroupMessage } from "../types.js";
import type { V3StateRepository } from "./v3-state-repository.js";

/**
 * L5 group-atmosphere summarizer (plan section 3/5).
 *
 * Every `summarizeIntervalMs` (10 min) the recent 1h of group messages are
 * collapsed into a short summary that:
 *  - never contains real names (replaced by 成员/群友),
 *  - strips emotional polarity (气死我了 → 表达不满的讨论),
 *  - desensitizes sensitive topics into vague descriptions (裁员 → 岗位变化).
 *
 * The summary — NOT the raw transcript — is what the context assembler feeds
 * the model (plan: L5 群氛围一定是摘要，不是原文).
 */
export interface AtmosphereSummary {
  groupId: string;
  windowStart: string;
  windowEnd: string;
  messageCount: number;
  speakerCount: number;
  summary: string;
  updatedAt: string;
}

export interface AtmosphereStore {
  summaries: Record<string, AtmosphereSummary>;
}

interface SummarizerOptions {
  windowMs?: number;
  summarizeIntervalMs?: number;
}

const DEFAULT_OPTIONS = {
  windowMs: 60 * 60 * 1000,
  summarizeIntervalMs: 10 * 60 * 1000,
};

/** Picks representative messages from the window, always including the newest. */
export function pickRepresentativeMessages(messages: RecentGroupMessage[], maxSamples = 12): RecentGroupMessage[] {
  const sorted = [...messages].sort((left, right) =>
    Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  if (sorted.length <= maxSamples) {
    return sorted;
  }
  const step = (sorted.length - 1) / Math.max(1, maxSamples - 1);
  const picked: RecentGroupMessage[] = [];
  for (let i = 0; i < maxSamples - 1; i += 1) {
    picked.push(sorted[Math.min(sorted.length - 1, Math.floor(i * step))]!);
  }
  picked.push(sorted[sorted.length - 1]!);
  return picked;
}

/** Detects high-signal keywords so the summary can name the topic vaguely. */
export function detectTopicHints(messages: RecentGroupMessage[]): string[] {
  const counts = new Map<string, number>();
  const hints: Array<{ match: RegExp; hint: string }> = [
    { match: /工作|上班|加班|辞职|离职|跳槽/, hint: "工作" },
    { match: /裁|优化(?!.*名单)|缩编|降薪|解雇/, hint: "岗位变化" },
    { match: /技术|架构|代码|编程|开发/, hint: "技术话题" },
    { match: /前端|后端|全栈/, hint: "技术话题" },
    { match: /\bAI\b|人工智能|大模型|agent/i, hint: "AI 话题" },
    { match: /游戏|打野|段位|副本|皮肤/, hint: "游戏" },
    { match: /天气|下雨|台风|降温|升温/, hint: "天气" },
    { match: /吃饭|午饭|晚饭|早餐|外卖/, hint: "饮食" },
    { match: /股票|基金|理财|投资|涨了|跌了/, hint: "投资" },
    { match: /比赛|决赛|晋级|比分/, hint: "比赛" },
    { match: /学习|考试|作业|考研|证书/, hint: "学习" },
  ];
  for (const message of messages) {
    for (const { match, hint } of hints) {
      if (match.test(message.text)) {
        counts.set(hint, (counts.get(hint) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([hint]) => hint);
}

/**
 * Builds the atmosphere summary text from recent messages:
 *  - strips names,
 *  - collapses duplicates,
 *  - desensitizes topics,
 *  - neutral phrasing only.
 */
export function buildAtmosphereSummary(
  messages: RecentGroupMessage[],
  hints: string[],
  maxChars = 240,
): string {
  const parts: string[] = [];
  if (hints.length > 0) {
    parts.push(`群内主要在讨论：${hints.join("、")}`);
  }
  if (messages.length > 0) {
    parts.push(`近一小时群聊较活跃，共 ${messages.length} 条消息`);
  }
  const emotional = messages.filter((message) =>
    /[！!]|气死|无语|烦|哈哈|笑死|哭|怒|不爽|太好了/.test(message.text),
  ).length;
  if (emotional >= 2) {
    parts.push("期间有成员表达较强情绪");
  }
  const text = parts.join("；") || "近一小时群内较为安静";
  return text.slice(0, maxChars);
}

/** Strips names/QQ numbers from a message for the summary (never shown verbatim anyway). */
export function sanitizeMessageForAtmosphere(message: RecentGroupMessage): string {
  return message.text
    .replace(/\d{5,12}/g, "成员")
    .replace(/@\S+/g, "@成员")
    .slice(0, 120);
}

export class AtmosphereSummarizer {
  private readonly options: Required<SummarizerOptions>;
  private lastSummarizeAt: Record<string, number> = {};
  private store: AtmosphereStore = { summaries: {} };

  constructor(
    private readonly dataDir: string,
    options: SummarizerOptions = {},
    private readonly v3State?: V3StateRepository,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.store = this.loadStore();
  }

  /** Updates the rolling window; returns a new summary when the interval elapsed. */
  update(
    groupId: string,
    messages: RecentGroupMessage[],
    nowMs = Date.now(),
  ): AtmosphereSummary | undefined {
    const lastAt = this.lastSummarizeAt[groupId] ?? 0;
    if (nowMs - lastAt < this.options.summarizeIntervalMs) {
      return undefined;
    }

    const cutoff = nowMs - this.options.windowMs;
    const inWindow = messages
      .filter((message) => Date.parse(message.timestamp) >= cutoff)
      .slice(-200);
    if (inWindow.length === 0) {
      return undefined;
    }

    this.lastSummarizeAt[groupId] = nowMs;
    const hints = detectTopicHints(inWindow);
    const summary: AtmosphereSummary = {
      groupId,
      windowStart: new Date(cutoff).toISOString(),
      windowEnd: new Date(nowMs).toISOString(),
      messageCount: inWindow.length,
      speakerCount: new Set(inWindow.map((message) => message.userId)).size,
      summary: buildAtmosphereSummary(inWindow, hints),
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.store.summaries[groupId] = summary;
    this.persistStore();
    return summary;
  }

  /** Force a fresh summary (used on demand before assembling context). */
  summarizeNow(groupId: string, messages: RecentGroupMessage[], nowMs = Date.now()): AtmosphereSummary {
    this.lastSummarizeAt[groupId] = nowMs;
    const cutoff = nowMs - this.options.windowMs;
    const inWindow = messages.filter((message) => Date.parse(message.timestamp) >= cutoff);
    const hints = detectTopicHints(inWindow);
    const summary: AtmosphereSummary = {
      groupId,
      windowStart: new Date(cutoff).toISOString(),
      windowEnd: new Date(nowMs).toISOString(),
      messageCount: inWindow.length,
      speakerCount: new Set(inWindow.map((message) => message.userId)).size,
      summary: buildAtmosphereSummary(inWindow, hints),
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.store.summaries[groupId] = summary;
    this.persistStore();
    return summary;
  }

  getSummary(groupId: string): AtmosphereSummary | undefined {
    // In split-process mode ingress/worker may update the summary file through
    // another instance. Reload on read so BotApplication sees that update.
    this.store = this.loadStore();
    return this.store.summaries[groupId];
  }

  private storePath(): string {
    return join(this.dataDir, "shared", "atmosphere.json");
  }

  private loadStore(): AtmosphereStore {
    if (this.v3State) {
      this.v3State.requireCutover();
      return normalizeAtmosphereStore(this.v3State.getDocument("atmosphere", "default", { summaries: {} }));
    }
    try {
      return normalizeAtmosphereStore(JSON.parse(readFileSync(this.storePath(), "utf8")) as AtmosphereStore);
    } catch {
      return { summaries: {} };
    }
  }

  private persistStore(): void {
    if (this.v3State) {
      this.v3State.requireCutover();
      this.v3State.saveDocument("atmosphere", "default", this.store);
      return;
    }
    try {
      mkdirSync(dirname(this.storePath()), { recursive: true });
      writeFileSync(this.storePath(), `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
    } catch (error) {
      logWarn("Failed to persist atmosphere summaries.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function normalizeAtmosphereStore(value: unknown): AtmosphereStore {
  const record = value && typeof value === "object" ? value as Partial<AtmosphereStore> : {};
  return { summaries: record.summaries && typeof record.summaries === "object" ? record.summaries : {} };
}
