import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AdminTasksFile } from "../types.js";
import { AdminTaskStore } from "./admin-task-store.js";

async function withStore<T>(run: (store: AdminTaskStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-task-store-"));
  try {
    return await run(new AdminTaskStore(path.join(dir, "tasks.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("AdminTaskStore records successful task runs", async () => {
  await withStore(async (store) => {
    const wrapped = await store.run({
      type: "memory-dedup",
      title: "Dedup member memories",
      groupId: "67890",
      subjectUserId: "20001",
      operatorUserId: "admin",
    }, async () => ({ appliedCount: 2, skippedCount: 0 }));

    assert.equal(wrapped.result.appliedCount, 2);
    assert.equal(wrapped.task.status, "succeeded");
    assert.equal(wrapped.task.progress, 100);
    assert.equal(wrapped.task.groupId, "67890");
    assert.equal(typeof wrapped.task.durationMs, "number");

    const page = await store.listPage({ groupId: "67890", page: 1, pageSize: 20 });
    assert.equal(page.pagination.total, 1);
    assert.equal(page.tasks[0]?.type, "memory-dedup");
    assert.deepEqual(page.tasks[0]?.result, { appliedCount: 2, skippedCount: 0 });
  });
});

test("AdminTaskStore starts background task runs without waiting for result", async () => {
  await withStore(async (store) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = await store.start({
      type: "memory-dedup",
      title: "Preview member memory dedup",
      groupId: "67890",
      subjectUserId: "20001",
      operatorUserId: "admin",
    }, async () => {
      await waiting;
      return { decisionCount: 3 };
    });

    assert.equal(task.status, "queued");
    assert.equal((await store.get(task.id))?.status, "queued");

    release();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await store.get(task.id);
      if (current?.status === "succeeded") {
        assert.deepEqual(current.result, { decisionCount: 3 });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("background task did not finish");
  });
});

test("AdminTaskStore records failed task runs", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.run({
        type: "model-check",
        title: "Check model",
        operatorUserId: "admin",
      }, async () => {
        throw new Error("connection failed");
      }),
      /connection failed/,
    );

    const page = await store.listPage({ status: "failed", page: 1, pageSize: 20 });
    assert.equal(page.pagination.total, 1);
    assert.equal(page.tasks[0]?.status, "failed");
    assert.match(page.tasks[0]?.error ?? "", /connection failed/);
  });
});

test("AdminTaskStore marks stale queued and running persisted tasks as failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-task-store-stale-"));
  try {
    const filePath = path.join(dir, "tasks.json");
    const oldStartedAt = "2026-06-01T00:00:00.000Z";
    const data: AdminTasksFile = {
      tasks: [
        {
          id: "stale-model-check",
          type: "model-check",
          status: "running",
          title: "模型检测 环境语音模型",
          operatorUserId: "admin",
          progress: 50,
          createdAt: oldStartedAt,
          updatedAt: oldStartedAt,
          startedAt: oldStartedAt,
        },
        {
          id: "stale-memory-dedup",
          type: "memory-dedup",
          status: "queued",
          title: "记忆去重",
          operatorUserId: "admin",
          progress: 0,
          createdAt: oldStartedAt,
          updatedAt: oldStartedAt,
        },
      ],
    };
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const store = new AdminTaskStore(filePath);

    const page = await store.listPage({ status: "failed", page: 1, pageSize: 20 });

    assert.equal(page.pagination.total, 2);
    const modelCheck = page.tasks.find((task) => task.id === "stale-model-check");
    const memoryDedup = page.tasks.find((task) => task.id === "stale-memory-dedup");
    assert.equal(modelCheck?.status, "failed");
    assert.equal(modelCheck?.progress, 100);
    assert.match(modelCheck?.error ?? "", /自动标记失败/);
    assert.equal(typeof modelCheck?.durationMs, "number");
    assert.equal(memoryDedup?.status, "failed");
    assert.match(memoryDedup?.error ?? "", /最后状态：queued/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AdminTaskStore searches task title, result, and errors before pagination", async () => {
  await withStore(async (store) => {
    await store.run({
      type: "profile-generate",
      title: "Generate profile for Alice",
      groupId: "67890",
      subjectUserId: "20001",
      operatorUserId: "admin",
      detail: "overall",
    }, async () => ({ recordId: "profile-alice", sourceMemoryCount: 3 }));

    await assert.rejects(
      () => store.run({
        type: "model-check",
        title: "Check reply model",
        operatorUserId: "admin",
      }, async () => {
        throw new Error("latency timeout");
      }),
      /latency timeout/,
    );

    const byResult = await store.listPage({ q: "profile-alice", page: 1, pageSize: 1 });
    assert.equal(byResult.pagination.total, 1);
    assert.equal(byResult.tasks[0]?.type, "profile-generate");

    const byError = await store.listPage({ q: "timeout", page: 1, pageSize: 1 });
    assert.equal(byError.pagination.total, 1);
    assert.equal(byError.tasks[0]?.type, "model-check");

    const byTitle = await store.listPage({ q: "alice", page: 1, pageSize: 1 });
    assert.equal(byTitle.pagination.total, 1);
    assert.equal(byTitle.tasks[0]?.subjectUserId, "20001");
  });
});

test("AdminTaskStore filters visible group tasks before pagination", async () => {
  await withStore(async (store) => {
    await store.run({
      type: "profile-generate",
      title: "Visible group task",
      groupId: "67890",
      subjectUserId: "20001",
      operatorUserId: "admin",
    }, async () => ({ recordId: "visible-profile" }));
    await store.run({
      type: "bulk-review",
      title: "Other group task",
      groupId: "100200300",
      operatorUserId: "admin",
    }, async () => ({ approvedCount: 8 }));
    await assert.rejects(
      () => store.run({
        type: "model-check",
        title: "System model check",
        operatorUserId: "admin",
      }, async () => {
        throw new Error("system probe failed");
      }),
      /system probe failed/,
    );

    const groupOnly = await store.listPage({
      visibleGroupIds: ["67890"],
      includeSystemTasks: false,
      page: 1,
      pageSize: 1,
    });
    assert.equal(groupOnly.pagination.total, 1);
    assert.equal(groupOnly.tasks[0]?.groupId, "67890");

    const withSystem = await store.listPage({
      visibleGroupIds: ["67890"],
      includeSystemTasks: true,
      page: 1,
      pageSize: 20,
    });
    assert.equal(withSystem.pagination.total, 2);
    assert.equal(withSystem.tasks.some((task) => !task.groupId && task.type === "model-check"), true);
    assert.equal(withSystem.tasks.some((task) => task.groupId === "100200300"), false);
  });
});
