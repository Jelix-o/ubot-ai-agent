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

  await runner.stop();
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

  await runner.stop();
  assert.equal(attempts.filter((id) => id === "fail").length, 2, "failed message must be retried");
  assert.ok(attempts.includes("ok"), "other key must still be processed");
  db.close();
});

test("ConsumerRunner restart recovers an expired source execution lease", async (t) => {
  const dbPath = tempDb(t);
  const firstDb = new SharedDb(dbPath);
  const rowId = insert(firstDb, "10001", "20001", "recover", 1000);
  const stale = firstDb.claimMessageExecutionLease({
    sourceRowId: rowId,
    now: Date.now() - 2_000,
    leaseMs: 1_000,
  });
  assert.equal(stale.state, "claimed");
  firstDb.close();

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
  await secondRunner.stop();
  assert.deepEqual(recovered, [rowId]);
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

  await runner.stop();
  assert.deepEqual(processed, [2]);
  db.close();
});

test("ConsumerRunner doubles retry delays from 5 seconds and caps at 30 seconds", async (t) => {
  const db = new SharedDb(tempDb(t));
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (_message, done) => { await done(); },
  });
  const internal = runner as unknown as {
    nextBackoff(state: { queue: []; backoffUntil: number; retryDelayMs: number }): number;
  };
  const state = { queue: [] as [], backoffUntil: 0, retryDelayMs: 0 };

  assert.equal(internal.nextBackoff(state), 5_000);
  state.retryDelayMs = 5_000;
  assert.equal(internal.nextBackoff(state), 10_000);
  state.retryDelayMs = 10_000;
  assert.equal(internal.nextBackoff(state), 20_000);
  state.retryDelayMs = 20_000;
  assert.equal(internal.nextBackoff(state), 30_000);
  state.retryDelayMs = 30_000;
  assert.equal(internal.nextBackoff(state), 30_000);

  await runner.stop();
  db.close();
});

test("ConsumerRunner resets a key's retry delay after successful completion", async (t) => {
  const db = new SharedDb(tempDb(t));
  let attempts = 0;
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (_message, done) => {
      attempts += 1;
      if (attempts === 1) throw new Error("retry once");
      await done();
    },
    pollIntervalMs: 10,
    initialKeyBackoffMs: 5,
    maxKeyBackoffMs: 30,
  });
  insert(db, "10001", "20001", "retry-reset", 1000);
  await waitFor(() => db.pollMessages("test-worker", 100).length === 0);

  const internal = runner as unknown as {
    keys: Map<string, { retryDelayMs: number; backoffUntil: number }>;
  };
  const state = internal.keys.get("10001:20001");
  assert.equal(attempts, 2);
  assert.equal(state?.retryDelayMs, 0);
  assert.equal(state?.backoffUntil, 0);

  await runner.stop();
  db.close();
});

test("ConsumerRunner stops intake and drains active work before resolving", async (t) => {
  const db = new SharedDb(tempDb(t));
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let markActiveStarted!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    markActiveStarted = resolve;
  });
  const processed: string[] = [];
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => `${message.group_id}:${message.user_id}`,
    handler: async (message, done) => {
      processed.push(message.msg_id);
      if (message.msg_id === "active") {
        markActiveStarted();
        await activeGate;
      }
      await done();
    },
    pollIntervalMs: 10,
  });
  try {
    insert(db, "10001", "20001", "active", 1000);
    await activeStarted;

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    insert(db, "10001", "20001", "queued-after-stop", 2000);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stopped, false, "stop must wait for the active handler");
    assert.deepEqual(processed, ["active"], "stop must reject new task dispatches");

    releaseActive();
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(processed, ["active"]);
    assert.deepEqual(
      db.pollMessages("test-worker", 100).map((message) => message.msg_id),
      ["queued-after-stop"],
    );
  } finally {
    releaseActive();
    await runner.stop();
    db.close();
  }
});

test("ConsumerRunner handoff never inserts ahead of an active destination task", async (t) => {
  const db = new SharedDb(tempDb(t));
  let releaseDestination!: () => void;
  const destinationReleased = new Promise<void>((resolve) => {
    releaseDestination = resolve;
  });
  let markDestinationStarted!: () => void;
  const destinationStarted = new Promise<void>((resolve) => {
    markDestinationStarted = resolve;
  });
  let markStagedHandoff!: () => void;
  const stagedHandoff = new Promise<void>((resolve) => {
    markStagedHandoff = resolve;
  });
  const processed: string[] = [];
  const runner = new ConsumerRunner(db, "test-worker", {
    keyOf: (message) => message.msg_id === "older-staged" ? "staging" : "destination",
    handler: async (message, done, handoff, currentKey) => {
      if (message.msg_id === "older-staged" && currentKey === "staging") {
        await destinationStarted;
        await handoff("destination");
        markStagedHandoff();
        return;
      }

      processed.push(message.msg_id);
      if (message.msg_id === "newer-destination") {
        markDestinationStarted();
        await destinationReleased;
      }
      await done();
    },
    pollIntervalMs: 10,
  });

  try {
    insert(db, "10001", "20001", "older-staged", 1000);
    insert(db, "10001", "20001", "newer-destination", 2000);

    await stagedHandoff;
    releaseDestination();
    await waitFor(() => db.pollMessages("test-worker", 100).length === 0);

    assert.deepEqual(
      processed,
      ["newer-destination", "older-staged"],
      "an active destination head must finish before a staged older row can run",
    );
  } finally {
    releaseDestination();
    await runner.stop();
    db.close();
  }
});

test("ConsumerRunner invokes an image handler only once across two worker connections", async (t) => {
  const dbPath = tempDb(t);
  const firstDb = new SharedDb(dbPath);
  const secondDb = new SharedDb(dbPath);
  let releaseImage = () => {};
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  let markImageStarted!: () => void;
  const imageStarted = new Promise<void>((resolve) => {
    markImageStarted = resolve;
  });
  let imageHandlerCalls = 0;
  const makeRunner = (db: SharedDb, consumerKey: string) => new ConsumerRunner(db, consumerKey, {
    keyOf: (message) => `${message.group_id}:image:${message.user_id}`,
    handler: async (_message, done) => {
      imageHandlerCalls += 1;
      if (imageHandlerCalls === 1) {
        markImageStarted();
        await imageGate;
      }
      await done();
    },
    pollIntervalMs: 10,
    initialKeyBackoffMs: 10,
    maxKeyBackoffMs: 30,
    maxConcurrentKeys: 1,
  });
  const firstRunner = makeRunner(firstDb, "worker:image-a");
  const secondRunner = makeRunner(secondDb, "worker:image-b");

  try {
    insert(firstDb, "10001", "20001", "image-source", 1000);
    await imageStarted;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(imageHandlerCalls, 1, "a live source-row lease blocks the second worker before image handling");

    releaseImage();
    await waitFor(() =>
      firstDb.pollMessages("worker:image-a", 10).length === 0 &&
      secondDb.pollMessages("worker:image-b", 10).length === 0,
    );
    assert.equal(imageHandlerCalls, 1, "the second worker only acknowledges the globally completed row");
  } finally {
    releaseImage();
    await Promise.all([firstRunner.stop(), secondRunner.stop()]);
    firstDb.close();
    secondDb.close();
  }
});

test("ConsumerRunner retains source ownership through handoff and drains it during stop", async (t) => {
  const dbPath = tempDb(t);
  const firstDb = new SharedDb(dbPath);
  let releaseStaging = () => {};
  const stagingGate = new Promise<void>((resolve) => {
    releaseStaging = resolve;
  });
  let markHandoffReady!: () => void;
  const handoffReady = new Promise<void>((resolve) => {
    markHandoffReady = resolve;
  });
  let destinationCalls = 0;
  const firstRunner = new ConsumerRunner(firstDb, "worker:handoff-owner", {
    keyOf: () => "image-intent-staging",
    handler: async (_message, done, handoff, currentKey) => {
      if (currentKey === "image-intent-staging") {
        await handoff("image-final");
        markHandoffReady();
        await stagingGate;
        return;
      }
      destinationCalls += 1;
      await done();
    },
    pollIntervalMs: 10,
    initialKeyBackoffMs: 10,
    maxKeyBackoffMs: 30,
    maxConcurrentKeys: 1,
  });

  let secondCalls = 0;
  let secondDb: SharedDb | undefined;
  let secondRunner: ConsumerRunner | undefined;
  try {
    insert(firstDb, "10001", "20001", "handoff-source", 1000);
    await handoffReady;

    secondDb = new SharedDb(dbPath);
    secondRunner = new ConsumerRunner(secondDb, "worker:handoff-observer", {
      keyOf: () => "image-intent-staging",
      handler: async (_message, done) => {
        secondCalls += 1;
        await done();
      },
      pollIntervalMs: 10,
      initialKeyBackoffMs: 10,
      maxKeyBackoffMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondCalls, 0, "another worker cannot enter while the staged row owns its lease");

    const stopping = firstRunner.stop();
    releaseStaging();
    await stopping;
    assert.equal(destinationCalls, 1, "stop drains the already-owned final handoff lane");

    await waitFor(() => secondDb!.pollMessages("worker:handoff-observer", 10).length === 0);
    assert.equal(secondCalls, 0, "the observer only acknowledges the completed source row");
  } finally {
    releaseStaging();
    await firstRunner.stop();
    await secondRunner?.stop();
    firstDb.close();
    secondDb?.close();
  }
});
