import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ScheduledReminderStore } from "./scheduled-reminder-store.js";

async function withStore<T>(run: (store: ScheduledReminderStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-reminder-store-"));
  try {
    return await run(new ScheduledReminderStore(path.join(dir, "store.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ScheduledReminderStore refreshes tasks after an external admin write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-reminder-refresh-"));
  const filePath = path.join(dir, "store.json");
  try {
    const workerStore = new ScheduledReminderStore(filePath);
    const adminStore = new ScheduledReminderStore(filePath);
    const first = await adminStore.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 60,
      topic: "第一条提醒",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });
    assert.equal((await workerStore.listGroupTasks("67890")).length, 1);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as { tasks: Record<string, unknown> };
    raw.tasks.external = {
      ...first,
      id: "external",
      topic: "后台新增提醒",
      createdAt: "2026-05-27T10:01:00.000Z",
      nextRunAt: "2026-05-27T11:01:00.000Z",
    };
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal((await workerStore.listGroupTasks("67890")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScheduledReminderStore creates, lists, deletes, and advances group tasks", async () => {
  await withStore(async (store) => {
    const now = new Date("2026-05-27T10:00:00.000Z");
    const task = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 60,
      topic: "喝水",
      now,
    });

    assert.equal(task.groupId, "67890");
    assert.equal(task.intervalMinutes, 60);
    assert.equal(task.nextRunAt, "2026-05-27T11:00:00.000Z");
    assert.deepEqual(await store.getDueTasks(new Date("2026-05-27T10:59:59.000Z")), []);
    assert.deepEqual((await store.getDueTasks(new Date("2026-05-27T11:00:00.000Z"))).map((item) => item.id), [task.id]);

    await store.markSent(task.id, "记得喝水", new Date("2026-05-27T11:00:00.000Z"));
    const [updated] = await store.listGroupTasks("67890");
    assert.equal(updated?.nextRunAt, "2026-05-27T12:00:00.000Z");
    assert.deepEqual(updated?.recentMessages, ["记得喝水"]);

    assert.equal(await store.removeGroupTask("67891", task.id), false);
    assert.equal(await store.removeGroupTask("67890", task.id), true);
    assert.deepEqual(await store.listGroupTasks("67890"), []);
  });
});

test("ScheduledReminderStore updates task interval, topic, and nextRunAt", async () => {
  await withStore(async (store) => {
    const task = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 60,
      topic: "喝水",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    const updated = await store.updateTask(task.id, {
      intervalMinutes: 30,
      topic: "站起来活动",
      nextRunAt: "2026-05-27T10:30:00.000Z",
    });

    assert.ok(updated);
    assert.equal(updated!.intervalMinutes, 30);
    assert.equal(updated!.topic, "站起来活动");
    assert.equal(updated!.nextRunAt, "2026-05-27T10:30:00.000Z");

    assert.equal(await store.updateTask("nonexistent", { intervalMinutes: 10 }), undefined);
  });
});

test("ScheduledReminderStore schedules fixed-time reminders with advance minutes and date rules", async () => {
  await withStore(async (store) => {
    const task = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 30,
      topic: "喝水提醒",
      scheduledTime: "10:00",
      advanceMinutes: 15,
      dateRule: "workday",
      now: new Date("2026-06-05T09:30:00"),
    });

    assert.equal(task.scheduledTime, "10:00");
    assert.equal(task.advanceMinutes, 15);
    assert.equal(task.nextRunAt, new Date("2026-06-05T09:45:00").toISOString());

    await store.markSent(task.id, "记得喝水", new Date("2026-06-05T09:45:00"));
    const [updated] = await store.listGroupTasks("67890");
    assert.equal(updated?.nextRunAt, new Date("2026-06-08T09:45:00").toISOString());
  });
});

test("ScheduledReminderStore uses smart workdays for fixed-time reminders", async () => {
  await withStore(async (store) => {
    const task = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 30,
      topic: "元旦后提醒",
      scheduledTime: "10:00",
      advanceMinutes: 15,
      dateRule: "workday",
      now: new Date("2026-01-01T09:30:00"),
    });

    assert.equal(task.nextRunAt, new Date("2026-01-04T09:45:00").toISOString());
  });
});

test("ScheduledReminderStore treats smart non-workday as workday complement", async () => {
  await withStore(async (store) => {
    const holidayTask = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 30,
      topic: "放假提醒",
      scheduledTime: "10:00",
      advanceMinutes: 15,
      dateRule: "holiday",
      now: new Date("2026-01-03T09:30:00"),
    });

    assert.equal(holidayTask.nextRunAt, new Date("2026-01-03T09:45:00").toISOString());

    const adjustedWorkdayTask = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 30,
      topic: "非工作日提醒",
      scheduledTime: "10:00",
      advanceMinutes: 15,
      dateRule: "holiday",
      now: new Date("2026-01-04T09:30:00"),
    });

    assert.equal(adjustedWorkdayTask.nextRunAt, new Date("2026-01-10T09:45:00").toISOString());
  });
});

test("ScheduledReminderStore updates fixed-time reminder schedule fields", async () => {
  await withStore(async (store) => {
    const task = await store.addTask({
      groupId: "67890",
      creatorUserId: "20001",
      intervalMinutes: 30,
      topic: "喝水提醒",
      scheduledTime: "10:00",
      advanceMinutes: 15,
      now: new Date("2026-06-05T09:30:00"),
    });

    const updated = await store.updateTask(task.id, {
      topic: "整理日报",
      scheduledTime: "17:45",
      advanceMinutes: 10,
      dateRule: "all",
      weekdays: [],
    });

    assert.ok(updated);
    assert.equal(updated!.topic, "整理日报");
    assert.equal(updated!.scheduledTime, "17:45");
    assert.equal(updated!.advanceMinutes, 10);
    assert.ok(new Date(updated!.nextRunAt).getTime() > Date.now());
  });
});
