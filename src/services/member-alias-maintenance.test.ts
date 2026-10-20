import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SharedDb } from "../shared/sqlite.js";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";
import { maintainMemberAlias, MEMBER_ALIAS_BACKUP_TYPE } from "./member-alias-maintenance.js";

const key = "0".repeat(64);
const input = { groupId: "67890", userId: "20001", expectedPrimaryName: "成员甲", alias: "甲别称" };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "alias-maintenance-"));
  const db = new SharedDb(path.join(dir, "state.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new V3StateRepository(db, { stateEncryptionKey: key });
  repo.markCutover();
  repo.saveGroup({ groupId: input.groupId, currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: ["90001"], liveChatUserIds: [], replyModelMode: "sol", manualIdentities: [
    { userIds: ["20001"], names: ["成员甲", "甲原称"], note: "保留管理员备注" },
    { userIds: ["20002"], names: ["成员乙"] },
  ] });
  return repo;
}

test("alias maintenance is parameterized, additive, encrypted, idempotent and preserves complete config", t => {
  const repo = fixture(t), before = repo.getGroup(input.groupId)!;
  assert.equal(maintainMemberAlias(repo, key, input).reason, "ready");
  assert.deepEqual(repo.getGroup(input.groupId), before);
  const applied = maintainMemberAlias(repo, key, input, true);
  assert.equal(applied.applied, true);
  assert.deepEqual(repo.getGroup(input.groupId), { ...before, manualIdentities: [{ ...before.manualIdentities![0], names: ["成员甲", "甲原称", "甲别称"] }, before.manualIdentities![1]] });
  const backup = repo.getDocument<{ ciphertext: string }>(MEMBER_ALIAS_BACKUP_TYPE, applied.backupKey, { ciphertext: "" });
  assert.equal(backup.ciphertext.includes("成员甲"), false);
  assert.deepEqual(JSON.parse(new StateCipher(key).decrypt(applied.backupKey, backup.ciphertext)), before);
  assert.equal(maintainMemberAlias(repo, key, { ...input, alias: " 甲别称 " }, true).reason, "already_present");
  repo.saveGroup(before);
  assert.throws(() => maintainMemberAlias(repo, key, input, true), /previously_applied_then_changed/);
});

test("alias maintenance rejects changed or ambiguous targets and occupied aliases without writes", t => {
  const repo = fixture(t), before = repo.getGroup(input.groupId)!;
  for (const changed of [{ ...input, userId: "20003" }, { ...input, expectedPrimaryName: "旧名" }, { ...input, alias: "成员乙" }]) {
    assert.throws(() => maintainMemberAlias(repo, key, changed, true), /target_changed_or_not_unique|already_owned/);
    assert.deepEqual(repo.getGroup(input.groupId), before);
  }
  repo.saveGroup({ ...before, manualIdentities: [...before.manualIdentities!, { userIds: [input.userId], names: ["重复绑定"] }] });
  assert.throws(() => maintainMemberAlias(repo, key, input, true), /not_unique/);
  for (const alias of ["", "20001", "bad\nname", "[CQ:at,qq=20001]", "a".repeat(65)]) {
    assert.throws(() => maintainMemberAlias(repo, key, { ...input, alias }, true), /invalid_member_alias_input/);
  }
});

test("alias maintenance rolls back the encrypted snapshot when the config write fails", t => {
  const repo = fixture(t), before = repo.getGroup(input.groupId)!;
  const { backupKey } = maintainMemberAlias(repo, key, input);
  repo.saveGroup = () => { throw new Error("write failed"); };
  assert.throws(() => maintainMemberAlias(repo, key, input, true), /write failed/);
  assert.deepEqual(repo.getGroup(input.groupId), before);
  assert.deepEqual(repo.getDocument(MEMBER_ALIAS_BACKUP_TYPE, backupKey, {}), {});
});
