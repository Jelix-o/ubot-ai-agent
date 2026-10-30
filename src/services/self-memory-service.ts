import { randomBytes } from "node:crypto";
import type { GroupMemory } from "../types.js";
import { AdminOperationLogService } from "./admin-operation-log-service.js";
import { containsSensitiveCredential } from "./explicit-memory-service.js";
import { assertRevision, revision } from "./state-mutation.js";
import type { V3StateRepository } from "./v3-state-repository.js";

interface DeleteConfirmation { code: string; expiresAt: number; snapshot: string }
export class SelfMemoryError extends Error {}

/** All ownership and revision checks happen in the authoritative write transaction. */
export class SelfMemoryService {
  private readonly audit: AdminOperationLogService;
  constructor(private readonly repo: V3StateRepository) { this.audit = new AdminOperationLogService("", repo); }

  list(groupId: string, userId: string, page = 1): { items: Array<GroupMemory & { revision: string }>; total: number; page: number } {
    this.checkAccess(groupId, userId);
    if (!Number.isInteger(page) || page < 1) throw new SelfMemoryError("invalid_page");
    const memories = this.owned(groupId, userId);
    return { items: memories.slice((page - 1) * 5, page * 5).map(m => ({ ...m, revision: revision(m) })), total: memories.length, page };
  }

  resolve(groupId: string, userId: string, selector: string): GroupMemory & { revision: string } {
    this.checkAccess(groupId, userId);
    if (selector.length < 8) throw new SelfMemoryError("memory_not_found");
    const matches = this.owned(groupId, userId).filter(m => m.id === selector || m.id.startsWith(selector));
    if (matches.length !== 1) throw new SelfMemoryError("memory_not_found");
    return { ...matches[0]!, revision: revision(matches[0]) };
  }

  edit(groupId: string, userId: string, id: string, content: string, expectedRevision: string): void {
    const value = content.replace(/\s+/gu, " ").trim();
    if (!value || [...value].length > 1800) throw new SelfMemoryError("invalid_content");
    if (containsSensitiveCredential(value)) throw new SelfMemoryError("sensitive_content");
    this.repo.runAtomically(() => {
      const current = this.target(groupId, userId, id, expectedRevision);
      this.repo.saveMemory({ ...current, title: [...value].slice(0, 80).join(""), content: value, updatedAt: new Date().toISOString() });
      this.record(groupId, userId, "memory_self_update", id);
    });
  }

  remove(groupId: string, userId: string, id: string, expectedRevision: string): void {
    this.repo.runAtomically(() => {
      this.target(groupId, userId, id, expectedRevision);
      this.repo.deleteMemory(id);
      this.record(groupId, userId, "memory_self_delete", id);
    });
  }

  prepareDeleteAll(groupId: string, userId: string, now = Date.now()): string {
    return this.repo.runAtomically(() => {
      this.checkAccess(groupId, userId);
      const code = randomBytes(4).toString("hex");
      this.repo.saveDocument("self-memory-delete-confirmation", `${groupId}:${userId}`, {
        code, expiresAt: now + 30_000, snapshot: revision(this.owned(groupId, userId)),
      } satisfies DeleteConfirmation, now);
      return code;
    });
  }

  confirmDeleteAll(groupId: string, userId: string, code: string, now = Date.now()): number {
    return this.repo.runAtomically(() => {
      this.checkAccess(groupId, userId);
      const key = `${groupId}:${userId}`;
      const confirm = this.repo.getDocument<DeleteConfirmation | null>("self-memory-delete-confirmation", key, null);
      if (!confirm || confirm.expiresAt <= now || confirm.code !== code) throw new SelfMemoryError("confirmation_invalid");
      const memories = this.owned(groupId, userId);
      if (revision(memories) !== confirm.snapshot) throw new SelfMemoryError("target_changed");
      for (const memory of memories) this.repo.deleteMemory(memory.id);
      this.repo.deleteDocument("self-memory-delete-confirmation", key);
      this.record(groupId, userId, "memory_self_delete_all", String(memories.length));
      return memories.length;
    });
  }

  private target(groupId: string, userId: string, id: string, expectedRevision: string): GroupMemory {
    this.checkAccess(groupId, userId);
    const current = this.repo.getMemory(id);
    if (!current || !this.isOwned(current, groupId, userId)) throw new SelfMemoryError("memory_not_found");
    assertRevision(current, { expectedRevision });
    return current;
  }
  private isOwned(memory: GroupMemory, groupId: string, userId: string): boolean {
    return memory.groupId === groupId && memory.subjectUserId === userId && memory.type === "member_profile"
      && ["explicit_command", "explicit_request"].includes(memory.source ?? "");
  }
  private owned(groupId: string, userId: string): GroupMemory[] {
    return this.repo.listMemories(groupId).filter(m => this.isOwned(m, groupId, userId)).sort((a, b) => a.id.localeCompare(b.id));
  }
  checkAccess(groupId: string, userId: string): void {
    const group = this.repo.getGroup(groupId);
    if (!group || group.enabled === false || !group.groupExperienceEnabled || group.botMuted
      || group.blacklistedUserIds?.includes(userId) || group.memoryDisabledUserIds?.includes(userId)) throw new SelfMemoryError("memory_unavailable");
  }
  private record(groupId: string, operatorUserId: string, action: string, target: string): void {
    this.audit.recordAtomic({ groupId, operatorUserId, action, target });
  }
}
