import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AiHealthStatus, AiReply, SkillDefinition, SystemModelConfig } from "../types.js";
import { ConfiguredAiService, type RuntimeAiService } from "./configured-ai-service.js";
import { SystemSettingsStore } from "./system-settings-store.js";

class FakeRuntimeAiService implements RuntimeAiService {
  healthCalls = 0;
  replyCalls = 0;
  summaryCalls = 0;
  staticHtmlCalls = 0;

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
    if (!this.reply) throw new Error("not implemented");
    return this.reply;
  }

  async generateStaticHtml(): ReturnType<RuntimeAiService["generateStaticHtml"]> {
    this.staticHtmlCalls += 1;
    return {
      text: '{"title":"Demo","html":"<!doctype html><title>Demo</title>"}',
      model: this.health.model,
    };
  }

  async evaluateReplyDesire(): ReturnType<RuntimeAiService["evaluateReplyDesire"]> {
    throw new Error("not implemented");
  }

  async evaluateControlledMention(): ReturnType<RuntimeAiService["evaluateControlledMention"]> {
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

test("ConfiguredAiService uses the selected reply model", async (t) => {
  const store = await createSettingsStore(t);
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      model({
        id: "reply-a",
        model: "reply-a-model",
      }),
      model({
        id: "reply-b",
        model: "reply-b-model",
      }),
    ],
    selectedModelIds: { reply: "reply-b" },
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (configured) => {
    created.push(configured.model);
    return new FakeRuntimeAiService(makeHealth(configured.model, configured.baseUrl), {
      text: "configured reply",
      model: configured.model,
      skillId: "huixian",
    });
  });

  const reply = await service.generateReply({
    skill: testSkill,
    history: [],
    userInput: "hello",
  });

  assert.equal(reply.model, "reply-b-model");
  assert.deepEqual(created, ["reply-b-model"]);
  assert.equal(fallback.replyCalls, 0);
});

test("ConfiguredAiService falls back when no usable selected model remains", async (t) => {
  const store = await createSettingsStore(t);
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"), {
    text: "fallback",
    model: "fallback",
    skillId: "huixian",
  });
  let factoryCalls = 0;

  await store.update({
    models: [model({
      id: "reply-disabled",
      model: "disabled-model",
      enabled: false,
    })],
    selectedModelIds: { reply: "reply-disabled" },
  });

  const service = new ConfiguredAiService(fallback, store, "reply", () => {
    factoryCalls += 1;
    return fallback;
  });
  const reply = await service.generateReply({
    skill: testSkill,
    history: [],
    userInput: "hello",
  });

  assert.equal(reply.model, "fallback");
  assert.equal(factoryCalls, 0);
  assert.equal(fallback.replyCalls, 1);
});

test("ConfiguredAiService reuses a provider until its persisted model changes", async (t) => {
  const store = await createSettingsStore(t);
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  let factoryCalls = 0;

  await store.update({
    models: [model({
      id: "reply",
      model: "reply-v1",
    })],
  });
  const service = new ConfiguredAiService(fallback, store, "reply", (configured) => {
    factoryCalls += 1;
    return new FakeRuntimeAiService(makeHealth(configured.model, configured.baseUrl));
  });

  assert.equal((await service.checkHealth()).model, "reply-v1");
  assert.equal((await service.checkHealth()).model, "reply-v1");
  assert.equal(factoryCalls, 1);

  await store.update({
    models: [model({
      id: "reply",
      model: "reply-v2",
    })],
  });

  assert.equal((await service.checkHealth()).model, "reply-v2");
  assert.equal(factoryCalls, 2);
});

test("ConfiguredAiService routes retained report summaries to the summary provider", async (t) => {
  const store = await createSettingsStore(t);
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      model({
        id: "reply",
        model: "reply-model",
      }),
      model({
        id: "summary",
        model: "summary-model",
        purpose: "summary",
      }),
    ],
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (configured) => {
    created.push(`${configured.purpose}:${configured.model}`);
    return new FakeRuntimeAiService(makeHealth(configured.model, configured.baseUrl));
  });
  const summary = await service.generateChatPeriodSummary({
    dateLabel: "2026-06-04",
    periodLabel: "全天",
    rangeLabel: "00:00-23:59",
    totalMessages: 0,
    participantCount: 0,
    topUsers: [],
    sampleMessages: [],
  });

  assert.equal(summary, "summary");
  assert.deepEqual(created, ["summary:summary-model"]);
});

test("ConfiguredAiService routes static HTML generation to the selected reply model", async (t) => {
  const store = await createSettingsStore(t);
  const fallback = new FakeRuntimeAiService(makeHealth("fallback", "https://fallback.example/v1"));
  const created: string[] = [];

  await store.update({
    models: [
      model({ id: "reply", model: "reply-model" }),
      model({ id: "summary", model: "summary-model", purpose: "summary" }),
    ],
    selectedModelIds: { reply: "reply", summary: "summary" },
  });

  const service = new ConfiguredAiService(fallback, store, "reply", (configured) => {
    created.push(`${configured.purpose}:${configured.model}`);
    return new FakeRuntimeAiService(makeHealth(configured.model, configured.baseUrl));
  });

  const generated = await service.generateStaticHtml({ request: "做一个待办清单" });

  assert.equal(generated.model, "reply-model");
  assert.match(generated.text, /\"html\"/);
  assert.deepEqual(created, ["reply:reply-model"]);
});

async function createSettingsStore(t: test.TestContext): Promise<SystemSettingsStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "configured-ai-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SystemSettingsStore(path.join(dir, "system-settings.json"));
}

function model(input: {
  id: string;
  model: string;
  purpose?: SystemModelConfig["purpose"];
  enabled?: boolean;
}): Partial<SystemModelConfig> & { apiKey?: string } {
  return {
    id: input.id,
    name: input.id,
    shortName: input.id,
    baseUrl: "https://configured.example/v1",
    model: input.model,
    purpose: input.purpose ?? "reply",
    enabled: input.enabled ?? true,
    apiKey: "configured-key",
  };
}

const testSkill: SkillDefinition = {
  id: "huixian",
  name: "会仙",
  systemPrompt: "You are Huixian.",
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
