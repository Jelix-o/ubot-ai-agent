import type { GroupMemory } from "../types.js";
import type { GroupMemoryStore } from "./group-memory-store.js";

const MEMORY_CONTENT_LIMIT = 1_800;
const MEMORY_TITLE_LIMIT = 80;

export type ExplicitMemorySource = "explicit_command" | "explicit_request";

export interface ExplicitMemoryCaptureInput {
  groupId: string;
  userId: string;
  userName: string;
  content: string;
  source: ExplicitMemorySource;
  createdAt?: string;
}

export type ExplicitMemoryCaptureResult =
  | { status: "created"; memory: GroupMemory }
  | { status: "duplicate"; memory: GroupMemory }
  | { status: "empty" }
  | { status: "disabled" }
  | { status: "unsafe" };

/**
 * Stores only content a member explicitly asks the bot to remember. This service
 * deliberately has no model dependency: it never infers facts from ambient chat
 * or attributes a statement to someone other than the sender.
 */
export class ExplicitMemoryService {
  constructor(private readonly memoryStore: GroupMemoryStore) {}

  async capture(
    input: ExplicitMemoryCaptureInput,
    options: { memoryDisabled?: boolean } = {},
  ): Promise<ExplicitMemoryCaptureResult> {
    if (options.memoryDisabled === true) {
      return { status: "disabled" };
    }

    const content = normalizeContent(input.content);
    if (!content) {
      return { status: "empty" };
    }
    if (containsSensitiveCredential(content)) {
      return { status: "unsafe" };
    }

    const normalizedContent = comparableContent(content);
    const existing = (await this.memoryStore.list(input.groupId)).find((memory) =>
      memory.type === "member_profile" &&
      memory.subjectUserId === input.userId &&
      comparableContent(memory.content) === normalizedContent,
    );
    if (existing) {
      return { status: "duplicate", memory: existing };
    }

    const createdAt = input.createdAt ?? new Date().toISOString();
    const memory = await this.memoryStore.create({
      groupId: input.groupId,
      type: "member_profile",
      subjectUserId: input.userId,
      title: buildMemoryTitle(content),
      content,
      confidence: 1,
      source: input.source,
      enabled: true,
      createdAt,
      evidence: {
        startAt: createdAt,
        endAt: createdAt,
        messageCount: 1,
        speakers: [{ userId: input.userId, userName: input.userName.trim().slice(0, 80) || input.userId }],
        // Keep the provenance useful without copying the member's full request a
        // second time into a second data field.
        summary: input.source === "explicit_command"
          ? "成员通过 #记忆 明确保存此条记忆。"
          : "成员通过明确“请记住/请记忆”请求保存此条记忆。",
      },
    });
    return { status: "created", memory };
  }
}

function normalizeContent(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MEMORY_CONTENT_LIMIT);
}

function buildMemoryTitle(content: string): string {
  const clipped = content.slice(0, MEMORY_TITLE_LIMIT).replace(/\s+/g, " ").trim();
  return clipped.length < content.length ? `${clipped.slice(0, MEMORY_TITLE_LIMIT - 1)}…` : clipped;
}

function comparableContent(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function containsSensitiveCredential(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    /-----begin [a-z ]*private key-----/i,
    /\b(?:api[_ -]?key|access[_ -]?token|authorization|bearer|secret|password|passwd)\b/i,
    /(?:密码|口令|令牌|密钥|私钥|访问令牌|授权码)\s*(?:是|为|:|：|=)/u,
    /\bsk-[a-z0-9_-]{12,}\b/i,
    /\bakia[0-9a-z]{16}\b/i,
  ].some((pattern) => pattern.test(normalized));
}
