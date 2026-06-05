import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ScheduledReminderService, formatIntervalLabel, isWithinWorkHours, adjustToWorkHours } from "./scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./scheduled-reminder-store.js";

class FakeAiService {
  calls: Array<{ topic: string; intervalMinutes: number; recentMessages?: string[] }> = [];

  constructor(private readonly response: string | null = "群友们，水杯拿起来") {}

  async generateScheduledReminderText(args: {
    topic: string;
    intervalMinutes: number;
    recentMessages?: string[];
  }): Promise<string | null> {
    this.calls.push(args);
    return this.response;
  }
}

async function withService<T>(
  aiService: FakeAiService,
  run: (service: ScheduledReminderService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-reminder-service-"));
  try {
    return await run(new ScheduledReminderService(new ScheduledReminderStore(path.join(dir, "store.json")), aiService as never));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ScheduledReminderService parses natural reminder creation requests", () => {
  const service = new ScheduledReminderService({} as never, {} as never);

  assert.deepEqual(service.parseCreateRequest("设置定时任务一个小时提醒群友喝水"), {
    intervalMinutes: 60,
    topic: "喝水",
  });
  assert.deepEqual(service.parseCreateRequest("添加定时任务每30分钟提醒大家站起来活动"), {
    intervalMinutes: 30,
    topic: "站起来活动",
  });
  assert.deepEqual(service.parseCreateRequest("定时任务 添加 每小时提醒群友喝水"), {
    intervalMinutes: 60,
    topic: "喝水",
  });
});

test("ScheduledReminderService generates varied reminder text and falls back locally", async () => {
  const aiService = new FakeAiService("换个姿势提醒：喝水");
  await withService(aiService, async (service) => {
    const task = await service.createTask({
      groupId: "67890",
      creatorUserId: "20001",
      request: { intervalMinutes: 60, topic: "喝水" },
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    const text = await service.buildReminderMessage(task);
    assert.equal(text, "【提醒喝水小助手】换个姿势提醒：喝水");
    assert.equal(aiService.calls[0]?.topic, "喝水");
  });

  await withService(new FakeAiService(null), async (service) => {
    const task = await service.createTask({
      groupId: "67890",
      creatorUserId: "20001",
      request: { intervalMinutes: 60, topic: "喝水" },
      now: new Date("2026-05-27T10:00:00.000Z"),
    });
    const text = await service.buildReminderMessage(task);
    assert.match(text, /^【提醒喝水小助手】/);
    assert.match(text, /喝水/);
  });
});

test("ScheduledReminderService strips duplicated reminder prefixes from ai text", async () => {
  const cases = [
    {
      response: "【提醒喝水小助手】大家手边有水的话喝几口",
      expected: "【提醒喝水小助手】大家手边有水的话喝几口",
    },
    {
      response: "【提醒喝水小助手】【提醒喝水小助手】大家手边有水的话喝几口",
      expected: "【提醒喝水小助手】大家手边有水的话喝几口",
    },
    {
      response: "大家手边有水的话喝几口",
      expected: "【提醒喝水小助手】大家手边有水的话喝几口",
    },
  ];

  for (const item of cases) {
    await withService(new FakeAiService(item.response), async (service) => {
      const task = await service.createTask({
        groupId: "67890",
        creatorUserId: "20001",
        request: { intervalMinutes: 60, topic: "喝水" },
        now: new Date("2026-05-27T10:00:00.000Z"),
      });

      assert.equal(await service.buildReminderMessage(task), item.expected);
    });
  }
});

test("ScheduledReminderService sends prefix-free recent message bodies to ai", async () => {
  const aiService = new FakeAiService("大家记得喝水");
  await withService(aiService, async (service) => {
    const task = await service.createTask({
      groupId: "67890",
      creatorUserId: "20001",
      request: { intervalMinutes: 60, topic: "喝水" },
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    await service.markSent(task.id, "【提醒喝水小助手】到点了，群友们记得喝水", new Date("2026-05-27T10:00:00.000Z"));
    await service.markSent(task.id, "【提醒喝水小助手】【提醒喝水小助手】大家手边有水的话喝几口", new Date("2026-05-27T11:00:00.000Z"));
    const updated = (await service.listGroupTasks("67890"))[0]!;

    await service.buildReminderMessage(updated);

    assert.deepEqual(aiService.calls[0]?.recentMessages, [
      "到点了，群友们记得喝水",
      "大家手边有水的话喝几口",
    ]);
  });
});

test("formatIntervalLabel formats hours and minutes", () => {
  assert.equal(formatIntervalLabel(60), "1 小时");
  assert.equal(formatIntervalLabel(120), "2 小时");
  assert.equal(formatIntervalLabel(30), "30 分钟");
});

test("isWithinWorkHours returns true for weekday work hours", () => {
  // Wednesday 10:00
  assert.equal(isWithinWorkHours(new Date("2026-05-27T10:00:00")), true);
  // Wednesday 09:00 (boundary)
  assert.equal(isWithinWorkHours(new Date("2026-05-27T09:00:00")), true);
  // Wednesday 17:59 (just before end)
  assert.equal(isWithinWorkHours(new Date("2026-05-27T17:59:00")), true);
});

test("isWithinWorkHours returns false outside work hours", () => {
  // Wednesday 08:59
  assert.equal(isWithinWorkHours(new Date("2026-05-27T08:59:00")), false);
  // Wednesday 18:00
  assert.equal(isWithinWorkHours(new Date("2026-05-27T18:00:00")), false);
  // Saturday
  assert.equal(isWithinWorkHours(new Date("2026-05-30T10:00:00")), false);
  // Sunday
  assert.equal(isWithinWorkHours(new Date("2026-05-31T10:00:00")), false);
  // Statutory holiday
  assert.equal(isWithinWorkHours(new Date("2026-01-01T10:00:00")), false);
});

test("adjustToWorkHours returns same time if within work hours", () => {
  const d = new Date("2026-05-27T10:30:00");
  assert.equal(adjustToWorkHours(d).getTime(), d.getTime());
});

test("adjustToWorkHours moves early morning to same day 9:00", () => {
  const d = new Date("2026-05-27T08:00:00");
  const result = adjustToWorkHours(d);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getMinutes(), 0);
  assert.equal(result.getDate(), 27);
});

test("adjustToWorkHours moves evening to next workday 9:00", () => {
  // Wednesday 19:00 -> Thursday 9:00
  const d = new Date("2026-05-27T19:00:00");
  const result = adjustToWorkHours(d);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getDate(), 28);
});

test("adjustToWorkHours moves weekend to Monday 9:00", () => {
  // Saturday -> Monday
  const d = new Date("2026-05-30T10:00:00");
  const result = adjustToWorkHours(d);
  assert.equal(result.getDay(), 1);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getDate(), 1); // June 1
});

test("adjustToWorkHours respects statutory holidays and adjusted workdays", () => {
  const holiday = adjustToWorkHours(new Date("2026-01-01T10:00:00"));
  assert.equal(holiday.getDay(), 0);
  assert.equal(holiday.getHours(), 9);
  assert.equal(holiday.getDate(), 4);

  const adjustedWorkday = new Date("2026-01-04T10:00:00");
  assert.equal(isWithinWorkHours(adjustedWorkday), true);
  assert.equal(adjustToWorkHours(adjustedWorkday).getTime(), adjustedWorkday.getTime());
});

test("adjustToWorkHours moves Friday evening to Monday 9:00", () => {
  // Friday 19:00 -> Monday 9:00
  const d = new Date("2026-05-29T19:00:00");
  const result = adjustToWorkHours(d);
  assert.equal(result.getDay(), 1);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getDate(), 1); // June 1
});

test("parseModifyRequest parses task ID and interval", () => {
  const service = new ScheduledReminderService({} as never, {} as never);

  assert.deepEqual(service.parseModifyRequest("rem-20260527103000 每30分钟提醒群友喝水"), {
    taskId: "rem-20260527103000",
    request: { intervalMinutes: 30, topic: "喝水" },
  });

  assert.deepEqual(service.parseModifyRequest("rem-20260527103000 每小时提醒大家站起来活动"), {
    taskId: "rem-20260527103000",
    request: { intervalMinutes: 60, topic: "站起来活动" },
  });

  assert.equal(service.parseModifyRequest("invalid"), undefined);
  assert.equal(service.parseModifyRequest("rem-123"), undefined);
});

test("ScheduledReminderService markSent adjusts nextRunAt to work hours", async () => {
  await withService(new FakeAiService("test"), async (service) => {
    const task = await service.createTask({
      groupId: "67890",
      creatorUserId: "20001",
      request: { intervalMinutes: 120, topic: "喝水" },
      now: new Date("2026-05-27T16:30:00"), // Wednesday 16:30
    });

    await service.markSent(task.id, "记得喝水", new Date("2026-05-27T16:30:00"));
    const tasks = await service.listGroupTasks("67890");
    const updated = tasks.find((t) => t.id === task.id);
    assert.ok(updated);
    // 16:30 + 2h = 18:30 -> outside work hours -> next day 9:00
    const nextRun = new Date(updated!.nextRunAt);
    assert.equal(nextRun.getHours(), 9);
    assert.equal(nextRun.getDate(), 28); // Thursday
  });
});

test("ScheduledReminderService updateTask adjusts nextRunAt to work hours", async () => {
  await withService(new FakeAiService("test"), async (service) => {
    const task = await service.createTask({
      groupId: "67890",
      creatorUserId: "20001",
      request: { intervalMinutes: 60, topic: "喝水" },
      now: new Date("2026-05-27T10:00:00"),
    });

    // Update interval to 120 minutes at 17:30 -> nextRun 19:30 -> adjust to next day 9:00
    const updated = await service.updateTask(task.id, {
      intervalMinutes: 120,
      topic: "站起来活动",
    });
    assert.ok(updated);
    assert.equal(updated!.intervalMinutes, 120);
    assert.equal(updated!.topic, "站起来活动");
  });
});
