import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import type { SystemSettings } from "../types.js";
import { SystemSettingsSqliteShadowRepository } from "./system-settings-sqlite-shadow-repository.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "system-settings-shadow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "bot-shared.db");
}

const INITIAL_SETTINGS: SystemSettings = {
  onlineLookupEnabled: false,
  tokenCostControl: {
    dailyReportAiQuipEnabled: false,
    chatSummaryAiEnabled: false,
    scheduledReminderAiRewriteEnabled: false,
    modelHealthAutoProbeEnabled: false,
  },
  defaultTriggerKeywords: [{ keyword: "trigger", enabled: true }],
  models: [{
    id: "reply-main",
    name: "Reply main",
    shortName: "reply",
    baseUrl: "https://reply.example/v1",
    model: "reply-model",
    purpose: "reply",
    apiKey: "provider-api-key",
    hasApiKey: true,
    enabled: true,
    apiProtocol: "openai",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }],
  selectedModelIds: { reply: "reply-main" },
  commands: [],
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function legacyInjectedSettings(): SystemSettings {
  return {
    ...INITIAL_SETTINGS,
    tokenCostControl: {
      ...INITIAL_SETTINGS.tokenCostControl,
      memoryCandidateExtractionEnabled: true,
      dailyProfileReviewAiEnabled: true,
    } as unknown as SystemSettings["tokenCostControl"],
    adminSecretHash: "admin-secret-hash",
    groupAdminSecretHash: "group-admin-secret-hash",
    adminSecretConfigured: true,
    groupAdminSecretConfigured: true,
    profileSummaryMaxChars: 1800,
    dailyProfileReviewEnabled: true,
    memoryDedupEnabled: true,
  } as unknown as SystemSettings;
}

test("SQLite system-settings shadow excludes secrets and retired V3 fields", (t) => {
  const db = new SharedDb(tempDb(t));
  const repository = new SystemSettingsSqliteShadowRepository(db);
  const legacy = legacyInjectedSettings();

  assert.equal(repository.compareAuthoritative(legacy).status, "missing");
  assert.equal(repository.syncFromAuthoritative(legacy).status, "created");
  const snapshot = repository.getSnapshot();
  assert.ok(snapshot);
  const safe = JSON.parse(snapshot.snapshot_json) as Record<string, unknown>;
  const model = (safe.models as Array<Record<string, unknown>>)[0];

  for (const key of [
    "adminSecretHash",
    "groupAdminSecretHash",
    "adminSecretConfigured",
    "groupAdminSecretConfigured",
    "profileSummaryMaxChars",
    "dailyProfileReviewEnabled",
    "memoryDedupEnabled",
  ]) {
    assert.equal(Object.hasOwn(safe, key), false, `${key} must be retired from the shadow`);
  }
  const controls = safe.tokenCostControl as Record<string, unknown>;
  assert.equal(Object.hasOwn(controls, "memoryCandidateExtractionEnabled"), false);
  assert.equal(Object.hasOwn(controls, "dailyProfileReviewAiEnabled"), false);
  assert.equal(model?.apiKey, undefined);
  assert.equal(model?.hasApiKey, true);
  assert.equal(snapshot.snapshot_json.includes("provider-api-key"), false);
  assert.equal(snapshot.snapshot_json.includes("admin-secret-hash"), false);
  assert.equal(snapshot.snapshot_json.includes("group-admin-secret-hash"), false);

  assert.equal(repository.syncFromAuthoritative(legacy).status, "unchanged");
  assert.equal(repository.compareAuthoritative(legacy).status, "in_sync");

  const changed: SystemSettings = { ...INITIAL_SETTINGS, onlineLookupEnabled: true };
  assert.equal(repository.compareAuthoritative(changed).status, "out_of_sync");
  assert.equal(repository.getSnapshot()?.snapshot_hash, snapshot.snapshot_hash, "compare must not mutate the shadow");
  assert.equal(repository.syncFromAuthoritative(changed).status, "updated");
  assert.equal(repository.compareAuthoritative(changed).status, "in_sync");
  db.close();
});
