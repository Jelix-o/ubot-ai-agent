import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupBotConfig } from "../types.js";
import { HolidayCountdownService } from "./holiday-countdown-service.js";
import { HolidayCountdownStore } from "./holiday-countdown-store.js";

const baseGroupConfig: GroupBotConfig = {
  groupId: "67890",
  currentSkillId: "assistant",
  allowedSkillIds: ["assistant"],
  switcherUserIds: ["99999"],
  liveChatUserIds: [],
  liveChatDelayMinutes: 5,
  dailyReportEnabled: true,
  dailyReportTime: "18:00",
  dailyReportTopUserCount: 3,
  holidayCountdownEnabled: true,
  holidayCountdownTime: "09:00",
  holidayCountdownDateRule: "workday",
};

test("holiday countdown scheduler only fires during the configured minute", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holiday-countdown-service-test-"));
  const storePath = path.join(tempDir, "holiday-countdown-store.json");

  try {
    const service = new HolidayCountdownService(
      new HolidayCountdownStore(storePath),
      {
        async generateBroadcastQuip() {
          return "会议先挂着，灵魂先喘口气";
        },
      } as never,
    );

    assert.equal(
      await service.shouldSendScheduledMessage(
        baseGroupConfig,
        new Date("2026-04-15T09:00:20"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        baseGroupConfig,
        new Date("2026-04-15T09:01:00"),
      ),
      false,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("holiday countdown uses compact workday format with model-generated quip", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holiday-countdown-message-test-"));
  const storePath = path.join(tempDir, "holiday-countdown-store.json");

  try {
    const service = new HolidayCountdownService(
      new HolidayCountdownStore(storePath),
      {
        async generateBroadcastQuip() {
          return "老板盯绩效，你盯周六";
        },
      } as never,
    );
    const message = await service.buildCountdownMessage(new Date("2026-04-15T09:00:00"));

    assert.match(message, /^2026年04月15日 09:00 星期三 早上好，摸鱼人/m);
    assert.match(message, /^上班了，该摸鱼了，老板盯绩效，你盯周六/m);
    assert.match(message, /距『周六』还有3天/);
    assert.match(message, /距『劳动节』还有16天/);
    assert.doesNotMatch(message, /节假日倒计时/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("holiday countdown scheduler skips weekends", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holiday-countdown-skip-weekend-test-"));
  const storePath = path.join(tempDir, "holiday-countdown-store.json");

  try {
    const service = new HolidayCountdownService(
      new HolidayCountdownStore(storePath),
      {
        async generateBroadcastQuip() {
          return "周末就别演了";
        },
      } as never,
    );

    assert.equal(
      await service.shouldSendScheduledMessage(
        baseGroupConfig,
        new Date("2026-04-18T09:00:00"),
      ),
      false,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("holiday countdown scheduler follows configured date rules", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holiday-countdown-date-rule-test-"));
  const storePath = path.join(tempDir, "holiday-countdown-store.json");

  try {
    const service = new HolidayCountdownService(
      new HolidayCountdownStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
      } as never,
    );

    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "all", holidayCountdownDateRule: "all" },
        new Date("2026-04-18T09:00:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "custom-ok", holidayCountdownDateRule: "custom", holidayCountdownWeekdays: [6] },
        new Date("2026-04-18T09:00:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "custom-skip", holidayCountdownDateRule: "custom", holidayCountdownWeekdays: [1] },
        new Date("2026-04-18T09:00:00"),
      ),
      false,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "smart-workday-skip", holidayCountdownDateRule: "workday" },
        new Date("2026-01-01T09:00:00"),
      ),
      false,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "smart-workday-adjusted", holidayCountdownDateRule: "workday" },
        new Date("2026-01-04T09:00:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledMessage(
        { ...baseGroupConfig, groupId: "smart-holiday-adjusted-skip", holidayCountdownDateRule: "holiday" },
        new Date("2026-01-04T09:00:00"),
      ),
      false,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
