import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GroupMemoryStore } from "./group-memory-store.js";

test("group memory store refreshes a second process cache after an external write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-refresh-"));
  const filePath = path.join(dir, "memory.json");
  try {
    const reader = new GroupMemoryStore(filePath);
    const writer = new GroupMemoryStore(filePath);
    await writer.create({
      groupId: "67890",
      type: "group_fact",
      title: "First fact",
      content: "The first shared fact.",
    });
    assert.equal((await reader.list("67890")).length, 1);

    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(filePath, "utf8")) as { memories: unknown[] };
    raw.memories.push({
      id: "external-memory",
      groupId: "67890",
      type: "group_fact",
      title: "External fact",
      content: "A backend process wrote this fact.",
      confidence: 0.8,
      source: "external",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      enabled: true,
    });
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal((await reader.list("67890")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory store initializes, persists, filters, updates and removes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    assert.deepEqual(await store.list("67890"), []);

    const memory = await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Tester preference",
      content: "Tester likes concise answers.",
      confidence: 0.8,
      source: "test",
      evidence: {
        startAt: "2026-06-01T10:00:00.000Z",
        endAt: "2026-06-01T10:02:00.000Z",
        messageCount: 2,
        speakers: [{ userId: "20001", userName: "Tester" }],
        summary: "Tester said they like concise answers.",
      },
    });
    await store.create({
      groupId: "99999",
      type: "group_fact",
      title: "Other group",
      content: "Not visible here.",
    });

    assert.equal((await store.list("67890")).length, 1);
    assert.equal((await store.listEnabled("67890")).length, 1);
    assert.deepEqual(await store.countBySubject("67890"), [{ userId: "20001", count: 1 }]);
    assert.equal((await store.get(memory.id))?.title, "Tester preference");
    assert.equal(await store.get("missing"), undefined);

    const updated = await store.update(memory.id, { enabled: false, title: "Updated" });
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.evidence?.messageCount, 2);
    assert.equal((await store.listEnabled("67890")).length, 0);

    const longEvidenceSummary = "evidence".repeat(180);
    const longEvidenceMemory = await store.create({
      groupId: "67890",
      type: "group_fact",
      title: "Long evidence",
      content: "Long source evidence should be retained.",
      evidence: {
        startAt: "2026-06-01T11:00:00.000Z",
        endAt: "2026-06-01T11:05:00.000Z",
        messageCount: 10,
        speakers: [{ userId: "20001", userName: "Tester" }],
        summary: longEvidenceSummary,
      },
    });
    assert.equal(longEvidenceMemory.evidence?.summary.length, longEvidenceSummary.length);
    assert.deepEqual(await store.countBySubject("67890"), [{ userId: "20001", count: 1 }]);

    assert.equal(await store.remove(memory.id), true);
    assert.equal(await store.remove(memory.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory reply selection prioritizes participants and stays within its prompt budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-relevant-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    const create = (title: string, type: "member_profile" | "group_fact", subjectUserId: string | undefined, minute: number, size = 32) =>
      store.create({
        groupId: "67890",
        type,
        ...(subjectUserId ? { subjectUserId } : {}),
        title,
        content: title.repeat(Math.ceil(size / title.length)).slice(0, size),
        createdAt: `2026-06-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
      });

    await create("speaker-old", "member_profile", "20001", 1);
    await create("speaker-new", "member_profile", "20001", 9);
    await create("mentioned", "member_profile", "20002", 8);
    await create("group-fact", "group_fact", undefined, 7);
    for (let index = 0; index < 10; index += 1) {
      await create(`general-${index}`, "member_profile", "30000", index + 10, 500);
    }

    const selected = await store.listRelevantEnabled({
      groupId: "67890",
      currentUserId: "20001",
      relatedUserIds: ["20002"],
    });

    assert.deepEqual(selected.slice(0, 4).map((memory) => memory.title), [
      "speaker-new",
      "speaker-old",
      "mentioned",
      "group-fact",
    ]);
    assert.ok(selected.length <= 8);
    assert.ok(selected.reduce((total, memory) => total + memory.title.length + memory.content.length, 0) <= 3_200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory reply selection excludes opted-out member memories before ranking and limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-opt-out-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    const create = (title: string, type: "member_profile" | "group_fact", subjectUserId: string | undefined, minute: number) =>
      store.create({
        groupId: "67890",
        type,
        ...(subjectUserId ? { subjectUserId } : {}),
        title,
        content: `${title} content`,
        createdAt: `2026-06-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
      });

    await create("excluded current speaker", "member_profile", "20001", 4);
    await create("excluded interaction target", "member_profile", "20002", 3);
    await create("shared group fact", "group_fact", undefined, 2);
    await create("eligible member memory", "member_profile", "30001", 1);

    const selected = await store.listRelevantEnabled({
      groupId: "67890",
      currentUserId: "20001",
      relatedUserIds: ["20002"],
      excludedSubjectUserIds: ["20001", "20002"],
      limit: 2,
    });

    assert.deepEqual(selected.map((memory) => memory.title), ["shared group fact", "eligible member memory"]);
    assert.equal(selected.some((memory) => memory.subjectUserId === "20001" || memory.subjectUserId === "20002"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory reply selection ranks an older query match above newer unrelated memories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-query-relevant-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Recent preference",
      content: "Tester usually chats late at night.",
      createdAt: "2026-06-03T10:00:00.000Z",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20002",
      title: "季博神的游戏偏好",
      content: "季博神最近一直在玩艾尔登法环。",
      createdAt: "2026-06-01T10:00:00.000Z",
    });

    const selected = await store.listRelevantEnabled({
      groupId: "67890",
      currentUserId: "20001",
      relatedUserIds: ["20002"],
      queryText: "季博神最近还在玩艾尔登法环吗",
      identityTerms: ["季博神", "季博霸王"],
    });

    assert.equal(selected[0]?.title, "季博神的游戏偏好");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory store pages filtered memories newest first without cloning full lists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-page-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Older tester preference",
      content: "Tester likes concise answers.",
      confidence: 0.9,
      source: "test",
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    await store.create({
      groupId: "67890",
      type: "group_fact",
      title: "Newest group fact",
      content: "The group prefers direct answers.",
      confidence: 0.8,
      source: "test",
      createdAt: "2026-06-03T10:00:00.000Z",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Evidence match",
      content: "Tester prefers code references.",
      confidence: 0.7,
      source: "test",
      createdAt: "2026-06-02T10:00:00.000Z",
      evidence: {
        startAt: "2026-06-02T09:59:00.000Z",
        endAt: "2026-06-02T10:00:00.000Z",
        messageCount: 2,
        speakers: [{ userId: "20001", userName: "EvidenceSpeaker" }],
        summary: "Tester mentioned source evidence.",
      },
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20002",
      title: "Disabled profile",
      content: "Disabled memories can be filtered.",
      enabled: false,
      createdAt: "2026-06-04T10:00:00.000Z",
    });
    await store.create({
      groupId: "99999",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Other group profile",
      content: "Other group should not match.",
      createdAt: "2026-06-05T10:00:00.000Z",
    });

    const firstPage = await store.listPage({
      groupId: "67890",
      page: 1,
      pageSize: 2,
    });
    assert.equal(firstPage.pagination.total, 4);
    assert.equal(firstPage.pagination.totalPages, 2);
    assert.equal(firstPage.items.length, 2);
    assert.deepEqual(firstPage.items.map((memory) => memory.title), ["Disabled profile", "Newest group fact"]);

    const subjectPage = await store.listPage({
      groupId: "67890",
      subjectUserId: "20001",
      type: "member_profile",
      enabled: true,
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(subjectPage.items.map((memory) => memory.title), ["Evidence match", "Older tester preference"]);
    assert.equal(subjectPage.pagination.total, 2);

    const evidenceSearch = await store.listPage({
      groupId: "67890",
      query: "evidencespeaker",
      page: 1,
      pageSize: 10,
    });
    assert.equal(evidenceSearch.pagination.total, 1);
    assert.equal(evidenceSearch.items[0]?.title, "Evidence match");
    assert.equal(evidenceSearch.items[0]?.evidence?.speakers[0]?.userName, "EvidenceSpeaker");

    const overlargePage = await store.listPage({
      groupId: "67890",
      page: 99,
      pageSize: 3,
    });
    assert.equal(overlargePage.pagination.page, 2);
    assert.equal(overlargePage.items.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group memory store keeps long profile summary content for admin full view", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-long-profile-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    const longSummary = [
      "徐美宜是台湾人，在半导体行业工作，拥有硬体工程师经验，日常负责收集机台异常和撰写分析报告。",
      "她偏好蝙蝠侠系列、蜘蛛侠电影、草东没有派对的音乐以及蜡笔小新相关物品。",
      "饮食方面，她爱吃辣食，但由于肠胃不好，不能吃太油或牛肉。",
    ].join("").repeat(6);

    const memory = await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "2026-06-03 昨日画像总结",
      content: longSummary,
      source: "daily_profile_review:2026-06-03",
      confidence: 0.8,
    });

    assert.equal(memory.content.length > 600, true);
    assert.equal(memory.content.length, Math.min(longSummary.length, 1800));
    assert.equal((await store.get(memory.id))?.content.length, memory.content.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
