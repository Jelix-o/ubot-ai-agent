import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "./shared/sqlite.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { V3StateRepository } from "./services/v3-state-repository.js";

const STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("image model configuration stores only encrypted key material and is idempotent", async (t) => {
  const appRoot = mkdtempSync(path.join(os.tmpdir(), "ubot-configure-image-"));
  const dbPath = path.join(appRoot, "data", "shared", "bot-shared.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(path.join(appRoot, ".env"), `UBOT_STATE_ENCRYPTION_KEY=${STATE_KEY}\n`, { mode: 0o600 });
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));

  const initial = new SharedDb(dbPath);
  try {
    const repository = new V3StateRepository(initial, { stateEncryptionKey: STATE_KEY });
    repository.markCutover();
    repository.saveGroup({
      groupId: "10001",
      currentSkillId: "huixian",
      allowedSkillIds: ["huixian"],
      switcherUserIds: [],
      liveChatUserIds: [],
    });
    const store = new SystemSettingsStore("unused.json", [], undefined, repository);
    await store.update({ models: ["gpt", "ds", "gemini", "astra"].map(replyModel) });
  } finally {
    initial.close();
  }

  const secret = "test-image-secret-never-store-plain";
  const env = {
    ...process.env,
    RELEASE_ROOT: process.cwd(),
    UBOT_APP_ROOT: appRoot,
    DB_PATH: dbPath,
    UBOT_STATE_ENCRYPTION_KEY: STATE_KEY,
  };
  for (let run = 0; run < 2; run += 1) {
    const result = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/configure-image-model.mjs")], {
      encoding: "utf8",
      env,
      input: `${secret}\n`,
    })) as { replyModelCount: number; imageModelCount: number; imageEnabledGroupCount: number };
    assert.deepEqual(result, {
      configuredModelId: "gpt-image-sunburst",
      selected: true,
      enabled: true,
      hasApiKey: true,
      replyModelCount: 4,
      imageModelCount: 1,
      groupCount: 1,
      imageEnabledGroupCount: 0,
    });
  }

  const verifiedDb = new SharedDb(dbPath);
  try {
    const repository = new V3StateRepository(verifiedDb, { stateEncryptionKey: STATE_KEY });
    const settings = repository.getSystemSettings();
    assert.equal(settings?.models.length, 5);
    assert.equal(settings?.selectedModelIds.image, "gpt-image-sunburst");
    assert.equal(settings?.models.find((model) => model.id === "gpt-image-sunburst")?.apiKey, secret);
    const rawSettings = verifiedDb.db.prepare(
      "SELECT settings_json FROM v3_system_settings WHERE settings_key = 'default'",
    ).get() as { settings_json: string };
    const storedSecret = verifiedDb.db.prepare(
      "SELECT ciphertext FROM v3_system_secrets WHERE secret_key = 'model:gpt-image-sunburst:api_key'",
    ).get() as { ciphertext: string };
    assert.equal(rawSettings.settings_json.includes(secret), false);
    assert.equal(storedSecret.ciphertext.includes(secret), false);
  } finally {
    verifiedDb.close();
  }
});

function replyModel(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    shortName: id,
    baseUrl: "https://example.test/v1",
    model: `${id}-model`,
    purpose: "reply" as const,
    apiKey: `${id}-secret`,
    hasApiKey: true,
    enabled: id !== "astra",
    apiProtocol: "openai" as const,
    createdAt: now,
    updatedAt: now,
  };
}
