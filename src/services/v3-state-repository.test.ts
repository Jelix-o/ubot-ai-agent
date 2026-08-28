import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupMemory, ScheduledReminderTask, SkillDefinition, SystemSettings } from "../types.js";
import { SharedDb } from "../shared/sqlite.js";
import { GroupMemoryStore } from "./group-memory-store.js";
import { KnowledgeBaseStore } from "./knowledge-base-store.js";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function withRepository<T>(run: (repository: V3StateRepository, db: SharedDb, dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-v3-state-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
  try {
    return await run(repository, db, dir);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function memory(id: string, title = "显式事实"): GroupMemory {
  return {
    id,
    groupId: "10001",
    type: "group_fact",
    title,
    content: "这是管理员明确保存的记忆。",
    confidence: 0.9,
    source: "admin",
    enabled: true,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function dueReminder(id = "reminder-1"): ScheduledReminderTask {
  return {
    id,
    groupId: "10001",
    creatorUserId: "20001",
    intervalMinutes: 60,
    topic: "喝水",
    createdAt: "2026-08-20T00:00:00.000Z",
    nextRunAt: "2026-08-20T01:00:00.000Z",
    enabled: true,
    recentMessages: [],
  };
}

function huixianProfile(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "huixian",
    name: "会仙",
    systemPrompt: "会仙自然聊天，不主动谈身份标签；不编造现实可核验的事实。",
    styleRules: ["自然接话"],
    knowledge: ["现实证明类话题自然转场，不承诺事实。"],
    temperature: 0.8,
    maxContextTurns: 24,
    ...overrides,
  };
}

test("StateCipher uses purpose-isolated AES-GCM keys", () => {
  const cipher = new StateCipher(TEST_STATE_KEY);
  const encrypted = cipher.encrypt("model:reply:api_key", "secret-value");

  assert.doesNotMatch(encrypted, /secret-value/);
  assert.equal(cipher.decrypt("model:reply:api_key", encrypted), "secret-value");
  assert.throws(() => cipher.decrypt("totp:account", encrypted), /Unsupported state|unable to authenticate|authenticate/i);
  assert.throws(() => new StateCipher("short"), /exactly 32 bytes/);
});

test("V3 system settings keep model credentials out of document JSON and retire shared credentials", async () => {
  await withRepository((repository, db) => {
    const settings = {
      onlineLookupEnabled: false,
      tokenCostControl: {
        dailyReportAiQuipEnabled: false,
        chatSummaryAiEnabled: false,
        scheduledReminderAiRewriteEnabled: false,
        modelHealthAutoProbeEnabled: false,
        memoryCandidateExtractionEnabled: true,
      },
      defaultTriggerKeywords: [],
      models: [{
        id: "reply-model",
        name: "Reply",
        shortName: "reply",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        purpose: "reply",
        apiKey: "model-secret",
        hasApiKey: true,
        enabled: true,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      }],
      selectedModelIds: { reply: "reply-model" },
      commands: [],
      updatedAt: "2026-08-20T00:00:00.000Z",
      adminSecretHash: "legacy-hash",
      groupAdminSecretHash: "legacy-group-hash",
      profileSummaryMaxChars: 1800,
      memoryDedupEnabled: true,
    } as unknown as SystemSettings;

    repository.saveSystemSettings(settings);
    const stored = db.db.prepare("SELECT settings_json FROM v3_system_settings WHERE settings_key = 'default'")
      .get() as { settings_json: string };
    const encrypted = db.db.prepare("SELECT ciphertext FROM v3_system_secrets ORDER BY secret_key").all() as Array<{ ciphertext: string }>;

    assert.doesNotMatch(stored.settings_json, /model-secret|legacy-hash/);
    assert.equal(encrypted.length, 1);
    assert.equal(encrypted.some((row) => row.ciphertext.includes("model-secret")), false);
    assert.equal(repository.getSystemSettings()?.models[0]?.apiKey, "model-secret");
    const restored = repository.getSystemSettings() as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(restored, "adminSecretHash"), false);
    assert.equal(Object.hasOwn(restored, "groupAdminSecretHash"), false);
    assert.equal(Object.hasOwn(restored, "profileSummaryMaxChars"), false);
    assert.equal(Object.hasOwn(restored, "memoryDedupEnabled"), false);
    assert.equal(Object.hasOwn((restored.tokenCostControl as Record<string, unknown>), "memoryCandidateExtractionEnabled"), false);
    const retiredCredentialRows = db.db.prepare(
      "SELECT COUNT(*) AS count FROM v3_system_secrets WHERE secret_key IN ('legacy_admin_secret_hash', 'legacy_group_admin_secret_hash')",
    ).get() as { count: number };
    assert.equal(retiredCredentialRows.count, 0);
  });
});

test("V3 state strips legacy QQ administrator fields and can clear an existing cutover", async () => {
  await withRepository((repository, db) => {
    repository.saveDocument("group-control", "default", { superAdminUserIds: ["90001"] });
    repository.saveGroups({
      superAdminUserIds: ["90001"],
      groups: [{
        groupId: "10001",
        currentSkillId: "huixian",
        allowedSkillIds: ["huixian"],
        switcherUserIds: ["90002"],
        liveChatUserIds: [],
      }],
    });

    assert.equal(repository.getGroups().superAdminUserIds, undefined);
    assert.deepEqual(repository.getGroup("10001")?.switcherUserIds, []);
    const stored = db.db.prepare("SELECT config_json FROM v3_groups WHERE group_id = '10001'").get() as { config_json: string };
    assert.deepEqual(JSON.parse(stored.config_json).switcherUserIds, []);
    assert.equal(repository.getDocument("group-control", "default", undefined), undefined);

    db.db.prepare("UPDATE v3_groups SET config_json = ? WHERE group_id = '10001'")
      .run(JSON.stringify({
        groupId: "10001",
        currentSkillId: "huixian",
        allowedSkillIds: ["huixian"],
        switcherUserIds: ["90003"],
        liveChatUserIds: [],
      }));
    repository.saveDocument("group-control", "default", { superAdminUserIds: ["90004"] });

    assert.deepEqual(repository.retireLegacyQqAdministration(), { groupsCleared: 1, controlRemoved: true });
    assert.deepEqual(repository.getGroup("10001")?.switcherUserIds, []);
    assert.equal(repository.getDocument("group-control", "default", undefined), undefined);
  });
});

test("Huixian release profile revisions are atomic, idempotent, and preserve later admin edits", async () => {
  await withRepository(async (repository, db) => {
    const baseline = huixianProfile();
    const first = repository.applyHuixianReleaseProfile({
      revision: "immersive-natural-v3.0.3",
      profile: baseline,
      changedBy: "release:3.0.3:huixian-immersive",
      now: Date.parse("2026-08-28T00:00:00.000Z"),
    });

    assert.deepEqual(first, { applied: true, revision: "immersive-natural-v3.0.3" });
    assert.equal((await repository.getHuixianProfile())?.systemPrompt, baseline.systemPrompt);
    assert.equal(
      (db.db.prepare("SELECT COUNT(*) AS count FROM v3_character_profile_revisions").get() as { count: number }).count,
      1,
    );

    const repeat = repository.applyHuixianReleaseProfile({
      revision: "immersive-natural-v3.0.3",
      profile: huixianProfile({ name: "不应覆盖" }),
      changedBy: "release:3.0.3:huixian-immersive",
    });
    assert.equal(repeat.applied, false);
    assert.equal((await repository.getHuixianProfile())?.name, "会仙");
    assert.equal(
      (db.db.prepare("SELECT COUNT(*) AS count FROM v3_character_profile_revisions").get() as { count: number }).count,
      1,
    );

    await repository.saveHuixianProfile(huixianProfile({ name: "会仙·管理员调整" }), "admin:42");
    const afterAdminEdit = repository.applyHuixianReleaseProfile({
      revision: "immersive-natural-v3.0.3",
      profile: baseline,
      changedBy: "release:3.0.3:huixian-immersive",
    });
    assert.equal(afterAdminEdit.applied, false);
    assert.equal((await repository.getHuixianProfile())?.name, "会仙·管理员调整");

    const blockedOlderRelease = repository.applyHuixianReleaseProfile({
      revision: "some-other-release",
      profile: baseline,
      changedBy: "release:test",
    });
    assert.deepEqual(blockedOlderRelease, {
      applied: false,
      revision: "immersive-natural-v3.0.3",
      previousRevision: "immersive-natural-v3.0.3",
    });
    assert.equal(
      (db.db.prepare("SELECT COUNT(*) AS count FROM v3_character_profile_revisions").get() as { count: number }).count,
      2,
    );
  });
});

test("cutover requires a state encryption key and repository stores never read legacy JSON", async () => {
  await withRepository(async (repository, db, dir) => {
    repository.markCutover();
    assert.throws(() => new V3StateRepository(db).requireCutover(), /UBOT_STATE_ENCRYPTION_KEY/);
    repository.saveMemory(memory("sqlite-memory", "SQLite 事实"));

    const legacyFile = path.join(dir, "group-memory.json");
    await writeFile(legacyFile, JSON.stringify({ memories: [memory("legacy-memory", "不应读取")] }), "utf8");
    const store = new GroupMemoryStore(legacyFile, repository);

    assert.deepEqual((await store.list("10001")).map((item) => item.id), ["sqlite-memory"]);
    await store.create({
      groupId: "10001",
      type: "group_fact",
      title: "第二条",
      content: "只写 SQLite",
      source: "explicit_command",
    });
    const legacy = JSON.parse(await readFile(legacyFile, "utf8")) as { memories: GroupMemory[] };
    assert.deepEqual(legacy.memories.map((item) => item.id), ["legacy-memory"]);
  });
});

test("scheduled reminder leases are exclusive across repository connections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-v3-lease-"));
  const dbPath = path.join(dir, "bot-shared.db");
  const firstDb = new SharedDb(dbPath);
  const secondDb = new SharedDb(dbPath);
  try {
    const first = new V3StateRepository(firstDb, { stateEncryptionKey: TEST_STATE_KEY });
    const second = new V3StateRepository(secondDb, { stateEncryptionKey: TEST_STATE_KEY });
    const task = dueReminder();
    first.saveScheduledReminder(task);

    const firstClaim = first.claimDueScheduledReminders(Date.parse(task.nextRunAt));
    assert.equal(firstClaim.length, 1);
    assert.deepEqual(second.claimDueScheduledReminders(Date.parse(task.nextRunAt)).map((item) => item.task.id), []);
    assert.equal(first.finalizeScheduledReminder({ ...task, nextRunAt: "2026-08-20T02:00:00.000Z" }, "wrong-token"), false);
    assert.equal(first.finalizeScheduledReminder({ ...task, nextRunAt: "2026-08-20T02:00:00.000Z" }, firstClaim[0]!.leaseToken), true);
    assert.equal(second.claimDueScheduledReminders(Date.parse("2026-08-20T01:30:00.000Z")).length, 0);
  } finally {
    firstDb.close();
    secondDb.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledge packs are durable group policy boundaries for SQLite knowledge", async () => {
  await withRepository(async (repository, _db, dir) => {
    const createdAt = "2026-08-20T00:00:00.000Z";
    repository.saveKnowledge({
      id: "knowledge-1",
      groupId: "10001",
      title: "报销规则",
      question: "怎么报销发票",
      answer: "按财务流程提交。",
      keywords: ["报销", "发票"],
      enabled: true,
      createdAt,
      updatedAt: createdAt,
    });

    assert.deepEqual(repository.getKnowledgePack("10001"), {
      groupId: "10001",
      enabled: true,
      createdAt,
      updatedAt: createdAt,
    });
    assert.deepEqual(repository.listKnowledgePacks().map((pack) => pack.groupId), ["10001"]);

    const store = new KnowledgeBaseStore(path.join(dir, "knowledge.json"), repository);
    assert.equal((await store.search("10001", "我要报销发票")).length, 1);

    repository.saveKnowledgePack({
      groupId: "10001",
      enabled: false,
      createdAt,
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    assert.equal((await store.search("10001", "我要报销发票")).length, 0);

    repository.saveKnowledge({
      id: "knowledge-2",
      groupId: "10001",
      title: "财务邮箱",
      question: "财务邮箱是什么",
      answer: "finance@example.test",
      keywords: ["财务"],
      enabled: true,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(repository.getKnowledgePack("10001")?.enabled, false, "entry writes must not re-enable a disabled pack");
  });
});

test("retention removes expired raw messages and report inputs while preserving fresh data", async () => {
  await withRepository((repository, db) => {
    const cutoff = Date.parse("2026-08-20T00:00:00.000Z");
    const expiredMessageId = db.insertMessage({
      groupId: "10001", userId: "20001", selfId: "30001", msgId: "expired", msgTime: cutoff + 365 * 24 * 60 * 60 * 1000,
      text: "过期原文", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: cutoff,
    });
    db.insertMessage({
      groupId: "10001", userId: "20001", selfId: "30001", msgId: "fresh", msgTime: cutoff - 365 * 24 * 60 * 60 * 1000,
      text: "保留原文", imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: cutoff + 1,
    });
    repository.appendDailyReportMessage({
      groupId: "10001", dayKey: "2026-08-19", userId: "20001", userName: "成员", text: "旧日报输入", timestamp: "2026-08-20T00:00:00.000Z",
    });
    repository.appendDailyReportMessage({
      groupId: "10001", dayKey: "2026-08-20", userId: "20001", userName: "成员", text: "新日报输入", timestamp: "2026-08-20T00:00:00.001Z",
    });

    db.db.prepare(
      `INSERT INTO conversation_turns
         (topic_id, branch_id, role, user_id, content, source_message_id, delivery_id, platform_message_id, created_at)
       VALUES ('topic-1', 'branch-1', 'user', '20001', '过期用户原文', 'expired', 'outbox:1', 'expired', ?)`,
    ).run(cutoff);
    db.db.prepare(
      `INSERT INTO conversation_topics
         (topic_id, group_id, owner_user_id, title, keywords_json, created_at, updated_at)
       VALUES ('topic-1', '10001', '20001', '过期主题原文', '["过期", "原文"]', ?, ?)`,
    ).run(cutoff, cutoff + 1);
    db.db.prepare(
      `INSERT INTO conversation_message_context
         (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
       VALUES ('10001', 'expired', 'topic-1', 'branch-1', 1, 'user', ?),
              ('10001', 'fresh', 'topic-1', 'branch-1', NULL, 'assistant', ?)`,
    ).run(cutoff, cutoff + 1);
    db.db.prepare(
      `INSERT INTO conversation_message_routes
         (source_row_id, group_id, user_id, source_message_id, reply_to_message_id, topic_id, branch_id, route_reason, parent_turn_id, turn_id, created_at)
       VALUES (?, '10001', '20001', 'expired', NULL, 'topic-1', 'branch-1', 'direct_mention', NULL, 1, ?)`,
    ).run(expiredMessageId, cutoff);
    db.db.prepare(
      `INSERT INTO bot_messages (group_id, msg_id, sent_at)
       VALUES ('10001', 'expired-bot', ?), ('10001', 'fresh-bot', ?)`,
    ).run(cutoff, cutoff + 1);

    assert.deepEqual(repository.pruneRawMessageRetention(cutoff), { messages: 1, reportMessages: 1, userTurns: 1 });
    const remaining = db.db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
    assert.equal(remaining.count, 1);
    assert.equal(repository.getDailyReportMessages("10001", "2026-08-19").length, 0);
    assert.equal(repository.getDailyReportMessages("10001", "2026-08-20").length, 1);
    const expiredTurn = db.db.prepare(
      "SELECT content, source_message_id, delivery_id, platform_message_id FROM conversation_turns WHERE role = 'user'",
    ).get() as { content: string; source_message_id: string | null; delivery_id: string | null; platform_message_id: string | null };
    assert.deepEqual(
      { ...expiredTurn },
      {
        content: "[expired]",
        source_message_id: null,
        delivery_id: null,
        platform_message_id: null,
      },
    );
    const contexts = db.db.prepare(
      "SELECT platform_message_id FROM conversation_message_context ORDER BY platform_message_id",
    ).all() as Array<{ platform_message_id: string }>;
    assert.deepEqual(contexts.map((row) => row.platform_message_id), ["fresh"]);
    const botMessages = db.db.prepare("SELECT msg_id FROM bot_messages ORDER BY msg_id").all() as Array<{ msg_id: string }>;
    assert.deepEqual(botMessages.map((row) => row.msg_id), ["fresh-bot"]);
    const topic = db.db.prepare("SELECT title, keywords_json FROM conversation_topics WHERE topic_id = 'topic-1'").get() as {
      title: string;
      keywords_json: string;
    };
    assert.equal(topic.title, "[expired]");
    assert.equal(topic.keywords_json, "[]");
  });
});

test("daily-report raw content cannot use a future timestamp to extend retention", async () => {
  await withRepository((repository, db) => {
    const receivedBefore = Date.now();
    repository.appendDailyReportMessage({
      groupId: "10001",
      dayKey: "2026-08-27",
      userId: "20001",
      userName: "成员",
      text: "未来时间戳不得延长原文留存",
      timestamp: new Date(receivedBefore + 24 * 60 * 60 * 1000).toISOString(),
    });
    const receivedAfter = Date.now();
    const row = db.db.prepare(
      "SELECT occurred_at FROM v3_daily_report_messages WHERE group_id = ? AND day_key = ?",
    ).get("10001", "2026-08-27") as { occurred_at: number };

    assert.ok(row.occurred_at >= receivedBefore);
    assert.ok(row.occurred_at <= receivedAfter);
  });
});

test("daily-report delivery keeps the rendered result after raw inputs expire", async () => {
  await withRepository((repository) => {
    const sentAt = Date.parse("2026-08-20T18:00:00.000Z");
    repository.appendDailyReportMessage({
      groupId: "10001",
      dayKey: "2026-08-12",
      userId: "20001",
      userName: "成员",
      text: "七天后应清理的原始群消息",
      timestamp: "2026-08-12T10:00:00.000Z",
    });

    repository.markDailyReportSent(
      "10001",
      "2026-08-12",
      sentAt,
      "2026-08-12 群聊日报\n今日消息 1 条",
    );

    assert.equal(repository.getDailyReportLastSent("10001"), "2026-08-12");
    assert.deepEqual(repository.getDailyReportOutput("10001", "2026-08-12"), {
      groupId: "10001",
      dayKey: "2026-08-12",
      renderedText: "2026-08-12 群聊日报\n今日消息 1 条",
      sentAt: "2026-08-20T18:00:00.000Z",
    });

    repository.pruneRawMessageRetention(Date.parse("2026-08-19T00:00:00.000Z"));
    assert.equal(repository.getDailyReportMessages("10001", "2026-08-12").length, 0);
    assert.equal(
      repository.getDailyReportOutput("10001", "2026-08-12")?.renderedText,
      "2026-08-12 群聊日报\n今日消息 1 条",
    );
  });
});
