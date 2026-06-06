import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IterationFeedbackStore } from "./iteration-feedback-store.js";
import { IterationPlanStore } from "./iteration-plan-store.js";
import { SelfIterationService } from "./self-iteration-service.js";
import type { RuntimeAiService } from "./configured-ai-service.js";
import type { GroupConfigService } from "./group-config-service.js";
import type { GroupMemoryCandidateService } from "./group-memory-candidate-service.js";
import type { GroupMemoryStore } from "./group-memory-store.js";
import type { KnowledgeBaseStore } from "./knowledge-base-store.js";
import type { ModelHealthHistoryStore } from "./model-health-history-store.js";
import type { SkillService } from "./skill-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";
import type { GroupBotConfig, GroupMemoryCandidate, GroupMemoryType, KnowledgeBaseEntry, SkillDefinition, SystemSettings } from "../types.js";

test("SelfIterationService generates a fallback /goal plan and marks open feedback planned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "self-iteration-service-"));
  try {
    const feedbackStore = new IterationFeedbackStore(path.join(dir, "feedback.json"));
    const planStore = new IterationPlanStore(path.join(dir, "plans.json"));
    const feedback = await feedbackStore.create({
      groupId: "10001",
      operatorUserId: "20001",
      source: "qq_command",
      category: "behavior",
      content: "机器人回复太长，希望能形成优化计划",
    });

    const service = new SelfIterationService({
      feedbackStore,
      planStore,
      groupConfigService: {
        getAll: async () => [groupConfig()],
      } as unknown as GroupConfigService,
      groupMemoryStore: {} as unknown as GroupMemoryStore,
      groupMemoryCandidateService: {
        list: async () => [candidate()],
      } as unknown as GroupMemoryCandidateService,
      knowledgeBaseStore: {
        list: async () => [knowledge()],
      } as unknown as KnowledgeBaseStore,
      skillService: {
        getAllSkills: async () => [skill()],
      } as unknown as SkillService,
      systemSettingsStore: {
        get: async () => settings(),
      } as unknown as SystemSettingsStore,
      modelHealthHistoryStore: {
        list: async () => [{
          id: "reply",
          purpose: "reply",
          name: "Reply",
          shortName: "reply",
          selected: true,
          ok: false,
          detail: "timeout",
          model: "reply",
          baseUrl: "https://example.test/v1",
          checkedAt: "2026-06-01T00:00:00.000Z",
          latencyMs: 1000,
          cached: false,
          source: "manual",
        }],
      } as unknown as ModelHealthHistoryStore,
      summaryAiService: {
        generateReply: async () => {
          throw new Error("ai unavailable");
        },
      } as unknown as RuntimeAiService,
      listOperationLogs: async () => [{ timestamp: "2026-06-01T00:00:00.000Z", groupId: "10001", operatorUserId: "admin", action: "model_check", target: "reply", detail: "timeout" }],
    });

    const plan = await service.analyze({ operatorUserId: "admin", groupId: "10001" });

    assert.equal(plan.status, "draft");
    assert.equal(plan.generatedBy, "manual");
    assert.equal(plan.scope, "mixed");
    assert.match(plan.goalPrompt, /npm test/);
    assert.match(plan.goalPrompt, /\/opt\/ai-project/);
    assert.equal(plan.evidence.some((item) => item.type === "feedback" && item.entityId === feedback.id), true);
    assert.equal((await feedbackStore.get(feedback.id))?.status, "planned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function groupConfig(): GroupBotConfig {
  return {
    groupId: "10001",
    groupName: "Test Group",
    enabled: true,
    currentSkillId: "default",
    replyModelMode: "reply",
    allowedSkillIds: ["default"],
    switcherUserIds: [],
    liveChatUserIds: [],
    triggerKeywords: [],
  };
}

function candidate(): GroupMemoryCandidate {
  return {
    id: "c1",
    groupId: "10001",
    type: "group_fact" as GroupMemoryType,
    title: "Pending fact",
    content: "Pending memory",
    confidence: 0.9,
    source: "test",
    status: "pending",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function knowledge(): KnowledgeBaseEntry {
  return {
    id: "k1",
    groupId: "10001",
    title: "FAQ",
    question: "Q",
    answer: "A",
    keywords: ["faq"],
    enabled: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function skill(): SkillDefinition {
  return {
    id: "default",
    name: "Default",
    systemPrompt: "reply",
    styleRules: [],
    knowledge: [],
    temperature: 0.2,
    maxContextTurns: 3,
  };
}

function settings(): SystemSettings {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    profileSummaryMaxChars: 1200,
    profileShortSummaryMaxChars: 140,
    dailyProfileReviewEnabled: true,
    dailyProfileReviewTime: "09:00",
    memoryDedupEnabled: true,
    memoryDedupTime: "03:30",
    defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
    models: [{
      id: "reply",
      name: "Reply",
      shortName: "reply",
      baseUrl: "https://example.test/v1",
      model: "reply",
      purpose: "reply",
      enabled: true,
      hasApiKey: true,
      createdAt: now,
      updatedAt: now,
    }],
    selectedModelIds: { reply: "reply" },
    commands: [],
    updatedAt: now,
  };
}
