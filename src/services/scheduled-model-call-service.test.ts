import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import type { GroupBotConfig, ScheduledReminderTask, SystemSettings, SystemModelConfig } from "../types.js";
import { V3StateRepository } from "./v3-state-repository.js";
import { ScheduledReminderStore } from "./scheduled-reminder-store.js";
import { ScheduledReminderService } from "./scheduled-reminder-service.js";
import { nextModelCallAt } from "./model-call-schedule.js";
import { ScheduledModelCallService, callScheduledModelOnce } from "./scheduled-model-call-service.js";

test("model-call daily Beijing slots are independent of process timezone and repeat across weekends", () => {
  assert.equal(nextModelCallAt("05:59", new Date("2026-10-30T22:00:00Z")), "2026-10-31T21:59:00.000Z");
  for (const [time, stamp] of [["05:59", "2026-10-30T21:59:00.000Z"], ["11:00", "2026-10-31T03:00:00.000Z"], ["16:01", "2026-10-31T08:01:00.000Z"]]) {
    assert.equal(nextModelCallAt(time!, new Date("2026-10-30T20:00:00Z")), stamp);
    assert.equal(Date.parse(nextModelCallAt(time!, new Date(stamp!))) - Date.parse(stamp!), 86_400_000);
  }
  assert.throws(() => nextModelCallAt("24:01"));
});

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-model-call-"));
  const db = new SharedDb(path.join(dir, "state.db"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const repo = new V3StateRepository(db, { stateEncryptionKey: "0".repeat(64) });
  const model = { id: "sol", purpose: "reply", enabled: true, model: "fixed-model", baseUrl: "http://127.0.0.1/v1", apiKey: "test-only" } as SystemModelConfig;
  const settings = { async getInternal() { return { models: [model] } as SystemSettings; } };
  const group = { groupId: "10001", enabled: true, scheduledRemindersEnabled: true } as GroupBotConfig;
  const groups = { async getGroup(id: string) { return id === group.groupId ? group : undefined; } };
  const task: ScheduledReminderTask = { id: "model-slot", groupId: group.groupId, creatorUserId: "admin", intervalMinutes: 1440, topic: "模型调用", kind: "model_call", modelId: "sol", timezone: "Asia/Shanghai", scheduledTime: "05:59", enabled: true, createdAt: "2026-10-30T00:00:00Z", nextRunAt: "2026-10-30T21:59:00.000Z" };
  repo.saveScheduledReminder(task);
  const runs = () => (db.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type='scheduled-model-call-run'").all() as { document_json: string }[]).map(row => JSON.parse(row.document_json));
  return { dir, db, repo, model, settings, group, groups, task, runs };
}

test("morning weekend model call runs once, persists result, isolates groups and never enters old reminder claims", async t => {
  const f = await fixture(t);
  assert.equal(f.repo.claimDueScheduledReminders(Date.parse(f.task.nextRunAt)).length, 0);
  let count = 0;
  const caller = async (model: SystemModelConfig, group: string) => { count++; assert.equal(model.id, "sol"); assert.equal(group, "10001"); return { model: model.model }; };
  const service = new ScheduledModelCallService(f.db, f.settings, f.groups, caller);
  await service.tick(new Date("2026-10-30T21:58:59Z"));
  assert.equal(count, 0);
  await Promise.all([service.tick(new Date(f.task.nextRunAt)), service.tick(new Date(f.task.nextRunAt))]);
  // Recreated worker sees the same run, even if a stale task accidentally retains that slot.
  assert.equal(f.repo.getScheduledReminder(f.task.id)?.lastRun?.status, "succeeded");
  f.repo.saveScheduledReminder(f.task);
  await new ScheduledModelCallService(f.db, f.settings, f.groups, caller).tick(new Date(f.task.nextRunAt));
  assert.equal(count, 1);
  assert.equal(f.runs()[0].status, "succeeded");
  assert.equal(f.repo.getScheduledReminder(f.task.id)?.lastRun?.status, undefined); // stale write above intentionally replaced task metadata
  const outbox = f.db.db.prepare("SELECT group_id,text FROM outbox").all() as { group_id: string; text: string }[];
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.group_id, "10001");
  assert.match(outbox[0]!.text, /05:59｜sol \/ fixed-model｜成功/);
  assert.equal(f.repo.getScheduledReminder(f.task.id)?.nextRunAt, "2026-10-31T21:59:00.000Z");
});

test("failed and unknown outcomes never retry or fall back and never expose upstream error bodies", async t => {
  for (const status of [429, undefined]) {
    const f = await fixture(t); let count = 0;
    const service = new ScheduledModelCallService(f.db, f.settings, f.groups, async () => { count++; throw Object.assign(new Error("secret-key-upstream-body"), { status }); });
    await service.tick(new Date(f.task.nextRunAt));
    await service.tick(new Date(Date.parse(f.task.nextRunAt) + 150_000));
    assert.equal(count, 1);
    assert.equal(f.runs()[0].status, status ? "failed" : "unknown");
    assert.equal(f.repo.getScheduledReminder(f.task.id)?.lastRun?.status, status ? "failed" : "unknown");
    const text = (f.db.db.prepare("SELECT text FROM outbox").get() as { text: string }).text;
    assert.doesNotMatch(text, /secret-key|upstream-body/);
  }
});

test("missed slots notify without calling; disabled groups and tasks do not call or notify", async t => {
  const f = await fixture(t); let count = 0;
  const service = new ScheduledModelCallService(f.db, f.settings, f.groups, async () => { count++; return { model: "fixed-model" }; });
  await service.tick(new Date(Date.parse(f.task.nextRunAt) + 120_001));
  assert.equal(count, 0); assert.equal(f.runs()[0].status, "missed");
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n, 1);
  f.group.scheduledRemindersEnabled = false;
  f.repo.saveScheduledReminder({ ...f.task, id: "disabled-group" });
  f.repo.saveScheduledReminder({ ...f.task, id: "disabled-task", enabled: false });
  f.repo.saveScheduledReminder({ ...f.task, id: "other-group", groupId: "10002" });
  await service.tick(new Date(f.task.nextRunAt));
  assert.equal(count, 0); assert.equal(f.runs().length, 1);
});

test("notification enqueue failure rolls back and restart sends original result without another model request", async t => {
  const f = await fixture(t); let count = 0;
  const original = f.db.enqueueOutbox.bind(f.db);
  f.db.enqueueOutbox = () => { throw new Error("queue temporarily unavailable"); };
  const caller = async () => { count++; return { model: "fixed-model" }; };
  await assert.rejects(new ScheduledModelCallService(f.db, f.settings, f.groups, caller).tick(new Date(f.task.nextRunAt)));
  assert.equal(f.runs()[0].status, "succeeded");
  f.db.enqueueOutbox = original;
  await new ScheduledModelCallService(f.db, f.settings, f.groups, caller).tick(new Date(f.task.nextRunAt));
  await new ScheduledModelCallService(f.db, f.settings, f.groups, caller).tick(new Date(f.task.nextRunAt));
  assert.equal(count, 1);
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n, 1);
});

test("interrupted in-flight run becomes unknown after recovery and is not submitted again", async t => {
  const f = await fixture(t); let count = 0;
  const run = { taskId: f.task.id, groupId: f.task.groupId, scheduledAt: f.task.nextRunAt, startedAt: f.task.nextRunAt, modelId: "sol", status: "running" };
  f.repo.saveDocument("scheduled-model-call-run", `${f.task.id}:${f.task.nextRunAt}`, run);
  await new ScheduledModelCallService(f.db, f.settings, f.groups, async () => { count++; return { model: "wrong" }; }).tick(new Date(Date.parse(f.task.nextRunAt) + 91_000));
  assert.equal(count, 0); assert.equal(f.runs()[0].status, "unknown");
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n, 1);
});

test("model-call task metadata round trips and re-enable always calculates a future slot", async t => {
  const f = await fixture(t);
  const store = new ScheduledReminderStore(path.join(f.dir, "unused.json"), f.repo);
  const service = new ScheduledReminderService(store, {});
  const created = await service.createTask({ groupId: "10001", creatorUserId: "admin", request: { kind: "model_call", modelId: "sol", timezone: "Asia/Shanghai", scheduledTime: "11:00", intervalMinutes: 1440, topic: "调用" }, now: new Date("2026-10-31T03:00:01Z") });
  assert.equal(created.nextRunAt, "2026-11-01T03:00:00.000Z");
  assert.equal(created.kind, "model_call");
  await service.updateTask(created.id, { enabled: false });
  const before = Date.now();
  const enabled = await service.updateTask(created.id, { enabled: true, modelId: "sol" });
  assert.ok(Date.parse(enabled!.nextRunAt) > before);
  assert.equal(enabled?.timezone, "Asia/Shanghai");
  await assert.rejects(service.updateTask(created.id, { timezone: "UTC" }));
});

test("wire request uses only fixed model and bounded prompt with SDK retries disabled", async t => {
  let count = 0; const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    count++; let raw = ""; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw)); res.setHeader("content-type", "application/json");
    if (count === 1) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: "test failure" } })); }
    else res.end(JSON.stringify({ id: "test", model: "wire-model", choices: [{ message: { content: "OK" }, finish_reason: "stop", index: 0 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const model = { id: "sol", model: "wire-model", apiKey: "test-only", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` } as SystemModelConfig;
  await assert.rejects(callScheduledModelOnce(model, "10001"));
  assert.equal(count, 1);
  assert.equal((await callScheduledModelOnce(model, "10001")).model, "wire-model");
  assert.deepEqual(bodies[0], { model: "wire-model", messages: [{ role: "user", content: "仅回复 OK" }], max_completion_tokens: 128, stream: false });
});
