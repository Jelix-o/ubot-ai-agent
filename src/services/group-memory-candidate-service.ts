import { logInfo, logWarn } from "../logger.js";
import type { GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryEvidence } from "../types.js";
import type { AiService, MemoryCandidateExtractionMessage } from "./ai-service.js";
import type { GroupMemoryCandidateListPageArgs, GroupMemoryCandidateListPageResult, GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;
const EVIDENCE_MESSAGE_LIMIT = 30;
const EVIDENCE_SUMMARY_LIMIT = 2400;

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

  async listPage(args: GroupMemoryCandidateListPageArgs): Promise<GroupMemoryCandidateListPageResult> {
    return this.candidateStore.listPage(args);
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
      text: normalizedText.slice(0, 300),
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
      const candidates = await this.aiService.extractGroupMemoryCandidates({ groupId, messages });
      let autoApprovedCount = 0;
      let pendingCount = 0;
      for (const candidate of candidates) {
        const subjectUserId =
          candidate.type === "member_profile" && candidate.subjectUserId && speakerIds.has(candidate.subjectUserId)
            ? candidate.subjectUserId
            : undefined;
        const forcedPending = candidate.type === "member_profile" && candidate.subjectUserId && !subjectUserId;
        const result = await this.candidateStore.addCandidateWithResult({
          groupId,
          type: candidate.type,
          subjectUserId,
          title: candidate.title,
          content: candidate.content,
          confidence: candidate.confidence,
          source: "auto",
          evidence,
        });
        if (!forcedPending && shouldAutoApprove(result.candidate) && (result.created || result.candidate.status === "pending")) {
          await this.candidateStore.approve(result.candidate.id, this.memoryStore);
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
