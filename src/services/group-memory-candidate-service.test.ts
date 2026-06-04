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

test("English memory candidates are not stored when normalization fails", async () => {
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
    assert.equal((await fixture.candidateStore.list({ groupId: "67890" })).length, 0);
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
