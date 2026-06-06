import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SkillDefinition, SystemModelConfig } from "../types.js";
import { ConfiguredTtsService, type RuntimeTtsService } from "./configured-tts-service.js";
import { TtsServiceError, type TtsSynthesisResult } from "./tts-service.js";
import { SystemSettingsStore } from "./system-settings-store.js";

class FakeRuntimeTtsService implements RuntimeTtsService {
  calls: Array<{ text: string; skillId: string }> = [];

  constructor(private readonly label: string) {}

  async synthesize(text: string, skill: SkillDefinition): Promise<TtsSynthesisResult> {
    this.calls.push({ text, skillId: skill.id });
    return {
      filePath: `${this.label}.wav`,
      recordFile: `base64://${this.label}`,
      spokenText: text,
      async cleanup() {},
    };
  }
}

test("ConfiguredTtsService uses selected enabled tts model from system settings", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeTtsService("fallback");
  const configured = new FakeRuntimeTtsService("configured");
  const created: Array<Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey">> = [];

  await store.update({
    models: [
      makeTtsModel({
        id: "tts-a",
        model: "env-tts",
        apiKey: "env-key",
      }),
      makeTtsModel({
        id: "tts-b",
        baseUrl: "https://configured.example/v1",
        model: "configured-tts",
        apiKey: "configured-key",
      }),
    ],
    selectedModelIds: { tts: "tts-b" },
  });

  const service = new ConfiguredTtsService(fallback, store, defaultOptions(), (model) => {
    created.push(model);
    return configured;
  });
  const result = await service.synthesize("hello", testSkill);

  assert.equal(result.recordFile, "base64://configured");
  assert.equal(configured.calls.length, 1);
  assert.equal(fallback.calls.length, 0);
  assert.equal(created[0]?.baseUrl, "https://configured.example/v1");
  assert.equal(created[0]?.model, "configured-tts");
  assert.equal(created[0]?.apiKey, "configured-key");
});

test("ConfiguredTtsService falls back when selected tts model is disabled or missing api key", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeTtsService("fallback");
  let factoryCalls = 0;

  await store.update({
    models: [
      makeTtsModel({
        id: "tts-disabled",
        model: "disabled-tts",
        enabled: false,
        apiKey: "disabled-key",
      }),
      makeTtsModel({
        id: "tts-no-key",
        model: "no-key-tts",
        apiKey: "",
      }),
    ],
    selectedModelIds: { tts: "tts-disabled" },
  });

  const service = new ConfiguredTtsService(fallback, store, defaultOptions(), () => {
    factoryCalls += 1;
    throw new Error("should not create configured service");
  });
  const result = await service.synthesize("fallback please", testSkill);

  assert.equal(result.recordFile, "base64://fallback");
  assert.equal(fallback.calls.length, 1);
  assert.equal(factoryCalls, 0);
});

test("ConfiguredTtsService switches on the next synthesis after tts settings change", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeTtsService("fallback");
  const created: string[] = [];

  await store.update({
    models: [makeTtsModel({ id: "tts-main", model: "tts-v1", apiKey: "key-v1" })],
    selectedModelIds: { tts: "tts-main" },
  });

  const service = new ConfiguredTtsService(fallback, store, defaultOptions(), (model) => {
    created.push(`${model.model}:${model.apiKey}`);
    return new FakeRuntimeTtsService(model.model);
  });

  assert.equal((await service.synthesize("first", testSkill)).recordFile, "base64://tts-v1");

  await store.update({
    models: [makeTtsModel({ id: "tts-main", model: "tts-v2", apiKey: "key-v2" })],
    selectedModelIds: { tts: "tts-main" },
  });

  assert.equal((await service.synthesize("second", testSkill)).recordFile, "base64://tts-v2");
  assert.deepEqual(created, ["tts-v1:key-v1", "tts-v2:key-v2"]);
});

test("ConfiguredTtsService adds selected system model id to TTS errors", async () => {
  const store = await createSettingsStore();
  const fallback = new FakeRuntimeTtsService("fallback");

  await store.update({
    models: [makeTtsModel({ id: "tts-main", model: "mimo-v2.5-tts", apiKey: "tts-key" })],
    selectedModelIds: { tts: "tts-main" },
  });

  const service = new ConfiguredTtsService(fallback, store, defaultOptions(), (model) => ({
    async synthesize(): Promise<TtsSynthesisResult> {
      throw new TtsServiceError("MiMo TTS request failed with status 401", {
        baseUrl: model.baseUrl,
        model: model.model,
        statusCode: 401,
      });
    },
  }));

  await assert.rejects(
    service.synthesize("hello", testSkill),
    (error) => {
      assert.ok(error instanceof TtsServiceError);
      assert.equal(error.details.systemModelId, "tts-main");
      assert.equal(error.details.statusCode, 401);
      assert.equal(error.details.model, "mimo-v2.5-tts");
      return true;
    },
  );
});

async function createSettingsStore(): Promise<SystemSettingsStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "configured-tts-"));
  return new SystemSettingsStore(path.join(dir, "system-settings.json"));
}

function defaultOptions(): ConstructorParameters<typeof ConfiguredTtsService>[2] {
  return {
    voice: "mimo_default",
    audioFormat: "wav",
    cacheDir: path.join(os.tmpdir(), "configured-tts-cache"),
    globalStyleHint: "plain",
  };
}

function makeTtsModel(input: Partial<SystemModelConfig>): SystemModelConfig {
  return {
    id: input.id ?? "tts",
    name: input.name ?? "TTS",
    shortName: input.shortName ?? "tts",
    baseUrl: input.baseUrl ?? "https://tts.example/v1",
    model: input.model ?? "tts-model",
    purpose: "tts",
    apiKey: input.apiKey,
    hasApiKey: input.hasApiKey ?? Boolean(input.apiKey),
    enabled: input.enabled ?? true,
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };
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
