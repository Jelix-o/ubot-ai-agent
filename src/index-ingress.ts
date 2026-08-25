import { loadConfig } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { NapCatReverseServer } from "./napcat-reverse-server.js";
import { openSharedDb, type OutboxRow, type SharedDb } from "./shared/sqlite.js";
import { Metrics } from "./shared/metrics.js";
import { IngressReadApi } from "./ingress-read-api.js";
import { parseGroupMessage, extractTextFromMessage, extractImagesFromMessage } from "./utils/message-parser.js";
import type { NapcatGroupMessageEvent } from "./types.js";
import type { MessageReceipt, MessageTransport } from "./bot.js";

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
 * Delivers one already-claimed outbox row and commits the real platform id.
 * Keeping this boundary outside IngressApp makes the cross-process receipt
 * handoff testable without opening a second NapCat server or timer loop.
 */
export async function deliverOutboxRow(
  sharedDb: SharedDb,
  transport: MessageTransport,
  row: OutboxRow,
  sentAtMs = Date.now(),
  onAckFailure?: (error: unknown) => void,
): Promise<string> {
  let receipt: MessageReceipt | void;
  if (row.kind === "record") {
    receipt = await transport.sendGroupRecord(row.group_id, row.text);
  } else if (row.kind === "airecord") {
    receipt = await transport.sendGroupAiRecord(row.group_id, row.text);
  } else {
    receipt = await transport.sendGroupMessage(row.group_id, row.text);
  }
  const platformMessageId = receipt?.platformMessageId ?? receipt?.messageId;
  if (!platformMessageId) {
    throw new Error("NapCat send succeeded without a real platform message id");
  }
  try {
    sharedDb.ackOutboxDelivery(row.id, platformMessageId, sentAtMs);
  } catch (error) {
    onAckFailure?.(error);
    // Never return this row to the send retry queue: the QQ action succeeded,
    // so retrying would create a duplicate. The row remains `sending` for
    // reconciliation/alerting with its causal turn still intact.
    throw new OutboxAcknowledgementError(platformMessageId, error);
  }
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

interface IngressOptions {
  botQq: string;
  dataDir: string;
  metricsDir: string;
}

export class IngressApp {
  private readonly sharedDb: SharedDb;
  private readonly metrics: Metrics;
  private readonly transport: MessageTransport;
  private readonly emitterTimer: NodeJS.Timeout;
  private readonly maintenanceTimer: NodeJS.Timeout;

  constructor(
    private readonly options: IngressOptions,
    transport?: MessageTransport,
  ) {
    this.sharedDb = openSharedDb(this.options.dataDir);
    this.metrics = new Metrics(this.options.metricsDir, {
      processName: "ingress",
      flushIntervalMs: 30_000,
    });
    this.transport = transport ?? new NapCatReverseServer({
      host: loadConfig().napcatReverseWsHost,
      port: loadConfig().napcatReverseWsPort,
      path: loadConfig().napcatReverseWsPath,
      accessToken: loadConfig().napcatAccessToken,
    });

    if (typeof this.transport.sendGroupMessage !== "function") {
      throw new Error("Ingress requires a transport that can send group messages.");
    }

    // Subscribe to incoming group messages and recall notices.
    const runtime = this.transport as MessageTransport & {
      on?(event: string, listener: (payload: unknown) => void): unknown;
    };
    if (typeof runtime.on === "function") {
      runtime.on("groupMessage", (event) => {
        void this.handleGroupMessage(event as NapcatGroupMessageEvent);
      });
      runtime.on("groupRecall", (payload) => {
        this.handleRecall(payload);
      });
    } else {
      throw new Error("Ingress requires a transport that emits groupMessage events.");
    }

    this.emitterTimer = setInterval(() => {
      void this.runEmitter();
    }, EMITTER_POLL_MS);
    this.emitterTimer.unref();

    this.maintenanceTimer = setInterval(() => {
      this.maintain();
    }, 60_000);
    this.maintenanceTimer.unref();

    // Localhost read API so the worker can use NapCat read actions.
    this.readApi = new IngressReadApi(this.transport, loadConfig().ingressReadApiPort);
    this.readApi.start();
  }

  private readonly readApi: IngressReadApi;

  async start(): Promise<void> {
    const withStart = this.transport as MessageTransport & { start?: () => void };
    if (typeof withStart.start === "function") {
      withStart.start();
    }
    logInfo("Ingress started.", {
      botQq: this.options.botQq,
      dataDir: this.options.dataDir,
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.emitterTimer);
    clearInterval(this.maintenanceTimer);
    this.metrics.stop();
    this.readApi.close();
    this.sharedDb.close();
    const withClose = this.transport as MessageTransport & { close?: () => void };
    if (typeof withClose.close === "function") {
      withClose.close();
    }
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

    // Empty messages.
    const text = extractTextFromMessage(event.message);
    const images = extractImagesFromMessage(event.message);
    if (!text && images.length === 0) {
      return;
    }

    // Backlog detection (plan section 8 Bonus): messages pushed after a
    // reconnect that are older than 60s must not trigger replies.
    const msgTimeMs = event.time ? event.time * 1000 : Date.now();
    if (Date.now() - msgTimeMs > BACKLOG_MAX_AGE_MS) {
      this.metrics.inc("backlog_detected");
      logInfo("Ignored backlog message after reconnect.", {
        groupId,
        userId,
        msgId,
        ageMs: Date.now() - msgTimeMs,
      });
      return;
    }

    // Per-group token bucket: persist excess messages as non-processable audit
    // events. The worker can then advance its normal consumer watermark without
    // ever generating a reply, avoiding the old detached token-bucket watermark.
    const count = this.sharedDb.countMessagesSince(groupId, Date.now() - TOKEN_BUCKET_WINDOW_MS);
    const dropReason = count >= TOKEN_BUCKET_MAX_PER_WINDOW ? "rate_limited" : undefined;

    // Idempotent dedupe (plan section 2.1): (self_bot_id, group_id, msg_id).
    // self_id 缺失时用 botQq 作为 dedup key 的一部分（保证幂等键稳定）。
    const parsed = parseGroupMessage(event.message, this.options.botQq);
    const createdAt = Date.now();
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
      replyTo: parsed.replyMessageId,
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
    this.metrics.inc("recall_handled");
    logInfo("Message recall registered.", { groupId, messageId });
  }

  // ---- emitter (sends worker replies through the reverse WS action channel) ----

  private async runEmitter(): Promise<void> {
    // 原子领取：每行先标记 sending，杜绝同一 outbox 双投递（计划 §6 红线）。
    const rows = this.sharedDb.claimOutbox(EMITTER_BATCH_SIZE);
    for (const row of rows) {
      try {
        // The acknowledgement transaction marks the outbox row sent, stores
        // the real QQ id, and binds that id to the causal branch.
        const platformMessageId = await deliverOutboxRow(
          this.sharedDb,
          this.transport,
          row,
          Date.now(),
          () => this.metrics.inc("outbox_ack_backfill_failed"),
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
          this.sharedDb.markOutboxFailed(row.id);
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
  }

  private maintain(): void {
    const now = Date.now();
    const stalledOutbox = this.sharedDb.recoverStaleSendingOutbox(now);
    if (stalledOutbox > 0) {
      this.metrics.inc("outbox_stalled_delivery_quarantined", stalledOutbox);
      logWarn("Quarantined delivery-ambiguous outbox rows after a stalled send.", { stalledOutbox });
    }
    this.sharedDb.pruneRetracted(now - RETRACTED_TTL_MS);
    this.sharedDb.pruneBotMessages(now - BOT_MESSAGE_TTL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const app = new IngressApp({
    botQq: config.botQq,
    dataDir: config.dataDir,
    metricsDir: `${config.dataDir}${config.dataDir.endsWith("/") || config.dataDir.endsWith("\\") ? "" : "/"}shared/metrics`,
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
