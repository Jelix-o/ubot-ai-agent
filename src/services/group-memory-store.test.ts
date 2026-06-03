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

    assert.equal(await store.remove(memory.id), true);
    assert.equal(await store.remove(memory.id), false);
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
            content: "问题解决后可能需要回填结论。",
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
