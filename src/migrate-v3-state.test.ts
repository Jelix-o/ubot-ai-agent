import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "./shared/sqlite.js";
import { StateCipher } from "./services/v3-state-repository.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("V3 cutover excludes daily-report raw messages older than seven days", (t) => {
  const appRoot = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-cutover-"));
  const dataDir = path.join(appRoot, "data");
  const now = Date.now();
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));

  mkdirSync(path.join(appRoot, "config"), { recursive: true });
  mkdirSync(path.join(dataDir, "shared"), { recursive: true });
  mkdirSync(path.join(appRoot, "assets"), { recursive: true });
  writeFileSync(path.join(appRoot, ".env"), `UBOT_STATE_ENCRYPTION_KEY=${TEST_STATE_KEY}\n`);
  writeFileSync(path.join(appRoot, "config", "groups.json"), JSON.stringify({ groups: [] }));
  cpSync(path.resolve("assets", "huixian-profile.json"), path.join(appRoot, "assets", "huixian-profile.json"));
  writeFileSync(path.join(dataDir, "daily-report-store.json"), JSON.stringify({
    days: {
      "2001-01-01": {
        "10001": [{
          userId: "20001",
          userName: "过期成员",
          text: "超过留存期的原始日报内容",
          timestamp: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
        }],
      },
      "2099-01-01": {
        "10001": [{
          userId: "20002",
          userName: "当前成员",
          text: "仍在留存期内的原始日报内容",
          timestamp: new Date(now - 60_000).toISOString(),
        }],
      },
    },
    lastSentDateByGroup: {},
  }));
  writeFileSync(path.join(dataDir, "admin-tasks.json"), JSON.stringify({
    tasks: [
      {
        id: "retired-profile-task",
        type: "profile-generate",
        status: "succeeded",
        title: "旧画像生成",
        operatorUserId: "system",
        progress: 100,
        createdAt: new Date(now - 1_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      },
      {
        id: "retained-model-task",
        type: "model-check",
        status: "succeeded",
        title: "模型检查",
        operatorUserId: "system",
        progress: 100,
        createdAt: new Date(now - 1_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      },
    ],
  }));

  const dbPath = path.join(dataDir, "shared", "bot-shared.db");
  const db = new SharedDb(dbPath);
  db.insertMessage({
    groupId: "10001",
    userId: "20001",
    selfId: "30001",
    msgId: "expired-ingress-message",
    msgTime: now - 8 * 24 * 60 * 60 * 1000,
    text: "超过留存期的历史群消息",
    imagesJson: "[]",
    hasAtBot: false,
    isBotMsg: false,
    createdAt: now - 8 * 24 * 60 * 60 * 1000,
  });
  const freshIngressRowId = db.insertMessage({
    groupId: "10001",
    userId: "20002",
    selfId: "30001",
    msgId: "fresh-ingress-message",
    msgTime: now - 60_000,
    text: "仍在留存期内的历史群消息",
    imagesJson: "[]",
    hasAtBot: false,
    isBotMsg: false,
    createdAt: now - 60_000,
  });
  db.db.exec(`
    INSERT INTO conversation_topics (topic_id, group_id, owner_user_id, title, keywords_json, created_at, updated_at)
    VALUES ('legacy-topic', '10001', '20002', '不得进入 V3 运行库的旧话题', '[]', ${now}, ${now});
    INSERT INTO conversation_branches (branch_id, topic_id, group_id, owner_user_id, created_at, updated_at)
    VALUES ('legacy-branch', 'legacy-topic', '10001', '20002', ${now}, ${now});
    INSERT INTO conversation_turns (topic_id, branch_id, role, user_id, content, source_message_id, created_at)
    VALUES ('legacy-topic', 'legacy-branch', 'user', '20002', '不得进入 V3 运行库的旧对话正文', 'fresh-ingress-message', ${now});
  `);
  const legacySentOutboxId = db.enqueueOutbox("10001", null, "旧对话草稿", "text", {
    topicId: "legacy-topic",
    branchId: "legacy-branch",
    sourceTurnId: 1,
    turnId: 1,
  });
  // The cutover correctly rejects retryable Outbox work. Use a terminal row
  // here to prove that retained delivery audit data loses its old context
  // without weakening that production preflight.
  db.markOutboxSent(legacySentOutboxId);
  db.db.prepare(
    `INSERT INTO conversation_message_routes
       (source_row_id, group_id, user_id, source_message_id, topic_id, branch_id, route_reason, turn_id, created_at)
     VALUES (?, '10001', '20002', 'fresh-ingress-message', 'legacy-topic', 'legacy-branch', 'new-topic', 1, ?)`,
  ).run(freshIngressRowId, now);
  db.close();

  const output = execFileSync(process.execPath, [
    path.resolve("scripts", "migrate-v3-state.mjs"),
    "--app-root", appRoot,
    "--execute",
  ], {
    encoding: "utf8",
    env: { ...process.env, UBOT_STATE_ENCRYPTION_KEY: TEST_STATE_KEY },
  });
  const report = JSON.parse(output) as {
    imported: {
      dailyReportMessages: number;
      expiredDailyReportMessages: number;
      retiredProfileTasks: number;
      initialRawRetention: { messages: number; reportMessages: number; userTurns: number };
      shortTermConversationCutoverMessageId: number;
    };
  };
  assert.equal(report.imported.dailyReportMessages, 1);
  assert.equal(report.imported.expiredDailyReportMessages, 1);
  assert.equal(report.imported.retiredProfileTasks, 1);
  assert.deepEqual(report.imported.initialRawRetention, { messages: 1, reportMessages: 0, userTurns: 0 });
  assert.equal(report.imported.shortTermConversationCutoverMessageId, freshIngressRowId);

  const rollbackFiles = readdirSync(path.join(dataDir, "v3-rollback"));
  const legacyArchive = rollbackFiles.find((file) => file.endsWith(".legacy.enc"));
  assert.ok(legacyArchive, "retired legacy input must be retained only in the encrypted rollback archive");
  const archivedBundle = JSON.parse(new StateCipher(TEST_STATE_KEY).decrypt(
    "rollback-legacy-bundle",
    readFileSync(path.join(dataDir, "v3-rollback", legacyArchive!), "utf8"),
  )) as { files: Array<{ key: string; body: string }> };
  const archivedTasks = archivedBundle.files.find((file) => file.key === "admin-tasks");
  assert.match(Buffer.from(archivedTasks?.body ?? "", "base64").toString("utf8"), /profile-generate/);

  const migrated = new SharedDb(dbPath);
  try {
    const messages = migrated.db.prepare(
      "SELECT user_id, text FROM v3_daily_report_messages ORDER BY occurred_at",
    ).all() as Array<{ user_id: string; text: string }>;
    assert.deepEqual(
      messages.map(({ user_id, text }) => ({ user_id, text })),
      [{ user_id: "20002", text: "仍在留存期内的原始日报内容" }],
    );
    const retainedTask = migrated.db.prepare(
      "SELECT document_key FROM v3_state_documents WHERE document_type = 'admin-task' ORDER BY document_key",
    ).all() as Array<{ document_key: string }>;
    assert.deepEqual(
      retainedTask.map(({ document_key }) => ({ document_key })),
      [{ document_key: "retained-model-task" }],
    );
    const retainedIngressMessages = migrated.db.prepare(
      "SELECT msg_id FROM messages ORDER BY msg_id",
    ).all() as Array<{ msg_id: string }>;
    assert.deepEqual(
      retainedIngressMessages.map(({ msg_id }) => ({ msg_id })),
      [{ msg_id: "fresh-ingress-message" }],
    );
    for (const table of [
      "conversation_topics",
      "conversation_branches",
      "conversation_turns",
      "conversation_message_context",
      "conversation_message_routes",
      "conversation_user_active_routes",
    ]) {
      const row = migrated.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0, `${table} must not retain a legacy runtime conversation`);
    }
    const cutover = migrated.db.prepare(
      "SELECT value FROM conversation_context_meta WHERE key = 'cutover_message_id'",
    ).get() as { value: string };
    assert.equal(cutover.value, String(freshIngressRowId));
    const retiredOutbox = migrated.db.prepare(
      "SELECT status, topic_id, branch_id FROM outbox WHERE id = ?",
    ).get(legacySentOutboxId) as { status: string; topic_id: string | null; branch_id: string | null };
    assert.deepEqual({ ...retiredOutbox }, { status: "sent", topic_id: null, branch_id: null });
  } finally {
    migrated.close();
  }
});
