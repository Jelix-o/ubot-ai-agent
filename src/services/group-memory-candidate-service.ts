import { logWarn } from "../logger.js";
import type { GroupMemoryCandidate, GroupMemoryCandidateStatus } from "../types.js";
import type { AiService, MemoryCandidateExtractionMessage } from "./ai-service.js";
import type { GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.6;

interface BufferedMemoryMessage {
  groupId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
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

  async approve(
    id: string,
    patch: Partial<Pick<GroupMemoryCandidate, "title" | "content" | "type" | "subjectUserId" | "confidence">> = {},
  ): Promise<Awaited<ReturnType<GroupMemoryCandidateStore["approve"]>>> {
    return this.candidateStore.approve(id, this.memoryStore, patch);
  }

  async reject(id: string): Promise<GroupMemoryCandidate | undefined> {
    return this.candidateStore.reject(id);
  }

  async update(
    id: string,
    patch: Partial<Pick<GroupMemoryCandidate, "title" | "content" | "type" | "subjectUserId" | "confidence" | "status">>,
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

  async flushAll(): Promise<void> {
    await Promise.all([...this.buffers.keys()].map((groupId) => this.flushGroup(groupId)));
  }

  async flushGroup(groupId: string): Promise<void> {
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
      const candidates = await this.aiService.extractGroupMemoryCandidates({ groupId, messages });
      for (const candidate of candidates) {
        const result = await this.candidateStore.addCandidateWithResult({
          groupId,
          type: candidate.type,
          subjectUserId: candidate.subjectUserId,
          title: candidate.title,
          content: candidate.content,
          confidence: candidate.confidence,
          source: "auto",
        });
        if (shouldAutoApprove(result.candidate) && (result.created || result.candidate.status === "pending")) {
          await this.candidateStore.approve(result.candidate.id, this.memoryStore);
        }
      }
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
