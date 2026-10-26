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
  keyOf: (message: IngressMessageRowLike) => string | Promise<string>;
  handler: (message: IngressMessageRowLike, done: () => Promise<void>) => Promise<void>;
  pollIntervalMs?: number;
  batchSize?: number;
  maxConcurrentKeys?: number;
  /** Defaults to the production retry schedule's 5-second first delay. */
  initialKeyBackoffMs?: number;
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
  canonical_segments_json?: string | null;
  sender_card?: string | null;
  sender_nickname?: string | null;
  reply_to?: string | null;
  has_at_bot?: number;
  processable?: number;
  drop_reason?: string | null;
}

interface KeyState {
  queue: IngressMessageRowLike[];
  backoffUntil: number;
  retryDelayMs: number;
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
  private readonly activeTasks = new Set<Promise<void>>();
  private stopped = false;
  private pollInFlight?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly db: SharedDb,
    private readonly consumerKey: string,
    private readonly options: ConsumerRunnerOptions,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxConcurrentKeys = options.maxConcurrentKeys ?? 8;
    this.maxKeyBackoffMs = Math.max(1, options.maxKeyBackoffMs ?? 30_000);
    this.defaultKeyBackoffMs = Math.min(
      Math.max(1, options.initialKeyBackoffMs ?? 5_000),
      this.maxKeyBackoffMs,
    );
    this.onEmpty = options.onEmpty;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, pollIntervalMs);
    // 消费循环是 worker 的核心驱动：不能 unref，否则事件循环空转、进程退出
    // （部署阻断：worker 启动即死，消息永远不被消费）。
    this.retryTimer = setInterval(() => {
      this.dispatchAll();
    }, Math.min(250, Math.max(1, this.defaultKeyBackoffMs)));
    this.retryTimer.unref();
    void this.poll();
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.retryTimer);
    this.stopPromise = this.waitForIdle();
    return this.stopPromise;
  }

  /** Total messages queued across all keys (指标 #5 per_key_queue_depth). */
  get queueDepth(): number {
    let total = 0;
    for (const state of this.keys.values()) {
      total += state.queue.length;
    }
    return total;
  }

  private poll(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.pollInFlight) {
      return this.pollInFlight;
    }
    const poll = this.pollOnce();
    this.pollInFlight = poll;
    void poll.then(
      () => this.finishPoll(poll),
      () => this.finishPoll(poll),
    );
    return poll;
  }

  private async pollOnce(): Promise<void> {
    try {
      const rows = this.db.pollMessages(this.consumerKey, this.batchSize);
      let queuedAny = false;
      for (const row of rows) {
        if (this.stopped) {
          return;
        }
        const key = await this.options.keyOf(row);
        if (this.stopped) {
          return;
        }
        if (this.db.isConsumerMessageCompleted(this.consumerKey, row.id)) {
          continue;
        }
        if (!key) {
          // Unroutable messages are terminally complete, but still participate
          // in contiguous watermark advancement.
          this.db.completeConsumerMessage(this.consumerKey, row.id);
          continue;
        }
        const state = this.keys.get(key) ?? (
          this.keys.set(key, { queue: [], backoffUntil: 0, retryDelayMs: 0 }),
          this.keys.get(key)!
        );
        // 防重复入队（历史副本兜底）：同一消息已在队列中则跳过。
        if (!state.queue.some((queued) => queued.id === row.id)) {
          state.queue.push(row);
          queuedAny = true;
        }
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
    }
  }

  private finishPoll(poll: Promise<void>): void {
    if (this.pollInFlight === poll) {
      this.pollInFlight = undefined;
    }
  }

  private dispatchAll(): void {
    for (const key of this.keys.keys()) {
      this.dispatch(key);
    }
  }

  private dispatch(key: string): void {
    if (this.stopped || this.busyKeys.has(key) || this.busyKeys.size >= this.maxConcurrentKeys) {
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
    const message = state.queue[0]!;
    this.busyKeys.add(key);
    const task = this.runTask(key, message);
    this.activeTasks.add(task);
    void task.then(
      () => this.finishTask(key, task),
      (error) => {
        logError("Consumer task rejected unexpectedly; retaining message for retry.", {
          consumer: this.consumerKey,
          key,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.finishTask(key, task);
      },
    );
  }

  private finishTask(key: string, task: Promise<void>): void {
    this.activeTasks.delete(task);
    this.busyKeys.delete(key);
    this.dispatch(key);
  }

  private async waitForIdle(): Promise<void> {
    while (this.pollInFlight || this.activeTasks.size > 0) {
      const pending = [
        ...(this.pollInFlight ? [this.pollInFlight] : []),
        ...this.activeTasks,
      ];
      await Promise.allSettled(pending);
    }
  }

  private async runTask(key: string, message: IngressMessageRowLike): Promise<void> {
    const taskStartedAt = Date.now();
    let finished = false;
    const done = async () => {
      if (finished) {
        return;
      }
      finished = true;
      const state = this.keys.get(key);
      if (state && state.queue[0]?.id === message.id) {
        state.queue.shift();
        state.backoffUntil = 0;
        state.retryDelayMs = 0;
      }
      this.db.completeConsumerMessage(this.consumerKey, message.id);
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
      logError("Consumer task failed; retaining message for retry.", {
        consumer: this.consumerKey,
        key,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const state = this.keys.get(key);
      if (state) {
        // Keep the message at the head. It is neither re-polled into the queue
        // nor acknowledged, and a process restart will recover it from SQLite.
        const retryDelayMs = this.nextBackoff(state);
        state.retryDelayMs = retryDelayMs;
        state.backoffUntil = Date.now() + retryDelayMs;
      }
    }
  }

  private nextBackoff(state: KeyState): number {
    if (state.retryDelayMs === 0) {
      return this.defaultKeyBackoffMs;
    }
    return Math.min(this.maxKeyBackoffMs, state.retryDelayMs * 2);
  }
}
