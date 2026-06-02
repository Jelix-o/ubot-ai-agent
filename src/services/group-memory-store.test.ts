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
            confidence: 0.75,
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
    assert.equal((await memoryStore.listEnabled("67890")).length, 1);

    const rejected = await service.reject(pending[0]!.id);
    assert.equal(rejected?.status, "rejected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
