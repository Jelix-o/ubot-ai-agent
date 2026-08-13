#!/usr/bin/env node
import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir ?? path.join(process.cwd(), "data"));
const execute = args.execute === true;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(dataDir, "context-backups", timestamp);
const dbPath = path.join(dataDir, "shared", "bot-shared.db");
const conversationsPath = path.join(dataDir, "conversations.json");
const atmospherePath = path.join(dataDir, "shared", "atmosphere.json");
const topicsPath = path.join(dataDir, "shared", "topics.json");

const report = {
  mode: execute ? "execute" : "dry-run",
  dataDir,
  backupDir: execute ? backupDir : undefined,
  outboxBlockingRows: 0,
  cutoverMessageId: 0,
  backedUp: [],
  cleared: [],
  retained: [
    "messages audit table",
    "group-memory.json",
    "group-memory-candidates.json",
    "daily-profile-review.json",
    "knowledge-base.json",
    "system-settings.json",
    "profile-records.json",
    "config/groups.json",
    "daily-report-store.json",
  ],
};

let db;
try {
  if (existsSync(dbPath)) {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    report.outboxBlockingRows = countBlockingOutboxRows(db);
    report.cutoverMessageId = scalar(db, "SELECT COALESCE(MAX(id), 0) FROM messages");
  }

  if (!execute) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }

  if (report.outboxBlockingRows > 0) {
    throw new Error(
      `Refusing context cutover: ${report.outboxBlockingRows} outbox row(s) are not drained`,
    );
  }

  await mkdir(backupDir, { recursive: true });
  await backupJsonFile(conversationsPath, "conversations.json");
  await backupJsonFile(atmospherePath, "atmosphere.json");
  await backupJsonFile(topicsPath, "topics.json");

  if (db) {
    const backupDbPath = path.join(backupDir, "bot-shared.db");
    db.exec(`VACUUM INTO '${escapeSqlString(backupDbPath)}'`);
    report.backedUp.push("shared/bot-shared.db");
    clearSqliteContext(db, report.cutoverMessageId);
    report.cleared.push(
      "conversation topics/branches/turns/routes/message mappings",
      "user active routes",
      "inflight state",
      "bot reply anchors",
      "outbox context columns",
    );
  }

  await writeJsonAtomic(conversationsPath, {
    conversations: {},
    sharedTopics: {},
    sharedTopicMessageIndex: {},
  });
  report.cleared.push("legacy conversations.json");

  if (existsSync(atmospherePath)) {
    await writeJsonAtomic(atmospherePath, { summaries: {} });
    report.cleared.push("atmosphere cache");
  }
  if (existsSync(topicsPath)) {
    await writeJsonAtomic(topicsPath, { topics: [] });
    report.cleared.push("legacy topic cache");
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db?.close();
}

function clearSqliteContext(database, cutoverMessageId) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_context_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const table of [
      "conversation_message_routes",
      "conversation_message_context",
      "conversation_user_active_routes",
      "conversation_turns",
      "conversation_branches",
      "conversation_topics",
      "inflight",
      "bot_messages",
      "consumer_completed_messages",
    ]) {
      if (tableExists(database, table)) {
        database.exec(`DELETE FROM ${table}`);
      }
    }
    if (tableExists(database, "outbox")) {
      const columns = new Set(
        database.prepare("PRAGMA table_info(outbox)").all().map((row) => row.name),
      );
      const assignments = ["topic_id", "branch_id", "source_turn_id", "turn_id"]
        .filter((column) => columns.has(column))
        .map((column) => `${column} = NULL`);
      if (assignments.length > 0) {
        database.exec(`UPDATE outbox SET ${assignments.join(", ")}`);
      }
    }
    database.prepare(
      `INSERT INTO conversation_context_meta (key, value)
       VALUES ('cutover_message_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(cutoverMessageId));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function countBlockingOutboxRows(database) {
  if (!tableExists(database, "outbox")) {
    return 0;
  }
  const columns = new Set(
    database.prepare("PRAGMA table_info(outbox)").all().map((row) => row.name),
  );
  if (!columns.has("status")) {
    return scalar(database, "SELECT COUNT(*) FROM outbox");
  }
  return scalar(database, "SELECT COUNT(*) FROM outbox WHERE status NOT IN ('sent', 'cancelled')");
}

function scalar(database, sql) {
  if (/\bFROM\s+messages\b/i.test(sql) && !tableExists(database, "messages")) {
    return 0;
  }
  const row = database.prepare(sql).get();
  return Number(Object.values(row ?? {})[0] ?? 0);
}

function tableExists(database, table) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

async function backupJsonFile(sourcePath, backupName) {
  if (!existsSync(sourcePath)) {
    return;
  }
  await stat(sourcePath);
  await copyFile(sourcePath, path.join(backupDir, backupName));
  report.backedUp.push(path.relative(dataDir, sourcePath).replaceAll("\\", "/"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-context-cutover-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function parseArgs(argv) {
  const parsed = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
    } else if (arg === "--data-dir") {
      parsed.dataDir = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run migrate:context -- [--data-dir <path>] [--execute]\n" +
        "Default is a read-only preflight. Stop all services and drain outbox before --execute.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
