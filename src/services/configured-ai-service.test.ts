import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AiHealthStatus, AiReply, SkillDefinition, SystemModelConfig } from "../types.js";
import { ConfiguredAiService, type RuntimeAiService } from "./configured-ai-service.js";
import { SystemSettingsStore } from "./system-settings-store.js";

class FakeRuntimeAiService implements RuntimeAiService {
  healthCalls = 0;
  replyCalls = 0;
  extractionCalls = 0;
  dedupCalls = 0;
  summaryCalls = 0;

  constructor(
    private readonly health: AiHealthStatus,
    private readonly reply?: AiReply,
  ) {}

  async checkHealth(): Promise<AiHealthStatus> {
    this.healthCalls += 1;
    return this.health;
  }

  async generateReply(): ReturnType<RuntimeAiService["generateReply"]> {
    this.replyCalls += 1;
    if (!this.reply) {
      throw new Error("not implemented");
    }
    return this.reply;
  }

  async evaluateReplyDesire(): ReturnType<RuntimeAiService["evaluateReplyDesire"]> {
    throw new Error("not implemented");
  }

  async evaluateControlledMention(): ReturnType<RuntimeAiService["evaluateControlledMention"]> {
    throw new Error("not implemented");
  }

  async extractGroupMemoryCandidates(): ReturnType<RuntimeAiService["extractGroupMemoryCandidates"]> {
    this.extractionCalls += 1;
    return [];
  }

  async normalizeMemoryCandidateLanguage(): ReturnType<RuntimeAiService["normalizeMemoryCandidateLanguage"]> {
    throw new Error("not implemented");
  }

  async judgeMemorySemanticRelation(): ReturnType<RuntimeAiService["judgeMemorySemanticRelation"]> {
    this.dedupCalls += 1;
    return { action: "duplicate", reason: "same fact" };
  }

  async summarizeDailyMemberProfile(): ReturnType<RuntimeAiService["summarizeDailyMemberProfile"]> {
    throw new Error("not implemented");
  }

  async summarizeOverallMemberProfile(): ReturnType<RuntimeAiService["summarizeOverallMemberProfile"]> {
    throw new Error("not implemented");
  }

  async generateDailyReportInsights(): ReturnType<RuntimeAiService["generateDailyReportInsights"]> {
    throw new Error("not implemented");
  }

  async generateBroadcastQuip(): ReturnType<RuntimeAiService["generateBroadcastQuip"]> {
    throw new Error("not implemented");
  }

  async generateScheduledReminderText(): ReturnType<RuntimeAiService["generateScheduledReminderText"]> {
    throw new Error("not implemented");
  }

  async generateChatPeriodSummary(): ReturnType<RuntimeAiService["generateChatPeriodSummary"]> {
    this.summaryCalls += 1;
    return "summary";
  }
}

test("ConfiguredAiService uses enabled profile model from system settings", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: Array<Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey">> = [];
  const configured = new FakeRuntimeAiService(makeHealth("configured-profile", "https://configured.example/v1"));

  await store.update({
    models: [{
      id: "profile_configured",
      name: "Profile",
      shortName: "profile",
      baseUrl: "https://configured.example/v1",
      model: "configured-profile",
      purpose: "profile",
      enabled: true,
      apiKey: "profile-key",
    }],
  });

  const service = new ConfiguredAiService(fallback as RuntimeAiService, store, "profile", (model) => {
    created.push(model);
    return configured as RuntimeAiService;
  });
  const health = await service.checkHealth({ refresh: true });

  assert.equal(health.model, "configured-profile");
  assert.equal(health.baseUrl, "https://configured.example/v1");
  assert.equal(configured.healthCalls, 1);
  assert.equal(fallback.healthCalls, 0);
  assert.equal(created[0]?.baseUrl, "https://configured.example/v1");
  assert.equal(created[0]?.model, "configured-profile");
  assert.equal(created[0]?.apiKey, "profile-key");
});

test("ConfiguredAiService falls back when profile model has no api key or is disabled", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  let factoryCalls = 0;

  await store.update({
    models: [
      {
        id: "profile_no_key",
        name: "No Key",
        shortName: "no-key",
        baseUrl: "https://nokey.example/v1",
        model: "nokey-profile",
        purpose: "profile",
        enabled: true,
      },
      {
        id: "profile_disabled",
        name: "Disabled",
        shortName: "disabled",
        baseUrl: "https://disabled.example/v1",
        model: "disabled-profile",
        purpose: "profile",
        enabled: false,
        apiKey: "disabled-key",
      },
    ],
  });

  const service = new ConfiguredAiService(fallback as RuntimeAiService, store, "profile", () => {
    factoryCalls += 1;
    throw new Error("should not create configured service");
  });
  const health = await service.checkHealth();

  assert.equal(health.model, "fallback");
  assert.equal(health.baseUrl, "https://fallback.example/v1");
  assert.equal(fallback.healthCalls, 1);
  assert.equal(factoryCalls, 0);
});

test("ConfiguredAiService reuses configured service until model config changes", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  let factoryCalls = 0;

  await store.update({
    models: [{
      id: "profile_model",
      name: "Profile",
      shortName: "profile",
      baseUrl: "https://configured.example/v1",
      model: "configured-profile",
      purpose: "profile",
      enabled: true,
      apiKey: "profile-key",
    }],
  });

  const service = new ConfiguredAiService(fallback as RuntimeAiService, store, "profile", (model) => {
    factoryCalls += 1;
    return new FakeRuntimeAiService(makeHealth(model.model, model.baseUrl)) as RuntimeAiService;
  });

  assert.equal((await service.checkHealth()).model, "configured-profile");
  assert.equal((await service.checkHealth()).model, "configured-profile");
  assert.equal(factoryCalls, 1);

  await store.update({
    models: [{
      id: "profile_model",
      name: "Profile",
      shortName: "profile",
      baseUrl: "https://configured.example/v1",
      model: "configured-profile-v2",
      purpose: "profile",
      enabled: true,
      apiKey: "profile-key",
    }],
  });

  assert.equal((await service.checkHealth()).model, "configured-profile-v2");
  assert.equal(factoryCalls, 2);
});

test("ConfiguredAiService prefers selected model id for a purpose", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      {
        id: "reply_a",
        name: "Reply A",
        shortName: "a",
        baseUrl: "https://reply-a.example/v1",
        model: "reply-a-model",
        purpose: "reply",
        enabled: true,
        apiKey: "reply-a-key",
      },
      {
        id: "reply_b",
        name: "Reply B",
        shortName: "b",
        baseUrl: "https://reply-b.example/v1",
        model: "reply-b-model",
        purpose: "reply",
        enabled: true,
        apiKey: "reply-b-key",
      },
    ],
    selectedModelIds: { reply: "reply_b" },
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (model) => {
    created.push(model.model);
    return new FakeRuntimeAiService(makeHealth(model.model, model.baseUrl), {
      text: "selected reply",
      model: model.model,
      skillId: "assistant",
    });
  });
  const reply = await service.generateReply({
    skill: testSkill,
    history: [],
    userInput: "hello",
  });

  assert.equal(reply.model, "reply-b-model");
  assert.deepEqual(created, ["reply-b-model"]);
});

test("ConfiguredAiService falls back when selected model is unavailable", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      {
        id: "reply_a",
        name: "Reply A",
        shortName: "a",
        baseUrl: "https://reply-a.example/v1",
        model: "reply-a-model",
        purpose: "reply",
        enabled: true,
        apiKey: "reply-a-key",
      },
      {
        id: "reply_b",
        name: "Reply B",
        shortName: "b",
        baseUrl: "https://reply-b.example/v1",
        model: "reply-b-model",
        purpose: "reply",
        enabled: false,
        apiKey: "reply-b-key",
      },
    ],
    selectedModelIds: { reply: "reply_b" },
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (model) => {
    created.push(model.model);
    return new FakeRuntimeAiService(makeHealth(model.model, model.baseUrl), {
      text: "fallback selected reply",
      model: model.model,
      skillId: "assistant",
    });
  });
  const reply = await service.generateReply({
    skill: testSkill,
    history: [],
    userInput: "hello",
  });

  assert.equal(reply.model, "reply-a-model");
  assert.deepEqual(created, ["reply-a-model"]);
});

test("ConfiguredAiService delegates replies to enabled reply model only", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"), {
    text: "fallback reply",
    model: "fallback",
    skillId: "assistant",
  });
  const configuredReply = new FakeRuntimeAiService(makeHealth("configured-reply", "https://reply.example/v1"), {
    text: "configured reply",
    model: "configured-reply",
    skillId: "assistant",
  });
  const created: Array<Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey">> = [];

  await store.update({
    models: [
      {
        id: "profile_configured",
        name: "Profile",
        shortName: "profile",
        baseUrl: "https://profile.example/v1",
        model: "configured-profile",
        purpose: "profile",
        enabled: true,
        apiKey: "profile-key",
      },
      {
        id: "reply_configured",
        name: "Reply",
        shortName: "reply",
        baseUrl: "https://reply.example/v1",
        model: "configured-reply",
        purpose: "reply",
        enabled: true,
        apiKey: "reply-key",
      },
    ],
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (model) => {
    created.push(model);
    return configuredReply;
  });
  const reply = await service.generateReply({
    skill: testSkill,
    history: [],
    userInput: "hello",
  });

  assert.equal(reply.text, "configured reply");
  assert.equal(reply.model, "configured-reply");
  assert.equal(configuredReply.replyCalls, 1);
  assert.equal(fallback.replyCalls, 0);
  assert.equal(created[0]?.purpose, "reply");
  assert.equal(created[0]?.baseUrl, "https://reply.example/v1");
  assert.equal(created[0]?.model, "configured-reply");
  assert.equal(created[0]?.apiKey, "reply-key");
});

test("ConfiguredAiService routes memory, dedup, and summary calls to their dedicated model purposes", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      {
        id: "memory_model",
        name: "Memory",
        shortName: "memory",
        baseUrl: "https://memory.example/v1",
        model: "memory_model",
        purpose: "memory",
        enabled: true,
        apiKey: "memory-key",
      },
      {
        id: "dedup_model",
        name: "Dedup",
        shortName: "dedup",
        baseUrl: "https://dedup.example/v1",
        model: "dedup_model",
        purpose: "dedup",
        enabled: true,
        apiKey: "dedup-key",
      },
      {
        id: "summary_model",
        name: "Summary",
        shortName: "summary",
        baseUrl: "https://summary.example/v1",
        model: "summary_model",
        purpose: "summary",
        enabled: true,
        apiKey: "summary-key",
      },
      {
        id: "profile_model",
        name: "Profile",
        shortName: "profile",
        baseUrl: "https://profile.example/v1",
        model: "profile_model",
        purpose: "profile",
        enabled: true,
        apiKey: "profile-key",
      },
    ],
  });

  const service = new ConfiguredAiService(fallback, store, "profile", (model) => {
    created.push(`${model.purpose}:${model.model}`);
    return new FakeRuntimeAiService(makeHealth(model.model, model.baseUrl));
  });

  await service.extractGroupMemoryCandidates({ groupId: "1", messages: [{ userId: "1", userName: "A", text: "hi", timestamp: "2026-06-04T00:00:00.000Z" }] });
  await service.judgeMemorySemanticRelation({
    candidate: { type: "member_profile", subjectUserId: "1", title: "A", content: "A likes tea", confidence: 0.9 },
    existing: { type: "member_profile", subjectUserId: "1", title: "A", content: "A likes tea", confidence: 0.9 },
  });
  await service.generateChatPeriodSummary({
    dateLabel: "2026-06-04",
    periodLabel: "全天",
    rangeLabel: "00:00-23:59",
    totalMessages: 0,
    participantCount: 0,
    topUsers: [],
    sampleMessages: [],
  });

  assert.deepEqual(created, [
    "memory:memory_model",
    "dedup:dedup_model",
    "summary:summary_model",
  ]);
});

test("ConfiguredAiService falls back from dedicated profile-family purpose to legacy profile model", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [{
      id: "profile_model",
      name: "Profile",
      shortName: "profile",
      baseUrl: "https://profile.example/v1",
      model: "profile_model",
      purpose: "profile",
      enabled: true,
      apiKey: "profile-key",
    }],
  });

  const service = new ConfiguredAiService(fallback, store, "profile", (model) => {
    created.push(`${model.purpose}:${model.model}`);
    return new FakeRuntimeAiService(makeHealth(model.model, model.baseUrl));
  });

  await service.extractGroupMemoryCandidates({ groupId: "1", messages: [{ userId: "1", userName: "A", text: "hi", timestamp: "2026-06-04T00:00:00.000Z" }] });
  await service.judgeMemorySemanticRelation({
    candidate: { type: "member_profile", subjectUserId: "1", title: "A", content: "A likes tea", confidence: 0.9 },
    existing: { type: "member_profile", subjectUserId: "1", title: "A", content: "A likes tea", confidence: 0.9 },
  });

  assert.deepEqual(created, ["profile:profile_model"]);
});

async function createSettingsStore(): Promise<SystemSettingsStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "configured-ai-"));
  return new SystemSettingsStore(path.join(dir, "system-settings.json"));
}

const testSkill: SkillDefinition = {
  id: "assistant",
  name: "Assistant",
  systemPrompt: "You are helpful.",
  styleRules: [],
  knowledge: [],
  temperature: 0.7,
  maxContextTurns: 12,
};

function makeHealth(model: string, baseUrl: string): AiHealthStatus {
  return {
    ok: true,
    detail: "ok",
    model,
    baseUrl,
    checkedAt: "2026-06-04T00:00:00.000Z",
    latencyMs: 1,
    cached: false,
  };
}
