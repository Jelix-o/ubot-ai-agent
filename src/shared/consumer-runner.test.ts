import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "./sqlite.js";
import { ConsumerRunner } from "./consumer-runner.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runner-db-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "bot-shared.db");
}

function insert(db: SharedDb, groupId: string, userId: string, msgId: string, msgTime: number): number {
  return db.insertMessage({
    groupId,
    userId,
    selfId: "bot",
    msgId,
    msgTime,
    text: `msg ${msgId}`,
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: msgTime,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ConsumerRunner processes messages per key serially and advances watermarks", async (t) => {
  const db = new SharedDb(tempDb(t));
  const processed: Array<{ key: string; id: number }> = [];
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (message, done) => {
      processed.push({ key: `${message.group_id}:${message.user_id}`, id: message.id });
      await done();
    },
    pollIntervalMs: 20,
    batchSize: 100,
    maxConcurrentKeys: 8,
  });

  insert(db, "10001", "20001", "a", 1000);
  insert(db, "10001", "20001", "b", 2000);
  insert(db, "10001", "20001", "c", 3000);
  insert(db, "10001", "20002", "d", 1500);

  await waitFor(() => processed.length === 4);

  runner.stop();
  const key1 = db.pollMessages("test-worker", 100);
  assert.equal(key1.length, 0, "all messages consumed");
  assert.deepEqual(
    processed.filter((item) => item.key === "10001:20001").map((item) => item.id),
    [1, 2, 3],
    "same key must process in msg_time order",
  );
  db.close();
});

test("ConsumerRunner retries failed messages without blocking other keys", async (t) => {
  const db = new SharedDb(tempDb(t));
  const attempts: string[] = [];
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (message, done) => {
      attempts.push(message.msg_id);
      if (message.msg_id === "fail" && attempts.filter((id) => id === "fail").length === 1) {
        throw new Error("boom");
      }
      await done();
    },
    pollIntervalMs: 20,
    batchSize: 100,
    maxConcurrentKeys: 8,
    maxKeyBackoffMs: 50,
  });

  insert(db, "10001", "20001", "fail", 1000);
  insert(db, "10001", "20002", "ok", 1500);

  // The other key completes while the failed row stays recoverable and retries
  // once after its per-key backoff.
  await waitFor(() => attempts.includes("ok"));
  await waitFor(() => db.pollMessages("test-worker", 100).length === 0);

  runner.stop();
  assert.equal(attempts.filter((id) => id === "fail").length, 2, "failed message must be retried");
  assert.ok(attempts.includes("ok"), "other key must still be processed");
  db.close();
});

test("ConsumerRunner restart recovers a queued message that was never completed", async (t) => {
  const dbPath = tempDb(t);
  const firstDb = new SharedDb(dbPath);
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstFinished!: () => void;
  const firstFinished = new Promise<void>((resolve) => {
    markFirstFinished = resolve;
  });
  const firstRunner = new ConsumerRunner(firstDb, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async () => {
      await firstBlocked;
      markFirstFinished();
    },
    pollIntervalMs: 20,
  });
  const rowId = insert(firstDb, "10001", "20001", "recover", 1000);
  await waitFor(() => firstRunner.queueDepth === 1);
  firstRunner.stop();

  const secondDb = new SharedDb(dbPath);
  const recovered: number[] = [];
  const secondRunner = new ConsumerRunner(secondDb, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (message, done) => {
      recovered.push(message.id);
      await done();
    },
    pollIntervalMs: 20,
  });
  await waitFor(() => recovered.length === 1);
  secondRunner.stop();
  releaseFirst();
  await firstFinished;
  assert.deepEqual(recovered, [rowId]);
  firstDb.close();
  secondDb.close();
});

test("ConsumerRunner ignores messages with empty key", async (t) => {
  const db = new SharedDb(tempDb(t));
  const processed: number[] = [];
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => (message.msg_id === "skip" ? "" : `${message.group_id}:${message.user_id}`),
    handler: async (message, done) => {
      processed.push(message.id);
      await done();
    },
    pollIntervalMs: 20,
  });

  insert(db, "10001", "20001", "skip", 1000);
  insert(db, "10001", "20001", "keep", 2000);

  await waitFor(() => processed.length === 1);
  await waitFor(() => db.pollMessages("test-worker", 100).length === 0);

  runner.stop();
  assert.deepEqual(processed, [2]);
  db.close();
});
