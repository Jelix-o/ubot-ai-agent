import type { MessageTransport } from "./bot.js";
import {
  NapCatActionNotSentError,
  NapCatActionOutcomeUnknownError,
  NapCatActionRejectedError,
} from "./napcat-action-errors.js";
import { logWarn } from "./logger.js";
import type { MessageRecallRow, SharedDb } from "./shared/sqlite.js";

export const MESSAGE_RECALL_POLL_MS = 1_000;
export const MESSAGE_RECALL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MESSAGE_RECALL_BATCH_SIZE = 20;
const MESSAGE_RECALL_RETRY_AFTER_MS = 100_000;
const MESSAGE_RECALL_MAINTENANCE_INTERVAL_MS = 60_000;

export type MessageRecallMetric =
  | "message_recall_succeeded"
  | "message_recall_retry_scheduled"
  | "message_recall_rejected"
  | "message_recall_outcome_unknown"
  | "message_recall_expired"
  | "message_recall_unsupported"
  | "message_recall_external"
  | "message_recall_stale_sending";

export interface MessageRecallServiceOptions {
  /** Called with non-content-bearing operational counters. */
  onMetric?: (name: MessageRecallMetric, by?: number) => void;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface MessageRecallRunSummary {
  claimed: number;
  recalled: number;
  retried: number;
  terminal: number;
}

/**
 * Owns durable deletion of bot-created messages. It intentionally has no
 * group-send path: every outcome remains silent to QQ users.
 */
export class MessageRecallService {
  private timer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private activeRun?: Promise<MessageRecallRunSummary>;
  private started = false;

  constructor(
    private readonly db: SharedDb,
    private readonly transport: Pick<MessageTransport, "deleteMessage">,
    private readonly options: MessageRecallServiceOptions = {},
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // A process crash after claim leaves the dispatch outcome unknowable.
    // Quarantine it immediately rather than risking a second delete action.
    const stale = this.db.recoverStaleSendingMessageRecalls(this.currentTime(), 0);
    if (stale > 0) {
      this.metric("message_recall_stale_sending", stale);
      this.metric("message_recall_outcome_unknown", stale);
    }

    void this.runDue().catch((error) => {
      this.logSchedulerFailure(error);
    });
    this.timer = setInterval(() => {
      void this.runDue().catch((error) => {
        this.logSchedulerFailure(error);
      });
    }, this.options.pollIntervalMs ?? MESSAGE_RECALL_POLL_MS);
    this.timer.unref();
    this.runMaintenance();
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance();
    }, MESSAGE_RECALL_MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    try {
      await this.activeRun;
    } catch (error) {
      this.logSchedulerFailure(error);
    }
  }

  /** Records a platform recall notice so an active job cannot delete twice. */
  observeGroupRecall(groupId: string, platformMessageId: string, nowMs = this.currentTime()): number {
    const observed = this.db.markMessageRecallObserved(groupId, platformMessageId, nowMs);
    if (observed > 0) {
      this.metric("message_recall_external", observed);
    }
    return observed;
  }

  /** Applies the normal seven-day bot-message retention window to final tasks. */
  maintain(nowMs = this.currentTime()): number {
    return this.db.pruneTerminalMessageRecalls(Math.max(0, nowMs - MESSAGE_RECALL_RETENTION_MS));
  }

  runDue(nowMs?: number): Promise<MessageRecallRunSummary> {
    if (this.activeRun) {
      return this.activeRun;
    }
    const runStartedAt = nowMs ?? this.currentTime();
    this.activeRun = this.runDueInternal(runStartedAt, nowMs === undefined).finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  private async runDueInternal(nowMs: number, refreshClockBeforeDispatch: boolean): Promise<MessageRecallRunSummary> {
    const summary: MessageRecallRunSummary = {
      claimed: 0,
      recalled: 0,
      retried: 0,
      terminal: 0,
    };
    const expired = this.db.expireMessageRecalls(nowMs);
    if (expired > 0) {
      summary.terminal += expired;
      this.metric("message_recall_expired", expired);
    }
    // A process that remains alive but loses a task mid-action must apply the
    // same no-replay rule as a restarted process. Normal action timeouts are
    // ten seconds, so thirty seconds leaves the action room to finish.
    const stale = this.db.recoverStaleSendingMessageRecalls(nowMs);
    if (stale > 0) {
      summary.terminal += stale;
      this.metric("message_recall_stale_sending", stale);
      this.metric("message_recall_outcome_unknown", stale);
    }

    const recalls = this.db.claimDueMessageRecalls(MESSAGE_RECALL_BATCH_SIZE, nowMs);
    summary.claimed = recalls.length;
    const outcomes = await Promise.allSettled(
      recalls.map((recall) => this.processClaimedRecall(recall, nowMs, refreshClockBeforeDispatch, summary)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        this.logSchedulerFailure(outcome.reason);
      }
    }
    return summary;
  }

  private async processClaimedRecall(
    recall: MessageRecallRow,
    nowMs: number,
    refreshClockBeforeDispatch: boolean,
    summary: MessageRecallRunSummary,
  ): Promise<void> {
    const dispatchAt = refreshClockBeforeDispatch ? this.currentTime() : nowMs;
    if (dispatchAt > recall.deadline_at) {
      if (this.db.markMessageRecallTerminal(recall.id, "expired", dispatchAt)) {
        summary.terminal += 1;
        this.metric("message_recall_expired");
      }
      return;
    }
    // A notice can race the outbox acknowledgement: in that order there was
    // no message_recalls row for the notice handler to complete. The durable
    // retracted registry closes that window before any delete_msg action.
    if (this.db.isRetracted(recall.group_id, recall.platform_message_id)) {
      if (this.db.markMessageRecallTerminal(recall.id, "recalled", dispatchAt)) {
        summary.terminal += 1;
        this.metric("message_recall_external");
      }
      return;
    }
    if (!this.transport.deleteMessage) {
      if (this.db.markMessageRecallTerminal(recall.id, "unsupported", dispatchAt)) {
        summary.terminal += 1;
        this.metric("message_recall_unsupported");
      }
      return;
    }

    try {
      // Pass the exact outer message id returned by send_group_forward_msg.
      await this.transport.deleteMessage(recall.platform_message_id);
      if (this.db.markMessageRecallTerminal(recall.id, "recalled", dispatchAt)) {
        summary.recalled += 1;
        this.metric("message_recall_succeeded");
      }
    } catch (error) {
      if (error instanceof NapCatActionNotSentError) {
        const retryAt = recall.sent_at + MESSAGE_RECALL_RETRY_AFTER_MS;
        if (this.db.rescheduleMessageRecallAfterNotSent(recall.id, retryAt, dispatchAt)) {
          summary.retried += 1;
          this.metric("message_recall_retry_scheduled");
          return;
        }
        const terminal = this.db.getMessageRecall(recall.id)?.status;
        if (terminal === "expired" || terminal === "not_sent_expired") {
          this.metric("message_recall_expired");
        }
        summary.terminal += 1;
        return;
      }

      const status = error instanceof NapCatActionRejectedError
        ? "rejected"
        : "outcome_unknown";
      if (this.db.markMessageRecallTerminal(recall.id, status, dispatchAt)) {
        summary.terminal += 1;
        this.metric(status === "rejected" ? "message_recall_rejected" : "message_recall_outcome_unknown");
      }
    }
  }

  private currentTime(): number {
    return this.options.now?.() ?? Date.now();
  }

  private metric(name: MessageRecallMetric, by = 1): void {
    this.options.onMetric?.(name, by);
  }

  private logSchedulerFailure(error: unknown): void {
    logWarn("Message recall scheduler failed without sending a group message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private runMaintenance(): void {
    try {
      this.maintain();
    } catch (error) {
      this.logSchedulerFailure(error);
    }
  }
}

/** Kept exported for tests and documents the action classification boundary. */
export function isAmbiguousMessageRecallError(error: unknown): boolean {
  return error instanceof NapCatActionOutcomeUnknownError ||
    (!(error instanceof NapCatActionNotSentError) && !(error instanceof NapCatActionRejectedError));
}
