import { AsyncLocalStorage } from "node:async_hooks";

import { logInfo } from "./logger.js";
import type { SharedDb } from "./shared/sqlite.js";
import type { OutboxContext } from "./shared/sqlite.js";
import type { ConversationRoute } from "./services/conversation-context-repository.js";
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
  private readonly routeStorage = new AsyncLocalStorage<ConversationRoute>();
  private conversationRoute?: ConversationRoute;

  constructor(
    private readonly db: SharedDb,
    private readonly readTransport?: Partial<MessageTransport>,
  ) {}

  /** Sets the route used by the next outbox send in the current worker task. */
  setConversationContext(route?: ConversationRoute): void {
    this.conversationRoute = route;
  }

  /** Keeps route metadata scoped to one async send chain under worker concurrency. */
  runWithConversationContext<T>(route: ConversationRoute, task: () => Promise<T>): Promise<T> {
    return this.routeStorage.run(route, task);
  }

  /** Completes the outbox -> assistant-turn link after the model reply exists. */
  bindConversationTurn(
    receipts: MessageReceipt[],
    route: ConversationRoute,
    turnId: number,
  ): void {
    const context: OutboxContext = {
      topicId: route.topicId,
      branchId: route.branchId,
      turnId,
    };
    this.db.attachOutboxContexts(
      receipts.flatMap((receipt) => receipt.deliveryId ? [receipt.deliveryId] : []),
      context,
    );
  }

  /** Rolls back unpublished drafts when assistant-turn persistence fails. */
  discardConversationDrafts(receipts: MessageReceipt[]): void {
    this.db.discardPreparingOutbox(
      receipts.flatMap((receipt) => receipt.deliveryId ? [receipt.deliveryId] : []),
    );
  }

  // ---- outbox-based sending ----

  async sendGroupMessage(groupId: string, text: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, text, "text", this.outboxContext());
    logInfo("Worker enqueued group message to outbox.", { outboxId: id, groupId });
    return { deliveryId: `outbox:${id}` };
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, recordFile, "record", this.outboxContext());
    logInfo("Worker enqueued record to outbox.", { outboxId: id, groupId });
    return { deliveryId: `outbox:${id}` };
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<MessageReceipt | undefined> {
    const id = this.db.enqueueOutbox(groupId, null, text, "airecord", this.outboxContext());
    logInfo("Worker enqueued AI record to outbox.", { outboxId: id, groupId });
    return { deliveryId: `outbox:${id}` };
  }

  private outboxContext(): OutboxContext | undefined {
    const route = this.routeStorage.getStore() ?? this.conversationRoute;
    if (!route) {
      return undefined;
    }
    // The assistant turn is created after enqueue; attach its id in
    // bindConversationTurn once all response segments are known.
    return {
      topicId: route.topicId,
      branchId: route.branchId,
      sourceTurnId: route.turnId,
    };
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
