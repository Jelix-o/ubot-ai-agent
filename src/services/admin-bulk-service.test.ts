import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { AdminBulkService, BulkError, revision, type BulkPayload, type BulkTarget } from "./admin-bulk-service.js";
import { AdminTaskStore } from "./admin-task-store.js";

interface Value { id: string; groupId: string; value: number }

function fixture(t: test.TestContext, initial: Value[] = [{ id: "a", groupId: "g1", value: 1 }, { id: "b", groupId: "g1", value: 2 }, { id: "c", groupId: "g2", value: 3 }]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "admin-bulk-"));
  const db = new SharedDb(path.join(dir, "shared.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const tasks = new AdminTaskStore(path.join(dir, "tasks.json"));
  const values = new Map(initial.map((item) => [item.id, { ...item }]));
  let now = Date.now();
  let allowed = true;
  const audit: string[] = [];
  const adapter = {
    read: async (id: string): Promise<BulkTarget | undefined> => {
      const value = values.get(id);
      return value ? { id, groupId: value.groupId, label: id, revision: revision(value), before: value.value, after: value.value + 1 } : undefined;
    },
    authorize: async (): Promise<boolean> => allowed,
    apply: async (target: BulkTarget, _payload: BulkPayload, committed?: () => void): Promise<void> => {
      const value = values.get(target.id)!;
      values.set(target.id, { ...value, value: value.value + 1 });
      committed?.();
    },
    audit: async (target: BulkTarget): Promise<void> => { audit.push(target.id); },
  };
  const service = new AdminBulkService(db, tasks, () => now);
  return { db, tasks, values, audit, adapter, service, setNow: (value: number) => { now = value; }, setAllowed: (value: boolean) => { allowed = value; } };
}

async function preview(f: ReturnType<typeof fixture>, ids = ["a", "b"]) {
  return f.service.preview("operator", { resource: "memories", action: "enable", ids, groupId: "g1" }, f.adapter);
}

async function waitForTask(service: AdminBulkService, tasks: AdminTaskStore, id: string) {
  for (let i = 0; i < 200; i++) {
    const task = await tasks.get(id);
    if (task && !["queued", "running"].includes(task.status)) { await service.waitForIdle(id); return task; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("bulk task did not finish");
}

test("bulk preview rejects unauthorized targets and execution rechecks permission", async (t) => {
  const f = fixture(t);
  f.setAllowed(false);
  await assert.rejects(preview(f), (error: unknown) => error instanceof BulkError && error.status === 403);
  f.setAllowed(true);
  const plan = await preview(f, ["a"]);
  f.setAllowed(false);
  await assert.rejects(f.service.execute(plan.id, "operator", f.adapter), (error: unknown) => error instanceof BulkError && error.status === 403);
  assert.equal((await f.tasks.listPage({ page: 1, pageSize: 20 })).pagination.total, 0);
});

test("bulk execution rejects expired previews and changed target revisions", async (t) => {
  const f = fixture(t);
  const expired = await preview(f, ["a"]);
  f.setNow(Date.now() + 600_001);
  await assert.rejects(f.service.execute(expired.id, "operator", f.adapter), (error: unknown) => error instanceof BulkError && error.code === "preview_expired");

  const changed = await preview(f, ["b"]);
  f.values.set("b", { ...f.values.get("b")!, value: 99 });
  await assert.rejects(f.service.execute(changed.id, "operator", f.adapter), (error: unknown) => error instanceof BulkError && error.code === "target_changed");
});

test("duplicate bulk submission returns one task and applies each target once", async (t) => {
  const f = fixture(t);
  const plan = await preview(f, ["a"]);
  const first = await f.service.execute(plan.id, "operator", f.adapter);
  const second = await f.service.execute(plan.id, "operator", f.adapter);
  assert.equal(second, first);
  const task = await waitForTask(f.service, f.tasks, first);
  assert.equal(task.status, "succeeded");
  assert.equal(f.values.get("a")?.value, 2);
  assert.equal((task.result as { counts: { succeeded: number } }).counts.succeeded, 1);
});

test("partial failure is recorded per target and later targets continue", async (t) => {
  const f = fixture(t);
  const apply = f.adapter.apply;
  f.adapter.apply = async (target, payload, committed) => {
    if (target.id === "b") throw new Error("simulated failure");
    await apply(target, payload, committed);
  };
  const plan = await preview(f, ["a", "b", "c"]);
  const id = await f.service.execute(plan.id, "operator", f.adapter);
  const task = await waitForTask(f.service, f.tasks, id);
  const result = task.result as { items: Array<{ id: string; status: string }>; counts: { succeeded: number; failed: number } };
  assert.equal(task.status, "failed");
  assert.deepEqual(result.items.map((item) => [item.id, item.status]), [["a", "succeeded"], ["b", "failed"], ["c", "succeeded"]]);
  assert.deepEqual(result.counts, { succeeded: 2, failed: 1, skipped: 0 });
});

test("cancellation preserves completed targets and skips the remainder", async (t) => {
  const f = fixture(t);
  const apply = f.adapter.apply;
  let entered!: () => void;
  let release!: () => void;
  const enteredApply = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.adapter.apply = async (target, payload, committed) => {
    if (target.id === "a") { entered(); await gate; }
    await apply(target, payload, committed);
  };
  const plan = await preview(f, ["a", "b", "c"]);
  const id = await f.service.execute(plan.id, "operator", f.adapter);
  await enteredApply;
  await f.service.cancel(id, "operator", false);
  release();
  const task = await waitForTask(f.service, f.tasks, id);
  const result = task.result as { items: Array<{ id: string; status: string }> };
  assert.equal(task.status, "cancelled");
  assert.deepEqual(result.items.map((item) => [item.id, item.status]), [["a", "succeeded"], ["b", "skipped"], ["c", "skipped"]]);
});

test("startup recovery keeps completed results and marks unfinished targets interrupted", async (t) => {
  const f = fixture(t);
  const plan = await preview(f, ["a", "b"]);
  const task = await f.tasks.create({ type: "bulk-operation", title: "recovered batch", operatorUserId: "operator" });
  await f.tasks.update(task.id, { status: "running" });
  f.db.db.prepare("UPDATE admin_bulk_previews SET task_id=? WHERE id=?").run(task.id, plan.id);
  f.db.db.prepare("INSERT INTO admin_bulk_runs(task_id,preview_id,status,updated_at) VALUES(?,?,?,?)").run(task.id, plan.id, "running", Date.now());
  f.db.db.prepare("INSERT INTO admin_bulk_results(task_id,target_id,result_json) VALUES(?,?,?)").run(task.id, "a", JSON.stringify({ id: "a", groupId: "g1", label: "a", status: "succeeded" }));

  await new AdminBulkService(f.db, f.tasks).interruptPreviousRuns();
  const recovered = await f.tasks.get(task.id);
  const result = recovered?.result as { items: Array<{ id: string; status: string; error?: string }> };
  assert.equal(recovered?.status, "failed");
  assert.deepEqual(result.items.map((item) => [item.id, item.status]), [["a", "succeeded"], ["b", "skipped"]]);
  assert.equal(result.items[1]?.error, "interrupted");
});

test("unexpected orchestration failure records every unfinished target as interrupted", async (t) => {
  const f = fixture(t);
  const update = f.tasks.update.bind(f.tasks);
  let failRunningTransition = true;
  f.tasks.update = async (id, patch) => {
    if (failRunningTransition && patch.status === "running") { failRunningTransition = false; throw new Error("simulated coordinator failure"); }
    return update(id, patch);
  };
  const plan = await preview(f, ["a", "b"]);
  const id = await f.service.execute(plan.id, "operator", f.adapter);
  const task = await waitForTask(f.service, f.tasks, id);
  const result = task.result as { items: Array<{ id: string; status: string; error?: string }> };
  assert.equal(task.status, "failed");
  assert.deepEqual(result.items.map(item => [item.id, item.status, item.error]), [["a", "skipped", "interrupted"], ["b", "skipped", "interrupted"]]);
});
