import assert from "node:assert/strict";
import test from "node:test";

import { LlmSemaphore, LlmSemaphoreTimeoutError, isLlmSemaphoreTimeout, withLlmPermit } from "./llm-semaphore.js";

test("semaphore allows up to maxConcurrent tasks and queues the rest", async () => {
  const semaphore = new LlmSemaphore(2, 2_000);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, () => withLlmPermit(semaphore, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(peak, 2, "must never exceed maxConcurrent");
  assert.equal(semaphore.activeCount, 0);
  assert.equal(semaphore.waitingCount, 0);
});

test("semaphore rejects with timeout when the queue is saturated", async () => {
  const semaphore = new LlmSemaphore(1, 50);
  const hold = withLlmPermit(semaphore, () => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  const result = await withLlmPermit(semaphore, async () => "never").catch((error) => error);
  assert.ok(isLlmSemaphoreTimeout(result));
  assert.ok(result instanceof LlmSemaphoreTimeoutError);
  await hold;
});

test("withLlmPermit releases the permit on task failure", async () => {
  const semaphore = new LlmSemaphore(1, 500);
  await withLlmPermit(semaphore, async () => {
    throw new Error("boom");
  }).catch(() => undefined);
  assert.equal(semaphore.activeCount, 0);
  const value = await withLlmPermit(semaphore, async () => "ok");
  assert.equal(value, "ok");
});
