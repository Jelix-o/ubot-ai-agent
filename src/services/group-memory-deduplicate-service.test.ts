import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MemorySemanticJudgeResult } from "./ai-service.js";
import { GroupMemoryDeduplicateService } from "./group-memory-deduplicate-service.js";
import { GroupMemoryStore } from "./group-memory-store.js";

test("memory deduplicate preview can skip semantic judge for fast admin previews", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-dedup-fast-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "回复偏好",
      content: "用户希望机器人回答简短一些。",
      source: "test",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "表达偏好",
      content: "用户想要机器人回复更精简。",
      source: "test",
    });

    let called = 0;
    const service = new GroupMemoryDeduplicateService(store, async () => {
      called += 1;
      return { action: "merge", reason: "same preference" };
    });

    const preview = await service.previewGroup("67890", {
      subjectUserId: "20001",
      semanticMode: "member",
      useSemanticJudge: false,
    });

    assert.equal(called, 0);
    assert.equal(preview.semanticStats.called, 0);
    assert.ok(preview.decisions.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory semantic deduplicate judge times out per pair without blocking preview", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-dedup-timeout-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "回复偏好",
      content: "喜欢在周末整理电影片单。",
      source: "test",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "表达偏好",
      content: "经常记录晚间跑步路线。",
      source: "test",
    });

    const service = new GroupMemoryDeduplicateService(store, async () =>
      new Promise<MemorySemanticJudgeResult>((resolve) => {
        setTimeout(() => resolve({ action: "merge", reason: "slow" }), 50);
      }));

    const startedAt = Date.now();
    const preview = await service.previewGroup("67890", {
      subjectUserId: "20001",
      semanticMode: "member",
      semanticTimeoutMs: 5,
    });

    assert.equal(preview.semanticStats.called, 1);
    assert.equal(preview.semanticStats.timedOut, 1);
    assert.equal(preview.decisions.length, 0);
    assert.ok(Date.now() - startedAt < 45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduled member memory dedup skips semantic judge by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-dedup-scheduled-fast-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "movie taste",
      content: "Collects quiet science fiction films and prefers short recommendations.",
      source: "test",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "running habit",
      content: "Usually records evening running routes and weekly distance goals.",
      source: "test",
    });

    let called = 0;
    const service = new GroupMemoryDeduplicateService(store, async () => {
      called += 1;
      return { action: "merge", reason: "same member preference" };
    });

    const result = await service.deduplicateMemberMemoriesForGroup("67890");

    assert.equal(called, 0);
    assert.equal(result.semanticStats.called, 0);
    assert.equal(result.semanticStats.timedOut, 0);
    assert.equal(result.decisionCount, 0);
    assert.ok(result.semanticStats.skippedDisabled >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduled member memory dedup can explicitly opt into semantic judge timeout guard", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-memory-dedup-scheduled-semantic-"));
  try {
    const store = new GroupMemoryStore(path.join(dir, "memory.json"));
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "movie taste",
      content: "Collects quiet science fiction films and prefers short recommendations.",
      source: "test",
    });
    await store.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "running habit",
      content: "Usually records evening running routes and weekly distance goals.",
      source: "test",
    });

    let called = 0;
    const service = new GroupMemoryDeduplicateService(store, async () => {
      called += 1;
      return new Promise<MemorySemanticJudgeResult>((resolve) => {
        setTimeout(() => resolve({ action: "merge", reason: "slow scheduled judge" }), 50);
      });
    });

    const startedAt = Date.now();
    const result = await service.deduplicateMemberMemoriesForGroup("67890", {
      useSemanticJudge: true,
      semanticTimeoutMs: 5,
    });

    assert.equal(called, 1);
    assert.equal(result.semanticStats.called, 1);
    assert.equal(result.semanticStats.timedOut, 1);
    assert.equal(result.decisionCount, 0);
    assert.ok(Date.now() - startedAt < 45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
