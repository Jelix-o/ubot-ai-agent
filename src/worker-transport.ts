import { logInfo } from "./logger.js";
import type { SharedDb } from "./shared/sqlite.js";
import type { MessageReceipt, MessageTransport, TransportHealthStatus } from "./bot.js";
import type {
  GroupMemberIdentity,
  MessageImageInput,
  NapcatGroupInfo,
  NapcatGroupMember,
  ReferencedMessage,
} from "./types.js";

/**
 * Worker-side transport adapter.
 *
 * The worker does NOT own the NapCat reverse WebSocket (the ingress process
 * does). Sending is done through the shared outbox table, which the ingress
 * process drains and delivers over the action channel. Read-only NapCat APIs
 * (group members, referenced messages, image materialization) are still
 * reachable through the action channel — the ingress exposes them via shared
 * tables/HTTP-free JSON files is overkill, so the worker opens its own WS
 * action client only when the transport is NapCat and provides the read APIs.
 *
 * For simplicity and single-process NapCat compatibility, the worker connects
 * a *second* WS to the same NapCat reverse WS endpoint when available — NapCat
 * accepts multiple downstream connections in many builds; when it does not,
 * the worker falls back to read-only modes returning empty results.
 */
export class WorkerTransport implements MessageTransport {
  constructor(
    private readonly db: SharedDb,
    private readonly readTransport?: Partial<MessageTransport>,
  ) {}

  // ---- outbox-based sending ----

  async sendGroupMessage(groupId: string, text: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, text, "text");
    logInfo("Worker enqueued group message to outbox.", { outboxId: id, groupId });
    return { messageId: `outbox:${id}` };
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, recordFile, "record");
    logInfo("Worker enqueued record to outbox.", { outboxId: id, groupId });
    return { messageId: `outbox:${id}` };
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, text, "airecord");
    logInfo("Worker enqueued AI record to outbox.", { outboxId: id, groupId });
    return { messageId: `outbox:${id}` };
  }

  // ---- read APIs delegated to the read transport (optional) ----

  resolveImageInputs?(images: MessageImageInput[]): Promise<MessageImageInput[]> {
    return this.readTransport?.resolveImageInputs
      ? this.readTransport.resolveImageInputs(images)
      : Promise.resolve(images.filter((image) => Boolean(image.url)));
  }

  listGroupMembers?(groupId: string): Promise<NapcatGroupMember[]> {
    return this.readTransport?.listGroupMembers
      ? this.readTransport.listGroupMembers(groupId)
      : Promise.resolve([]);
  }

  listGroups?(): Promise<NapcatGroupInfo[]> {
    return this.readTransport?.listGroups ? this.readTransport.listGroups() : Promise.resolve([]);
  }

  resolveMentionTargets?(groupId: string, candidates: string[]): Promise<string[]> {
    return this.readTransport?.resolveMentionTargets
      ? this.readTransport.resolveMentionTargets(groupId, candidates)
      : Promise.resolve(candidates.filter((candidate) => /^\d+$/.test(candidate)));
  }

  resolveMemberIdentities?(groupId: string, candidates: string[]): Promise<GroupMemberIdentity[]> {
    return this.readTransport?.resolveMemberIdentities
      ? this.readTransport.resolveMemberIdentities(groupId, candidates)
      : Promise.resolve([]);
  }

  getMessage?(messageId: string): Promise<ReferencedMessage | undefined> {
    return this.readTransport?.getMessage
      ? this.readTransport.getMessage(messageId)
      : Promise.resolve(undefined);
  }

  getHealthStatus?(): Promise<TransportHealthStatus> {
    return this.readTransport?.getHealthStatus
      ? this.readTransport.getHealthStatus()
      : Promise.resolve({ ok: true, detail: "Worker outbox transport (health via ingress unavailable)." });
  }
}
