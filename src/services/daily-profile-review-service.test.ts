import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
