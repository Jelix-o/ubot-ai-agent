import { logError, logInfo, logWarn } from "../logger.js";
import type { SharedDb } from "./sqlite.js";

/**
 * Per-key serial consumption loop over the shared `messages` table.
 *
 * Guarantees:
 *  - Messages within one key are processed strictly one at a time, in
 *    arrival (id) order (plan section 2.2: 每 key 串行 = 1).
 *  - Different keys run in parallel.
 *  - Watermarks advance only after the handler completed; a failed message is
 *    re-queued (not lost) and its key backs off before the next attempt.
 *  - When a message fails repeatedly the key backs off exponentially instead
 *    of stalling the whole loop.
 */

export interface ConsumerRunnerOptions {
  keyOf: (message: IngressMessageRowLike) => string;
  handler: (message: IngressMessageRowLike, done: () => Promise<void>) => Promise<void>;
  pollIntervalMs?: number;
  batchSize?: number;
  maxConcurrentKeys?: number;
  maxKeyBackoffMs?: number;
  onEmpty?: () => void;
}

// Structural subset of the sqlite row so the runner can be tested with plain objects.
export interface IngressMessageRowLike {
  id: number;
  group_id: string;
  user_id: string;
  msg_id: string;
  msg_time: number;
  text: string;
  images_json?: string;
  reply_to?: string | null;
  has_at_bot?: number;
}

interface KeyState {
  queue: IngressMessageRowLike[];
  backoffUntil: number;
}

export class ConsumerRunner {
  private readonly keys = new Map<string, KeyState>();
  private readonly busyKeys = new Set<string>();
  private readonly pollTimer: NodeJS.Timeout;
  private readonly retryTimer: NodeJS.Timeout;
  private readonly defaultKeyBackoffMs: number;
  private readonly maxKeyBackoffMs: number;
  private readonly maxConcurrentKeys: number;
  private readonly batchSize: number;
  private readonly onEmpty?: () => void;
  private stopped = false;
  private pollInFlight = false;

  constructor(
    private readonly db: SharedDb,
    private readonly consumerKey: string,
    private readonly options: ConsumerRunnerOptions,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxConcurrentKeys = options.maxConcurrentKeys ?? 8;
    this.maxKeyBackoffMs = options.maxKeyBackoffMs ?? 30_000;
    this.defaultKeyBackoffMs = options.maxKeyBackoffMs ? Math.floor(options.maxKeyBackoffMs / 2) : 5_000;
    this.onEmpty = options.onEmpty;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, pollIntervalMs);
    // 消费循环是 worker 的核心驱动：不能 unref，否则事件循环空转、进程退出
    // （部署阻断：worker 启动即死，消息永远不被消费）。
    this.retryTimer = setInterval(() => {
      this.dispatchAll();
    }, 250);
    this.retryTimer.unref();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.retryTimer);
  }

  /** Total messages queued across all keys (指标 #5 per_key_queue_depth). */
  get queueDepth(): number {
    let total = 0;
    for (const state of this.keys.values()) {
      total += state.queue.length;
    }
    return total;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const rows = this.db.pollMessages(this.consumerKey, this.batchSize);
      let queuedAny = false;
      for (const row of rows) {
        const key = this.options.keyOf(row);
        if (!key) {
          // Unroutable message: advance the watermark so it is never retried.
          this.db.advanceWatermark(this.consumerKey, row.id);
          continue;
        }
        const state = this.keys.get(key) ?? (this.keys.set(key, { queue: [], backoffUntil: 0 }), this.keys.get(key)!);
        state.queue.push(row);
        queuedAny = true;
      }
      if (queuedAny) {
        this.dispatchAll();
      }
      if (!queuedAny) {
        this.onEmpty?.();
      }
    } catch (error) {
      logWarn("Consumer poll failed.", {
        consumer: this.consumerKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  private dispatchAll(): void {
    for (const key of this.keys.keys()) {
      this.dispatch(key);
    }
  }

  private dispatch(key: string): void {
    if (this.busyKeys.has(key) || this.busyKeys.size >= this.maxConcurrentKeys) {
      return;
    }
    const state = this.keys.get(key);
    if (!state || state.queue.length === 0) {
      return;
    }
    const now = Date.now();
    if (state.backoffUntil > now) {
      return;
    }
    state.backoffUntil = 0;

    const message = state.queue[0]!;
    this.busyKeys.add(key);

    void this.runTask(key, message).finally(() => {
      this.busyKeys.delete(key);
      this.dispatch(key);
    });
  }

  private async runTask(key: string, message: IngressMessageRowLike): Promise<void> {
    const taskStartedAt = Date.now();
    const done = async () => {
      const state = this.keys.get(key);
      if (state && state.queue[0]?.id === message.id) {
        state.queue.shift();
      }
      this.db.advanceWatermark(this.consumerKey, message.id);
    };
    try {
      await this.options.handler(message, done);
      logInfo("Consumer task done.", {
        consumer: this.consumerKey,
        key,
        messageId: message.id,
        durationMs: Date.now() - taskStartedAt,
      });
    } catch (error) {
      logError("Consumer task failed; will retry after backoff.", {
        consumer: this.consumerKey,
        key,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const state = this.keys.get(key);
      if (state) {
        state.backoffUntil = Date.now() + this.nextBackoff(state);
      }
    }
  }

  private nextBackoff(state: KeyState): number {
    if (state.backoffUntil === 0) {
      return this.defaultKeyBackoffMs;
    }
    const elapsedBackoff = state.backoffUntil - Date.now();
    return Math.min(this.maxKeyBackoffMs, Math.max(this.defaultKeyBackoffMs, elapsedBackoff * 2));
  }
}
