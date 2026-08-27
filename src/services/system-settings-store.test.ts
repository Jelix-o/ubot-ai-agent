import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import type { SystemSettings } from "../types.js";
import {
  LEGACY_MIMO_TTS_BASE_URL,
  LEGACY_MIMO_TTS_MODEL,
  MIMO_TTS_BASE_URL,
  MIMO_TTS_MODEL,
} from "./mimo-tts-config.js";
import { SystemSettingsStore } from "./system-settings-store.js";
import type { SystemSettingsShadowWriter } from "./system-settings-sqlite-shadow-repository.js";
import { V3StateRepository } from "./v3-state-repository.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function model(id: string, purpose: "reply" | "summary" | "knowledge" | "tts" | "custom", apiKey = `${id}-key`) {
  return {
    id,
    name: `${id} model`,
    shortName: id,
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-model`,
    purpose,
    apiKey,
    hasApiKey: true,
    enabled: true,
  };
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("SystemSettingsStore redacts provider keys from public reads", async () => {
  await withDir(async (dir) => {
    const store = new SystemSettingsStore(path.join(dir, "settings.json"), [
      model("reply", "reply", "reply-secret"),
      model("tts", "tts", "tts-secret"),
    ]);

    const publicSettings = await store.get();
    assert.equal(publicSettings.models.every((item) => item.apiKey === undefined), true);
    assert.equal(publicSettings.models.every((item) => item.hasApiKey), true);
    const internal = await store.getInternal();
    assert.equal(internal.models.find((item) => item.id === "reply")?.apiKey, "reply-secret");
    assert.equal(internal.models.find((item) => item.id === "tts")?.apiKey, "tts-secret");
  });
});

test("SystemSettingsStore preserves an existing API key for blank-key edits", async () => {
  await withDir(async (dir) => {
    const store = new SystemSettingsStore(path.join(dir, "settings.json"));
    await store.update({ models: [model("reply", "reply", "reply-secret")] });
    const visible = (await store.get()).models[0]!;
    await store.update({ models: [{ ...visible, apiKey: "" }] });

    assert.equal((await store.getInternal()).models[0]?.apiKey, "reply-secret");
  });
});

test("SystemSettingsStore accepts only V3 model purposes and safe identifiers", async () => {
  await withDir(async (dir) => {
    const store = new SystemSettingsStore(path.join(dir, "settings.json"));
    await assert.rejects(
      store.update({ models: [{ ...model("legacy", "reply"), purpose: "profile" as never }] }),
      /invalid_model_purpose/,
    );
    await assert.rejects(
      store.update({ models: [{ ...model("../bad", "reply") }] }),
      /invalid_model_id/,
    );
    await assert.rejects(
      store.update({ models: [{ ...model("reply", "reply") }, { ...model("reply", "reply") }] }),
      /duplicate_model_id/,
    );
  });
});

test("SystemSettingsStore persists retained cost controls and online lookup", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "settings.json");
    const store = new SystemSettingsStore(file);
    const next = await store.update({
      onlineLookupEnabled: true,
      tokenCostControl: {
        dailyReportAiQuipEnabled: true,
        chatSummaryAiEnabled: true,
        scheduledReminderAiRewriteEnabled: false,
        modelHealthAutoProbeEnabled: true,
      },
    });
    assert.equal(next.onlineLookupEnabled, true);
    assert.deepEqual(next.tokenCostControl, {
      dailyReportAiQuipEnabled: true,
      chatSummaryAiEnabled: true,
      scheduledReminderAiRewriteEnabled: false,
      modelHealthAutoProbeEnabled: true,
    });
    assert.deepEqual((await new SystemSettingsStore(file).get()).tokenCostControl, next.tokenCostControl);
  });
});

test("SystemSettingsStore migrates built-in MiMo TTS configuration only", async () => {
  await withDir(async (dir) => {
    const store = new SystemSettingsStore(path.join(dir, "settings.json"));
    await store.update({
      models: [
        {
          ...model("tts-mimo-v25", "tts", "tts-key"),
          baseUrl: `${LEGACY_MIMO_TTS_BASE_URL}/`,
          model: LEGACY_MIMO_TTS_MODEL,
        },
        {
          ...model("custom-tts", "tts", "custom-key"),
          baseUrl: LEGACY_MIMO_TTS_BASE_URL,
          model: LEGACY_MIMO_TTS_MODEL,
        },
      ],
      selectedModelIds: { tts: "tts-mimo-v25" },
    });
    const internal = await store.getInternal();
    assert.equal(internal.models.find((item) => item.id === "tts-mimo-v25")?.baseUrl, MIMO_TTS_BASE_URL);
    assert.equal(internal.models.find((item) => item.id === "tts-mimo-v25")?.model, MIMO_TTS_MODEL);
    assert.equal(internal.models.find((item) => item.id === "custom-tts")?.baseUrl, LEGACY_MIMO_TTS_BASE_URL);
    assert.equal(internal.models.find((item) => item.id === "custom-tts")?.model, LEGACY_MIMO_TTS_MODEL);
  });
});

test("SystemSettingsStore permits command copy changes but not permission escalation", async () => {
  await withDir(async (dir) => {
    const store = new SystemSettingsStore(path.join(dir, "settings.json"));
    const before = await store.get();
    const conversation = before.commands.find((item) => item.id === "conversation");
    assert.ok(conversation);
    const next = await store.update({
      commands: [
        { ...conversation, title: "Conversation", primary: "#chat", permission: "super_admin" },
        { id: "unknown", title: "unknown", primary: "#unknown", aliases: [], permission: "super_admin", enabled: true, help: "", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const updated = next.commands.find((item) => item.id === "conversation");
    assert.equal(updated?.title, "Conversation");
    assert.equal(updated?.primary, "#chat");
    assert.equal(updated?.permission, conversation.permission);
    assert.equal(next.commands.some((item) => item.id === "unknown"), false);
  });
});

test("SystemSettingsStore discards legacy profile and automatic-memory fields from JSON", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "settings.json");
    await writeFile(file, JSON.stringify({
      profileSummaryMaxChars: 1800,
      dailyProfileReviewEnabled: true,
      memoryDedupEnabled: true,
      memoryCandidateConfidenceThreshold: 90,
      memoryUnattendedModeEnabled: true,
      tokenCostControl: {
        memoryCandidateExtractionEnabled: true,
        memoryCandidateNormalizationEnabled: true,
        memorySemanticDedupEnabled: true,
        dailyProfileReviewAiEnabled: true,
        chatSummaryAiEnabled: true,
      },
      onlineLookupEnabled: true,
      models: [
        { ...model("legacy-profile", "reply"), purpose: "profile" },
        model("reply", "reply", "reply-secret"),
      ],
      selectedModelIds: { reply: "reply" },
      commands: [],
      updatedAt: "2026-08-25T00:00:00.000Z",
    }), "utf8");

    const settings = await new SystemSettingsStore(file).get();
    const record = settings as unknown as Record<string, unknown>;
    for (const key of [
      "profileSummaryMaxChars",
      "dailyProfileReviewEnabled",
      "memoryDedupEnabled",
      "memoryCandidateConfidenceThreshold",
      "memoryUnattendedModeEnabled",
    ]) {
      assert.equal(Object.hasOwn(record, key), false);
    }
    assert.equal(settings.models.some((item) => item.id === "legacy-profile"), false);
    assert.equal(settings.tokenCostControl.chatSummaryAiEnabled, true);
    assert.equal(Object.hasOwn(settings.tokenCostControl as unknown as Record<string, unknown>, "memoryCandidateExtractionEnabled"), false);
  });
});

test("SystemSettingsStore uses V3 SQLite after cutover and never reads or writes legacy JSON", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "settings.json");
    const legacy = JSON.stringify({ onlineLookupEnabled: true, models: [model("legacy", "reply", "legacy-secret")] });
    await writeFile(file, legacy, "utf8");
    const db = new SharedDb(path.join(dir, "bot-shared.db"));
    try {
      const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
      repository.markCutover();
      const store = new SystemSettingsStore(file, [], undefined, repository);
      assert.equal((await store.get()).onlineLookupEnabled, false);
      await store.update({ onlineLookupEnabled: true });
      assert.equal(repository.getSystemSettings()?.onlineLookupEnabled, true);
      assert.equal(await readFile(file, "utf8"), legacy);
    } finally {
      db.close();
    }
  });
});

test("SystemSettingsStore retains the JSON shadow only before V3 cutover", async () => {
  await withDir(async (dir) => {
    const snapshots: SystemSettings[] = [];
    const shadowWriter: SystemSettingsShadowWriter = {
      syncFromAuthoritative(settings) {
        snapshots.push(JSON.parse(JSON.stringify(settings)) as SystemSettings);
        return { status: "created", snapshotHash: "test" };
      },
    };
    const store = new SystemSettingsStore(path.join(dir, "settings.json"), [], shadowWriter);
    await store.get();
    assert.equal(snapshots.length, 0);
    assert.equal(await store.syncShadowFromAuthoritative(), true);
    await store.update({ onlineLookupEnabled: true });
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1]?.onlineLookupEnabled, true);
  });
});
