import { logInfo, logWarn } from "../logger.js";
import type { GroupMemory, GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryEvidence, GroupMemoryType } from "../types.js";
import type { AiService, MemoryCandidateExtractionMessage } from "./ai-service.js";
import type { GroupMemoryCandidateListPageArgs, GroupMemoryCandidateListPageResult, GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;
const EVIDENCE_MESSAGE_LIMIT = 30;
const EVIDENCE_SUMMARY_LIMIT = 2400;
const MESSAGE_TEXT_LIMIT = 1000;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.82;
const RELATED_SIMILARITY_THRESHOLD = 0.68;

interface BufferedMemoryMessage {
  groupId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

export interface GroupMemoryCandidateFlushStats {
  groupId: string;
  messageCount: number;
  candidateCount: number;
  autoApprovedCount: number;
  pendingCount: number;
  skippedDuplicateCount: number;
  mergedCandidateCount: number;
  refinedMemoryCount: number;
}

export class GroupMemoryCandidateService {
  private readonly buffers = new Map<string, BufferedMemoryMessage[]>();

  constructor(
    private readonly candidateStore: GroupMemoryCandidateStore,
    private readonly memoryStore: GroupMemoryStore,
    private readonly aiService: Pick<AiService, "extractGroupMemoryCandidates">,
    private readonly batchSize = 8,
  ) {}

  async list(args: { groupId?: string; status?: GroupMemoryCandidateStatus } = {}): Promise<GroupMemoryCandidate[]> {
    return this.candidateStore.list(args);
  }

  async get(id: string): Promise<GroupMemoryCandidate | undefined> {
    return this.candidateStore.get(id);
  }

  async listPage(args: GroupMemoryCandidateListPageArgs): Promise<GroupMemoryCandidateListPageResult> {
    return this.candidateStore.listPage(args);
  }

  async countPendingBySubject(groupId: string): Promise<Array<{ userId: string; count: number }>> {
    return this.candidateStore.countPendingBySubject(groupId);
  }

  async approve(
    id: string,
    patch: Partial<Pick<GroupMemoryCandidate, "title" | "content" | "type" | "subjectUserId" | "confidence" | "evidence">> = {},
  ): Promise<Awaited<ReturnType<GroupMemoryCandidateStore["approve"]>>> {
    return this.candidateStore.approve(id, this.memoryStore, patch);
  }

  async reject(id: string): Promise<GroupMemoryCandidate | undefined> {
    return this.candidateStore.reject(id);
  }

  async update(
    id: string,
    patch: Partial<Pick<GroupMemoryCandidate, "title" | "content" | "type" | "subjectUserId" | "confidence" | "status" | "evidence">>,
  ): Promise<GroupMemoryCandidate | undefined> {
    return this.candidateStore.update(id, patch);
  }

  async remove(id: string): Promise<boolean> {
    return this.candidateStore.remove(id);
  }

  queueMessage(message: BufferedMemoryMessage): void {
    const normalizedText = message.text.trim();
    if (!normalizedText || normalizedText.startsWith("#")) {
      return;
    }

    const buffer = this.buffers.get(message.groupId) ?? [];
    buffer.push({
      ...message,
      text: normalizedText.slice(0, MESSAGE_TEXT_LIMIT),
    });
    this.buffers.set(message.groupId, buffer.slice(-this.batchSize * 2));

    if (buffer.length >= this.batchSize) {
      void this.flushGroup(message.groupId);
    }
  }

  async flushAll(): Promise<GroupMemoryCandidateFlushStats[]> {
    const results = await Promise.all([...this.buffers.keys()].map((groupId) => this.flushGroup(groupId)));
    return results.filter((result): result is GroupMemoryCandidateFlushStats => Boolean(result));
  }

  async flushGroup(groupId: string): Promise<GroupMemoryCandidateFlushStats | undefined> {
    const buffer = this.buffers.get(groupId) ?? [];
    if (buffer.length === 0) {
      return;
    }

    this.buffers.set(groupId, []);
    try {
      const messages: MemoryCandidateExtractionMessage[] = buffer.map((message) => ({
        userId: message.userId,
        userName: message.userName,
        text: message.text,
        timestamp: message.timestamp,
      }));
      const evidence = buildEvidence(buffer);
      const speakerIds = new Set(buffer.map((message) => message.userId));
      const [existingMemories, existingCandidates] = await Promise.all([
        this.memoryStore.list(groupId),
        this.candidateStore.list({ groupId }),
      ]);
      const dedupReferenceMemories = existingMemories.filter(isDedupReferenceMemory);
      const candidates = await this.aiService.extractGroupMemoryCandidates({
        groupId,
        messages,
        existingMemories: dedupReferenceMemories,
        existingCandidates: existingCandidates.filter((candidate) => candidate.status !== "rejected"),
      });
      let autoApprovedCount = 0;
      let pendingCount = 0;
      let skippedDuplicateCount = 0;
      let mergedCandidateCount = 0;
      let refinedMemoryCount = 0;
      for (const candidate of candidates) {
        const subjectUserId =
          candidate.type === "member_profile" && candidate.subjectUserId && speakerIds.has(candidate.subjectUserId)
            ? candidate.subjectUserId
            : undefined;
        const forcedPending = candidate.type === "member_profile" && candidate.subjectUserId && !subjectUserId;
        const normalizedCandidate = {
          groupId,
          type: candidate.type,
          subjectUserId,
          title: candidate.title,
          content: candidate.content,
          confidence: candidate.confidence,
          source: "auto",
          evidence,
        };
        const duplicateDecision = findDuplicateDecision(normalizedCandidate, dedupReferenceMemories, existingCandidates);
        if (duplicateDecision.kind === "skip" || duplicateDecision.kind === "skip_candidate") {
          skippedDuplicateCount += 1;
          continue;
        }
        if (duplicateDecision.kind === "refine_memory") {
          const refined = await this.memoryStore.update(duplicateDecision.memory.id, {
            title: chooseMoreSpecificText(duplicateDecision.memory.title, candidate.title, 80),
            content: chooseMoreSpecificText(duplicateDecision.memory.content, candidate.content, 600),
            confidence: Math.max(duplicateDecision.memory.confidence, candidate.confidence),
            evidence: mergeEvidence(duplicateDecision.memory.evidence, evidence),
          });
          if (refined) {
            replaceMemory(existingMemories, refined);
            replaceMemory(dedupReferenceMemories, refined);
            refinedMemoryCount += 1;
          } else {
            skippedDuplicateCount += 1;
          }
          continue;
        }
        if (duplicateDecision.kind === "merge") {
          const merged = await this.candidateStore.update(duplicateDecision.candidate.id, {
            title: chooseMoreSpecificText(duplicateDecision.candidate.title, candidate.title, 80),
            content: chooseMoreSpecificText(duplicateDecision.candidate.content, candidate.content, 600),
            confidence: Math.max(duplicateDecision.candidate.confidence, candidate.confidence),
            source: "auto",
            evidence: mergeEvidence(duplicateDecision.candidate.evidence, evidence),
            status: duplicateDecision.candidate.status === "rejected" ? "pending" : duplicateDecision.candidate.status,
          });
          if (merged) {
            replaceCandidate(existingCandidates, merged);
            mergedCandidateCount += 1;
            if (!forcedPending && shouldAutoApprove(merged) && merged.status === "pending") {
              await this.candidateStore.approve(merged.id, this.memoryStore);
              const approvedCandidate = { ...merged, status: "approved" as const };
              replaceCandidate(existingCandidates, approvedCandidate);
              existingMemories.push({
                id: `approved:${merged.id}`,
                groupId: merged.groupId,
                type: merged.type,
                subjectUserId: merged.subjectUserId,
                title: merged.title,
                content: merged.content,
                confidence: merged.confidence,
                source: merged.source,
                createdAt: merged.createdAt,
                updatedAt: new Date().toISOString(),
                enabled: true,
                evidence: merged.evidence,
              });
              dedupReferenceMemories.push(existingMemories.at(-1)!);
              autoApprovedCount += 1;
            } else if (merged.status === "pending") {
              pendingCount += 1;
            }
          }
          continue;
        }
        const result = await this.candidateStore.addCandidateWithResult({
          ...normalizedCandidate,
        });
        replaceCandidate(existingCandidates, result.candidate);
        if (!forcedPending && shouldAutoApprove(result.candidate) && (result.created || result.candidate.status === "pending")) {
          const approved = await this.candidateStore.approve(result.candidate.id, this.memoryStore);
          if (approved) {
            replaceCandidate(existingCandidates, approved.candidate);
            existingMemories.push(approved.memory);
            if (isDedupReferenceMemory(approved.memory)) {
              dedupReferenceMemories.push(approved.memory);
            }
          }
          autoApprovedCount += 1;
        } else if (result.candidate.status === "pending") {
          pendingCount += 1;
        }
      }
      const stats = {
        groupId,
        messageCount: buffer.length,
        candidateCount: candidates.length,
        autoApprovedCount,
        pendingCount,
        skippedDuplicateCount,
        mergedCandidateCount,
        refinedMemoryCount,
      };
      logInfo("Extracted group memory candidates.", stats);
      return stats;
    } catch (error) {
      logWarn("Failed to extract group memory candidates.", {
        groupId,
        error: (error as Error).message,
      });
    }
  }
}

function shouldAutoApprove(candidate: GroupMemoryCandidate): boolean {
  if (candidate.confidence < AUTO_APPROVE_CONFIDENCE_THRESHOLD) {
    return false;
  }
  return candidate.type === "group_fact" || Boolean(candidate.subjectUserId);
}

type CandidateLike = Pick<
  GroupMemoryCandidate,
  "groupId" | "type" | "subjectUserId" | "title" | "content" | "confidence" | "source" | "evidence"
>;

type DuplicateDecision =
  | { kind: "none" }
  | { kind: "skip"; memory: GroupMemory; similarity: number }
  | { kind: "refine_memory"; memory: GroupMemory; similarity: number }
  | { kind: "skip_candidate"; candidate: GroupMemoryCandidate; similarity: number }
  | { kind: "merge"; candidate: GroupMemoryCandidate; similarity: number };

function findDuplicateDecision(
  candidate: CandidateLike,
  memories: GroupMemory[],
  candidates: GroupMemoryCandidate[],
): DuplicateDecision {
  const comparableMemories = memories.filter((memory) => memory.enabled && sameScope(candidate, memory));
  const duplicateMemory = findMostSimilar(candidate, comparableMemories);
  if (duplicateMemory && duplicateMemory.similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
    if (isMoreSpecificMemory(candidate, duplicateMemory.item)) {
      return { kind: "refine_memory", memory: duplicateMemory.item, similarity: duplicateMemory.similarity };
    }
    return { kind: "skip", memory: duplicateMemory.item, similarity: duplicateMemory.similarity };
  }

  if (duplicateMemory && duplicateMemory.similarity >= RELATED_SIMILARITY_THRESHOLD) {
    const titleOverlap = textSimilarity(candidate.title, duplicateMemory.item.title);
    if (titleOverlap >= DUPLICATE_SIMILARITY_THRESHOLD && isMoreSpecificMemory(candidate, duplicateMemory.item)) {
      return { kind: "refine_memory", memory: duplicateMemory.item, similarity: duplicateMemory.similarity };
    }
  }

  const approvedCandidates = candidates.filter((item) => item.status === "approved" && sameScope(candidate, item));
  const duplicateApprovedCandidate = findMostSimilar(candidate, approvedCandidates);
  if (duplicateApprovedCandidate && duplicateApprovedCandidate.similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
    return {
      kind: "skip_candidate",
      candidate: duplicateApprovedCandidate.item,
      similarity: duplicateApprovedCandidate.similarity,
    };
  }

  const comparableCandidates = candidates.filter((item) => item.status === "pending" && sameScope(candidate, item));
  const duplicateCandidate = findMostSimilar(candidate, comparableCandidates);
  if (duplicateCandidate && duplicateCandidate.similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
    return { kind: "merge", candidate: duplicateCandidate.item, similarity: duplicateCandidate.similarity };
  }

  if (duplicateCandidate && duplicateCandidate.similarity >= RELATED_SIMILARITY_THRESHOLD) {
    const titleOverlap = textSimilarity(candidate.title, duplicateCandidate.item.title);
    if (titleOverlap >= DUPLICATE_SIMILARITY_THRESHOLD) {
      return { kind: "merge", candidate: duplicateCandidate.item, similarity: duplicateCandidate.similarity };
    }
  }

  return { kind: "none" };
}

function sameScope(
  left: Pick<GroupMemoryCandidate, "groupId" | "type" | "subjectUserId">,
  right: Pick<GroupMemory | GroupMemoryCandidate, "groupId" | "type" | "subjectUserId">,
): boolean {
  return left.groupId === right.groupId && left.type === right.type && (left.subjectUserId ?? "") === (right.subjectUserId ?? "");
}

function isDedupReferenceMemory(memory: GroupMemory): boolean {
  return memory.enabled && !memory.source.startsWith("daily_profile_review:");
}

function isMoreSpecificMemory(candidate: CandidateLike, memory: GroupMemory): boolean {
  if (candidate.confidence < AUTO_APPROVE_CONFIDENCE_THRESHOLD) {
    return false;
  }

  const candidateContent = candidate.content.trim();
  const memoryContent = memory.content.trim();
  if (candidateContent.length >= memoryContent.length + 24) {
    return true;
  }
  return false;
}

function findMostSimilar<T extends Pick<GroupMemory | GroupMemoryCandidate, "title" | "content">>(
  candidate: Pick<GroupMemoryCandidate, "title" | "content">,
  items: T[],
): { item: T; similarity: number } | undefined {
  let best: { item: T; similarity: number } | undefined;
  for (const item of items) {
    const similarity = memorySimilarity(candidate, item);
    if (!best || similarity > best.similarity) {
      best = { item, similarity };
    }
  }
  return best;
}

function memorySimilarity(
  left: Pick<GroupMemory | GroupMemoryCandidate, "title" | "content">,
  right: Pick<GroupMemory | GroupMemoryCandidate, "title" | "content">,
): number {
  const titleScore = textSimilarity(left.title, right.title);
  const contentScore = textSimilarity(left.content, right.content);
  const combinedScore = textSimilarity(`${left.title} ${left.content}`, `${right.title} ${right.content}`);
  return Math.max(titleScore * 0.35 + contentScore * 0.65, combinedScore);
}

function textSimilarity(left: string, right: string): number {
  const leftText = normalizeComparableText(left);
  const rightText = normalizeComparableText(right);
  if (!leftText || !rightText) {
    return 0;
  }
  if (leftText === rightText) {
    return 1;
  }
  if (leftText.includes(rightText) || rightText.includes(leftText)) {
    return 0.92;
  }

  const leftTokens = tokenizeComparableText(leftText);
  const rightTokens = tokenizeComparableText(rightText);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  const coverage = intersection / Math.min(leftSet.size, rightSet.size);
  const jaccard = intersection / union;
  return Math.max(jaccard, coverage * 0.88);
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(value: string): string[] {
  const tokens = value.match(/[\p{Script=Han}]|[a-z0-9]{2,}/gu) ?? [];
  return tokens.filter((token) => !isLowValueToken(token));
}

function isLowValueToken(token: string): boolean {
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

function chooseMoreSpecificText(current: string, incoming: string, limit: number): string {
  const normalizedIncoming = incoming.trim();
  if (!normalizedIncoming) {
    return current;
  }
  if (normalizedIncoming.length > current.trim().length) {
    return normalizedIncoming.slice(0, limit);
  }
  return current.trim().slice(0, limit);
}

function mergeEvidence(
  current: GroupMemoryEvidence | undefined,
  incoming: GroupMemoryEvidence,
): GroupMemoryEvidence {
  if (!current) {
    return incoming;
  }

  const speakerMap = new Map<string, string>();
  for (const speaker of [...current.speakers, ...incoming.speakers]) {
    if (!speakerMap.has(speaker.userId)) {
      speakerMap.set(speaker.userId, speaker.userName);
    }
  }
  const summary = `${current.summary} / ${incoming.summary}`.slice(0, EVIDENCE_SUMMARY_LIMIT);
  return {
    startAt: current.startAt.localeCompare(incoming.startAt) <= 0 ? current.startAt : incoming.startAt,
    endAt: current.endAt.localeCompare(incoming.endAt) >= 0 ? current.endAt : incoming.endAt,
    messageCount: current.messageCount + incoming.messageCount,
    speakers: [...speakerMap.entries()].map(([userId, userName]) => ({ userId, userName })).slice(0, 20),
    summary,
  };
}

function replaceMemory(memories: GroupMemory[], memory: GroupMemory): void {
  const index = memories.findIndex((item) => item.id === memory.id);
  if (index === -1) {
    memories.push(memory);
    return;
  }
  memories[index] = memory;
}

function replaceCandidate(candidates: GroupMemoryCandidate[], candidate: GroupMemoryCandidate): void {
  const index = candidates.findIndex((item) => item.id === candidate.id);
  if (index === -1) {
    candidates.push(candidate);
    return;
  }
  candidates[index] = candidate;
}

function buildEvidence(messages: BufferedMemoryMessage[]): GroupMemoryEvidence {
  const sortedMessages = [...messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const speakerMap = new Map<string, string>();
  for (const message of sortedMessages) {
    if (!speakerMap.has(message.userId)) {
      speakerMap.set(message.userId, message.userName);
    }
  }

  return {
    startAt: sortedMessages[0]?.timestamp ?? new Date().toISOString(),
    endAt: sortedMessages.at(-1)?.timestamp ?? sortedMessages[0]?.timestamp ?? new Date().toISOString(),
    messageCount: sortedMessages.length,
    speakers: [...speakerMap.entries()].map(([userId, userName]) => ({ userId, userName })),
    summary: summarizeEvidenceMessages(sortedMessages),
  };
}

function summarizeEvidenceMessages(messages: BufferedMemoryMessage[]): string {
  return messages
    .slice(0, EVIDENCE_MESSAGE_LIMIT)
    .map((message) => `${message.userName}(${message.userId}): ${message.text}`)
    .join(" / ")
    .slice(0, EVIDENCE_SUMMARY_LIMIT);
}
