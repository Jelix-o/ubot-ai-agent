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
  profileSummaryMaxChars: 1800,
  profileShortSummaryMaxChars: 140,
  dailyProfileReviewEnabled: false,
  dailyProfileReviewTime: "00:00",
  memoryDedupEnabled: false,
  memoryDedupTime: "23:00",
  memoryDedupSemanticTimeoutMinutes: 10,
  memoryCandidateConfidenceThreshold: 60,
  memoryAutoApproveConfidenceThreshold: 80,
  memoryUnattendedModeEnabled: false,
  onlineLookupEnabled: false,
  tokenCostControl: {
    memoryCandidateExtractionEnabled: false,
    memoryCandidateNormalizationEnabled: false,
    memorySemanticDedupEnabled: false,
    dailyProfileReviewAiEnabled: false,
    dailyReportAiQuipEnabled: false,
    chatSummaryAiEnabled: false,
    scheduledReminderAiRewriteEnabled: false,
    modelHealthAutoProbeEnabled: false,
  },
  adminSecretHash: "admin-secret-hash",
  groupAdminSecretHash: "group-admin-secret-hash",
  defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
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

test("SQLite system-settings shadow is canonical, non-authoritative, and strictly redacted", (t) => {
  const db = new SharedDb(tempDb(t));
  const repository = new SystemSettingsSqliteShadowRepository(db);

  assert.equal(repository.compareAuthoritative(INITIAL_SETTINGS).status, "missing");
  assert.equal(repository.syncFromAuthoritative(INITIAL_SETTINGS).status, "created");
  const snapshot = repository.getSnapshot();
  assert.ok(snapshot);
  const safe = JSON.parse(snapshot?.snapshot_json ?? "{}") as Record<string, unknown>;
  const model = (safe.models as Array<Record<string, unknown>>)[0];
  assert.equal(safe.adminSecretHash, undefined);
  assert.equal(safe.groupAdminSecretHash, undefined);
  assert.equal(safe.adminSecretConfigured, true);
  assert.equal(safe.groupAdminSecretConfigured, true);
  assert.equal(model?.apiKey, undefined);
  assert.equal(model?.hasApiKey, true);
  assert.equal(snapshot?.snapshot_json.includes("provider-api-key"), false);
  assert.equal(snapshot?.snapshot_json.includes("admin-secret-hash"), false);
  assert.equal(snapshot?.snapshot_json.includes("group-admin-secret-hash"), false);

  assert.equal(repository.syncFromAuthoritative(INITIAL_SETTINGS).status, "unchanged");
  assert.equal(repository.compareAuthoritative(INITIAL_SETTINGS).status, "in_sync");

  const reordered: SystemSettings = {
    updatedAt: INITIAL_SETTINGS.updatedAt,
    commands: INITIAL_SETTINGS.commands,
    selectedModelIds: INITIAL_SETTINGS.selectedModelIds,
    models: INITIAL_SETTINGS.models,
    defaultTriggerKeywords: INITIAL_SETTINGS.defaultTriggerKeywords,
    groupAdminSecretHash: INITIAL_SETTINGS.groupAdminSecretHash,
    adminSecretHash: INITIAL_SETTINGS.adminSecretHash,
    tokenCostControl: INITIAL_SETTINGS.tokenCostControl,
    onlineLookupEnabled: INITIAL_SETTINGS.onlineLookupEnabled,
    memoryUnattendedModeEnabled: INITIAL_SETTINGS.memoryUnattendedModeEnabled,
    memoryAutoApproveConfidenceThreshold: INITIAL_SETTINGS.memoryAutoApproveConfidenceThreshold,
    memoryCandidateConfidenceThreshold: INITIAL_SETTINGS.memoryCandidateConfidenceThreshold,
    memoryDedupSemanticTimeoutMinutes: INITIAL_SETTINGS.memoryDedupSemanticTimeoutMinutes,
    memoryDedupTime: INITIAL_SETTINGS.memoryDedupTime,
    memoryDedupEnabled: INITIAL_SETTINGS.memoryDedupEnabled,
    dailyProfileReviewTime: INITIAL_SETTINGS.dailyProfileReviewTime,
    dailyProfileReviewEnabled: INITIAL_SETTINGS.dailyProfileReviewEnabled,
    profileShortSummaryMaxChars: INITIAL_SETTINGS.profileShortSummaryMaxChars,
    profileSummaryMaxChars: INITIAL_SETTINGS.profileSummaryMaxChars,
  };
  assert.equal(repository.compareAuthoritative(reordered).status, "in_sync");

  const changed: SystemSettings = { ...INITIAL_SETTINGS, onlineLookupEnabled: true };
  assert.equal(repository.compareAuthoritative(changed).status, "out_of_sync");
  assert.equal(repository.getSnapshot()?.snapshot_hash, snapshot?.snapshot_hash, "compare must not mutate the shadow");
  assert.equal(repository.syncFromAuthoritative(changed).status, "updated");
  assert.equal(repository.compareAuthoritative(changed).status, "in_sync");
  db.close();
});
