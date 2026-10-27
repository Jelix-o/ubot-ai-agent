import { logError, logInfo, logWarn } from "../logger.js";
import {
  DEFAULT_MESSAGE_EXECUTION_SCOPE,
  MESSAGE_EXECUTION_LEASE_DEFAULT_MS,
  type SharedDb,
} from "./sqlite.js";

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
  /**
   * `handoff` moves an uncompleted message to a different serial key without
   * advancing its durable consumer watermark. It is intended for a cheap
   * staging lane whose final key is known only after local work completes.
   */
  handler: (
    message: IngressMessageRowLike,
    done: () => Promise<void>,
    handoff: (targetKey: string) => Promise<void>,
    currentKey: string,
  ) => Promise<void>;
  pollIntervalMs?: number;
  batchSize?: number;
  maxConcurrentKeys?: number;
  /** Defaults to the production retry schedule's 5-second first delay. */
  initialKeyBackoffMs?: number;
  maxKeyBackoffMs?: number;
  /** Shared by every WorkerApp instance; intentionally independent of consumerKey. */
  executionScope?: string;
  /** Long-running image work renews this lease while its handler is active. */
  executionLeaseMs?: number;
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

interface ActiveExecutionOwnership {
  sourceRowId: number;
  leaseToken: string;
  heartbeat?: NodeJS.Timeout;
  lost: boolean;
}

type ExecutionOwnershipClaim =
  | { state: "owned"; ownership: ActiveExecutionOwnership }
  | { state: "busy"; leaseExpiresAt?: number }
  | { state: "completed" };

export class ConsumerRunner {
  private readonly keys = new Map<string, KeyState>();
  private readonly busyKeys = new Set<string>();
  /** Prevent a handoff/re-poll race from placing one source row in two keys. */
  private readonly queuedKeysByMessage = new Map<number, string>();
  /** Survives an in-memory key handoff until the destination finally calls done. */
  private readonly executionOwnershipByMessage = new Map<number, ActiveExecutionOwnership>();
  /** A worker that waited behind a live owner must only acknowledge its result. */
  private readonly observedLiveExecutionByMessage = new Set<number>();
  /** Handoffs must finish during stop; other queued work remains for restart. */
  private readonly handedOffMessageIds = new Set<number>();
  private readonly handoffDrainMessageIds = new Set<number>();
  private readonly pollTimer: NodeJS.Timeout;
  private readonly retryTimer: NodeJS.Timeout;
  private readonly defaultKeyBackoffMs: number;
  private readonly maxKeyBackoffMs: number;
  private readonly maxConcurrentKeys: number;
  private readonly batchSize: number;
  private readonly executionScope: string;
  private readonly executionLeaseMs: number;
  private readonly executionHeartbeatMs: number;
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
    this.executionScope = options.executionScope ?? DEFAULT_MESSAGE_EXECUTION_SCOPE;
    this.executionLeaseMs = normalizeExecutionLeaseMs(options.executionLeaseMs ?? MESSAGE_EXECUTION_LEASE_DEFAULT_MS);
    this.executionHeartbeatMs = Math.max(250, Math.floor(this.executionLeaseMs / 3));
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
    // A source already moved through a staging lane owns a live execution
    // lease. Keep only those handoff chains draining; unstarted work remains
    // durable for the next process exactly as before.
    for (const sourceRowId of this.handedOffMessageIds) {
      this.handoffDrainMessageIds.add(sourceRowId);
    }
    this.dispatchAll();
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
        if (this.queuedKeysByMessage.has(row.id)) {
          continue;
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
        // A row can be moved to another key while remaining durably pending.
        // Keep its in-memory ownership stable until either `done` or another
        // handoff changes it; otherwise a later poll could enqueue it twice.
        this.enqueue(key, row);
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
    const message = state.queue[0]!;
    if (this.stopped && !this.handoffDrainMessageIds.has(message.id)) {
      return;
    }
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
    // A task may have handed its row to a different key. Revisit every key
    // after releasing this slot so the destination can start immediately.
    this.dispatchAll();
  }

  private async waitForIdle(): Promise<void> {
    while (this.pollInFlight || this.activeTasks.size > 0 || this.handoffDrainMessageIds.size > 0) {
      const pending = [
        ...(this.pollInFlight ? [this.pollInFlight] : []),
        ...this.activeTasks,
      ];
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      } else {
        // Retry timer remains alive while an already-owned handoff drains.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    clearInterval(this.retryTimer);
  }

  private async runTask(key: string, message: IngressMessageRowLike): Promise<void> {
    const taskStartedAt = Date.now();
    let settled = false;
    let ownership: ActiveExecutionOwnership | undefined;
    try {
      const claim = this.acquireExecutionOwnership(message);
      if (claim.state === "busy") {
        this.backoffForBusyExecution(key, claim);
        return;
      }
      if (claim.state === "completed") {
        this.db.completeConsumerMessage(this.consumerKey, message.id);
        this.finishLocalMessage(key, message);
        return;
      }
      const activeOwnership = claim.ownership;
      ownership = activeOwnership;

      const done = async () => {
        if (settled) {
          return;
        }
        const completed = this.db.completeConsumerMessageWithExecutionLease({
          consumerKey: this.consumerKey,
          executionScope: this.executionScope,
          sourceRowId: message.id,
          leaseToken: activeOwnership.leaseToken,
        });
        if (!completed) {
          activeOwnership.lost = true;
          this.forgetExecutionOwnership(message.id, activeOwnership);
          throw new Error("consumer_execution_lease_lost");
        }
        settled = true;
        this.forgetExecutionOwnership(message.id, activeOwnership);
        this.finishLocalMessage(key, message);
      };
      const handoff = async (targetKey: string) => {
        const normalizedTargetKey = targetKey.trim();
        if (!normalizedTargetKey) throw new Error("consumer_handoff_key_empty");
        if (normalizedTargetKey === key) throw new Error("consumer_handoff_key_unchanged");
        if (settled) return;
        this.removeHead(key, message);
        this.queuedKeysByMessage.delete(message.id);
        this.enqueue(normalizedTargetKey, message);
        this.handedOffMessageIds.add(message.id);
        if (this.stopped) this.handoffDrainMessageIds.add(message.id);
        settled = true;
      };

      await this.options.handler(message, done, handoff, key);
      if (!settled) {
        throw new Error("consumer_handler_returned_without_done_or_handoff");
      }
      logInfo("Consumer task done.", {
        consumer: this.consumerKey,
        key,
        messageId: message.id,
        durationMs: Date.now() - taskStartedAt,
      });
    } catch (error) {
      // Once a message has moved (or completed), a late error cannot safely
      // put the source back into its previous key. The durable row remains
      // pending after a handoff and will still recover on process restart.
      if (settled) {
        logWarn("Consumer task failed after completion or handoff.", {
          consumer: this.consumerKey,
          key,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (ownership && this.executionOwnershipByMessage.get(message.id) === ownership) {
        try {
          if (!ownership.lost) {
            this.db.releaseMessageExecutionLease({
              executionScope: this.executionScope,
              sourceRowId: message.id,
              leaseToken: ownership.leaseToken,
            });
          }
        } catch (releaseError) {
          logWarn("Consumer execution lease release failed; expiry will recover it.", {
            consumer: this.consumerKey,
            key,
            messageId: message.id,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        } finally {
          this.forgetExecutionOwnership(message.id, ownership);
        }
      }
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

  private acquireExecutionOwnership(message: IngressMessageRowLike): ExecutionOwnershipClaim {
    const retained = this.executionOwnershipByMessage.get(message.id);
    if (retained && !retained.lost) {
      return { state: "owned", ownership: retained };
    }
    if (retained) {
      this.forgetExecutionOwnership(message.id, retained);
    }

    const claim = this.db.claimMessageExecutionLease({
      executionScope: this.executionScope,
      sourceRowId: message.id,
      leaseMs: this.executionLeaseMs,
      allowCompletedReplay: !this.observedLiveExecutionByMessage.has(message.id),
    });
    if (claim.state === "busy") {
      this.observedLiveExecutionByMessage.add(message.id);
      return { state: "busy", leaseExpiresAt: claim.lease.leaseExpiresAt };
    }
    if (claim.state === "completed") {
      return { state: "completed" };
    }

    this.observedLiveExecutionByMessage.delete(message.id);

    const ownership: ActiveExecutionOwnership = {
      sourceRowId: message.id,
      leaseToken: claim.leaseToken,
      lost: false,
    };
    this.executionOwnershipByMessage.set(message.id, ownership);
    ownership.heartbeat = setInterval(() => this.renewExecutionOwnership(ownership), this.executionHeartbeatMs);
    ownership.heartbeat.unref();
    return { state: "owned", ownership };
  }

  private renewExecutionOwnership(ownership: ActiveExecutionOwnership): void {
    if (
      ownership.lost ||
      this.executionOwnershipByMessage.get(ownership.sourceRowId) !== ownership
    ) {
      return;
    }
    try {
      if (this.db.renewMessageExecutionLease({
        executionScope: this.executionScope,
        sourceRowId: ownership.sourceRowId,
        leaseToken: ownership.leaseToken,
        leaseMs: this.executionLeaseMs,
      })) {
        return;
      }
      ownership.lost = true;
      this.forgetExecutionOwnership(ownership.sourceRowId, ownership);
      logWarn("Consumer execution lease was lost before handler completion.", {
        consumer: this.consumerKey,
        messageId: ownership.sourceRowId,
      });
    } catch (error) {
      // A transient SQLite busy error should not immediately revoke a valid
      // owner. A later heartbeat or the fenced done() transition decides it.
      logWarn("Consumer execution lease heartbeat failed.", {
        consumer: this.consumerKey,
        messageId: ownership.sourceRowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private forgetExecutionOwnership(sourceRowId: number, expected?: ActiveExecutionOwnership): void {
    const ownership = this.executionOwnershipByMessage.get(sourceRowId);
    if (!ownership || (expected && ownership !== expected)) return;
    if (ownership.heartbeat) clearInterval(ownership.heartbeat);
    this.executionOwnershipByMessage.delete(sourceRowId);
  }

  private backoffForBusyExecution(key: string, claim: Extract<ExecutionOwnershipClaim, { state: "busy" }>): void {
    const state = this.keys.get(key);
    if (!state) return;
    const now = Date.now();
    const retryDelayMs = this.nextBackoff(state);
    state.retryDelayMs = retryDelayMs;
    const localRetryAt = now + retryDelayMs;
    state.backoffUntil = claim.leaseExpiresAt && claim.leaseExpiresAt > now
      ? Math.min(localRetryAt, claim.leaseExpiresAt)
      : localRetryAt;
  }

  private finishLocalMessage(key: string, message: IngressMessageRowLike): void {
    this.removeHead(key, message);
    this.queuedKeysByMessage.delete(message.id);
    this.observedLiveExecutionByMessage.delete(message.id);
    this.handedOffMessageIds.delete(message.id);
    this.handoffDrainMessageIds.delete(message.id);
  }

  private enqueue(key: string, message: IngressMessageRowLike): void {
    const state = this.keys.get(key) ?? (
      this.keys.set(key, { queue: [], backoffUntil: 0, retryDelayMs: 0 }),
      this.keys.get(key)!
    );
    // Handoffs can arrive after a newer source row was already queued for the
    // destination. Keep pending work in source-row order whenever neither task
    // has started yet. The active queue head is immutable: moving an older row
    // before it would make that active task complete the wrong source row.
    const firstMovableIndex = this.busyKeys.has(key) && state.queue.length > 0 ? 1 : 0;
    const insertionIndex = state.queue.findIndex((queued, index) =>
      index >= firstMovableIndex && queued.id > message.id,
    );
    if (insertionIndex === -1) state.queue.push(message);
    else state.queue.splice(insertionIndex, 0, message);
    this.queuedKeysByMessage.set(message.id, key);
  }

  private removeHead(key: string, message: IngressMessageRowLike): void {
    const state = this.keys.get(key);
    if (!state || state.queue[0]?.id !== message.id) {
      throw new Error("consumer_queue_head_mismatch");
    }
    state.queue.shift();
    state.backoffUntil = 0;
    state.retryDelayMs = 0;
  }

  private nextBackoff(state: KeyState): number {
    if (state.retryDelayMs === 0) {
      return this.defaultKeyBackoffMs;
    }
    return Math.min(this.maxKeyBackoffMs, state.retryDelayMs * 2);
  }
}

function normalizeExecutionLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 60_000) {
    throw new Error("consumer_execution_lease_duration_invalid");
  }
  return value;
}
