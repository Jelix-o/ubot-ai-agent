import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupsConfigFile } from "../types.js";
import { SharedDb } from "../shared/sqlite.js";
import { GroupConfigSqliteShadowRepository } from "./group-config-sqlite-shadow-repository.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "group-config-shadow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "bot-shared.db");
}

const INITIAL_CONFIG: GroupsConfigFile = {
  superAdminUserIds: ["10001"],
  groups: [
    {
      groupId: "67890",
      groupName: "Test group",
      currentSkillId: "huixian",
      allowedSkillIds: ["huixian"],
      switcherUserIds: [],
      liveChatUserIds: [],
      enabled: false,
      botMuted: true,
    },
  ],
};

test("SQLite group-config shadow is non-authoritative, canonical and divergence-aware", (t) => {
  const db = new SharedDb(tempDb(t));
  const repository = new GroupConfigSqliteShadowRepository(db);

  assert.equal(repository.compareAuthoritative(INITIAL_CONFIG).status, "missing");
  const first = repository.syncFromAuthoritative(INITIAL_CONFIG);
  assert.equal(first.status, "created");
  assert.equal(first.groupCount, 1);
  const snapshot = repository.getSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot?.group_count, 1);
  assert.deepEqual(JSON.parse(snapshot?.snapshot_json ?? "{}"), INITIAL_CONFIG);

  const second = repository.syncFromAuthoritative(INITIAL_CONFIG);
  assert.equal(second.status, "unchanged");
  assert.equal(repository.compareAuthoritative(INITIAL_CONFIG).status, "in_sync");

  const changed: GroupsConfigFile = {
    ...INITIAL_CONFIG,
    groups: [{ ...INITIAL_CONFIG.groups[0]!, botMuted: false }],
  };
  const comparison = repository.compareAuthoritative(changed);
  assert.equal(comparison.status, "out_of_sync");
  assert.equal(repository.getSnapshot()?.snapshot_hash, snapshot?.snapshot_hash, "compare must not mutate the shadow");

  const updated = repository.syncFromAuthoritative(changed);
  assert.equal(updated.status, "updated");
  assert.equal(repository.compareAuthoritative(changed).status, "in_sync");
  db.close();
});

test("canonical serialization ignores object-key order but preserves config array order", (t) => {
  const db = new SharedDb(tempDb(t));
  const repository = new GroupConfigSqliteShadowRepository(db);
  repository.syncFromAuthoritative(INITIAL_CONFIG);

  const equivalentDifferentKeyOrder: GroupsConfigFile = {
    groups: INITIAL_CONFIG.groups.map((group) => ({
      enabled: group.enabled,
      liveChatUserIds: group.liveChatUserIds,
      allowedSkillIds: group.allowedSkillIds,
      groupId: group.groupId,
      currentSkillId: group.currentSkillId,
      groupName: group.groupName,
      switcherUserIds: group.switcherUserIds,
      botMuted: group.botMuted,
    })),
    superAdminUserIds: INITIAL_CONFIG.superAdminUserIds,
  };
  assert.equal(repository.compareAuthoritative(equivalentDifferentKeyOrder).status, "in_sync");

  const reordered: GroupsConfigFile = {
    ...INITIAL_CONFIG,
    superAdminUserIds: ["20002", "10001"],
  };
  assert.equal(repository.compareAuthoritative(reordered).status, "out_of_sync");
  db.close();
});
