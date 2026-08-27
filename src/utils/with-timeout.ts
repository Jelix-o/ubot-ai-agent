/**
 * Runs a promise under a hard timeout. On expiry the returned promise rejects
 * with `TimeoutError`; the underlying work continues but its result is ignored
 * (used for non-critical context layers where a slow call must not block the
 * reply, plan §2.4 分级超时).
 */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof TimeoutError;
}
