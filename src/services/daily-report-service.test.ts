import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupBotConfig } from "../types.js";
import { DailyReportService } from "./daily-report-service.js";
import { DailyReportStore } from "./daily-report-store.js";

const baseGroupConfig: GroupBotConfig = {
  groupId: "67890",
  currentSkillId: "assistant",
  allowedSkillIds: ["assistant"],
  switcherUserIds: ["99999"],
  liveChatUserIds: [],
  liveChatDelayMinutes: 5,
  dailyReportEnabled: true,
  dailyReportTime: "17:59",
  dailyReportDateRule: "workday",
  dailyReportTopUserCount: 5,
  holidayCountdownEnabled: true,
  holidayCountdownTime: "09:00",
};

test("daily report scheduler only fires during the configured minute on weekdays", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-service-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateDailyReportInsights() {
          return null;
        },
        async generateChatPeriodSummary() {
          return null;
        },
        async generateBroadcastQuip() {
          return "摸完这一会儿，人生都通透了";
        },
      } as never,
    );

    assert.equal(
      await service.shouldSendScheduledReport(
        baseGroupConfig,
        new Date("2026-04-15T17:59:10"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        baseGroupConfig,
        new Date("2026-04-15T18:00:00"),
      ),
      false,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        baseGroupConfig,
        new Date("2026-04-18T17:59:00"),
      ),
      false,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daily report scheduler follows configured date rules", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-date-rule-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateChatPeriodSummary() {
          return null;
        },
        async generateBroadcastQuip() {
          return "unused";
        },
      } as never,
    );

    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "all", dailyReportDateRule: "all" },
        new Date("2026-04-18T17:59:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "custom-ok", dailyReportDateRule: "custom", dailyReportWeekdays: [6] },
        new Date("2026-04-18T17:59:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "custom-skip", dailyReportDateRule: "custom", dailyReportWeekdays: [1] },
        new Date("2026-04-18T17:59:00"),
      ),
      false,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "smart-workday-skip", dailyReportDateRule: "workday" },
        new Date("2026-01-01T17:59:00"),
      ),
      false,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "smart-workday-adjusted", dailyReportDateRule: "workday" },
        new Date("2026-01-04T17:59:00"),
      ),
      true,
    );
    assert.equal(
      await service.shouldSendScheduledReport(
        { ...baseGroupConfig, groupId: "smart-holiday-adjusted-skip", dailyReportDateRule: "holiday" },
        new Date("2026-01-04T17:59:00"),
      ),
      false,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daily report layout is concise and includes model-generated after-work quip", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-layout-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "打卡不是加班许可证，赶紧撤";
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "大家早啊",
      timestamp: "2026-04-15T05:12:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "今天我来收个尾，先下了",
      timestamp: "2026-04-15T17:45:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "中午这个话题我接一下",
      timestamp: "2026-04-15T12:30:00",
    });

    const report = await service.buildReport(
      baseGroupConfig,
      new Date("2026-04-15T17:59:00"),
    );

    assert.match(report, /^2026年04月15日 17:59 星期三 下午好，摸鱼人/m);
    assert.match(report, /^下班了，该回家了，别磨磨叽叽的，打卡不是加班许可证，赶紧撤/m);
    assert.match(report, /今日消息 3 条/);
    assert.match(report, /活跃人数 2 人/);
    assert.match(report, /最热时段/);
    assert.match(report, /发言 TOP5/);
    assert.match(report, /1\. 老张 2 条/);
    assert.doesNotMatch(report, /今日最高光/);
    assert.doesNotMatch(report, /晨间开场/);
    assert.doesNotMatch(report, /白天收尾/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("builds named-period chat summary from stored messages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary(args: {
          totalMessages: number;
          participantCount: number;
          periodLabel: string;
          sampleMessages: Array<{ text: string }>;
        }) {
          assert.equal(args.periodLabel, "上午");
          assert.equal(args.totalMessages, 2);
          assert.equal(args.participantCount, 2);
          assert.equal(args.sampleMessages.length, 2);
          assert.equal(args.sampleMessages[0]?.text, "早会先过一下需求");
          assert.equal(args.sampleMessages[1]?.text, "行，我补一下接口文档");
          return "上午聊天总结\n主要在聊：需求和接口文档\n比较活跃：小王、老张\n整体感觉：推进项目为主";
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "早会先过一下需求",
      timestamp: "2026-04-15T09:12:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "行，我补一下接口文档",
      timestamp: "2026-04-15T10:03:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u3",
      userName: "阿强",
      text: "晚上去吃什么",
      timestamp: "2026-04-15T19:30:00",
    });

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "上午",
        startMinute: 6 * 60,
        endMinute: 11 * 60 + 59,
        mode: "named_period",
      },
      now: new Date("2026-04-15T20:00:00"),
    });

    assert.match(summary, /上午聊天总结/);
    assert.doesNotMatch(summary, /晚上去吃什么/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("returns friendly text when requested range has no messages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-empty-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary() {
          return null;
        },
      } as never,
    );

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "下午",
        startMinute: 14 * 60,
        endMinute: 17 * 60 + 59,
        mode: "named_period",
      },
      now: new Date("2026-04-15T18:00:00"),
    });

    assert.equal(summary, "下午这段时间没有可总结的聊天记录");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fallback summary still points out concrete topics when ai summary is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-fallback-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary() {
          return null;
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "早会先过一下需求，下午再补接口文档",
      timestamp: "2026-04-15T09:12:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "行，我顺手把回滚方案也整理一下",
      timestamp: "2026-04-15T09:20:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u3",
      userName: "阿强",
      text: "接口文档晚点我来对一下字段",
      timestamp: "2026-04-15T09:28:00",
    });

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "上午",
        startMinute: 6 * 60,
        endMinute: 11 * 60 + 59,
        mode: "named_period",
      },
      now: new Date("2026-04-15T12:00:00"),
    });

    assert.match(summary, /上午聊天总结/);
    assert.match(summary, /主要在聊：/);
    assert.match(summary, /(需求|接口文档|回滚方案)/);
    assert.match(summary, /典型内容：/);
    assert.doesNotMatch(summary, /这段时间共 3 条消息/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("uses previous day records when request targets yesterday", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-yesterday-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary(args: {
          dateLabel: string;
          periodLabel: string;
          totalMessages: number;
          sampleMessages: Array<{ text: string }>;
        }) {
          assert.equal(args.dateLabel, "2026-04-14");
          assert.equal(args.periodLabel, "昨晚");
          assert.equal(args.totalMessages, 1);
          assert.equal(args.sampleMessages[0]?.text, "昨晚在聊发布版本");
          return "昨晚聊天总结\n主要在聊：发布版本\n比较活跃：小王\n整体感觉：节奏还挺赶";
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "昨晚在聊发布版本",
      timestamp: "2026-04-14T21:05:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "今天上午聊接口联调",
      timestamp: "2026-04-15T10:05:00",
    });

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "昨晚",
        startMinute: 18 * 60,
        endMinute: 23 * 60 + 59,
        mode: "named_period",
        dayOffset: -1,
      },
      now: new Date("2026-04-15T20:00:00"),
    });

    assert.match(summary, /昨晚聊天总结/);
    assert.doesNotMatch(summary, /接口联调/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("collects cross-day records for fixed range windows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-fixed-cross-day-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary(args: {
          totalMessages: number;
          sampleMessages: Array<{ text: string }>;
        }) {
          assert.equal(args.totalMessages, 2);
          assert.equal(args.sampleMessages[0]?.text, "昨晚继续聊发布");
          assert.equal(args.sampleMessages[1]?.text, "今天上午聊回滚方案");
          return "昨晚到今天上午聊天总结\n主要在聊：发布和回滚\n比较活跃：小王、老张\n整体感觉：事情还没收口";
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "昨晚继续聊发布",
      timestamp: "2026-04-14T22:30:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "今天上午聊回滚方案",
      timestamp: "2026-04-15T10:30:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u3",
      userName: "阿强",
      text: "今天下午闲聊",
      timestamp: "2026-04-15T15:10:00",
    });

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "昨天18:00到今天11:59",
        startMinute: 18 * 60,
        endMinute: 11 * 60 + 59,
        mode: "custom_range",
        dayOffset: -1,
        startDayOffset: -1,
        endDayOffset: 0,
      },
      now: new Date("2026-04-15T20:00:00"),
    });

    assert.match(summary, /昨晚到今天上午聊天总结/);
    assert.doesNotMatch(summary, /今天下午闲聊/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("collects cross-day records for relative summary windows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "daily-report-chat-summary-relative-test-"));
  const storePath = path.join(tempDir, "daily-report-store.json");

  try {
    const service = new DailyReportService(
      new DailyReportStore(storePath),
      {
        async generateBroadcastQuip() {
          return "unused";
        },
        async generateChatPeriodSummary(args: {
          totalMessages: number;
          sampleMessages: Array<{ text: string }>;
        }) {
          assert.equal(args.totalMessages, 2);
          assert.equal(args.sampleMessages[0]?.text, "昨晚收尾");
          assert.equal(args.sampleMessages[1]?.text, "今天凌晨继续");
          return "最近半小时聊天总结\n主要在聊：收尾和继续处理\n比较活跃：小王、老张\n整体感觉：跨天还在接着聊";
        },
      } as never,
    );

    await service.recordMessage({
      groupId: "67890",
      userId: "u1",
      userName: "小王",
      text: "昨晚收尾",
      timestamp: "2026-04-14T23:55:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u2",
      userName: "老张",
      text: "今天凌晨继续",
      timestamp: "2026-04-15T00:10:00",
    });
    await service.recordMessage({
      groupId: "67890",
      userId: "u3",
      userName: "阿强",
      text: "太早了先不聊",
      timestamp: "2026-04-14T22:10:00",
    });

    const summary = await service.buildChatSummary({
      groupId: "67890",
      request: {
        label: "最近半小时",
        startMinute: 0,
        endMinute: 0,
        mode: "relative_window",
        dayOffset: 0,
        relativeDurationMinutes: 30,
      },
      now: new Date("2026-04-15T00:20:00"),
    });

    assert.match(summary, /最近半小时聊天总结/);
    assert.doesNotMatch(summary, /太早了先不聊/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
