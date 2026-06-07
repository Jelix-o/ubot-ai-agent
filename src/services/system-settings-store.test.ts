import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemSettingsStore } from "./system-settings-store.js";
import {
  LEGACY_MIMO_TTS_BASE_URL,
  LEGACY_MIMO_TTS_MODEL,
  MIMO_TTS_BASE_URL,
  MIMO_TTS_MODEL,
} from "./mimo-tts-config.js";

test("SystemSettingsStore seeds existing environment models and never returns api keys from public get", async () => {
  const store = await createStore([
    {
      id: "gpt",
      name: "Env Reply Model",
      shortName: "gpt-env",
      baseUrl: "https://reply-env.example/v1",
      model: "gpt-env-model",
      purpose: "reply",
      apiKey: "env-reply-key",
      hasApiKey: true,
      enabled: true,
    },
    {
      id: "mimo",
      name: "Env Profile Model",
      shortName: "mimo-env",
      baseUrl: "https://profile-env.example/v1",
      model: "mimo-env-model",
      purpose: "profile",
      apiKey: "env-profile-key",
      hasApiKey: true,
      enabled: true,
    },
  ]);

  const settings = await store.get();
  const gpt = settings.models.find((model) => model.id === "gpt");
  const mimo = settings.models.find((model) => model.id === "mimo");
  assert.equal(gpt?.model, "gpt-env-model");
  assert.equal(gpt?.hasApiKey, true);
  assert.equal(gpt?.apiKey, undefined);
  assert.equal(mimo?.model, "mimo-env-model");
  assert.equal(mimo?.hasApiKey, true);
  assert.equal(mimo?.apiKey, undefined);

  const internal = await store.getInternal();
  assert.equal(internal.models.find((model) => model.id === "gpt")?.apiKey, "env-reply-key");
  assert.equal(internal.models.find((model) => model.id === "mimo")?.apiKey, "env-profile-key");
});

test("SystemSettingsStore keeps default models when they remain in incoming settings", async () => {
  const store = await createStore([
    {
      id: "gpt",
      name: "Env Reply Model",
      shortName: "gpt-env",
      baseUrl: "https://reply-env.example/v1",
      model: "gpt-env-model",
      purpose: "reply",
      apiKey: "env-reply-key",
      hasApiKey: true,
      enabled: true,
    },
  ]);

  const next = await store.update({
    models: [
      {
        id: "gpt",
        name: "Env Reply Model",
        shortName: "gpt-env",
        baseUrl: "https://reply-env.example/v1",
        model: "gpt-env-model",
        purpose: "reply",
        apiKey: "",
        hasApiKey: true,
        enabled: true,
      },
      {
        id: "reply-pro",
        name: "Reply Pro",
        shortName: "reply-pro",
        baseUrl: "https://reply-pro.example/v1",
        model: "reply-pro-model",
        purpose: "reply",
        apiKey: "reply-pro-key",
        enabled: true,
      },
    ],
  });

  assert.equal(next.models.some((model) => model.id === "gpt"), true);
  assert.equal(next.models.some((model) => model.id === "reply-pro"), true);
  assert.equal(next.models.every((model) => model.apiKey === undefined), true);
  assert.equal(next.models.find((model) => model.id === "reply-pro")?.hasApiKey, true);

  const internal = await store.getInternal();
  assert.equal(internal.models.find((model) => model.id === "gpt")?.apiKey, "env-reply-key");
  assert.equal(internal.models.find((model) => model.id === "reply-pro")?.apiKey, "reply-pro-key");
});

test("SystemSettingsStore remembers deleted default models", async () => {
  const store = await createStore([
    {
      id: "gpt",
      name: "Env Reply Model",
      shortName: "gpt-env",
      baseUrl: "https://reply-env.example/v1",
      model: "gpt-env-model",
      purpose: "reply",
      apiKey: "env-reply-key",
      hasApiKey: true,
      enabled: true,
    },
    {
      id: "mimo",
      name: "Env Profile Model",
      shortName: "mimo-env",
      baseUrl: "https://profile-env.example/v1",
      model: "mimo-env-model",
      purpose: "profile",
      apiKey: "env-profile-key",
      hasApiKey: true,
      enabled: true,
    },
  ]);

  const first = await store.get();
  assert.equal(first.models.some((model) => model.id === "gpt"), true);
  assert.equal(first.models.some((model) => model.id === "mimo"), true);

  const next = await store.update({
    models: first.models.filter((model) => model.id !== "gpt"),
  });
  assert.equal(next.models.some((model) => model.id === "gpt"), false);
  assert.equal(next.models.some((model) => model.id === "mimo"), true);

  const internal = await store.getInternal();
  assert.deepEqual(internal.removedDefaultModelIds, ["gpt"]);
  assert.equal(internal.models.some((model) => model.id === "gpt"), false);

  const afterAnotherUpdate = await store.update({
    profileSummaryMaxChars: 1200,
  });
  assert.equal(afterAnotherUpdate.models.some((model) => model.id === "gpt"), false);
  assert.equal(afterAnotherUpdate.models.some((model) => model.id === "mimo"), true);
});

test("SystemSettingsStore preserves an existing model api key when editing with blank key", async () => {
  const store = await createStore();
  await store.update({
    models: [{
      id: "reply-pro",
      name: "Reply Pro",
      shortName: "reply-pro",
      baseUrl: "https://reply-pro.example/v1",
      model: "reply-pro-model",
      purpose: "reply",
      apiKey: "reply-pro-key",
      enabled: true,
    }],
  });

  await store.update({
    models: [{
      id: "reply-pro",
      name: "Reply Pro Renamed",
      shortName: "reply-pro",
      baseUrl: "https://reply-pro.example/v1",
      model: "reply-pro-model-v2",
      purpose: "reply",
      apiKey: "",
      enabled: true,
    }],
  });

  const internal = await store.getInternal();
  const model = internal.models.find((item) => item.id === "reply-pro");
  assert.equal(model?.name, "Reply Pro Renamed");
  assert.equal(model?.model, "reply-pro-model-v2");
  assert.equal(model?.apiKey, "reply-pro-key");
  assert.equal(model?.hasApiKey, true);
});

test("SystemSettingsStore normalizes scheduler switches and times", async () => {
  const store = await createStore();
  const next = await store.update({
    dailyProfileReviewEnabled: false,
    dailyProfileReviewTime: "01:30",
    memoryDedupEnabled: false,
    memoryDedupTime: "22:15",
    memoryDedupSemanticTimeoutMinutes: 10,
  });

  assert.equal(next.dailyProfileReviewEnabled, false);
  assert.equal(next.dailyProfileReviewTime, "01:30");
  assert.equal(next.memoryDedupEnabled, false);
  assert.equal(next.memoryDedupTime, "22:15");
  assert.equal(next.memoryDedupSemanticTimeoutMinutes, 10);
});

test("SystemSettingsStore normalizes memory dedup semantic timeout minutes", async () => {
  const store = await createStore();

  assert.equal((await store.get()).memoryDedupSemanticTimeoutMinutes, 10);
  assert.equal((await store.update({ memoryDedupSemanticTimeoutMinutes: 0 })).memoryDedupSemanticTimeoutMinutes, 1);
  assert.equal((await store.update({ memoryDedupSemanticTimeoutMinutes: 99 })).memoryDedupSemanticTimeoutMinutes, 60);
  assert.equal((await store.update({ memoryDedupSemanticTimeoutMinutes: "bad" as never })).memoryDedupSemanticTimeoutMinutes, 10);
});

test("SystemSettingsStore rejects invalid scheduler time", async () => {
  const store = await createStore();
  await assert.rejects(
    store.update({ memoryDedupTime: "24:00" }),
    /invalid_time/,
  );
});

test("SystemSettingsStore accepts all system model purposes without exposing api keys", async () => {
  const store = await createStore();
  const purposes = ["reply", "profile", "memory", "dedup", "summary", "knowledge", "tts", "custom"] as const;

  const next = await store.update({
    models: purposes.map((purpose) => ({
      id: `${purpose}-model`,
      name: `${purpose} Model`,
      shortName: purpose,
      baseUrl: `https://${purpose}.example/v1`,
      model: `${purpose}-model-name`,
      purpose,
      apiKey: `${purpose}-key`,
      enabled: true,
    })),
  });

  assert.deepEqual(new Set(next.models.map((model) => model.purpose)), new Set(purposes));
  assert.equal(next.models.every((model) => model.apiKey === undefined), true);

  const internal = await store.getInternal();
  for (const purpose of purposes) {
    const model = internal.models.find((item) => item.purpose === purpose);
    assert.equal(model?.apiKey, `${purpose}-key`);
    assert.equal(model?.hasApiKey, true);
  }
});

test("SystemSettingsStore drops unsafe model ids before they reach reply switching", async () => {
  const store = await createStore();
  const next = await store.update({
    models: [
      {
        id: "reply-pro",
        name: "Reply Pro",
        shortName: "reply-pro",
        baseUrl: "https://reply-pro.example/v1",
        model: "reply-pro-model",
        purpose: "reply",
        apiKey: "reply-pro-key",
        enabled: true,
      },
      {
        id: "../bad",
        name: "Bad",
        shortName: "bad",
        baseUrl: "https://bad.example/v1",
        model: "bad-model",
        purpose: "reply",
        apiKey: "bad-key",
        enabled: true,
      },
    ],
  });

  assert.equal(next.models.some((model) => model.id === "reply-pro"), true);
  assert.equal(next.models.some((model) => model.id === "../bad"), false);
  const internal = await store.getInternal();
  assert.equal(internal.models.find((model) => model.id === "reply-pro")?.apiKey, "reply-pro-key");
  assert.equal(internal.models.some((model) => model.id === "../bad"), false);
});

test("SystemSettingsStore migrates only built-in MiMo TTS models to current endpoint and model", async () => {
  const store = await createStore();
  await store.update({
    models: [
      {
        id: "tts-mimo-v25",
        name: "MiMo V2.5 TTS",
        shortName: "mimo-v2.5-tts",
        baseUrl: `${LEGACY_MIMO_TTS_BASE_URL}/`,
        model: MIMO_TTS_MODEL,
        purpose: "tts",
        apiKey: "tts-key",
        enabled: true,
      },
      {
        id: "tts",
        name: "Env TTS",
        shortName: LEGACY_MIMO_TTS_MODEL,
        baseUrl: "https://env-tts.example/v1",
        model: LEGACY_MIMO_TTS_MODEL,
        purpose: "tts",
        apiKey: "env-tts-key",
        enabled: true,
      },
      {
        id: "custom-tts",
        name: "Custom TTS",
        shortName: "custom",
        baseUrl: LEGACY_MIMO_TTS_BASE_URL,
        model: LEGACY_MIMO_TTS_MODEL,
        purpose: "tts",
        apiKey: "custom-key",
        enabled: true,
      },
    ],
    selectedModelIds: { tts: "tts-mimo-v25" },
  });

  const internal = await store.getInternal();
  const builtInMimo = internal.models.find((model) => model.id === "tts-mimo-v25");
  const envTts = internal.models.find((model) => model.id === "tts");
  const customTts = internal.models.find((model) => model.id === "custom-tts");

  assert.equal(builtInMimo?.baseUrl, MIMO_TTS_BASE_URL);
  assert.equal(builtInMimo?.model, MIMO_TTS_MODEL);
  assert.equal(envTts?.baseUrl, "https://env-tts.example/v1");
  assert.equal(envTts?.model, MIMO_TTS_MODEL);
  assert.equal(customTts?.baseUrl, LEGACY_MIMO_TTS_BASE_URL);
  assert.equal(customTts?.model, LEGACY_MIMO_TTS_MODEL);
  assert.equal(internal.selectedModelIds.tts, "tts-mimo-v25");
});

test("SystemSettingsStore keeps command permissions immutable and ignores unknown commands", async () => {
  const store = await createStore();
  const before = await store.get();
  const profileCommand = before.commands.find((item) => item.id === "profile_yesterday");
  assert.ok(profileCommand);

  const next = await store.update({
    commands: [
      {
        ...profileCommand,
        title: "Yesterday Profile",
        primary: "#昨日报告",
        aliases: ["#昨日画像", "#昨天画像", "#昨日画像"],
        permission: "super_admin",
        help: "Updated help text",
        enabled: true,
      },
      {
        id: "unknown_dangerous_command",
        title: "Danger",
        primary: "#danger",
        aliases: [],
        permission: "super_admin",
        enabled: true,
        help: "Must be ignored",
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const updatedProfileCommand = next.commands.find((item) => item.id === "profile_yesterday");
  assert.equal(updatedProfileCommand?.title, "Yesterday Profile");
  assert.equal(updatedProfileCommand?.primary, "#昨日报告");
  assert.deepEqual(updatedProfileCommand?.aliases, ["#昨日画像", "#昨天画像"]);
  assert.equal(updatedProfileCommand?.permission, profileCommand.permission);
  assert.equal(updatedProfileCommand?.help, "Updated help text");
  assert.equal(next.commands.some((item) => item.id === "unknown_dangerous_command"), false);
  assert.equal(next.commands.some((item) => item.id === "model"), true);
  assert.equal(next.commands.some((item) => item.id === "voice_reply" && item.primary === "#语音回复"), true);
  assert.equal(next.commands.some((item) => item.id === "sing" && item.primary === "#唱歌"), true);
});

async function createStore(defaultModels: ConstructorParameters<typeof SystemSettingsStore>[1] = []): Promise<SystemSettingsStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-settings-"));
  return new SystemSettingsStore(path.join(dir, "system-settings.json"), defaultModels);
}
