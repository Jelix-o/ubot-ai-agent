import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "./sqlite.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shared-db-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "bot-shared.db");
}

test("insertMessage dedupes by (self, group, msg) and returns 0 on duplicates", (t) => {
  const db = new SharedDb(tempDb(t));
  const base = {
    groupId: "10001",
    userId: "20001",
    selfId: "30001",
    msgId: "m1",
    msgTime: 1_700_000_000_000,
    text: "hello",
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: 1_700_000_000_000,
  };
  const first = db.insertMessage(base);
  assert.ok(first > 0);
  assert.equal(db.insertMessage(base), 0);
  assert.equal(
    db.insertMessage({ ...base, msgId: "m2" }) > 0,
    true,
    "different msg_id must insert",
  );
  db.close();
});

test("pollMessages advances watermark per consumer key and never backwards", (t) => {
  const db = new SharedDb(tempDb(t));
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "a",
    msgTime: 1000, text: "first", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: 1,
  });
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "b",
    msgTime: 3000, text: "third", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: 2,
  });
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "c",
    msgTime: 2000, text: "second", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: 3,
  });

  // Poll order is QQ-side msg_time (plan §2.1), tie-broken by id.
  const batch = db.pollMessages("worker:main", 10);
  assert.deepEqual(batch.map((row) => row.text), ["first", "second", "third"]);

  // Advancing to the first id only reveals the rest (watermark stays on id).
  db.advanceWatermark("worker:main", batch[0]!.id);
  assert.deepEqual(db.pollMessages("worker:main", 10).map((row) => row.text), ["second", "third"]);

  // Watermark never moves backwards: re-advancing an old id is a no-op.
  db.advanceWatermark("worker:main", 1);
  assert.deepEqual(db.pollMessages("worker:main", 10).map((row) => row.text), ["second", "third"]);

  // Separate consumer key starts from the beginning.
  assert.equal(db.pollMessages("worker:other", 10).length, 3);
  db.close();
});

test("inflight registry supports cancel request and clear", (t) => {
  const db = new SharedDb(tempDb(t));
  const key = "10001:20001:t1";
  db.registerInflight(key, "task-1", 123, "tok-1");
  const row = db.getInflight(key);
  assert.equal(row?.task_id, "task-1");
  assert.equal(row?.cancel_requested, 0);
  assert.equal(row?.cancel_token, "tok-1");

  db.requestCancel(key);
  assert.equal(db.getInflight(key)?.cancel_requested, 1);

  db.clearInflight(key);
  assert.equal(db.getInflight(key), undefined);
  db.close();
});

test("retracted registry marks and prunes", (t) => {
  const db = new SharedDb(tempDb(t));
  db.markRetracted("10001", "m1", 1000);
  assert.equal(db.isRetracted("10001", "m1"), true);
  assert.equal(db.isRetracted("10001", "m2"), false);
  db.pruneRetracted(2000);
  assert.equal(db.isRetracted("10001", "m1"), false);
  db.close();
});

test("outbox claims atomically to prevent double-send", (t) => {
  const db = new SharedDb(tempDb(t));
  const id = db.enqueueOutbox("10001", "m1", "reply text");
  assert.ok(id > 0);

  // First claim flips the row to 'sending' and returns it.
  const claimed = db.claimOutbox(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.text, "reply text");
  assert.equal(claimed[0]!.reply_to, "m1");

  // A second claim must NOT return the same row (it is 'sending', not expired).
  assert.equal(db.claimOutbox(10).length, 0, "sending row must not be re-claimed");

  // After the sending timeout elapses, the row is reclaimed (sender may have died).
  const reclaimed = db.claimOutbox(10, Date.now() + 11_000);
  assert.equal(reclaimed.length, 1, "stale sending row must be reclaimed");

  // Mark sent → never claimed again.
  db.markOutboxSent(reclaimed[0]!.id);
  assert.equal(db.claimOutbox(10, Date.now() + 60_000).length, 0);

  // Failed with retry_after → reclaimed only after the backoff.
  const failed = db.enqueueOutbox("10001", null, "another");
  db.markOutboxFailed(failed, 2_000);
  assert.equal(db.claimOutbox(10).length, 0, "failed row waits for retry_after");
  assert.equal(db.claimOutbox(10, Date.now() + 3_000).length, 1, "failed row retries after backoff");
  db.close();
});

test("token bucket counting uses msg_time window", (t) => {
  const db = new SharedDb(tempDb(t));
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    db.insertMessage({
      groupId: "10001", userId: "20001", selfId: "30001", msgId: `m${i}`,
      msgTime: now - i * 1000, text: "x", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: now,
    });
  }
  assert.equal(db.countMessagesSince("10001", now - 10_000), 5);
  assert.equal(db.countMessagesSince("10001", now - 2_000), 3);
  assert.equal(db.countMessagesSince("99999", now - 10_000), 0);
  db.close();
});

test("bot messages recorded and pruned", (t) => {
  const db = new SharedDb(tempDb(t));
  db.recordBotMessage("10001", "b1", 1000);
  db.recordBotMessage("10001", "b2", 3000);
  db.pruneBotMessages(2000);
  // The prune only deletes rows older than the cutoff; b1 is gone.
  const rows = db.db
    .prepare("SELECT msg_id FROM bot_messages WHERE group_id = ? ORDER BY sent_at")
    .all("10001") as Array<{ msg_id: string }>;
  assert.deepEqual(rows.map((row) => row.msg_id), ["b2"]);
  db.close();
});
