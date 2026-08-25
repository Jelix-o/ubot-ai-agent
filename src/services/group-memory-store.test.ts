import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GroupMemoryCandidateService } from "./group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
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

test("candidate store refreshes after an external admin write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-candidate-refresh-"));
  const filePath = path.join(dir, "candidates.json");
  try {
    const reader = new GroupMemoryCandidateStore(filePath);
    const writer = new GroupMemoryCandidateStore(filePath);
    await writer.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "第一条候选",
      content: "第一条候选内容",
    });
    assert.equal((await reader.list({ groupId: "67890" })).length, 1);

    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(filePath, "utf8")) as { candidates: unknown[] };
    raw.candidates.push({
      id: "external-candidate",
      groupId: "67890",
      type: "group_fact",
      title: "外部候选",
      content: "管理后台写入的候选",
      confidence: 0.7,
      source: "admin",
      status: "pending",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal((await reader.list({ groupId: "67890" })).length, 2);
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

test("candidate service deduplicates and approves candidates into long term memory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-candidate-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "group_fact",
            title: "固定群规",
            content: "提问前先贴上下文。",
            confidence: 0.65,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "以后提问前先贴上下文",
      timestamp: new Date().toISOString(),
    });
    await service.flushAll();
    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "以后提问前先贴上下文",
      timestamp: new Date().toISOString(),
    });
    await service.flushAll();

    const pending = await service.list({ groupId: "67890", status: "pending" });
    assert.equal(pending.length, 1);

    const approved = await service.approve(pending[0]!.id, { title: "提问规则" });
    assert.equal(approved?.candidate.status, "approved");
    assert.equal(approved?.memory.evidence?.speakers[0]?.userId, "20001");
    assert.equal((await memoryStore.listEnabled("67890")).length, 1);

    const rejected = await service.reject(pending[0]!.id);
    assert.equal(rejected?.status, "rejected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate evidence keeps detailed summaries when approved into memory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-candidate-evidence-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "group_fact",
            title: "详细证据",
            content: "详细来源证据需要在批准后保留下来。",
            confidence: 0.65,
          },
        ];
      },
    });

    for (let index = 0; index < 2; index += 1) {
      service.queueMessage({
        groupId: "67890",
        userId: "20001",
        userName: "Tester",
        text: `long evidence ${index} ${"detail ".repeat(120)}`,
        timestamp: new Date(1_780_000_000_000 + index * 1000).toISOString(),
      });
    }
    await service.flushAll();

    const pending = await service.list({ groupId: "67890", status: "pending" });
    assert.equal(pending.length, 1);

    const approved = await service.approve(pending[0]!.id);
    assert.equal(approved?.candidate.status, "approved");
    assert.equal((approved?.memory.evidence?.summary.length ?? 0) > 600, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service auto-approves confident candidates and keeps unsafe member profiles pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-auto-approve-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "group_fact",
            title: "固定群规",
            content: "问题解决后要回填结论。",
            confidence: 0.8,
          },
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "Tester 偏好",
            content: "Tester 喜欢直接给结论。",
            confidence: 0.8,
          },
          {
            type: "group_fact",
            title: "低置信固定群规",
            content: "群里周五晚上常会约组队游戏。",
            confidence: 0.7,
          },
          {
            type: "member_profile",
            title: "未归属偏好",
            content: "有人喜欢长回答。",
            confidence: 0.95,
          },
          {
            type: "member_profile",
            subjectUserId: "99999",
            title: "错归属偏好",
            content: "模型把画像挂到了未发言的人。",
            confidence: 0.95,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "问题解决后要回填结论",
      timestamp: new Date().toISOString(),
    });
    await service.flushAll();

    const memories = await memoryStore.listEnabled("67890");
    assert.equal(memories.length, 2);
    assert.deepEqual(
      memories.map((memory) => memory.title).sort(),
      ["Tester 偏好", "固定群规"],
    );

    const pending = await service.list({ groupId: "67890", status: "pending" });
    assert.equal(pending.length, 3);
    assert.deepEqual(
      pending.map((candidate) => candidate.title).sort(),
      ["低置信固定群规", "未归属偏好", "错归属偏好"],
    );
    assert.equal(pending.find((candidate) => candidate.title === "错归属偏好")?.subjectUserId, undefined);

    const approved = await service.list({ groupId: "67890", status: "approved" });
    assert.equal(approved.length, 2);
    assert.equal(memories.every((memory) => memory.evidence?.messageCount === 1), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service does not duplicate memories for repeated auto-approved candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-auto-dedupe-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "group_fact",
            title: "固定群规",
            content: "问题解决后要回填结论。",
            confidence: 0.82,
          },
        ];
      },
    });

    for (let index = 0; index < 2; index += 1) {
      service.queueMessage({
        groupId: "67890",
        userId: "20001",
        userName: "Tester",
        text: "问题解决后要回填结论",
        timestamp: new Date().toISOString(),
      });
      await service.flushAll();
    }

    assert.equal((await memoryStore.listEnabled("67890")).length, 1);
    assert.equal((await service.list({ groupId: "67890", status: "approved" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service skips candidates similar to approved memories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-existing-dedupe-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "回答偏好",
      content: "Tester 喜欢简洁回答，并希望直接给结论。",
      confidence: 0.9,
      source: "test",
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "回答偏好",
            content: "Tester 喜欢简洁回答，并希望直接给结论。",
            confidence: 0.95,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "我还是喜欢简洁回答，最好直接给结论。",
      timestamp: new Date().toISOString(),
    });
    const stats = await service.flushGroup("67890");

    assert.equal(stats?.skippedDuplicateCount, 1);
    assert.equal((await memoryStore.listEnabled("67890")).length, 1);
    assert.equal((await service.list({ groupId: "67890" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service refines similar approved memories when new detail is stronger", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-refine-approved-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const existing = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "游戏偏好",
      content: "Tester 平时玩英雄联盟。",
      confidence: 0.82,
      source: "test",
      evidence: {
        startAt: "2026-06-01T10:00:00.000Z",
        endAt: "2026-06-01T10:00:00.000Z",
        messageCount: 1,
        speakers: [{ userId: "20001", userName: "Tester" }],
        summary: "Tester mentioned League of Legends.",
      },
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "游戏偏好",
            content: "Tester 平时主要玩英雄联盟，喜欢和固定朋友五排开黑，不太喜欢单排，也会关注队友配合体验。",
            confidence: 0.9,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "我平时主要玩英雄联盟，喜欢五排，不太喜欢路人局",
      timestamp: "2026-06-02T10:00:00.000Z",
    });
    const stats = await service.flushGroup("67890");

    const refined = await memoryStore.get(existing.id);
    assert.equal(stats?.refinedMemoryCount, 1);
    assert.equal(stats?.autoApprovedCount, 0);
    assert.equal(stats?.pendingCount, 0);
    assert.equal((await memoryStore.listEnabled("67890")).length, 1);
    assert.equal((await service.list({ groupId: "67890" })).length, 0);
    assert.match(refined?.content ?? "", /固定朋友五排/);
    assert.equal(refined?.confidence, 0.9);
    assert.equal(refined?.evidence?.messageCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service ignores daily profile summaries for duplicate blocking", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-daily-review-dedupe-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "2026-06-01 昨日画像总结",
      content: "Tester 昨日提到自己常玩游戏，也会聊工作和群内协作方式。",
      confidence: 0.8,
      source: "daily_profile_review:2026-06-01",
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "游戏偏好",
            content: "Tester 主要玩英雄联盟，并且喜欢五排。",
            confidence: 0.86,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "我平时主要玩英雄联盟，喜欢五排",
      timestamp: "2026-06-02T10:00:00.000Z",
    });
    const stats = await service.flushGroup("67890");

    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal(stats?.skippedDuplicateCount, 0);
    assert.equal((await memoryStore.listEnabled("67890")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service sends long message bodies to the profile extractor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-long-message-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    let observedText = "";
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates(args) {
        observedText = args.messages[0]?.text ?? "";
        return [];
      },
    });

    const longText = `前缀${"一".repeat(360)}后缀`;
    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: longText,
      timestamp: "2026-06-02T10:00:00.000Z",
    });
    await service.flushGroup("67890");

    assert.equal(observedText.includes("后缀"), true);
    assert.equal(observedText.length, longText.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service merges candidates similar to pending candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-pending-merge-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    const existingCandidate = await candidateStore.addCandidate({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "游戏偏好",
      content: "Tester 主要玩英雄联盟，并且喜欢五排。",
      confidence: 0.62,
      evidence: {
        startAt: "2026-06-01T10:00:00.000Z",
        endAt: "2026-06-01T10:00:00.000Z",
        messageCount: 1,
        speakers: [{ userId: "20001", userName: "Tester" }],
        summary: "Tester mentioned League of Legends.",
      },
    });
    assert.equal((await candidateStore.get(existingCandidate.id))?.title, "游戏偏好");
    assert.equal(await candidateStore.get("missing"), undefined);
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "游戏偏好",
            content: "Tester 主要玩英雄联盟，并且喜欢五排。",
            confidence: 0.7,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "我主要玩英雄联盟，也喜欢五排。",
      timestamp: "2026-06-02T10:00:00.000Z",
    });
    const stats = await service.flushGroup("67890");

    const pending = await service.list({ groupId: "67890", status: "pending" });
    assert.equal(stats?.mergedCandidateCount, 1);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.confidence, 0.7);
    assert.equal(pending[0]?.evidence?.messageCount, 2);
    assert.equal((await memoryStore.listEnabled("67890")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate service still approves new non-duplicate facts after duplicate filtering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-new-after-dedupe-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "回答偏好",
      content: "Tester 喜欢简洁回答，并希望直接给结论。",
      confidence: 0.9,
      source: "test",
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "游戏偏好",
            content: "Tester 主要玩英雄联盟，并且喜欢五排。",
            confidence: 0.85,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "我主要玩英雄联盟，也喜欢五排。",
      timestamp: new Date().toISOString(),
    });
    const stats = await service.flushGroup("67890");

    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal((await memoryStore.listEnabled("67890")).length, 2);
    assert.equal((await service.list({ groupId: "67890", status: "approved" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate store pages filtered candidates newest first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-candidate-page-"));
  try {
    const store = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    await store.addCandidate({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Older profile",
      content: "Tester likes concise answers.",
      confidence: 0.7,
      evidence: {
        startAt: "2026-06-01T09:59:00.000Z",
        endAt: "2026-06-01T10:00:00.000Z",
        messageCount: 2,
        speakers: [{ userId: "20001", userName: "CandidateSpeaker" }],
        summary: "CandidateSpeaker talked about concise answers.",
      },
    });
    const rejected = await store.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "Rejected fact",
      content: "The group likes short updates.",
      confidence: 0.6,
    });
    await store.update(rejected.id, { status: "rejected" });
    await store.addCandidate({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20002",
      title: "Other profile",
      content: "Another member likes long updates.",
      confidence: 0.6,
    });
    await store.addCandidate({
      groupId: "99999",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Other group profile",
      content: "Other group should not match.",
    });

    assert.deepEqual(
      (await store.countPendingBySubject("67890")).sort((left, right) => left.userId.localeCompare(right.userId)),
      [
        { userId: "20001", count: 1 },
        { userId: "20002", count: 1 },
      ],
    );

    const subjectPage = await store.listPage({
      groupId: "67890",
      status: "pending",
      type: "member_profile",
      subjectUserId: "20001",
      query: "candidatespeaker",
      page: 1,
      pageSize: 10,
    });
    assert.equal(subjectPage.pagination.total, 1);
    assert.equal(subjectPage.items[0]?.title, "Older profile");

    const pendingPage = await store.listPage({
      groupId: "67890",
      status: "pending",
      page: 1,
      pageSize: 1,
    });
    assert.equal(pendingPage.pagination.total, 2);
    assert.equal(pendingPage.pagination.totalPages, 2);
    assert.equal(pendingPage.items.length, 1);

    const rejectedPage = await store.listPage({
      groupId: "67890",
      status: "rejected",
      page: 1,
      pageSize: 10,
    });
    assert.equal(rejectedPage.pagination.total, 1);
    assert.equal(rejectedPage.items[0]?.title, "Rejected fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
