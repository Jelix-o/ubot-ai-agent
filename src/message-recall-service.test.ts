import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NapCatActionNotSentError,
  NapCatActionOutcomeUnknownError,
  NapCatActionRejectedError,
} from "./napcat-action-errors.js";
import { MessageRecallService } from "./message-recall-service.js";
import { SharedDb } from "./shared/sqlite.js";

const policy = { afterMs: 90_000, deadlineMs: 105_000 };

function tempDb(t: test.TestContext): SharedDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "message-recall-service-"));
  const db = new SharedDb(path.join(dir, "shared.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function recallTransport(deleteMessage?: (messageId: string) => Promise<void>) {
  const groupMessages: string[] = [];
  const deleted: string[] = [];
  return {
    groupMessages,
    deleted,
    transport: {
      sendGroupMessage: async (_groupId: string, text: string) => {
        groupMessages.push(text);
      },
      sendGroupImage: async () => undefined,
      deleteMessage: deleteMessage
        ? async (messageId: string) => {
            deleted.push(messageId);
            await deleteMessage(messageId);
          }
        : undefined,
    },
  };
}

test("recalls the exact outer forward message id silently at 90 seconds", async (t) => {
  const db = tempDb(t);
  db.scheduleDirectMessageRecall("10001", "outer:card%25&tracker=[x]", policy, 1_000);
  const fake = recallTransport(async () => undefined);
  const service = new MessageRecallService(db, fake.transport);

  await service.runDue(90_999);
  assert.deepEqual(fake.deleted, []);
  await service.runDue(91_000);

  assert.deepEqual(fake.deleted, ["outer:card%25&tracker=[x]"]);
  assert.deepEqual(fake.groupMessages, []);
  assert.equal(db.getMessageRecall(1)?.status, "recalled");
});

test("retries exactly once only when delete_msg was definitely not dispatched", async (t) => {
  const db = tempDb(t);
  const recall = db.scheduleDirectMessageRecall("10001", "outer-card", policy, 1_000);
  let attempts = 0;
  const fake = recallTransport(async () => {
    attempts += 1;
    if (attempts === 1) throw new NapCatActionNotSentError("socket unavailable before send");
  });
  const service = new MessageRecallService(db, fake.transport);

  await service.runDue(91_000);
  assert.equal(db.getMessageRecall(recall.id)?.status, "pending");
  assert.equal(db.getMessageRecall(recall.id)?.due_at, 101_000);
  await service.runDue(101_000);

  assert.equal(attempts, 2);
  assert.equal(db.getMessageRecall(recall.id)?.status, "recalled");
  assert.deepEqual(fake.groupMessages, []);
});

test("rejection and ambiguous delete results are terminal and do not emit group text", async (t) => {
  const db = tempDb(t);
  const rejected = db.scheduleDirectMessageRecall("10001", "rejected-card", policy, 1_000);
  const unknown = db.scheduleDirectMessageRecall("10001", "unknown-card", policy, 1_000);
  const fake = recallTransport(async (messageId) => {
    if (messageId === "rejected-card") throw new NapCatActionRejectedError("cannot delete");
    throw new NapCatActionOutcomeUnknownError("request timed out");
  });
  const service = new MessageRecallService(db, fake.transport);

  await service.runDue(91_000);

  assert.equal(db.getMessageRecall(rejected.id)?.status, "rejected");
  assert.equal(db.getMessageRecall(unknown.id)?.status, "outcome_unknown");
  assert.deepEqual(fake.groupMessages, []);
});

test("expired and externally recalled tasks never issue another action", async (t) => {
  const db = tempDb(t);
  const expired = db.scheduleDirectMessageRecall("10001", "expired-card", policy, 1_000);
  const external = db.scheduleDirectMessageRecall("10001", "external-card", policy, 1_000);
  db.markMessageRecallObserved("10001", "external-card", 2_000);

  const fake = recallTransport();
  const service = new MessageRecallService(db, fake.transport);
  await service.runDue(106_001);

  assert.equal(db.getMessageRecall(expired.id)?.status, "expired");
  assert.equal(db.getMessageRecall(external.id)?.status, "recalled");
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.groupMessages, []);
});

test("a recall notice that precedes task creation is rechecked before delete_msg", async (t) => {
  const db = tempDb(t);
  db.markRetracted("10001", "race-card", 2_000);
  const recall = db.scheduleDirectMessageRecall("10001", "race-card", policy, 1_000);
  const fake = recallTransport(async () => {
    throw new Error("delete_msg must not be called for an already recalled card");
  });
  const service = new MessageRecallService(db, fake.transport);

  await service.runDue(91_000);

  assert.equal(db.getMessageRecall(recall.id)?.status, "recalled");
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.groupMessages, []);
});

test("unsupported transports and inherited in-flight sends are terminal without group text", async (t) => {
  const db = tempDb(t);
  const unsupported = db.scheduleDirectMessageRecall("10001", "unsupported-card", policy, 1_000);
  const inherited = db.scheduleDirectMessageRecall("10001", "inherited-card", policy, 1_000);
  assert.equal(db.claimDueMessageRecalls(1, 91_000)[0]?.id, unsupported.id);

  const fake = recallTransport();
  const service = new MessageRecallService(db, fake.transport, { now: () => 122_000 });
  service.start();
  await service.stop();

  // The first claimed job was inherited after a crash. The other due job is
  // expired by the startup pass, and neither can generate group text.
  assert.equal(db.getMessageRecall(unsupported.id)?.status, "outcome_unknown");
  assert.equal(db.getMessageRecall(inherited.id)?.status, "expired");
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.groupMessages, []);
});

test("a due job is marked unsupported when delete_msg is unavailable", async (t) => {
  const db = tempDb(t);
  const recall = db.scheduleDirectMessageRecall("10001", "unsupported-card", policy, 1_000);
  const fake = recallTransport();
  const service = new MessageRecallService(db, fake.transport);

  await service.runDue(91_000);

  assert.equal(db.getMessageRecall(recall.id)?.status, "unsupported");
  assert.deepEqual(fake.groupMessages, []);
});

test("terminal recall tasks use the normal seven-day retention window", async (t) => {
  const db = tempDb(t);
  const recall = db.scheduleDirectMessageRecall("10001", "retained-card", policy, 1_000);
  assert.equal(db.claimDueMessageRecalls(1, 91_000)[0]?.id, recall.id);
  assert.equal(db.markMessageRecallTerminal(recall.id, "recalled", 91_001), true);
  const service = new MessageRecallService(db, recallTransport().transport);

  assert.equal(service.maintain(91_001 + 7 * 24 * 60 * 60 * 1_000), 0);
  assert.equal(service.maintain(91_002 + 7 * 24 * 60 * 60 * 1_000), 1);
  assert.equal(db.getMessageRecall(recall.id), undefined);
});
