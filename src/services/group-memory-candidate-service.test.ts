import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtractedGroupMemoryCandidate, MemorySemanticJudgeInput, MemorySemanticJudgeResult } from "./ai-service.js";
import { GroupMemoryCandidateService } from "./group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./group-memory-candidate-store.js";
import { GroupMemoryStore } from "./group-memory-store.js";

class FakeMemoryAi {
  candidates: ExtractedGroupMemoryCandidate[] = [];
  normalizeCalls: ExtractedGroupMemoryCandidate[] = [];
  judgeCalls: MemorySemanticJudgeInput[] = [];
  normalized?: ExtractedGroupMemoryCandidate | null;
  judgeResult?: MemorySemanticJudgeResult | null;

  async extractGroupMemoryCandidates(): Promise<ExtractedGroupMemoryCandidate[]> {
    return this.candidates;
  }

  async normalizeMemoryCandidateLanguage(candidate: ExtractedGroupMemoryCandidate): Promise<ExtractedGroupMemoryCandidate | null> {
    this.normalizeCalls.push(candidate);
    return this.normalized ?? null;
  }

  async judgeMemorySemanticRelation(args: MemorySemanticJudgeInput): Promise<MemorySemanticJudgeResult | null> {
    this.judgeCalls.push(args);
    return this.judgeResult ?? null;
  }
}

test("English memory candidates are normalized to Chinese before auto approval", async () => {
  const fixture = await createFixture();
  try {
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "Food sensitivity",
        content: "Tester cannot eat oily food.",
        confidence: 0.9,
      },
    ];
    fixture.ai.normalized = {
      type: "member_profile",
      subjectUserId: "20001",
      title: "饮食忌口",
      content: "Tester 不能吃太油的食物。",
      confidence: 0.9,
    };

    fixture.service.queueMessage(message("Tester 说自己不能吃太油。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal(fixture.ai.normalizeCalls.length, 1);
    const memories = await fixture.memoryStore.list("67890");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.title, "饮食忌口");
    assert.equal(memories[0]?.content, "Tester 不能吃太油的食物。");
  } finally {
    await fixture.cleanup();
  }
});

test("English memory candidates stay pending for manual language review when normalization fails", async () => {
  const fixture = await createFixture();
  try {
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "Food sensitivity",
        content: "Tester cannot eat oily food.",
        confidence: 0.9,
      },
    ];
    fixture.ai.normalized = null;

    fixture.service.queueMessage(message("Tester 说自己不能吃太油。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.pendingCount, 1);
    assert.equal((await fixture.memoryStore.list("67890")).length, 0);
    const pending = await fixture.candidateStore.list({ groupId: "67890", status: "pending" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.title, "需中文化：Food sensitivity");
    assert.equal(pending[0]?.source, "auto:language_review");
    assert.equal(pending[0]?.confidence, 0.79);
  } finally {
    await fixture.cleanup();
  }
});

test("manual approval merges semantic duplicate into existing memory instead of creating another memory", async () => {
  const fixture = await createFixture();
  try {
    const existing = await fixture.memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "饮食偏好",
      content: "Tester 肠胃不好，不能吃太油的食物。",
      confidence: 0.86,
      source: "auto",
    });
    const candidate = await fixture.candidateStore.addCandidate({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "饮食忌口",
      content: "Tester 肠胃敏感，平时避免油腻食物，还会主动避开太油的快餐。",
      confidence: 0.9,
    });
    fixture.ai.judgeResult = {
      action: "merge",
      title: "饮食忌口",
      content: "Tester 肠胃不好，不能吃太油或油腻的食物，会主动避开太油的快餐。",
    };

    const approved = await fixture.service.approve(candidate.id);

    assert.equal(approved?.candidate.status, "approved");
    assert.equal(approved?.memory.id, existing.id);
    assert.equal(fixture.ai.judgeCalls.length, 1);
    const memories = await fixture.memoryStore.list("67890");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.content, "Tester 肠胃不好，不能吃太油或油腻的食物，会主动避开太油的快餐。");
  } finally {
    await fixture.cleanup();
  }
});

test("semantic duplicate skips same fact with different wording", async () => {
  const fixture = await createFixture();
  try {
    await fixture.memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "饮食偏好",
      content: "Tester 肠胃不好，不能吃太油的食物。",
      confidence: 0.86,
      source: "auto",
    });
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "饮食忌口",
        content: "Tester 肠胃敏感，平时避免油腻食物。",
        confidence: 0.9,
      },
    ];
    fixture.ai.judgeResult = { action: "duplicate", reason: "同一饮食忌口事实" };

    fixture.service.queueMessage(message("Tester 又提到肠胃敏感，避免油腻。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.skippedDuplicateCount, 1);
    assert.equal(fixture.ai.judgeCalls.length, 1);
    assert.equal((await fixture.memoryStore.list("67890")).length, 1);
    assert.equal((await fixture.candidateStore.list({ groupId: "67890" })).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("semantic merge updates existing memory with merged Chinese content", async () => {
  const fixture = await createFixture();
  try {
    await fixture.memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "工作习惯",
      content: "Tester 经常加班到晚上。",
      confidence: 0.76,
      source: "auto",
    });
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "工作习惯",
        content: "Tester 工作日通常很晚下班，晚上 11 点后还会整理机台异常和分析报告。",
        confidence: 0.9,
      },
    ];
    fixture.ai.judgeResult = {
      action: "merge",
      title: "工作习惯",
      content: "Tester 经常加班到晚上 11 点，并负责整理机台异常和分析报告。",
    };

    fixture.service.queueMessage(message("Tester 说今天又加班到 11 点写机台异常分析。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.refinedMemoryCount, 1);
    assert.equal(fixture.ai.judgeCalls.length, 1);
    assert.equal((await fixture.candidateStore.list({ groupId: "67890" })).length, 0);
    const memories = await fixture.memoryStore.list("67890");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.content, "Tester 经常加班到晚上 11 点，并负责整理机台异常和分析报告。");
  } finally {
    await fixture.cleanup();
  }
});

test("semantic judge failure falls back to local rules without blocking new memory", async () => {
  const fixture = await createFixture();
  try {
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "电影偏好",
        content: "Tester 喜欢蝙蝠侠系列和蜘蛛侠电影。",
        confidence: 0.88,
      },
    ];
    fixture.ai.judgeResult = null;

    fixture.service.queueMessage(message("Tester 说自己喜欢蝙蝠侠和蜘蛛侠。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal((await fixture.memoryStore.list("67890")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("low-value memory candidates are skipped before pending or approval", async () => {
  const fixture = await createFixture();
  try {
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "聊天活跃",
        content: "Tester 今天很活跃，参与了聊天。",
        confidence: 0.9,
      },
    ];

    fixture.service.queueMessage(message("Tester 今天说了很多话。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.skippedLowValueCount, 1);
    assert.equal(stats?.autoApprovedCount, 0);
    assert.equal(stats?.pendingCount, 0);
    assert.equal((await fixture.memoryStore.list("67890")).length, 0);
    assert.equal((await fixture.candidateStore.list({ groupId: "67890" })).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("durable preference candidates still auto approve", async () => {
  const fixture = await createFixture();
  try {
    fixture.ai.candidates = [
      {
        type: "member_profile",
        subjectUserId: "20001",
        title: "饮食忌口",
        content: "Tester 不能吃太油的食物。",
        confidence: 0.9,
      },
    ];

    fixture.service.queueMessage(message("Tester 说自己不能吃太油。"));
    const stats = await fixture.service.flushGroup("67890");

    assert.equal(stats?.skippedLowValueCount, 0);
    assert.equal(stats?.autoApprovedCount, 1);
    assert.equal((await fixture.memoryStore.list("67890")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent manual approvals of the same candidate create only one memory", async () => {
  const fixture = await createFixture();
  try {
    const candidate = await fixture.candidateStore.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "Shared schedule",
      content: "The group shares deployment notes every Friday.",
      confidence: 0.92,
    });

    const [first, second] = await Promise.all([
      fixture.service.approve(candidate.id),
      fixture.service.approve(candidate.id),
    ]);

    assert.equal(first?.candidate.status, "approved");
    assert.equal(second?.candidate.status, "approved");
    assert.equal(first?.memory.id, second?.memory.id);
    const memories = await fixture.memoryStore.list("67890");
    assert.equal(memories.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("approving an already approved candidate is idempotent and does not create another memory", async () => {
  const fixture = await createFixture();
  try {
    const candidate = await fixture.candidateStore.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "Shared schedule",
      content: "The group shares deployment notes every Friday.",
      confidence: 0.92,
    });

    const first = await fixture.service.approve(candidate.id);
    const second = await fixture.service.approve(candidate.id);

    assert.equal(first?.candidate.status, "approved");
    assert.equal(second, undefined);
    const memories = await fixture.memoryStore.list("67890");
    assert.equal(memories.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(): Promise<{
  ai: FakeMemoryAi;
  service: GroupMemoryCandidateService;
  memoryStore: GroupMemoryStore;
  candidateStore: GroupMemoryCandidateStore;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-candidate-service-"));
  const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
  const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
  const ai = new FakeMemoryAi();
  return {
    ai,
    service: new GroupMemoryCandidateService(candidateStore, memoryStore, ai, 8),
    memoryStore,
    candidateStore,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function message(text: string) {
  return {
    groupId: "67890",
    userId: "20001",
    userName: "Tester",
    text,
    timestamp: "2026-06-03T09:00:00.000Z",
  };
}
