import { logInfo, logWarn } from "../logger.js";
import type { GroupMemory } from "../types.js";
import type { MemorySemanticJudgeInput, MemorySemanticJudgeResult } from "./ai-service.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const DEDUP_LOCAL_THRESHOLD = 0.72;
const DEDUP_SEMANTIC_CANDIDATE_THRESHOLD = 0.2;
const DEDUP_SEMANTIC_PAIR_LIMIT = 12;
const DEDUP_SEMANTIC_PAIR_TIMEOUT_MS = 2500;

export type MemoryDedupAction = "duplicate" | "merge";

export interface MemoryDedupDecision {
  action: MemoryDedupAction;
  targetId?: string;
  duplicateId: string;
  reason: string;
  similarity: number;
}

export interface MemoryDedupSemanticStats {
  candidatePairCount: number;
  called: number;
  duplicate: number;
  merge: number;
  new: number;
  failed: number;
  timedOut: number;
  skippedDisabled: number;
  skippedProtected: number;
}

export interface MemoryDedupPreviewBuildResult {
  decisions: MemoryDedupDecision[];
  semanticStats: MemoryDedupSemanticStats;
}

export interface MemoryDedupApplyResult {
  applied: Array<{ duplicateId: string; action: string; targetId?: string }>;
  skipped: Array<{ duplicateId: string; error: string }>;
  appliedCount: number;
  skippedCount: number;
}

export class GroupMemoryDeduplicateService {
  constructor(
    private readonly memoryStore: GroupMemoryStore,
    private readonly judgeMemorySemanticRelation?: (args: MemorySemanticJudgeInput) => Promise<MemorySemanticJudgeResult | null>,
  ) {}

  async preview(
    memories: GroupMemory[],
    options: { semanticMode?: "member" | "global"; useSemanticJudge?: boolean; semanticTimeoutMs?: number } = {},
  ): Promise<MemoryDedupPreviewBuildResult> {
    return buildMemoryDeduplicateDecisions(memories, this.judgeMemorySemanticRelation, options);
  }

  async apply(groupId: string, decisions: MemoryDedupDecision[]): Promise<MemoryDedupApplyResult> {
    const applied: MemoryDedupApplyResult["applied"] = [];
    const skipped: MemoryDedupApplyResult["skipped"] = [];
    const handledDuplicateIds = new Set<string>();
    for (const decision of decisions) {
      if (handledDuplicateIds.has(decision.duplicateId)) {
        skipped.push({ duplicateId: decision.duplicateId, error: "duplicate_decision" });
        continue;
      }
      handledDuplicateIds.add(decision.duplicateId);

      const duplicate = await this.memoryStore.get(decision.duplicateId);
      if (!duplicate || duplicate.groupId !== groupId) {
        skipped.push({ duplicateId: decision.duplicateId, error: "not_found" });
        continue;
      }
      if (!duplicate.enabled) {
        skipped.push({ duplicateId: decision.duplicateId, error: "already_disabled" });
        continue;
      }

      if (decision.action === "merge" && decision.targetId) {
        if (decision.targetId === decision.duplicateId) {
          skipped.push({ duplicateId: decision.duplicateId, error: "invalid_target" });
          continue;
        }
        const target = await this.memoryStore.get(decision.targetId);
        if (!target || target.groupId !== groupId) {
          skipped.push({ duplicateId: decision.duplicateId, error: "target_not_found" });
          continue;
        }
        if (!target.enabled) {
          skipped.push({ duplicateId: decision.duplicateId, error: "target_disabled" });
          continue;
        }
        await this.memoryStore.update(target.id, {
          title: chooseLongerText(target.title, duplicate.title, 80),
          content: chooseLongerText(target.content, duplicate.content, 1800),
          confidence: Math.max(target.confidence, duplicate.confidence),
          evidence: target.evidence ?? duplicate.evidence,
        });
      }

      await this.memoryStore.update(duplicate.id, { enabled: false });
      applied.push({
        duplicateId: duplicate.id,
        action: decision.action,
        ...(decision.targetId ? { targetId: decision.targetId } : {}),
      });
    }

    return { applied, skipped, appliedCount: applied.length, skippedCount: skipped.length };
  }

  async previewGroup(
    groupId: string,
    options: {
      subjectUserId?: string;
      type?: GroupMemory["type"];
      semanticMode?: "member" | "global";
      useSemanticJudge?: boolean;
      semanticTimeoutMs?: number;
    } = {},
  ): Promise<MemoryDedupPreviewBuildResult> {
    const memories = (await this.memoryStore.list(groupId))
      .filter((memory) => memory.enabled)
      .filter((memory) => !options.subjectUserId || memory.subjectUserId === options.subjectUserId)
      .filter((memory) => !options.type || memory.type === options.type);
    return this.preview(memories, {
      semanticMode: options.semanticMode,
      useSemanticJudge: options.useSemanticJudge,
      semanticTimeoutMs: options.semanticTimeoutMs,
    });
  }

  async deduplicateMemberMemoriesForGroup(
    groupId: string,
    options: { useSemanticJudge?: boolean; semanticTimeoutMs?: number } = {},
  ): Promise<{
    groupId: string;
    subjectCount: number;
    decisionCount: number;
    appliedCount: number;
    skippedCount: number;
    semanticStats: MemoryDedupSemanticStats;
  }> {
    const memories = (await this.memoryStore.list(groupId)).filter((memory) =>
      memory.enabled &&
      memory.type === "member_profile" &&
      Boolean(memory.subjectUserId) &&
      !isProfileRecordMemory(memory)
    );
    const bySubject = new Map<string, GroupMemory[]>();
    for (const memory of memories) {
      const subjectUserId = memory.subjectUserId;
      if (!subjectUserId) continue;
      const items = bySubject.get(subjectUserId) ?? [];
      items.push(memory);
      bySubject.set(subjectUserId, items);
    }

    let decisionCount = 0;
    let appliedCount = 0;
    let skippedCount = 0;
    const semanticStats = createSemanticStats();
    for (const [subjectUserId, subjectMemories] of bySubject.entries()) {
      if (subjectMemories.length < 2) continue;
      const preview = await this.preview(subjectMemories, {
        semanticMode: "member",
        useSemanticJudge: options.useSemanticJudge === true,
        semanticTimeoutMs: options.semanticTimeoutMs,
      });
      mergeSemanticStats(semanticStats, preview.semanticStats);
      decisionCount += preview.decisions.length;
      if (preview.decisions.length === 0) continue;
      const result = await this.apply(groupId, preview.decisions);
      appliedCount += result.appliedCount;
      skippedCount += result.skippedCount;
      logInfo("Deduplicated member long-term memories.", {
        groupId,
        subjectUserId,
        decisions: preview.decisions.length,
        applied: result.appliedCount,
        skipped: result.skippedCount,
      });
    }

    return {
      groupId,
      subjectCount: bySubject.size,
      decisionCount,
      appliedCount,
      skippedCount,
      semanticStats,
    };
  }
}

export function normalizeMemoryDedupDecision(value: unknown): MemoryDedupDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MemoryDedupDecision>;
  const duplicateId = optionalString(record.duplicateId);
  if (!duplicateId) return undefined;
  const action: MemoryDedupAction = record.action === "merge" ? "merge" : "duplicate";
  return {
    action,
    duplicateId,
    ...(optionalString(record.targetId) ? { targetId: optionalString(record.targetId) } : {}),
    reason: optionalString(record.reason) ?? "manual_apply",
    similarity: optionalNumber(record.similarity) ?? 1,
  };
}

async function buildMemoryDeduplicateDecisions(
  memories: GroupMemory[],
  judgeMemorySemanticRelation?: (args: MemorySemanticJudgeInput) => Promise<MemorySemanticJudgeResult | null>,
  options: { semanticMode?: "member" | "global"; useSemanticJudge?: boolean; semanticTimeoutMs?: number } = {},
): Promise<MemoryDedupPreviewBuildResult> {
  const decisions: MemoryDedupDecision[] = [];
  const semanticPairs: Array<{ left: GroupMemory; right: GroupMemory; similarity: number }> = [];
  const semanticStats = createSemanticStats();
  const active = memories.filter((memory) => memory.enabled);
  for (let index = 0; index < active.length; index += 1) {
    const left = active[index]!;
    for (let otherIndex = index + 1; otherIndex < active.length; otherIndex += 1) {
      const right = active[otherIndex]!;
      if (left.groupId !== right.groupId || left.type !== right.type || left.subjectUserId !== right.subjectUserId) {
        continue;
      }
      const sameContent = normalizeComparableText(left.content) === normalizeComparableText(right.content);
      const similarity = sameContent ? 1 : textSimilarity(`${left.title} ${left.content}`, `${right.title} ${right.content}`);
      if (!sameContent && similarity < DEDUP_LOCAL_THRESHOLD) {
        const shouldAskSemanticJudge = options.semanticMode === "member" || similarity >= DEDUP_SEMANTIC_CANDIDATE_THRESHOLD;
        if (judgeMemorySemanticRelation && shouldAskSemanticJudge) {
          if (options.useSemanticJudge === false) {
            semanticStats.skippedDisabled += 1;
          } else {
            semanticPairs.push({ left, right, similarity });
          }
        }
        continue;
      }
      const [target, duplicate] = chooseDedupTarget(left, right);
      decisions.push({
        action: similarity >= 0.9 ? "duplicate" : "merge",
        targetId: target.id,
        duplicateId: duplicate.id,
        similarity: roundSimilarity(similarity),
        reason: similarity >= 0.9 ? "local_high_similarity" : "local_related_memory",
      });
    }
  }

  if (judgeMemorySemanticRelation && options.useSemanticJudge !== false && semanticPairs.length > 0) {
    semanticStats.candidatePairCount = semanticPairs.length;
    const alreadyDuplicateIds = new Set(decisions.map((decision) => decision.duplicateId));
    const protectedTargetIds = new Set(decisions.flatMap((decision) => decision.targetId ? [decision.targetId] : []));
    for (const pair of semanticPairs
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, DEDUP_SEMANTIC_PAIR_LIMIT)) {
      const [target, duplicate] = chooseDedupTarget(pair.left, pair.right);
      if (alreadyDuplicateIds.has(duplicate.id) || protectedTargetIds.has(duplicate.id)) {
        semanticStats.skippedProtected += 1;
        continue;
      }
      const semanticDecision = await buildSemanticMemoryDedupDecision(
        target,
        duplicate,
        pair.similarity,
        judgeMemorySemanticRelation,
        semanticStats,
        options.semanticTimeoutMs ?? DEDUP_SEMANTIC_PAIR_TIMEOUT_MS,
      );
      if (!semanticDecision.decision) {
        continue;
      }
      if (semanticDecision.decision.targetId && alreadyDuplicateIds.has(semanticDecision.decision.targetId)) {
        semanticStats.skippedProtected += 1;
        continue;
      }
      decisions.push(semanticDecision.decision);
      alreadyDuplicateIds.add(semanticDecision.decision.duplicateId);
      if (semanticDecision.decision.targetId) {
        protectedTargetIds.add(semanticDecision.decision.targetId);
      }
    }
  }

  const seen = new Set<string>();
  const uniqueDecisions = decisions.filter((decision) => {
    if (seen.has(decision.duplicateId)) return false;
    seen.add(decision.duplicateId);
    return true;
  });
  return { decisions: uniqueDecisions, semanticStats };
}

async function buildSemanticMemoryDedupDecision(
  target: GroupMemory,
  duplicate: GroupMemory,
  similarity: number,
  judgeMemorySemanticRelation: (args: MemorySemanticJudgeInput) => Promise<MemorySemanticJudgeResult | null>,
  semanticStats: MemoryDedupSemanticStats,
  timeoutMs: number,
): Promise<{ decision?: MemoryDedupDecision }> {
  try {
    semanticStats.called += 1;
    const result = await withTimeout(judgeMemorySemanticRelation({
      candidate: {
        type: duplicate.type,
        subjectUserId: duplicate.subjectUserId,
        title: duplicate.title,
        content: duplicate.content,
        confidence: duplicate.confidence,
      },
      existing: {
        type: target.type,
        subjectUserId: target.subjectUserId,
        title: target.title,
        content: target.content,
        confidence: target.confidence,
      },
    }), timeoutMs);
    if (!result || result.action === "new") {
      semanticStats.new += 1;
      return {};
    }
    semanticStats[result.action] += 1;
    return { decision: {
      action: result.action,
      targetId: target.id,
      duplicateId: duplicate.id,
      similarity: roundSimilarity(similarity),
      reason: result.reason ? `semantic:${result.reason}` : `semantic_${result.action}`,
    } };
  } catch (error) {
    semanticStats.failed += 1;
    if (error instanceof Error && error.message === "semantic_judge_timeout") {
      semanticStats.timedOut += 1;
    }
    logWarn("Memory semantic deduplicate judge failed; keeping local dedup preview.", {
      targetId: target.id,
      duplicateId: duplicate.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("semantic_judge_timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function chooseLongerText(left: string, right: string, limit: number): string {
  return (right.trim().length > left.trim().length ? right : left).trim().slice(0, limit);
}

function chooseDedupTarget(left: GroupMemory, right: GroupMemory): [GroupMemory, GroupMemory] {
  if (normalizeComparableText(left.content) === normalizeComparableText(right.content)) {
    return left.createdAt <= right.createdAt ? [left, right] : [right, left];
  }
  if (left.content.length !== right.content.length) {
    return left.content.length >= right.content.length ? [left, right] : [right, left];
  }
  return left.confidence >= right.confidence ? [left, right] : [right, left];
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").trim();
}

function textSimilarity(left: string, right: string): number {
  const leftTags = getComparableSemanticTags(left);
  const rightTags = getComparableSemanticTags(right);
  const leftTokens = tokenizeComparableText(left);
  const rightTokens = tokenizeComparableText(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const tokenScore = overlap / Math.max(leftTokens.size, rightTokens.size);
  let tagScore = 0;
  for (const tag of leftTags) {
    if (rightTags.has(tag)) tagScore = Math.max(tagScore, 0.82);
  }
  return Math.max(tokenScore, tagScore);
}

function tokenizeComparableText(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]{2,}/g)) {
    if (!isLowValueComparableToken(match[0])) tokens.add(match[0]);
  }
  const hanText = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  for (const match of hanText.matchAll(/[\u4e00-\u9fa5]/g)) {
    tokens.add(match[0]);
  }
  for (let index = 0; index < hanText.length - 1; index += 1) {
    const token = hanText.slice(index, index + 2);
    if (/[\u4e00-\u9fa5]{2}/.test(token)) tokens.add(token);
  }
  return tokens;
}

function getComparableSemanticTags(value: string): Set<string> {
  const normalized = normalizeComparableText(value);
  const tags = new Set<string>();
  if (hasShortReplyPreference(normalized)) {
    tags.add("short_reply_preference");
  }
  return tags;
}

function hasShortReplyPreference(value: string): boolean {
  return [
    /(?:喜欢|偏好|希望|想要|倾向).{0,8}(?:简短|简洁|精简|短.{0,4}(?:回答|回复|答复))/u,
    /(?:简短|简洁|精简|短.{0,4}(?:回答|回复|答复)).{0,8}(?:喜欢|偏好|希望|想要|倾向)/u,
  ].some((pattern) => pattern.test(value));
}
function isLowValueComparableToken(token: string): boolean {
  return new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "like",
    "likes",
    "prefers",
    "preference",
    "profile",
  ]).has(token);
}

function createSemanticStats(): MemoryDedupSemanticStats {
  return {
    candidatePairCount: 0,
    called: 0,
    duplicate: 0,
    merge: 0,
    new: 0,
    failed: 0,
    timedOut: 0,
    skippedDisabled: 0,
    skippedProtected: 0,
  };
}

function mergeSemanticStats(target: MemoryDedupSemanticStats, source: MemoryDedupSemanticStats): void {
  target.candidatePairCount += source.candidatePairCount;
  target.called += source.called;
  target.duplicate += source.duplicate;
  target.merge += source.merge;
  target.new += source.new;
  target.failed += source.failed;
  target.timedOut += source.timedOut;
  target.skippedDisabled += source.skippedDisabled;
  target.skippedProtected += source.skippedProtected;
}

function roundSimilarity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProfileRecordMemory(memory: GroupMemory): boolean {
  return memory.source.startsWith("daily_profile_review:") ||
    memory.source.startsWith("profile_record:") ||
    memory.title.includes("画像总结") ||
    memory.title.includes("昨日画像") ||
    memory.title.includes("群聊画像");
}

