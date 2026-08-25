import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupBotConfig } from "../types.js";
import { DailyProfileReviewService, getYesterdayDateKey } from "./daily-profile-review-service.js";
import { GroupMemoryStore } from "./group-memory-store.js";

const groupConfig: GroupBotConfig = {
  groupId: "67890",
  currentSkillId: "assistant",
  allowedSkillIds: ["assistant"],
  switcherUserIds: ["99999"],
  liveChatUserIds: [],
  manualIdentities: [
    {
      userIds: ["20001"],
      names: ["Tester"],
      note: "测试同学",
    },
  ],
};

class FakeProfileAi {
  dailyCalls: Array<{ groupId: string; userId: string; dateKey: string; memories: Array<{ title: string; content: string }> }> = [];
  overallCalls: Array<{ groupId: string; userId: string; memories: Array<{ title: string; content: string }> }> = [];

  async summarizeDailyMemberProfile(args: {
    groupId: string;
    userId: string;
    dateKey: string;
    memories: Array<{ title: string; content: string }>;
  }): Promise<string> {
    this.dailyCalls.push(args);
    return `${args.userId} 昨日新增画像总结`;
  }

  async summarizeOverallMemberProfile(args: {
    groupId: string;
    userId: string;
    memories: Array<{ title: string; content: string }>;
  }): Promise<string> {
    this.overallCalls.push(args);
    return `${args.userId} 整体画像总结`;
  }
}

test("daily profile review refreshes reviewed-date state after an external update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-profile-review-refresh-"));
  const filePath = path.join(dir, "review.json");
  try {
    const memories = new GroupMemoryStore(path.join(dir, "memory.json"));
    const ai = new FakeProfileAi();
    const reader = new DailyProfileReviewService(filePath, memories, ai);
    const writer = new DailyProfileReviewService(filePath, memories, ai);
    assert.equal(await reader.shouldRunGroupReview("67890", "2026-08-23"), true);

    await writer.reviewGroup({ groupConfig, dateKey: "2026-08-23" });
    const raw = JSON.parse(await readFile(filePath, "utf8")) as { reviewedDatesByGroup: Record<string, string[]> };
    raw.reviewedDatesByGroup["67890"] = ["2026-08-23"];
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal(await reader.shouldRunGroupReview("67890", "2026-08-23"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daily profile review summarizes only yesterday's new member profile memories once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-profile-review-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const ai = new FakeProfileAi();
    const service = new DailyProfileReviewService(path.join(dir, "review.json"), memoryStore, ai);

    const yesterday = "2026-06-01";
    const included = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "偏好",
      content: "Tester 喜欢直接给结论。",
      source: "auto",
      confidence: 0.8,
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const groupFact = await memoryStore.create({
      groupId: "67890",
      type: "group_fact",
      title: "群事实",
      content: "群里周五复盘。",
      source: "auto",
      createdAt: "2026-06-01T11:00:00.000Z",
    });
    const reviewMemory = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20002",
      title: "旧总结",
      content: "不要再次总结。",
      source: "daily_profile_review:2026-06-01",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    const result = await service.reviewGroup({ groupConfig, dateKey: yesterday });
    assert.equal(result.createdCount, 1);
    assert.equal(ai.dailyCalls.length, 1);
    assert.equal(ai.dailyCalls[0]?.userId, "20001");

    const memories = await memoryStore.list("67890");
    assert.equal(memories.some((memory) =>
      memory.subjectUserId === "20001" &&
      memory.source === "daily_profile_review:2026-06-01" &&
      memory.title === "2026-06-01 昨日画像总结"
    ), true);

    const repeated = await service.reviewGroup({ groupConfig, dateKey: yesterday });
    assert.equal(repeated.createdCount, 0);
    assert.equal(ai.dailyCalls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daily profile review can create yesterday summary on demand and summarize overall profile", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-profile-command-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const ai = new FakeProfileAi();
    const service = new DailyProfileReviewService(path.join(dir, "review.json"), memoryStore, ai);
    const yesterday = getYesterdayDateKey(new Date("2026-06-02T00:05:00+08:00"));

    const memory = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "偏好",
      content: "Tester 喜欢直接给结论。",
      source: "auto",
      createdAt: `${yesterday}T09:00:00.000Z`,
    });
    const generatedSummary = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "历史昨日画像总结",
      content: "这是一条已经生成过的画像总结，不应该再作为整体画像的来源记忆。",
      source: "daily_profile_review:2026-05-31",
      createdAt: `${yesterday}T10:00:00.000Z`,
    });
    const generatedRecordMemory = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "群聊画像总结",
      content: "画像记录同步记忆，不应该作为下一次画像总结来源。",
      source: "profile_record:record-1",
      createdAt: `${yesterday}T11:00:00.000Z`,
    });

    const daily = await service.getOrCreateYesterdaySummary({
      groupConfig,
      userId: "20001",
      dateKey: yesterday,
    });
    assert.equal(daily?.content, "20001 昨日新增画像总结");

    const dailyDetail = await service.getYesterdaySummaryDetail({
      groupConfig,
      userId: "20001",
      dateKey: yesterday,
    });
    assert.equal(dailyDetail?.summary, "20001 昨日新增画像总结");
    assert.equal(dailyDetail?.memoryCount, 1);
    assert.equal(typeof dailyDetail?.generatedAt, "string");
    assert.deepEqual(ai.dailyCalls[0]?.memories.map((item) => item.title), ["偏好"]);

    const overall = await service.summarizeOverallProfile({
      groupConfig,
      userId: "20001",
    });
    assert.equal(overall, "20001 整体画像总结");
    assert.equal(ai.overallCalls.length, 1);
    assert.deepEqual(ai.overallCalls[0]?.memories.map((item) => item.title), ["偏好"]);

    const overallDetail = await service.summarizeOverallProfileDetail({
      groupConfig,
      userId: "20001",
    });
    assert.equal(overallDetail?.summary, "20001 整体画像总结");
    assert.equal(overallDetail?.memoryCount, 1);
    assert.equal(overallDetail?.cached, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daily profile review does not surface or generate profiles for members with memory disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-profile-review-memory-disabled-"));
  try {
    const memoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
    const ai = new FakeProfileAi();
    const service = new DailyProfileReviewService(path.join(dir, "review.json"), memoryStore, ai);
    const dateKey = "2026-06-01";
    const disabledGroupConfig: GroupBotConfig = {
      ...groupConfig,
      memoryDisabledUserIds: ["20001"],
    };

    await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "已退出成员的原始画像",
      content: "不应再用于生成或展示。",
      source: "auto",
      createdAt: `${dateKey}T09:00:00.000Z`,
    });
    const existingDisabledSummary = await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: `${dateKey} 昨日画像总结`,
      content: "历史摘要应保留在存储中，但不可再展示。",
      source: `daily_profile_review:${dateKey}`,
      createdAt: `${dateKey}T10:00:00.000Z`,
    });
    await memoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20002",
      title: "未退出成员的原始画像",
      content: "应该正常生成每日摘要。",
      source: "auto",
      createdAt: `${dateKey}T11:00:00.000Z`,
    });

    const review = await service.reviewGroup({ groupConfig: disabledGroupConfig, dateKey });
    assert.equal(review.createdCount, 1);
    assert.deepEqual(review.createdSummaries.map((memory) => memory.subjectUserId), ["20002"]);
    assert.deepEqual(ai.dailyCalls.map((call) => call.userId), ["20002"]);

    assert.equal(await service.getOrCreateYesterdaySummary({
      groupConfig: disabledGroupConfig,
      userId: "20001",
      dateKey,
    }), undefined);
    assert.equal(await service.getYesterdaySummaryDetail({
      groupConfig: disabledGroupConfig,
      userId: "20001",
      dateKey,
    }), null);
    assert.equal(await service.summarizeOverallProfile({
      groupConfig: disabledGroupConfig,
      userId: "20001",
    }), null);
    assert.equal(await service.summarizeOverallProfileDetail({
      groupConfig: disabledGroupConfig,
      userId: "20001",
    }), null);
    assert.equal(ai.overallCalls.length, 0);

    const allMemories = await memoryStore.list("67890");
    assert.equal(allMemories.some((memory) => memory.id === existingDisabledSummary.id), true);
    assert.equal(allMemories.filter((memory) =>
      memory.subjectUserId === "20001" && memory.source === `daily_profile_review:${dateKey}`
    ).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
