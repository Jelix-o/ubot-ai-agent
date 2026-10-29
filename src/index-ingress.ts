import { MemeLibraryService } from "./services/meme-library-service.js";
import { GroupInteractionService, type GroupPokeEvent } from "./services/group-interaction-service.js";
import { loadConfig } from "./config.js";
import { parseForwardNodes, sendForwardOrFallback } from "./forward-message.js";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { logError, logInfo, logWarn } from "./logger.js";
import {
  NapCatActionNotSentError,
  NapCatActionOutcomeUnknownError,
  NapCatReverseServer,
} from "./napcat-reverse-server.js";
import { openSharedDb, type OutboxRow, type SharedDb } from "./shared/sqlite.js";
import { resolveV3RuntimeState } from "./services/v3-runtime-state.js";
import { hasUnsafeReplyArtifacts } from "./services/reply-artifacts.js";
import { Metrics } from "./shared/metrics.js";
import { IngressReadApi } from "./ingress-read-api.js";
import { MessageRecallService } from "./message-recall-service.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import {
  restoreCanonicalMessageSegments,
  serializeCanonicalMessageSegments,
} from "./utils/persisted-message-segments.js";
import type { NapcatGroupMessageEvent } from "./types.js";
import type { MessageReceipt, MessageTransport } from "./bot.js";
import {
  IMAGE_GENERATION_MAX_BYTES,
  isGeneratedImagePath,
  isSupportedGeneratedImage,
} from "./services/image-generation-service.js";

/**
 * Ingress process (plan section 1):
 *   - Single process that owns the NapCat reverse WebSocket.
 *   - Only does: validate → dedupe → deliver events (no business logic).
 *   - Emits events into the shared `messages` table; workers poll per key.
 *   - Also owns the Emitter half: polls the `outbox` table and sends replies
 *     back through NapCat with idempotent reply_to (the worker cannot own the
 *     reverse WS connection).
 */

const BACKLOG_MAX_AGE_MS = 60_000;
const TOKEN_BUCKET_MAX_PER_WINDOW = 6;
const TOKEN_BUCKET_WINDOW_MS = 10_000;
const RETRACTED_TTL_MS = 24 * 60 * 60 * 1000;
const BOT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMITTER_POLL_MS = 400;
const EMITTER_BATCH_SIZE = 20;

/**
 * OneBot timestamps describe the source event, but are not a retention
 * authority. A future timestamp would otherwise extend raw-content retention
 * and can also distort route windows, so receipt time wins in that case.
 */
export function normalizeIngressMessageTime(eventTimeSeconds: unknown, receivedAtMs: number): number {
  const seconds = typeof eventTimeSeconds === "number"
    ? eventTimeSeconds
    : Number(eventTimeSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return receivedAtMs;
  }
  const eventTimeMs = Math.trunc(seconds * 1_000);
  if (!Number.isSafeInteger(eventTimeMs)) {
    return receivedAtMs;
  }
  return Math.min(eventTimeMs, receivedAtMs);
}

async function resolveGeneratedImageFile(rootDir: string | undefined, filePath: string): Promise<string> {
  const outside = () => new Error("Generated image outbox path is outside the managed directory.");
  if (!rootDir) throw outside();
  let root: string, parent: string;
  try {
    [root, parent] = await Promise.all([realpath(rootDir), realpath(path.dirname(filePath))]);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw outside();
    throw error;
  }
  // Release directories may alias the same data directory. Resolve parents
  // only so that lstat still rejects a symlink in the final file component.
  const resolved = path.join(parent, path.basename(filePath));
  if (!isGeneratedImagePath(root, resolved)) throw outside();
  const entry = await lstat(resolved);
  if (!entry.isFile()) throw outside();
  if (entry.size === 0 || entry.size > IMAGE_GENERATION_MAX_BYTES) {
    throw new Error("Generated image outbox file has an invalid size or type.");
  }
  return resolved;
}

/**
 * Delivers one already-claimed outbox row and commits the real platform id.
 * Keeping this boundary outside IngressApp makes the cross-process receipt
 * handoff testable without opening a second NapCat server or timer loop.
 */
export async function deliverOutboxRow(
  sharedDb: SharedDb,
  transport: MessageTransport,
  row: OutboxRow,
  sentAtMs?: number,
  onAckFailure?: (error: unknown) => void,
  generatedImageRoot?: string,
  memeLibrary?: Pick<MemeLibraryService, "loadImageFile" | "getAsset">,
): Promise<string | undefined> {
  // Old workers or manual recovery can leave malformed private reply metadata
  // in a contextual outbox row. Stop it before any QQ send and leave a
  // terminal record for inspection instead of retrying the same leak.
  if (isMalformedConversationOutboxRow(row, sharedDb)) {
    sharedDb.markOutboxFailed(row.id, null);
    throw new ConversationOutboxEnvelopeError();
  }
  let receipt: MessageReceipt | void;
  let deliveredForward = false;
  let generatedImagePath: string | undefined;
  if (row.kind === "poke") {
    if (!transport.sendGroupPoke || Date.now() - row.created_at > 60_000 || !/^\d+$/.test(row.text)) throw new Error("poke_expired_or_unsupported");
    await transport.sendGroupPoke(row.group_id, row.text);
    sharedDb.markOutboxSent(row.id);
    return undefined;
  }
  if (row.kind === "meme_image") {
    const asset = await memeLibrary?.getAsset(row.text);
    const image = asset?.enabled ? await memeLibrary?.loadImageFile(row.text) : undefined;
    if (!image) throw new Error("meme_asset_unavailable");
    receipt = await transport.sendGroupImage(row.group_id, image);
  } else if (row.kind === "record" || row.kind === "airecord") {
    throw new Error("Retired voice outbox kind cannot be delivered.");
  } else if (row.kind === "forward") {
    const delivery = await sendForwardOrFallback(
      transport,
      row.group_id,
      parseForwardNodes(row.forward_payload_json),
      row.text,
      row.auto_recall_after_ms !== null && row.auto_recall_deadline_ms !== null
        ? { autoRecall: { afterMs: row.auto_recall_after_ms, deadlineMs: row.auto_recall_deadline_ms } }
        : undefined,
    );
    receipt = delivery.receipt;
    deliveredForward = delivery.kind === "forward";
  } else if (row.kind === "image") {
    receipt = await transport.sendGroupImage(row.group_id, row.text);
  } else if (row.kind === "generated_image") {
    generatedImagePath = await resolveGeneratedImageFile(generatedImageRoot, row.text);
    const image = await readFile(generatedImagePath);
    if (image.byteLength === 0 || image.byteLength > IMAGE_GENERATION_MAX_BYTES || !isSupportedGeneratedImage(image)) {
      throw new Error("Generated image outbox file has an invalid size or type.");
    }
    receipt = await transport.sendGroupImage(row.group_id, `base64://${image.toString("base64")}`);
  } else {
    receipt = await transport.sendGroupMessage(row.group_id, row.text, row.reply_to ? { replyToMessageId: row.reply_to } : undefined);
  }
  const platformMessageId = receipt?.platformMessageId ?? receipt?.messageId;
  if (!platformMessageId) {
    if (row.kind === "forward") throw new NapCatActionOutcomeUnknownError("Forward send succeeded without a real platform message id");
    throw new Error("NapCat send succeeded without a real platform message id");
  }
  try {
    // The success receipt, rather than the queued time, starts an adult card's
    // display window. A text fallback explicitly cannot create a recall job.
    sharedDb.ackOutboxDelivery(row.id, platformMessageId, sentAtMs ?? Date.now(), {
      actualForward: deliveredForward,
    });
  } catch (error) {
    if (generatedImagePath) await rm(generatedImagePath, { force: true }).catch(() => undefined);
    onAckFailure?.(error);
    // Never return this row to the send retry queue: the QQ action succeeded,
    // so retrying would create a duplicate. The row remains `sending` for
    // reconciliation/alerting with its causal turn still intact.
    throw new OutboxAcknowledgementError(platformMessageId, error);
  }
  if (generatedImagePath) await rm(generatedImagePath, { force: true }).catch(() => undefined);
  return platformMessageId;
}

export class OutboxAcknowledgementError extends Error {
  constructor(
    readonly platformMessageId: string,
    readonly cause: unknown,
  ) {
    super("QQ send succeeded but the outbox acknowledgement could not be persisted");
    this.name = "OutboxAcknowledgementError";
  }
}

/** A contextual outbox row contains private conversation reply metadata. */
export class ConversationOutboxEnvelopeError extends Error {
  constructor() {
    super("Refused to deliver malformed conversation reply envelope");
    this.name = "ConversationOutboxEnvelopeError";
  }
}

function isMalformedConversationOutboxRow(row: OutboxRow, sharedDb: SharedDb): boolean {
  const contextual = Boolean(
    row.topic_id ||
    row.branch_id ||
    row.source_turn_id !== null ||
    row.turn_id !== null,
  );
  const input = contextual && row.source_turn_id !== null
    ? sharedDb.db.prepare("SELECT content FROM conversation_turns WHERE id = ? AND role = 'user'").get(row.source_turn_id) as { content: string } | undefined : undefined;
  return row.kind === "text" && contextual && hasUnsafeReplyArtifacts(row.text, input?.content);
}

export type OutboxFailureDisposition = "retryable" | "terminal";

export function markOutboxDeliveryFailed(
  sharedDb: SharedDb,
  row: Pick<OutboxRow, "id" | "kind">,
  error: unknown,
): OutboxFailureDisposition {
  const retiredVoice = row.kind === "record" || row.kind === "airecord";
  const retryable = !(error instanceof ConversationOutboxEnvelopeError) &&
    !retiredVoice &&
    (!["generated_image", "forward", "poke", "meme_image"].includes(row.kind) || error instanceof NapCatActionNotSentError);
  sharedDb.markOutboxFailed(row.id, retryable ? 2_000 : null);
  return retryable ? "retryable" : "terminal";
}

interface IngressOptions {
  botQq: string;
  dataDir: string;
  metricsDir: string;
  /** Enables V3-only read checks used by narrow ingress policy exceptions. */
  stateEncryptionKey?: string;
}

export class IngressApp {
  private readonly sharedDb: SharedDb;
  private readonly metrics: Metrics;
  private readonly transport: MessageTransport;
  private readonly emitterTimer: NodeJS.Timeout;
  private readonly maintenanceTimer: NodeJS.Timeout;
  private readonly messageRecalls: MessageRecallService;
  private readonly memeLibrary: MemeLibraryService;
  private readonly interactions: GroupInteractionService;
  private readonly v3State: ReturnType<typeof resolveV3RuntimeState>;
  private emitterInFlight?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly options: IngressOptions,
    transport?: MessageTransport,
  ) {
    const config = loadConfig();
    this.sharedDb = openSharedDb(this.options.dataDir);
    this.v3State = this.options.stateEncryptionKey
      ? resolveV3RuntimeState(this.sharedDb, this.options.stateEncryptionKey)
      : undefined;
    this.v3State?.retireRoastModeForExistingGroupsOnce();
    this.memeLibrary = new MemeLibraryService(options.dataDir, this.v3State);
    this.interactions = new GroupInteractionService(this.sharedDb, options.botQq);
    this.metrics = new Metrics(this.options.metricsDir, {
      processName: "ingress",
      flushIntervalMs: 30_000,
    });
    this.transport = transport ?? new NapCatReverseServer({
      host: config.napcatReverseWsHost,
      port: config.napcatReverseWsPort,
      path: config.napcatReverseWsPath,
      accessToken: config.napcatAccessToken,
    });

    if (typeof this.transport.sendGroupMessage !== "function") {
      throw new Error("Ingress requires a transport that can send group messages.");
    }
    this.messageRecalls = new MessageRecallService(this.sharedDb, this.transport, {
      onMetric: (name, by) => this.metrics.inc(name, by),
    });

    // Subscribe to incoming group messages and recall notices.
    const runtime = this.transport as MessageTransport & {
      on?(event: string, listener: (payload: unknown) => void): unknown;
    };
    if (typeof runtime.on === "function") {
      runtime.on("groupMessage", (event) => {
        void this.handleGroupMessage(event as NapcatGroupMessageEvent);
      });
      runtime.on("groupPoke", (payload) => {
        const event = payload as GroupPokeEvent;
        this.interactions.queuePoke(event, this.v3State?.getGroup(String(event.group_id)));
      });
      runtime.on("groupRecall", (payload) => {
        this.handleRecall(payload);
      });
    } else {
      throw new Error("Ingress requires a transport that emits groupMessage events.");
    }

    this.emitterTimer = setInterval(() => {
      void this.runEmitterSafely();
    }, EMITTER_POLL_MS);
    this.emitterTimer.unref();

    this.maintenanceTimer = setInterval(() => {
      this.maintain();
    }, 60_000);
    this.maintenanceTimer.unref();

    // Localhost read API so the worker can use NapCat read actions.
    this.readApi = new IngressReadApi(
      this.transport,
      config.ingressReadApiPort,
      config.ingressReadApiToken,
    );
  }

  private readonly readApi: IngressReadApi;

  async start(): Promise<void> {
    try {
      await this.readApi.start();
      const withStart = this.transport as MessageTransport & { start?: () => void | Promise<void> };
      if (typeof withStart.start === "function") {
        await withStart.start();
      }
      this.messageRecalls.start();
      logInfo("Ingress started.", {
        botQq: this.options.botQq,
        dataDir: this.options.dataDir,
      });
    } catch (error) {
      await this.stop().catch((cleanupError) => {
        logWarn("Ingress startup cleanup failed.", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
      throw error;
    }
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.stopInternal();
    }
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    clearInterval(this.emitterTimer);
    clearInterval(this.maintenanceTimer);
    let cleanupError: unknown;
    const recordCleanupError = (error: unknown) => {
      cleanupError ??= error;
    };

    await this.emitterInFlight?.catch(recordCleanupError);
    await this.messageRecalls.stop().catch(recordCleanupError);
    try {
      this.metrics.stop();
    } catch (error) {
      recordCleanupError(error);
    }
    await this.readApi.close().catch(recordCleanupError);
    const withClose = this.transport as MessageTransport & { close?: () => void };
    try {
      if (typeof withClose.close === "function") {
        withClose.close();
      }
    } catch (error) {
      recordCleanupError(error);
    } finally {
      // All ingress work has stopped before the shared connection is closed.
      this.sharedDb.close();
    }
    if (cleanupError) throw cleanupError;
    logInfo("Ingress stopped.");
  }

  // ---- message ingress ----

  private async handleGroupMessage(event: NapcatGroupMessageEvent): Promise<void> {
    const groupId = String(event.group_id);
    const userId = String(event.user_id);
    const selfId = event.self_id !== undefined ? String(event.self_id) : "";
    const msgId = String(event.message_id);

    // Bot's own messages must never trigger the bot (plan section 8.2).
    // 判断依据：userId 等于 bot 自己（self_id 是事件归属的 bot 账号，
    // NapCat 单账号下对所有事件恒等于 botQq，不能用来判断"谁发的"）。
    if (userId === this.options.botQq || (selfId && userId === selfId)) {
      this.metrics.inc("bot_self_trigger_blocked");
      logInfo("Ignored bot self message.", { groupId, userId, msgId, selfId });
      return;
    }

    // Parse only the controlled representation. Raw CQ-looking text cannot
    // establish a bot mention, a reply relationship, an image input, or an
    // avatar target: those privileges require a structured platform segment.
    const canonicalSegmentsJson = serializeCanonicalMessageSegments(event.message);
    const parsed = parseGroupMessage(
      restoreCanonicalMessageSegments(canonicalSegmentsJson) ?? [],
      this.options.botQq,
    );
    const blacklistedAtBot = parsed.hasAtBot && this.isV3BlacklistedUser(groupId, userId);
    // A lone platform @ segment normally remains an empty message. The sole
    // exception is a current V3 blacklisted member, whose @ needs to reach the
    // worker for the fixed image response.
    // Keep a genuine bare @bot long enough for the natural-image parser to
    // return its compact usage hint.  It is still an ordinary empty message
    // when that entry point is disabled, so the Worker drops it before any
    // participation or chat handling.
    if (!parsed.text && parsed.images.length === 0 && !parsed.hasAtBot && !blacklistedAtBot) {
      return;
    }
    const { images } = parsed;

    // Backlog detection (plan section 8 Bonus): messages pushed after a
    // reconnect that are older than 60s must not trigger replies.
    const receivedAt = Date.now();
    const msgTimeMs = normalizeIngressMessageTime(event.time, receivedAt);
    if (receivedAt - msgTimeMs > BACKLOG_MAX_AGE_MS) {
      this.metrics.inc("backlog_detected");
      logInfo("Ignored backlog message after reconnect.", {
        groupId,
        userId,
        msgId,
        ageMs: receivedAt - msgTimeMs,
      });
      return;
    }

    // Idempotent dedupe (plan section 2.1): (self_bot_id, group_id, msg_id).
    // self_id 缺失时用 botQq 作为 dedup key 的一部分（保证幂等键稳定）。
    // Per-group token bucket: persist excess messages as non-processable audit
    // events. A V3-persisted blacklisted member who explicitly @s the bot is
    // the sole exception: every such mention must reach the worker's fixed
    // image response. All other traffic, including a blacklisted member who
    // did not @ the bot, remains rate-limited normally.
    const count = this.sharedDb.countMessagesSince(groupId, receivedAt - TOKEN_BUCKET_WINDOW_MS);
    const rateLimitExceeded = count >= TOKEN_BUCKET_MAX_PER_WINDOW;
    const dropReason = rateLimitExceeded && !blacklistedAtBot ? "rate_limited" : undefined;
    if (rateLimitExceeded && blacklistedAtBot) {
      this.metrics.inc("token_bucket_blacklisted_mention_bypassed");
      logInfo("Bypassed token bucket for blacklisted bot mention.", {
        groupId,
        userId,
        msgId,
        count: count + 1,
        windowMs: TOKEN_BUCKET_WINDOW_MS,
      });
    }
    const createdAt = receivedAt;
    const rowId = this.sharedDb.insertMessage({
      groupId,
      userId,
      selfId: selfId || this.options.botQq,
      msgId,
      msgTime: msgTimeMs,
      text: parsed.text,
      imagesJson: JSON.stringify(images),
      senderCard: event.sender?.card,
      senderNickname: event.sender?.nickname,
      senderRole: event.sender?.role,
      replyTo: parsed.replyMessageId,
      verifiedMentionUserIds: parsed.verifiedMentionUserIds,
      canonicalSegmentsJson,
      hasAtBot: parsed.hasAtBot,
      isBotMsg: false,
      processable: !dropReason,
      dropReason,
      createdAt,
    });
    if (rowId === 0) {
      this.metrics.inc("dedup_hit");
      logInfo("Dedup hit, skipping message.", { groupId, userId, msgId });
      return;
    }
    this.metrics.inc("msg_ingress");

    if (dropReason) {
      this.sharedDb.recordParticipationDecision({
        sourceRowId: rowId,
        groupId,
        userId,
        action: "ignore",
        reason: dropReason,
        score: 0,
        policyVersion: "ingress-rate-limit-v1",
        signals: { rateLimited: true },
        createdAt,
      });
      this.metrics.inc("token_bucket_dropped");
      logInfo("Token bucket exceeded; queued a non-processable message audit record.", {
        groupId,
        userId,
        msgId,
        count: count + 1,
        windowMs: TOKEN_BUCKET_WINDOW_MS,
      });
      return;
    }

    logInfo("Message ingested.", {
      groupId,
      userId,
      msgId,
      hasAtBot: parsed.hasAtBot,
      textLength: parsed.text.length,
      imageCount: images.length,
      replyTo: parsed.replyMessageId,
    });
  }

  /** Recall handling (plan section 8.1): mark (group_id, msg_id) so the worker never emits a reply for it. */
  private handleRecall(payload: unknown): void {
    const event = payload as { group_id?: number | string; message_id?: number | string };
    const groupId = String(event.group_id ?? "");
    const messageId = String(event.message_id ?? "");
    if (!groupId || !messageId) {
      return;
    }
    this.sharedDb.markRetracted(groupId, messageId, Date.now());
    this.messageRecalls.observeGroupRecall(groupId, messageId, Date.now());
    this.metrics.inc("recall_handled");
    logInfo("Message recall registered.", { groupId, messageId });
  }

  private isV3BlacklistedUser(groupId: string, userId: string): boolean {
    return (this.v3State?.getGroup(groupId)?.blacklistedUserIds ?? []).includes(userId);
  }

  // ---- emitter (sends worker replies through the reverse WS action channel) ----

  /**
   * The poll interval is intentionally shorter than a slow NapCat action.
   * Keep one complete claim-and-delivery pass in flight so a newly queued row
   * cannot begin sending alongside an earlier batch.
   */
  private async runEmitterSafely(): Promise<void> {
    if (this.emitterInFlight) {
      this.metrics.inc("outbox_emitter_overlap_skipped");
      return;
    }
    const run = this.runEmitter();
    this.emitterInFlight = run;
    try {
      await run;
    } catch (error) {
      this.metrics.inc("outbox_emitter_failed");
      logWarn("Outbox emitter pass failed before row delivery.", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.emitterInFlight === run) {
        this.emitterInFlight = undefined;
      }
    }
  }

  private async runEmitter(): Promise<void> {
    // 原子领取：每行先标记 sending，杜绝同一 outbox 双投递（计划 §6 红线）。
    const rows = this.sharedDb.claimOutbox(EMITTER_BATCH_SIZE);
    const byGroup = new Map<string, OutboxRow[]>();
    for (const row of rows) byGroup.set(row.group_id, [...(byGroup.get(row.group_id) ?? []), row]);
    await Promise.all([...byGroup.values()].map(async groupRows => {
    for (const row of groupRows) {
      try {
        if (row.kind === "poke") {
          const group = this.v3State?.getGroup(row.group_id);
          if (!group?.pokeReplyEnabled || group.enabled === false || group.botMuted || group.blacklistedUserIds?.includes(row.text)) throw new Error("poke_policy_disabled");
        }
        // The acknowledgement transaction marks the outbox row sent, stores
        // the real QQ id, and binds that id to the causal branch.
        const platformMessageId = await deliverOutboxRow(
          this.sharedDb,
          this.transport,
          row,
          undefined,
          () => this.metrics.inc("outbox_ack_backfill_failed"),
          path.join(this.options.dataDir, "generated-images"),
          this.memeLibrary,
        );
        this.metrics.inc("outbox_sent");
        logInfo("Outbox message sent.", {
          outboxId: row.id,
          kind: row.kind,
          groupId: row.group_id,
          replyTo: row.reply_to,
          platformMessageId,
        });
      } catch (error) {
        if (!(error instanceof OutboxAcknowledgementError)) {
          const disposition = markOutboxDeliveryFailed(this.sharedDb, row, error);
          if (row.kind === "generated_image" && disposition === "terminal") {
            this.metrics.inc("generated_image_delivery_terminal");
            if (error instanceof NapCatActionOutcomeUnknownError) {
              this.metrics.inc("generated_image_delivery_ambiguous");
            }
          }
        }
        this.metrics.inc("outbox_failed");
        logWarn("Outbox send failed.", {
          outboxId: row.id,
          kind: row.kind,
          groupId: row.group_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    }));
  }

  private maintain(): void {
    const now = Date.now();
    const stalledOutbox = this.sharedDb.recoverStaleSendingOutbox(now);
    if (stalledOutbox > 0) {
      this.metrics.inc("outbox_stalled_delivery_quarantined", stalledOutbox);
      logWarn("Quarantined delivery-ambiguous outbox rows after a stalled send.", { stalledOutbox });
    }
    this.sharedDb.db.prepare("DELETE FROM poke_events WHERE created_at < ?").run(now - RETRACTED_TTL_MS);
    this.sharedDb.pruneRetracted(now - RETRACTED_TTL_MS);
    this.sharedDb.pruneBotMessages(now - BOT_MESSAGE_TTL_MS);
  }
}

export async function main(): Promise<void> {
  const config = loadConfig();
  // Ingress does not otherwise read application state, but it is still a V3
  // production unit. Validate the migration marker and state key before it
  // accepts any NapCat traffic so a partial rollout cannot reopen JSON state
  // through the other roles.
  const startupDb = openSharedDb(config.dataDir);
  try {
    resolveV3RuntimeState(startupDb, config.stateEncryptionKey)?.retireRoastModeForExistingGroupsOnce();
  } finally {
    startupDb.close();
  }
  const app = new IngressApp({
    botQq: config.botQq,
    dataDir: config.dataDir,
    metricsDir: `${config.dataDir}${config.dataDir.endsWith("/") || config.dataDir.endsWith("\\") ? "" : "/"}shared/metrics`,
    stateEncryptionKey: config.stateEncryptionKey,
  });
  await app.start();

  const shutdown = async () => {
    logInfo("Ingress shutting down...");
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("index-ingress")) {
  void main().catch((error) => {
    logError("Ingress startup failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
