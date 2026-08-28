/**
 * The worker polls every ten seconds. Individual jobs retain their own
 * cadence so a slow or disabled feature does not require another process or
 * timer. These values preserve the V3 BotApplication timing contract.
 */
export const BOT_MAINTENANCE_INTERVALS = {
  poll: 10_000,
  liveChat: 15 * 1_000,
  dailyReport: 30 * 1_000,
  holidayCountdown: 30 * 1_000,
  scheduledReminder: 30 * 1_000,
  opsAlert: 30 * 1_000,
  dailyReportCleanup: 60 * 1_000,
} as const;

export interface MaintenanceJob {
  /** Stable diagnostic key; duplicate jobs are rejected at composition time. */
  id: string;
  intervalMs: number;
  run(): Promise<void>;
}

export interface MaintenanceSchedulerOptions {
  jobs: readonly MaintenanceJob[];
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: (handler: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}

/**
 * Owns only maintenance timing and serialization. Feature work remains in
 * focused services/callbacks, while the scheduler guarantees that a slow
 * tick cannot overlap the next polling turn.
 */
export class MaintenanceScheduler {
  private readonly jobs: readonly MaintenanceJob[];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: (handler: () => void, intervalMs: number) => NodeJS.Timeout;
  private readonly clearIntervalImpl: (timer: NodeJS.Timeout) => void;
  private readonly lastRunAtByJobId = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private tickRunning = false;

  constructor(options: MaintenanceSchedulerOptions) {
    this.jobs = options.jobs;
    this.pollIntervalMs = options.pollIntervalMs ?? BOT_MAINTENANCE_INTERVALS.poll;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setInterval ?? setInterval;
    this.clearIntervalImpl = options.clearInterval ?? clearInterval;
    assertValidJobs(this.jobs);

    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("maintenance_poll_interval_invalid");
    }
  }

  /** Starts polling and reports whether this call acquired the lifecycle. */
  start(): boolean {
    if (this.timer) {
      return false;
    }

    this.timer = this.setIntervalImpl(() => {
      void this.runDueJobs();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  /**
   * Executes due jobs in declaration order. A job is marked before it runs,
   * exactly matching the former BotApplication behavior: one failing job does
   * not cause an immediate tight retry, and jobs after it wait for the next
   * poll.
   */
  async runDueJobs(nowMs = this.now()): Promise<void> {
    if (this.tickRunning) {
      return;
    }
    this.tickRunning = true;
    try {
      for (const job of this.jobs) {
        const lastRunAt = this.lastRunAtByJobId.get(job.id) ?? 0;
        if (nowMs - lastRunAt < job.intervalMs) {
          continue;
        }
        this.lastRunAtByJobId.set(job.id, nowMs);
        await job.run();
      }
    } finally {
      this.tickRunning = false;
    }
  }
}

function assertValidJobs(jobs: readonly MaintenanceJob[]): void {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job.id.trim() || ids.has(job.id)) {
      throw new Error("maintenance_job_id_invalid");
    }
    if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
      throw new Error(`maintenance_job_interval_invalid:${job.id}`);
    }
    ids.add(job.id);
  }
}
