import assert from "node:assert/strict";
import test from "node:test";

import { MaintenanceScheduler } from "./maintenance-scheduler.js";

test("maintenance scheduler runs each due job in declaration order at its own cadence", async () => {
  const calls: string[] = [];
  const scheduler = new MaintenanceScheduler({
    jobs: [
      { id: "live-chat", intervalMs: 15, run: async () => { calls.push("live-chat"); } },
      { id: "daily-report", intervalMs: 30, run: async () => { calls.push("daily-report"); } },
      { id: "cleanup", intervalMs: 60, run: async () => { calls.push("cleanup"); } },
    ],
  });

  await scheduler.runDueJobs(100);
  await scheduler.runDueJobs(114);
  await scheduler.runDueJobs(115);
  await scheduler.runDueJobs(130);
  await scheduler.runDueJobs(160);

  assert.deepEqual(calls, [
    "live-chat", "daily-report", "cleanup",
    "live-chat",
    "live-chat", "daily-report",
    "live-chat", "daily-report", "cleanup",
  ]);
});

test("maintenance scheduler skips overlapping polls and resumes once the current run completes", async () => {
  let releaseFirstJob: (() => void) | undefined;
  const firstJobStarted = new Promise<void>((resolve) => {
    releaseFirstJob = resolve;
  });
  const calls: string[] = [];
  const scheduler = new MaintenanceScheduler({
    jobs: [{
      id: "slow-job",
      intervalMs: 1,
      run: async () => {
        calls.push("start");
        await firstJobStarted;
        calls.push("finish");
      },
    }],
  });

  const first = scheduler.runDueJobs(100);
  await Promise.resolve();
  await scheduler.runDueJobs(101);
  assert.deepEqual(calls, ["start"]);

  releaseFirstJob?.();
  await first;
  await scheduler.runDueJobs(101);

  assert.deepEqual(calls, ["start", "finish", "start", "finish"]);
});

test("maintenance scheduler preserves failed-job backoff and defers later jobs to the next due poll", async () => {
  const calls: string[] = [];
  let fail = true;
  const scheduler = new MaintenanceScheduler({
    jobs: [
      {
        id: "failing",
        intervalMs: 10,
        run: async () => {
          calls.push("failing");
          if (fail) throw new Error("expected");
        },
      },
      { id: "later", intervalMs: 10, run: async () => { calls.push("later"); } },
    ],
  });

  await assert.rejects(scheduler.runDueJobs(100), /expected/);
  fail = false;
  await scheduler.runDueJobs(105);
  await scheduler.runDueJobs(110);

  assert.deepEqual(calls, ["failing", "later", "failing"]);
});

test("maintenance scheduler owns an unrefed timer with idempotent lifecycle", () => {
  let handler: (() => void) | undefined;
  let setCalls = 0;
  let clearCalls = 0;
  let unrefCalls = 0;
  const timer = { unref: () => { unrefCalls += 1; } } as unknown as NodeJS.Timeout;
  const scheduler = new MaintenanceScheduler({
    jobs: [],
    setInterval: (nextHandler) => {
      setCalls += 1;
      handler = nextHandler;
      return timer;
    },
    clearInterval: (received) => {
      assert.equal(received, timer);
      clearCalls += 1;
    },
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(setCalls, 1);
  assert.equal(unrefCalls, 1);
  assert.equal(typeof handler, "function");

  scheduler.stop();
  scheduler.stop();
  assert.equal(clearCalls, 1);
  assert.equal(scheduler.start(), true);
});
