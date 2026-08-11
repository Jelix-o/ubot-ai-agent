import { randomUUID } from "node:crypto";

import { logInfo } from "../logger.js";
import type { SharedDb } from "../shared/sqlite.js";

/**
 * Per-key in-flight registry implementing plan section 2.3
 * ("同一 key 上 新消息覆盖旧任务").
 *
 * Semantics when a new message arrives on a key that already has a running task:
 *  1. Old task older than `cancelAfterMs` (20s) → cancel it and run the new
 *     message; the reply carries "（合并了你刚才和这条）".
 *  2. Old task younger, and the new message is an append/correction heuristic
 *     (starts with 补充/不对/其实, or shorter than `mergeShortTextChars`) →
 *     wait for the old task, then merge into one reply.
 *  3. Otherwise drop the new message silently (avoid double replies).
 *
 * Cancellation is "true": the running task observes `cancel_token` via an
 * AbortController whose signal is passed into the LLM client (socket close).
 */
export class InflightManager {
  constructor(
    private readonly db: SharedDb,
    private readonly options: {
      cancelAfterMs?: number;
      mergeShortTextChars?: number;
      mergeWaitMs?: number;
    } = {},
  ) {}

  /** Starts tracking a task for the key; returns a cancel token + AbortController. */
  begin(key: string): { taskId: string; cancel: () => void } {
    const taskId = randomUUID();
    const controller = new AbortController();
    this.db.registerInflight(key, taskId, Date.now(), taskId);
    return {
      taskId,
      cancel: () => {
        controller.abort();
        this.db.requestCancel(key);
      },
    };
  }

  /** Returns the abort signal for an in-flight task; aborted when a cancel is requested. */
  signalFor(key: string): AbortSignal {
    const controller = new AbortController();
    const row = this.db.getInflight(key);
    if (row?.cancel_requested) {
      controller.abort();
    }
    return controller.signal;
  }

  /** Clears the registry entry for the key. */
  end(key: string): void {
    this.db.clearInflight(key);
  }

  /**
   * Decides what to do with a new message on a key that already has an
   * in-flight task. Returns the merge text when the new message should be
   * merged into the running reply, or undefined when it should be dropped.
   */
  decideNewMessage(
    key: string,
    newText: string,
    nowMs = Date.now(),
  ): { action: "merge" | "drop"; mergeText?: string; reason: string } {
    const row = this.db.getInflight(key);
    if (!row) {
      return { action: "drop", reason: "no_inflight" };
    }
    const elapsed = nowMs - row.started_at;
    const cancelAfterMs = this.options.cancelAfterMs ?? 20_000;
    const mergeShortTextChars = this.options.mergeShortTextChars ?? 10;

    if (elapsed > cancelAfterMs) {
      // User perceives "no response" → cancel old, rerun with the new message.
      this.db.requestCancel(key);
      logInfo("Inflight task cancelled because user re-triggered after threshold.", {
        key,
        elapsedMs: elapsed,
        cancelAfterMs,
      });
      return { action: "merge", mergeText: newText, reason: "cancel_and_rerun" };
    }

    const trimmed = newText.trim();
    const isAppendCorrection = /^(补充|不对|其实|更正|纠正|另外|还有)/.test(trimmed) || trimmed.length < mergeShortTextChars;
    if (isAppendCorrection) {
      logInfo("Inflight task will merge follow-up message.", {
        key,
        elapsedMs: elapsed,
        newTextLength: trimmed.length,
      });
      return { action: "merge", mergeText: newText, reason: "append_correction" };
    }

    logInfo("Inflight task dropped duplicate-triggering message.", {
      key,
      elapsedMs: elapsed,
      newTextLength: trimmed.length,
    });
    return { action: "drop", reason: "duplicate_trigger" };
  }
}
