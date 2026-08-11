import { logWarn } from "../logger.js";

/**
 * Global LLM concurrency limiter (plan section 2.2, 全局 LLM 并发).
 * Protects the upstream gateway: at most `maxConcurrent` in-flight LLM calls,
 * others wait up to `queueTimeoutMs`, then are rejected with a timeout error so
 * the caller can degrade (轻量话术) instead of piling up.
 */
export class LlmSemaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly maxConcurrent = 8,
    private readonly queueTimeoutMs = 2_000,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  /** Acquires a permit; rejects with LlmSemaphoreTimeoutError when the wait exceeds queueTimeoutMs. */
  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new LlmSemaphoreTimeoutError(this.queueTimeoutMs));
      }, this.queueTimeoutMs);
      timer.unref();
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          this.active += 1;
          resolve(() => this.release());
        },
        timer,
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
    }
  }
}

export class LlmSemaphoreTimeoutError extends Error {
  constructor(queueTimeoutMs: number) {
    super(`LLM concurrency slot unavailable after ${queueTimeoutMs}ms of waiting.`);
    this.name = "LlmSemaphoreTimeoutError";
  }
}

/** Runs an LLM-bound async task under the semaphore; rejects with LlmSemaphoreTimeoutError on queue overflow. */
export async function withLlmPermit<T>(
  semaphore: LlmSemaphore,
  task: () => Promise<T>,
): Promise<T> {
  const release = await semaphore.acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

/** True when the error came from the semaphore queue rather than the upstream call. */
export function isLlmSemaphoreTimeout(error: unknown): boolean {
  return error instanceof LlmSemaphoreTimeoutError;
}

export function logSemaphorePressure(semaphore: LlmSemaphore): void {
  if (semaphore.waitingCount > 0) {
    logWarn("LLM semaphore has queued callers.", {
      active: semaphore.activeCount,
      waiting: semaphore.waitingCount,
    });
  }
}
