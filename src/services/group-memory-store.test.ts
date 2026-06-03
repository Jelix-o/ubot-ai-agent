import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GroupMemoryCandidateService } from "./group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
import { GroupMemoryStore } from "./group-memory-store.js";

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

    assert.equal(await store.remove(memory.id), true);
    assert.equal(await store.remove(memory.id), false);
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
            confidence: 0.55,
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
            title: "Detailed evidence",
            content: "Detailed evidence should survive approval.",
            confidence: 0.55,
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
      title: "Tester answer preference",
      content: "Tester prefers concise answers with direct conclusions.",
      confidence: 0.9,
      source: "test",
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "Tester answer preference",
            content: "Tester prefers concise answers with direct conclusions.",
            confidence: 0.95,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "I still prefer concise answers with direct conclusions.",
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

test("candidate service merges candidates similar to pending candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-pending-merge-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
    await candidateStore.addCandidate({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Tester game preference",
      content: "Tester mainly plays League of Legends and likes five-stack games.",
      confidence: 0.62,
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
            title: "Tester game preference",
            content: "Tester mainly plays League of Legends and likes five-stack games.",
            confidence: 0.7,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "I mainly play League of Legends and like five-stack games.",
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
      title: "Tester answer preference",
      content: "Tester prefers concise answers with direct conclusions.",
      confidence: 0.9,
      source: "test",
    });
    const service = new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [
          {
            type: "member_profile",
            subjectUserId: "20001",
            title: "Tester game preference",
            content: "Tester mainly plays League of Legends and likes five-stack games.",
            confidence: 0.85,
          },
        ];
      },
    });

    service.queueMessage({
      groupId: "67890",
      userId: "20001",
      userName: "Tester",
      text: "I mainly play League of Legends and like five-stack games.",
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
