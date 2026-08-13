import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("context cutover backs up and clears only short-term state", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "context-cutover-"));
  const sharedDir = path.join(dataDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const dbPath = path.join(sharedDir, "bot-shared.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);
    INSERT INTO messages (text) VALUES ('retained audit');
    CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT);
    INSERT INTO outbox (status) VALUES ('sent');
    CREATE TABLE conversation_topics (topic_id TEXT);
    INSERT INTO conversation_topics VALUES ('short-term-topic');
    CREATE TABLE inflight (key TEXT);
    INSERT INTO inflight VALUES ('group:branch');
    CREATE TABLE consumer_completed_messages (consumer_key TEXT, message_id INTEGER, completed_at INTEGER);
    INSERT INTO consumer_completed_messages VALUES ('worker', 1, 1);
  `);
  db.close();
  writeFileSync(path.join(dataDir, "conversations.json"), JSON.stringify({
    conversations: { legacy: ["short-term"] },
    sharedTopics: { old: {} },
    sharedTopicMessageIndex: { message: "old" },
  }));
  writeFileSync(path.join(dataDir, "group-memory.json"), JSON.stringify({ keep: "long-term" }));

  const migrationScript = path.resolve("scripts/migrate-context-isolation.mjs");
  const dryRun = JSON.parse(execFileSync(process.execPath, [migrationScript, "--data-dir", dataDir], {
    encoding: "utf8",
  })) as { mode: string; outboxBlockingRows: number };
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.outboxBlockingRows, 0);

  execFileSync(process.execPath, [migrationScript, "--data-dir", dataDir, "--execute"], {
    encoding: "utf8",
  });
  const migrated = new DatabaseSync(dbPath);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM conversation_topics").get() as { count: number }).count, 0);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM inflight").get() as { count: number }).count, 0);
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) AS count FROM consumer_completed_messages").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (migrated.prepare("SELECT value FROM conversation_context_meta WHERE key = 'cutover_message_id'").get() as { value: string }).value,
    "1",
  );
  migrated.close();

  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "conversations.json"), "utf8")), {
    conversations: {},
    sharedTopics: {},
    sharedTopicMessageIndex: {},
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "group-memory.json"), "utf8")), {
    keep: "long-term",
  });
  assert.equal(readdirSync(path.join(dataDir, "context-backups")).length, 1);
});

test("context cutover refuses to run while outbox is not drained", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "context-cutover-blocked-"));
  const sharedDir = path.join(dataDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(sharedDir, "bot-shared.db"));
  db.exec("CREATE TABLE outbox (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO outbox VALUES (1, 'pending')");
  db.close();

  const migrationScript = path.resolve("scripts/migrate-context-isolation.mjs");
  assert.throws(
    () => execFileSync(process.execPath, [migrationScript, "--data-dir", dataDir, "--execute"], {
      encoding: "utf8",
      stdio: "pipe",
    }),
    /Refusing context cutover/,
  );
  assert.equal(readdirSync(dataDir).includes("context-backups"), false);
});

test("context cutover also refuses terminal failed and preparing outbox rows", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "context-cutover-failed-"));
  const sharedDir = path.join(dataDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(sharedDir, "bot-shared.db"));
  db.exec(`
    CREATE TABLE outbox (id INTEGER PRIMARY KEY, status TEXT, retry_after INTEGER);
    INSERT INTO outbox VALUES (1, 'failed', NULL), (2, 'preparing', NULL);
  `);
  db.close();
  const migrationScript = path.resolve("scripts/migrate-context-isolation.mjs");
  assert.throws(
    () => execFileSync(process.execPath, [migrationScript, "--data-dir", dataDir, "--execute"], {
      encoding: "utf8",
      stdio: "pipe",
    }),
    /Refusing context cutover/,
  );
});

test("context cutover treats explicitly cancelled outbox rows as drained", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "context-cutover-cancelled-"));
  const sharedDir = path.join(dataDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(sharedDir, "bot-shared.db"));
  db.exec("CREATE TABLE outbox (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO outbox VALUES (1, 'cancelled')");
  db.close();

  const migrationScript = path.resolve("scripts/migrate-context-isolation.mjs");
  const report = JSON.parse(execFileSync(process.execPath, [migrationScript, "--data-dir", dataDir], {
    encoding: "utf8",
  })) as { outboxBlockingRows: number };
  assert.equal(report.outboxBlockingRows, 0);
});
