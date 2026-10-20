import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import { SystemSettingsStore } from "./system-settings-store.js";
import { checkModelPolicyUpgrade, rollbackModelPolicy, upgradeModelPolicy } from "./model-policy-upgrade.js";
const key = "0".repeat(64);

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-policy-")); const db = new SharedDb(path.join(dir, "shared.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repository = new V3StateRepository(db, { stateEncryptionKey: key }); repository.markCutover();
  const store = new SystemSettingsStore("unused", [], undefined, repository);
  await store.update({ models: ["sol", "gpt", "ds"].map(id => ({ id, name: id, shortName: id, purpose: "reply", enabled: true, model: id, baseUrl: "https://test.invalid", apiKey: "secret-value", supportsVision: id === "gpt" })), selectedModelIds: { reply: "gpt" } });
  repository.saveGroup({ groupId: "g1", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], replyModelMode: "gpt" });
  return { repository, db, store };
}
test("policy upgrade is atomic, encrypted, idempotent and preserves command copy and switches", async t => {
  const { repository, db, store } = await fixture(t);
  const before = await store.getInternal(); const command = before.commands.find(command => command.id === "image_generation")!;
  await store.update({ commands: [{ ...command, primary: "#绘画", aliases: ["/draw"], enabled: false, permission: "super_admin" }] });
  assert.deepEqual(upgradeModelPolicy(repository, key), { applied: true, groupCount: 1 });
  const settings = await store.getInternal();
  assert.equal(settings.selectedModelIds.reply, "sol"); assert.deepEqual(settings.replyRouting?.fallbackModelIds, ["gpt", "ds"]);
  assert.equal(settings.models.find(model => model.id === "ds")?.model, "deepseek-flash");
  const image = settings.commands.find(command => command.id === "image_generation")!;
  assert.equal(image.primary, "#绘画"); assert.equal(image.enabled, false); assert.equal(image.permission, "member");
  assert.equal(repository.getGroup("g1")?.replyModelSource, "global");
  assert.equal(JSON.stringify(db.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type='release-policy-backup'").all()).includes("secret-value"), false);
  await store.update({ selectedModelIds: { reply: "ds" }, commands: [{ ...image, permission: "group_admin" }] });
  assert.equal(upgradeModelPolicy(repository, key).applied, false); assert.equal((await store.get()).selectedModelIds.reply, "ds");
  assert.equal((await store.get()).commands.find(command => command.id === "image_generation")?.permission, "group_admin");
  assert.equal(rollbackModelPolicy(repository, key).restored, true); assert.equal((await store.get()).selectedModelIds.reply, "gpt");
  assert.equal((await store.getInternal()).models.find(model => model.id === "ds")?.model, "ds");
  assert.equal((await store.get()).commands.find(command => command.id === "image_generation")?.permission, "super_admin");
  assert.equal(repository.getGroup("g1")?.replyModelMode, "gpt"); assert.equal(repository.getGroup("g1")?.replyModelSource, undefined);
  assert.equal(rollbackModelPolicy(repository, key).restored, false); assert.equal(upgradeModelPolicy(repository, key).applied, false);
  assert.equal(upgradeModelPolicy(repository, key, { retryAfterRollback: true }).applied, true);
  assert.equal((await store.get()).selectedModelIds.reply, "sol");
  assert.equal(upgradeModelPolicy(repository, key, { retryAfterRollback: true }).applied, false);
});
test("failed preflight leaves settings, groups and backup untouched", async t => {
  const { repository, db, store } = await fixture(t); const settings = repository.getSystemSettings()!;
  settings.models = settings.models.filter(model => model.id !== "ds"); repository.saveSystemSettings(settings);
  assert.throws(() => checkModelPolicyUpgrade(repository), /required_reply_model_unavailable:ds/);
  assert.throws(() => upgradeModelPolicy(repository, key));
  assert.equal((await store.get()).selectedModelIds.reply, "gpt"); assert.equal(repository.getGroup("g1")?.replyModelSource, undefined);
  assert.equal(repository.getMeta("model_policy_v3_0_39"), undefined);
  assert.equal(db.db.prepare("SELECT * FROM v3_state_documents WHERE document_type='release-policy-backup'").all().length, 0);
});
