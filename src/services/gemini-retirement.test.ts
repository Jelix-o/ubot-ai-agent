import assert from "node:assert/strict";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import type { GroupBotConfig, SystemModelConfig, SystemSettings } from "../types.js";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";
import { SystemSettingsStore } from "./system-settings-store.js";
import { normalizeGroupConfigPatch } from "./group-config-service.js";
import { removeRetiredModels } from "./retired-models.js";

function model(id: string, purpose: SystemModelConfig["purpose"] = "reply", upstream = id): SystemModelConfig {
  return { id, name: id, shortName: id, purpose, model: upstream, baseUrl: "https://example.test/v1", enabled: true, hasApiKey: true, createdAt: "2026-10-19", updatedAt: "2026-10-19" };
}

function fixture() {
  const db = new SharedDb(":memory:");
  const key = "0".repeat(64);
  const repository = new V3StateRepository(db, { stateEncryptionKey: key });
  repository.markCutover();
  const cipher = new StateCipher(key);
  const settings = {
    models: [model("sol"), model("gpt"), model("ds"), model("gemini"), model("image-ok", "image"), model("old-summary", "summary", "google/gemini-2.5-flash")],
    selectedModelIds: { reply: "gemini", summary: "old-summary", image: "image-ok" },
    replyRouting: { fallbackEnabled: true, fallbackModelIds: ["gemini", "gpt", "gemini-38-flash", "ds"] },
    tokenCostControl: {}, commands: [], defaultTriggerKeywords: [], updatedAt: "2026-10-19",
  } as unknown as SystemSettings;
  db.db.prepare("INSERT INTO v3_system_settings VALUES ('default', ?, 1)").run(JSON.stringify(settings));
  const group: GroupBotConfig = { groupId: "fixture-group", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], replyModelMode: "old-summary", replyModelSource: "override" };
  db.db.prepare("INSERT INTO v3_groups VALUES (?, ?, 1)").run(group.groupId, JSON.stringify(group));
  for (const id of ["sol", "gpt", "ds", "image-ok", "gemini", "gemini-38-flash", "old-summary"]) {
    const purpose = `model:${id}:api_key`;
    db.db.prepare("INSERT INTO v3_system_secrets (secret_key, ciphertext, updated_at) VALUES (?, ?, 1)").run(purpose, cipher.encrypt(purpose, `fixture-${id}`));
  }
  return { db, repository, settings, group };
}

function snapshot(db: SharedDb): string {
  return JSON.stringify(["v3_system_settings", "v3_system_secrets", "v3_groups", "v3_state_meta", "v3_maintenance_runs"].map(table => db.db.prepare(`SELECT * FROM ${table}`).all()));
}

test("Gemini retirement atomically removes aliases, orphan credentials and references while preserving other providers", async () => {
  const { db, repository, settings } = fixture();
  try {
    const preservedSecrets = db.db.prepare("SELECT * FROM v3_system_secrets WHERE secret_key NOT IN ('model:gemini:api_key','model:gemini-38-flash:api_key','model:old-summary:api_key') ORDER BY secret_key").all();
    const result = repository.retireGeminiOnce();
    assert.deepEqual(result, { applied: true, modelIds: ["gemini", "gemini-38-flash", "old-summary"], groupsUpdated: 1, secretsDeleted: 3 });
    const migrated = repository.getSystemSettings()!;
    assert.deepEqual(migrated.models.map(item => item.id), ["sol", "gpt", "ds", "image-ok"]);
    assert.deepEqual(migrated.selectedModelIds, { reply: "sol", summary: "", image: "image-ok" });
    assert.deepEqual(migrated.replyRouting?.fallbackModelIds, ["gpt", "ds"]);
    assert.deepEqual(repository.getGroup("fixture-group")?.replyModelSource, "global");
    assert.equal(repository.getGroup("fixture-group")?.replyModelMode, "sol");
    assert.deepEqual(db.db.prepare("SELECT * FROM v3_system_secrets ORDER BY secret_key").all(), preservedSecrets);
    const after = snapshot(db);
    assert.equal(repository.retireGeminiOnce().applied, false);
    assert.equal(snapshot(db), after);
    const audit = JSON.stringify(db.db.prepare("SELECT detail_json FROM v3_maintenance_runs").all());
    assert.doesNotMatch(audit, /fixture-gemini|ciphertext|api_key|example\.test/);
    // Old imports and environment defaults cannot reintroduce the retired provider.
    repository.saveSystemSettings(settings);
    const store = new SystemSettingsStore("unused.json", [model("injected-default", "reply", "gemini-3")], undefined, repository);
    assert.equal((await store.getInternal()).models.some(item => item.model.includes("gemini")), false);
    await assert.rejects(store.update({ models: [model("new-alias", "reply", "gemini-3")] }), /model_retired/);
    await assert.rejects(store.update({ selectedModelIds: { image: "gemini" } }), /model_retired/);
    await assert.rejects(store.update({ replyRouting: { ...migrated.replyRouting!, fallbackModelIds: ["gemini"] } }), /model_retired/);
    assert.throws(() => normalizeGroupConfigPatch(repository.getGroup("fixture-group")!, { replyModelMode: "gemini" }), /model_retired/);
  } finally { db.close(); }
});

test("corrupt settings or any corrupt group roll back Gemini retirement with credentials and audit untouched", () => {
  for (const corrupt of ["settings", "group", "selected", "routing"]) {
    const { db, repository } = fixture();
    try {
      if (corrupt === "settings") db.db.prepare("UPDATE v3_system_settings SET settings_json = '{'").run();
      if (corrupt === "group") db.db.prepare("INSERT INTO v3_groups VALUES ('broken', '{}', 1)").run();
      if (corrupt === "selected") db.db.prepare("UPDATE v3_system_settings SET settings_json = json_set(settings_json, '$.selectedModelIds', 42)").run();
      if (corrupt === "routing") db.db.prepare("UPDATE v3_system_settings SET settings_json = json_set(settings_json, '$.replyRouting.fallbackModelIds', 'broken')").run();
      const before = snapshot(db);
      assert.throws(() => repository.retireGeminiOnce(), /invalid_v3_/);
      assert.equal(snapshot(db), before, corrupt);
    } finally { db.close(); }
  }
});

test("failure during credential deletion rolls back prior settings and group writes", () => {
  const { db, repository } = fixture();
  try {
    db.db.exec("CREATE TRIGGER fail_retirement BEFORE DELETE ON v3_system_secrets WHEN OLD.secret_key = 'model:gemini-38-flash:api_key' BEGIN SELECT RAISE(ABORT, 'injected_retirement_failure'); END");
    const before = snapshot(db);
    assert.throws(() => repository.retireGeminiOnce(), /injected_retirement_failure/);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test("an explicitly cleared nonreply selection remains unconfigured instead of switching purposes", () => {
  const { db, settings } = fixture();
  try {
    const next = removeRetiredModels(settings);
    assert.equal(next.selectedModelIds.summary, "");
    assert.deepEqual(removeRetiredModels(next), next);
    assert.deepEqual(next.models.find(item => item.id === "image-ok"), settings.models.find(item => item.id === "image-ok"));
  } finally { db.close(); }
});
