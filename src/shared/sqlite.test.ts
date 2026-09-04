import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SharedDb } from "./sqlite.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shared-db-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "bot-shared.db");
}

test("participation decisions persist the latest auditable policy result per source message", (t) => {
  const db = new SharedDb(tempDb(t));

  db.recordParticipationDecision({
    sourceRowId: 10,
    groupId: "67890",
    userId: "20001",
    action: "observe",
    reason: "ambient_observation",
    score: 0,
    policyVersion: "v1-conservative",
    signals: { hasAtBot: false },
    createdAt: 1_000,
  });
  db.recordParticipationDecision({
    sourceRowId: 10,
    groupId: "67890",
    userId: "20001",
    action: "reply",
    reason: "direct_mention",
    score: 1,
    policyVersion: "v1-conservative",
    signals: { hasAtBot: true },
    createdAt: 2_000,
  });
  db.recordParticipationDecision({
    sourceRowId: 11,
    groupId: "other-group",
    userId: "30001",
    action: "ignore",
    reason: "group_unavailable",
    score: 0,
    policyVersion: "v1-conservative",
    signals: { hasAtBot: false },
    createdAt: 3_000,
  });

  const rows = db.listParticipationDecisions({ groupId: "67890" });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0] && {
    sourceRowId: rows[0].source_row_id,
    action: rows[0].action,
    reason: rows[0].reason,
    score: rows[0].score,
    policyVersion: rows[0].policy_version,
    signals: JSON.parse(rows[0].signals_json),
    createdAt: rows[0].created_at,
  }, {
    sourceRowId: 10,
    action: "reply",
    reason: "direct_mention",
    score: 1,
    policyVersion: "v1-conservative",
    signals: { hasAtBot: true },
    createdAt: 2_000,
  });
  assert.equal(db.getParticipationDecision(10)?.reason, "direct_mention");
  assert.equal(db.getParticipationDecision(999), undefined);
  db.close();
});

test("dropped messages remain auditable but carry a non-processable marker", (t) => {
  const db = new SharedDb(tempDb(t));
  const id = db.insertMessage({
    groupId: "10001",
    userId: "20001",
    selfId: "30001",
    msgId: "dropped-1",
    msgTime: 1_700_000_000_000,
    text: "burst message",
    imagesJson: "[]",
    hasAtBot: false,
    isBotMsg: false,
    processable: false,
    dropReason: "rate_limited",
    createdAt: 1_700_000_000_000,
  });

  const [row] = db.pollMessages("worker:main", 10);
  assert.equal(row?.id, id);
  assert.equal(row?.processable, 0);
  assert.equal(row?.drop_reason, "rate_limited");
  db.markMessageDropped(id, "manual_drop");
  assert.equal(db.pollMessages("worker:main", 10)[0]?.drop_reason, "manual_drop");
  db.close();
});

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

test("message sender card and nickname survive SQLite polling", (t) => {
  const db = new SharedDb(tempDb(t));
  db.insertMessage({
    groupId: "10001",
    userId: "20001",
    selfId: "30001",
    msgId: "sender-1",
    msgTime: 1_700_000_000_000,
    text: "hello",
    imagesJson: "[]",
    senderCard: "  群名片  ",
    senderNickname: "  QQ昵称  ",
    hasAtBot: false,
    isBotMsg: false,
    createdAt: 1_700_000_000_000,
  });

  const [row] = db.pollMessages("worker:sender", 10);
  assert.equal(row?.sender_card, "群名片");
  assert.equal(row?.sender_nickname, "QQ昵称");
  db.close();
});

test("old messages schema is upgraded with nullable sender identity columns", (t) => {
  const dbPath = tempDb(t);
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      self_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      msg_time INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      has_at_bot INTEGER NOT NULL DEFAULT 0,
      is_bot_msg INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE
    );
  `);
  legacy.close();

  const db = new SharedDb(dbPath);
  const columns = db.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "sender_card"), true);
  assert.equal(columns.some((column) => column.name === "sender_nickname"), true);
  db.close();
});

test("versioned migrations are recorded once and provision V3 authority tables", (t) => {
  const dbPath = tempDb(t);
  const first = new SharedDb(dbPath);
  assert.deepEqual(
    first.listSchemaMigrations().map((migration) => ({ version: migration.version, name: migration.name })),
    [
      { version: 1, name: "reconcile-pre-versioned-schema" },
      { version: 2, name: "add-group-config-shadow-snapshots" },
      { version: 3, name: "add-system-settings-shadow-snapshots" },
      { version: 4, name: "add-outbox-delivery-attempts" },
      { version: 5, name: "add-v3-control-and-character-authority" },
      { version: 6, name: "add-v3-content-and-schedule-authority" },
      { version: 7, name: "add-v3-admin-account-authentication" },
      { version: 8, name: "add-v3-retention-and-cutover-metadata" },
      { version: 9, name: "add-v3-daily-report-rendered-outputs" },
      { version: 10, name: "add-static-html-preview-publications" },
      { version: 11, name: "add-admin-qq-account-bindings" },
    ],
  );
  const tables = first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  assert.equal(tables.some((table) => table.name === "group_config_shadow_snapshots"), true);
  assert.equal(tables.some((table) => table.name === "system_settings_shadow_snapshots"), true);
  assert.equal(tables.some((table) => table.name === "v3_character_profiles"), true);
  assert.equal(tables.some((table) => table.name === "v3_memories"), true);
  assert.equal(tables.some((table) => table.name === "admin_accounts"), true);
  assert.equal(tables.some((table) => table.name === "v3_rollback_archives"), true);
    assert.equal(tables.some((table) => table.name === "v3_daily_report_outputs"), true);
    assert.equal(tables.some((table) => table.name === "html_previews"), true);
    assert.equal(tables.some((table) => table.name === "admin_qq_bindings"), true);
  first.close();

  const second = new SharedDb(dbPath);
  assert.deepEqual(
    second.listSchemaMigrations().map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "reopening must not apply or record the same migration twice",
  );
  second.close();
});

test("pollMessages uses the same monotonic id order as its watermark", (t) => {
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

  // Poll order is the SQLite autoincrement id used by the watermark.
  const batch = db.pollMessages("worker:main", 10);
  assert.deepEqual(batch.map((row) => row.text), ["first", "third", "second"]);

  // Advancing to the first id only reveals the rest (watermark stays on id).
  db.advanceWatermark("worker:main", batch[0]!.id);
  assert.deepEqual(db.pollMessages("worker:main", 10).map((row) => row.text), ["third", "second"]);

  // Watermark never moves backwards: re-advancing an old id is a no-op.
  db.advanceWatermark("worker:main", 1);
  assert.deepEqual(db.pollMessages("worker:main", 10).map((row) => row.text), ["third", "second"]);

  // Separate consumer key starts from the beginning.
  assert.equal(db.pollMessages("worker:other", 10).length, 3);
  db.close();
});

test("pollMessages does not skip rows when a batch contains out-of-order timestamps", (t) => {
  const db = new SharedDb(tempDb(t));
  for (let index = 0; index < 65; index += 1) {
    db.insertMessage({
      groupId: "10001",
      userId: "20001",
      selfId: "30001",
      msgId: `batch-${index}`,
      msgTime: 10_000 - index,
      text: String(index),
      imagesJson: "[]",
      hasAtBot: false,
      isBotMsg: false,
      createdAt: index,
    });
  }
  const seen: number[] = [];
  while (true) {
    const batch = db.pollMessages("worker:batch", 20);
    if (batch.length === 0) {
      break;
    }
    for (const row of batch) {
      seen.push(row.id);
      db.completeConsumerMessage("worker:batch", row.id);
    }
  }
  assert.deepEqual(seen, Array.from({ length: 65 }, (_, index) => index + 1));
  db.close();
});

test("completed rows behind a failed gap do not starve later polling batches", (t) => {
  const db = new SharedDb(tempDb(t));
  const ids: number[] = [];
  for (let index = 0; index < 65; index += 1) {
    ids.push(db.insertMessage({
      groupId: "10001",
      userId: "20001",
      selfId: "30001",
      msgId: `gap-${index}`,
      msgTime: 20_000 - index,
      text: String(index),
      imagesJson: "[]",
      hasAtBot: false,
      isBotMsg: false,
      createdAt: index,
    }));
  }

  const firstBatch = db.pollMessages("worker:gap", 50);
  assert.deepEqual(firstBatch.map((row) => row.id), ids.slice(0, 50));
  for (const row of firstBatch.slice(1)) {
    db.completeConsumerMessage("worker:gap", row.id);
  }

  const nextBatch = db.pollMessages("worker:gap", 50);
  assert.deepEqual(
    nextBatch.map((row) => row.id),
    [ids[0]!, ...ids.slice(50)],
    "the failed head remains retryable while completed rows stop occupying the batch",
  );
  db.close();
});

test("completed watermark crosses the context cutover and consumes later batches exactly once", (t) => {
  const db = new SharedDb(tempDb(t));
  for (let index = 0; index < 7; index += 1) {
    db.insertMessage({
      groupId: "10001",
      userId: "20001",
      selfId: "30001",
      msgId: `audit-${index}`,
      msgTime: index,
      text: `audit ${index}`,
      imagesJson: "[]",
      hasAtBot: false,
      isBotMsg: false,
      createdAt: index,
    });
  }
  db.db.prepare(
    `INSERT INTO conversation_context_meta (key, value)
     VALUES ('cutover_message_id', '7')`,
  ).run();
  for (let index = 0; index < 45; index += 1) {
    db.insertMessage({
      groupId: "10001",
      userId: "20001",
      selfId: "30001",
      msgId: `post-cutover-${index}`,
      msgTime: 10_000 - index,
      text: String(index),
      imagesJson: "[]",
      hasAtBot: true,
      isBotMsg: false,
      createdAt: 100 + index,
    });
  }

  const seen: number[] = [];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const batch = db.pollMessages("worker:cutover", 10);
    if (batch.length === 0) {
      break;
    }
    const pending = batch.filter((row) => !db.isConsumerMessageCompleted("worker:cutover", row.id));
    if (pending.length === 0) {
      break;
    }
    for (const row of pending) {
      seen.push(row.id);
      db.completeConsumerMessage("worker:cutover", row.id);
    }
  }

  assert.deepEqual(seen, Array.from({ length: 45 }, (_, index) => index + 8));
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(db.pollMessages("worker:cutover", 10), []);
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

  // Ambiguous in-flight rows are quarantined. Reclaiming them would duplicate
  // a QQ send when delivery succeeded but the acknowledgement was lost.
  assert.equal(db.claimOutbox(10, Date.now() + 60_000).length, 0);
  const quarantined = db.db.prepare("SELECT status, retry_after FROM outbox WHERE id = ?").get(id) as {
    status: string;
    retry_after: number | null;
  };
  assert.deepEqual({ ...quarantined }, { status: "failed", retry_after: null });

  // Failed with retry_after → reclaimed only after the backoff. A platform
  // action gets at most three attempts total; further failures are terminal to
  // prevent a permanent retry loop from noisy or disabled QQ targets.
  const failed = db.enqueueOutbox("10001", null, "another");
  db.markOutboxFailed(failed, 2_000);
  assert.equal(db.claimOutbox(10).length, 0, "failed row waits for retry_after");
  assert.equal(db.claimOutbox(10, Date.now() + 3_000).length, 1, "failed row retries after backoff");
  db.markOutboxFailed(failed, 2_000);
  assert.equal(db.claimOutbox(10, Date.now() + 6_000).length, 1, "second retry remains eligible");
  db.markOutboxFailed(failed, 2_000);
  assert.equal(db.claimOutbox(10, Date.now() + 9_000).length, 1, "third retry remains eligible");
  db.markOutboxFailed(failed, 2_000);
  const terminal = db.db.prepare("SELECT status, retry_after, attempts FROM outbox WHERE id = ?").get(failed) as {
    status: string;
    retry_after: number | null;
    attempts: number;
  };
  assert.deepEqual({ ...terminal }, { status: "failed", retry_after: null, attempts: 3 });
  assert.equal(db.claimOutbox(10, Date.now() + 12_000).length, 0, "third failed send must not retry forever");
  db.close();
});

test("two database connections cannot claim the same outbox row", (t) => {
  const dbPath = tempDb(t);
  const first = new SharedDb(dbPath);
  const second = new SharedDb(dbPath);
  const id = first.enqueueOutbox("10001", null, "once");
  assert.equal(first.claimOutbox(1)[0]?.id, id);
  assert.deepEqual(second.claimOutbox(1), []);
  first.close();
  second.close();
});

test("routed outbox remains hidden until its assistant turn is attached", (t) => {
  const db = new SharedDb(tempDb(t));
  const id = db.enqueueOutbox("10001", null, "reply", "text", {
    topicId: "topic-1",
    branchId: "branch-1",
  });
  assert.deepEqual(db.claimOutbox(10), []);
  const row = db.db.prepare("SELECT status FROM outbox WHERE id = ?").get(id) as { status: string };
  assert.equal(row.status, "preparing");
  db.close();
});

test("outbox stores context and atomically acknowledges the real platform id", (t) => {
  const db = new SharedDb(tempDb(t));
  db.db.prepare(
    `INSERT INTO conversation_topics
       (topic_id, group_id, owner_user_id, title, keywords_json, created_at, updated_at)
     VALUES ('topic-1', '10001', '20001', '', '[]', 1, 1)`,
  ).run();
  db.db.prepare(
    `INSERT INTO conversation_branches
       (branch_id, topic_id, group_id, owner_user_id, created_at, updated_at)
     VALUES ('branch-1', 'topic-1', '10001', '20001', 1, 1)`,
  ).run();
  const turn = db.db.prepare(
    `INSERT INTO conversation_turns
       (topic_id, branch_id, role, content, created_at)
     VALUES ('topic-1', 'branch-1', 'assistant', 'reply', 2)`,
  ).run();
  const turnId = Number(turn.lastInsertRowid);
  const outboxId = db.enqueueOutbox("10001", null, "reply", "text", {
    topicId: "topic-1",
    branchId: "branch-1",
    turnId,
  });
  const queued = db.claimOutbox(1)[0]!;
  assert.equal(queued.delivery_id, `outbox:${outboxId}`);
  assert.equal(queued.topic_id, "topic-1");
  assert.equal(queued.branch_id, "branch-1");

  db.ackOutboxDelivery(outboxId, "qq-message-900", 5_000);
  db.ackOutboxDelivery(outboxId, "qq-message-900", 5_001);

  const sent = db.db.prepare("SELECT status, platform_message_id FROM outbox WHERE id = ?").get(outboxId) as {
    status: string;
    platform_message_id: string;
  };
  assert.equal(sent.status, "sent");
  assert.equal(sent.platform_message_id, "qq-message-900");
  const binding = db.db.prepare(
    `SELECT topic_id, branch_id, turn_id
       FROM conversation_message_context
      WHERE group_id = '10001' AND platform_message_id = 'qq-message-900'`,
  ).get() as { topic_id: string; branch_id: string; turn_id: number };
  assert.equal(binding.topic_id, "topic-1");
  assert.equal(binding.branch_id, "branch-1");
  assert.equal(binding.turn_id, turnId);
  assert.throws(() => db.ackOutboxDelivery(outboxId, "different-id"), /different platform message id/);
  db.close();
});

test("outbox context can be attached after the platform acknowledgement", (t) => {
  const db = new SharedDb(tempDb(t));
  db.db.prepare(
    `INSERT INTO conversation_topics
       (topic_id, group_id, owner_user_id, title, keywords_json, created_at, updated_at)
     VALUES ('late-topic', '10001', '20001', '', '[]', 1, 1)`,
  ).run();
  db.db.prepare(
    `INSERT INTO conversation_branches
       (branch_id, topic_id, group_id, owner_user_id, created_at, updated_at)
     VALUES ('late-branch', 'late-topic', '10001', '20001', 1, 1)`,
  ).run();
  const turnId = Number(db.db.prepare(
    `INSERT INTO conversation_turns
       (topic_id, branch_id, role, content, created_at)
     VALUES ('late-topic', 'late-branch', 'assistant', 'reply', 2)`,
  ).run().lastInsertRowid);
  const id = db.enqueueOutbox("10001", null, "reply");
  db.ackOutboxDelivery(id, "qq-before-context", 4_000);
  const beforeAttach = db.db
    .prepare("SELECT COUNT(*) AS count FROM conversation_message_context")
    .get() as { count: number };
  assert.equal(beforeAttach.count, 0);

  db.attachOutboxContext(`outbox:${id}`, {
    topicId: "late-topic",
    branchId: "late-branch",
    turnId,
  });
  const binding = db.db.prepare(
    `SELECT topic_id, branch_id, turn_id
       FROM conversation_message_context
      WHERE group_id = '10001' AND platform_message_id = 'qq-before-context'`,
  ).get() as { topic_id: string; branch_id: string; turn_id: number };
  assert.equal(binding.topic_id, "late-topic");
  assert.equal(binding.branch_id, "late-branch");
  assert.equal(binding.turn_id, turnId);
  const turn = db.db.prepare("SELECT delivery_id, platform_message_id FROM conversation_turns WHERE id = ?").get(turnId) as {
    delivery_id: string;
    platform_message_id: string;
  };
  assert.equal(turn.delivery_id, `outbox:${id}`);
  assert.equal(turn.platform_message_id, "qq-before-context");
  assert.throws(
    () => db.attachOutboxContext(`outbox:${id}`, { topicId: "wrong", branchId: "late-branch", turnId }),
    /different conversation route/,
  );
  db.close();
});

test("discardPreparingOutbox removes only unpublished worker drafts", (t) => {
  const db = new SharedDb(tempDb(t));
  const preparing = db.enqueueOutbox("10001", null, "draft", "text", {
    topicId: "topic-draft",
    branchId: "branch-draft",
  });
  const pending = db.enqueueOutbox("10001", null, "ready");

  assert.equal(db.discardPreparingOutbox([
    `outbox:${preparing}`,
    `outbox:${pending}`,
    "not-an-outbox-id",
  ]), 1);
  const rows = db.db.prepare("SELECT id, status FROM outbox ORDER BY id").all() as Array<{ id: number; status: string }>;
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: pending, status: "pending" }]);
  db.close();
});

test("retry cleanup removes only drafts for the exact routed source turn", (t) => {
  const db = new SharedDb(tempDb(t));
  const stale = db.enqueueOutbox("10001", null, "stale", "text", {
    topicId: "topic-draft",
    branchId: "branch-draft",
    sourceTurnId: 11,
  });
  const sibling = db.enqueueOutbox("10001", null, "sibling", "text", {
    topicId: "topic-draft",
    branchId: "branch-draft",
    sourceTurnId: 12,
  });
  const otherBranch = db.enqueueOutbox("10001", null, "other", "text", {
    topicId: "topic-draft",
    branchId: "branch-other",
    sourceTurnId: 11,
  });

  assert.equal(db.discardPreparingOutboxForSource("topic-draft", "branch-draft", 11), 1);
  const rows = db.db.prepare("SELECT id FROM outbox ORDER BY id").all() as Array<{ id: number }>;
  assert.deepEqual(rows.map((row) => row.id), [sibling, otherBranch]);
  assert.equal(rows.some((row) => row.id === stale), false);
  db.close();
});

test("old outbox schema without retry_after is migrated without losing rows", (t) => {
  const dbPath = tempDb(t);
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      reply_to TEXT,
      kind TEXT NOT NULL DEFAULT 'text',
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    INSERT INTO outbox (group_id, text, created_at) VALUES ('g', 'legacy', 1);
  `);
  legacy.close();

  const db = new SharedDb(dbPath);
  const columns = db.db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "retry_after"), true);
  assert.equal(columns.some((column) => column.name === "attempts"), true);
  const row = db.claimOutbox(1)[0]!;
  assert.equal(row.text, "legacy");
  assert.equal(row.retry_after, null);
  assert.equal(row.attempts, 1);
  assert.equal(row.topic_id, null);
  assert.equal(row.source_turn_id, null);
  assert.equal(row.platform_message_id, null);
  db.close();
});

test("token bucket counting uses received-time window", (t) => {
  const db = new SharedDb(tempDb(t));
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    db.insertMessage({
      groupId: "10001", userId: "20001", selfId: "30001", msgId: `m${i}`,
      msgTime: now + 365 * 24 * 60 * 60 * 1000, text: "x", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: now - i * 1000,
    });
  }
  assert.equal(db.countMessagesSince("10001", now - 10_000), 5);
  assert.equal(db.countMessagesSince("10001", now - 2_000), 3);
  assert.equal(db.countMessagesSince("99999", now - 10_000), 0);
  db.close();
});

test("recent group evidence is bounded before the source message and merges only sent bot text", (t) => {
  const db = new SharedDb(tempDb(t));
  const now = 1_800_000_000_000;
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "old",
    msgTime: now - 8 * 24 * 60 * 60 * 1_000, text: "expired", imagesJson: "[]",
    hasAtBot: false, isBotMsg: false, createdAt: now - 8 * 24 * 60 * 60 * 1_000,
  });
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "member",
    msgTime: now - 5_000, text: "能源是根源", imagesJson: "[]", senderNickname: "企鹅",
    hasAtBot: false, isBotMsg: false, createdAt: now - 5_000,
  });
  db.insertMessage({
    groupId: "10001", userId: "opted-out", selfId: "30001", msgId: "private",
    msgTime: now - 4_000, text: "private text", imagesJson: "[]",
    hasAtBot: false, isBotMsg: false, createdAt: now - 4_000,
  });
  db.insertMessage({
    groupId: "10001", userId: "20002", selfId: "30001", msgId: "command",
    msgTime: now - 3_000, text: "#模型 secret", imagesJson: "[]",
    hasAtBot: false, isBotMsg: false, createdAt: now - 3_000,
  });
  const sent = db.enqueueOutbox("10001", null, "机器人回复");
  db.ackOutboxDelivery(sent, "bot-message", now - 2_000);
  db.enqueueOutbox("10001", null, "pending reply");
  const sourceRowId = db.insertMessage({
    groupId: "10001", userId: "20003", selfId: "30001", msgId: "source",
    msgTime: now, text: "评价一下", imagesJson: "[]",
    hasAtBot: true, isBotMsg: false, createdAt: now,
  });
  db.insertMessage({
    groupId: "10001", userId: "20001", selfId: "30001", msgId: "later",
    msgTime: now + 1, text: "later text", imagesJson: "[]",
    hasAtBot: false, isBotMsg: false, createdAt: now + 1,
  });
  db.insertMessage({
    groupId: "other", userId: "20001", selfId: "30001", msgId: "other",
    msgTime: now - 1_000, text: "other group", imagesJson: "[]",
    hasAtBot: false, isBotMsg: false, createdAt: now - 1_000,
  });

  const evidence = db.listRecentGroupEvidence({
    groupId: "10001",
    beforeSourceRowId: sourceRowId,
    sinceMs: now - 7 * 24 * 60 * 60 * 1_000,
    excludedUserIds: ["opted-out"],
    limit: 30,
  });

  assert.deepEqual(evidence.map((row) => [row.role, row.text]), [
    ["member", "能源是根源"],
    ["bot", "机器人回复"],
  ]);
  assert.equal(evidence[0]?.sender_nickname, "企鹅");
  db.close();
});

test("bot messages recorded and pruned", (t) => {
  const db = new SharedDb(tempDb(t));
  db.recordBotMessage("10001", "b1", 1000);
  db.recordBotMessage("10001", "b2", 3000);
  assert.equal(db.isKnownBotMessage("10001", "b1"), true);
  assert.equal(db.isKnownBotMessage("other-group", "b1"), false);
  assert.equal(db.isKnownBotMessage("10001", "missing"), false);
  db.pruneBotMessages(2000);
  // The prune only deletes rows older than the cutoff; b1 is gone.
  const rows = db.db
    .prepare("SELECT msg_id FROM bot_messages WHERE group_id = ? ORDER BY sent_at")
    .all("10001") as Array<{ msg_id: string }>;
  assert.deepEqual(rows.map((row) => row.msg_id), ["b2"]);
  assert.equal(db.isKnownBotMessage("10001", "b1"), false);
  db.close();
});
