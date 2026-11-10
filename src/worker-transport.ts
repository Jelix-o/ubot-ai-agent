import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { logInfo } from "./logger.js";
import { BT_FORWARD_FALLBACK_TEXT, serializeForwardNodes, type ForwardMessageNode } from "./forward-message.js";
import { ConversationReplyEnvelopeError } from "./services/conversation-state.js";
import { hasUnsafeReplyArtifacts } from "./services/reply-artifacts.js";
import type { OutboxDeliveryPurpose, OutboxContext, SharedDb } from "./shared/sqlite.js";
import type { ConversationRoute } from "./services/conversation-context-repository.js";
import type { ForwardAutoRecallOptions, MessageReceipt, MessageTransport, TransportHealthStatus } from "./bot.js";
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
  private readonly requestStorage = new AsyncLocalStorage<number>();
  private readonly batchStorage = new AsyncLocalStorage<{ batchId: string; delayBeforeMs: number }>();
  private conversationRoute?: ConversationRoute;

  constructor(
    private readonly db: SharedDb,
    private readonly readTransport?: Partial<MessageTransport>,
  ) {}

  /** Sets the route used by the next outbox send in the current worker task. */
  setConversationContext(route?: ConversationRoute): void {
    this.conversationRoute = route;
  }

  runWithRequestContext<T>(sourceRowId: number, task: () => Promise<T>): Promise<T> {
    return this.requestStorage.run(sourceRowId, task);
  }

  private enqueueOutbox(...args: Parameters<SharedDb["enqueueOutbox"]>): number {
    const id = this.db.enqueueOutbox(...args);
    const source = this.requestStorage.getStore();
    if (source !== undefined) this.db.db.prepare("UPDATE outbox SET request_source_row_id=? WHERE id=?").run(source, id);
    return id;
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

  async sendGroupMessage(
    groupId: string,
    text: string,
    options?: { replyToMessageId?: string; deliveryPurpose?: OutboxDeliveryPurpose },
  ): Promise<MessageReceipt | undefined> {
    const route = this.routeStorage.getStore() ?? this.conversationRoute;
    // A routed text send is a user-facing conversation reply. Do not persist
    // private reply-envelope fields even when a caller bypasses BotApplication.
    const input = route ? this.db.db.prepare("SELECT text FROM messages WHERE id = ?").get(route.sourceRowId) as { text: string } | undefined : undefined;
    if (route && hasUnsafeReplyArtifacts(text, input?.text)) {
      throw new ConversationReplyEnvelopeError();
    }
    const id = this.enqueueOutbox(
      groupId,
      options?.replyToMessageId ?? route?.sourceMessageId ?? null,
      text,
      "text",
      this.outboxContext(),
      undefined,
      undefined,
      undefined,
      this.batchStorage.getStore(),
      options?.deliveryPurpose ?? "chat",
    );
    logInfo("Worker enqueued group message to outbox.", { outboxId: id, groupId });
    return { deliveryId: `outbox:${id}` };
  }

  async sendGroupMessageBatch(groupId: string, texts: string[]): Promise<MessageReceipt[]> {
    const route = this.routeStorage.getStore() ?? this.conversationRoute;
    const input = route ? this.db.db.prepare("SELECT text FROM messages WHERE id = ?").get(route.sourceRowId) as { text: string } | undefined : undefined;
    if (route && hasUnsafeReplyArtifacts(texts.join("\n"), input?.text)) throw new ConversationReplyEnvelopeError();
    const batchId = randomUUID();
    const receipts: MessageReceipt[] = [];
    for (const [index, text] of texts.entries()) {
      const receipt = await this.batchStorage.run(
        { batchId, delayBeforeMs: index === 0 ? 0 : 1500 + Math.floor(Math.random() * 2001) },
        () => this.sendGroupMessage(groupId, text),
      );
      if (!receipt) continue;
      receipts.push(receipt);
    }
    return receipts;
  }

  async sendMemeGroupImage(groupId: string, assetId: string, afterDeliveryId?: string): Promise<MessageReceipt> {
    const previous = afterDeliveryId ? this.db.db.prepare("SELECT batch_id,topic_id,branch_id,source_turn_id,turn_id FROM outbox WHERE delivery_id=? AND group_id=? AND kind='text'")
      .get(afterDeliveryId, groupId) as { batch_id: string | null; topic_id: string | null; branch_id: string | null; source_turn_id: number | null; turn_id: number | null } | undefined : undefined;
    const context: OutboxContext | undefined = previous?.topic_id && previous.branch_id && previous.turn_id !== null
      ? { topicId: previous.topic_id, branchId: previous.branch_id, turnId: previous.turn_id, sourceTurnId: previous.source_turn_id ?? undefined }
      : undefined;
    const id = this.enqueueOutbox(groupId, null, assetId, "meme_image", context, undefined, undefined, undefined,
      previous?.batch_id ? { batchId: previous.batch_id, delayBeforeMs: 0 } : undefined);
    return { deliveryId: `outbox:${id}` };
  }

  async sendGroupForwardMessage(groupId: string, nodes: ForwardMessageNode[], options?: ForwardAutoRecallOptions): Promise<MessageReceipt> {
    const id = this.enqueueOutbox(
      groupId,
      null,
      BT_FORWARD_FALLBACK_TEXT,
      "forward",
      this.outboxContext(),
      serializeForwardNodes(nodes),
      options?.autoRecall,
    );
    logInfo("Worker enqueued forward message to outbox.", { outboxId: id, groupId, nodeCount: nodes.length });
    return { deliveryId: `outbox:${id}` };
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<MessageReceipt | undefined> {
    const id = this.enqueueOutbox(groupId, null, imageFile, "image", this.outboxContext());
    logInfo("Worker enqueued image to outbox.", { outboxId: id, groupId });
    return { deliveryId: `outbox:${id}` };
  }

  async sendGeneratedGroupImage(groupId: string, imagePath: string, options?: {
    imagePreviewId?: string;
    imageRequestId?: string;
  }): Promise<MessageReceipt | undefined> {
    if (options?.imageRequestId) {
      if (!options.imagePreviewId) throw new Error("image_request_preview_required");
      const outbox = this.db.enqueueGeneratedImageOutboxForRequest({
        requestId: options.imageRequestId,
        groupId,
        imagePath,
        imagePreviewId: options.imagePreviewId,
        context: this.outboxContext(),
      });
      logInfo("Worker enqueued generated image request to outbox.", {
        outboxId: outbox.outboxId,
        groupId,
        reused: !outbox.created,
      });
      return { deliveryId: `outbox:${outbox.outboxId}` };
    }
    const id = this.enqueueOutbox(groupId, null, imagePath, "generated_image", this.outboxContext(), undefined, undefined, options?.imagePreviewId);
    logInfo("Worker enqueued generated image to outbox.", { outboxId: id, groupId });
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

  listGroupMembers?(groupId: string, options?: { refresh?: boolean }): Promise<NapcatGroupMember[]> {
    return this.readTransport?.listGroupMembers
      ? this.readTransport.listGroupMembers(groupId, options)
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
