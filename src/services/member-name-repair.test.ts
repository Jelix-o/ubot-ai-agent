import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SharedDb } from "../shared/sqlite.js";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";
import { repairMemberName } from "./member-name-repair.js";

const key = "0".repeat(64);
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "member-name-repair-"));
  const db = new SharedDb(path.join(dir, "state.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new V3StateRepository(db, { stateEncryptionKey: key });
  repo.markCutover();
  repo.saveGroup({ groupId: "1044162764", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], replyModelMode: "sol", manualIdentities: [
    { userIds: ["2458031445"], names: ["外包仔", "外包仙人"], note: "保持备注" },
    { userIds: ["1418509802"], names: ["鸡哥"] },
  ] });
  return repo;
}

test("targeted name repair backs up atomically, preserves other fields and never reapplies", t => {
  const repo = fixture(t);
  const before = repo.getGroup("1044162764")!;
  assert.equal(repairMemberName(repo, key).reason, "ready");
  assert.deepEqual(repo.getGroup("1044162764"), before);
  assert.equal(repairMemberName(repo, key, true).applied, true);
  const after = repo.getGroup("1044162764")!;
  assert.deepEqual(after, { ...before, manualIdentities: [{ ...before.manualIdentities![0], names: ["外包仙人"] }, before.manualIdentities![1]] });
  const backup = repo.getDocument<{ ciphertext: string }>("release-policy-backup", "v3.0.46-member-names", { ciphertext: "" });
  assert.equal(backup.ciphertext.includes("外包仔"), false);
  assert.deepEqual(JSON.parse(new StateCipher(key).decrypt("v3.0.46-member-names", backup.ciphertext)), { groupId: before.groupId, identity: before.manualIdentities![0] });
  assert.equal(repairMemberName(repo, key, true).applied, false);
});

test("targeted name repair skips changed records and rolls back backup on write failure", t => {
  const repo = fixture(t);
  const before = repo.getGroup("1044162764")!;
  const save = repo.saveGroup.bind(repo);
  repo.saveGroup = () => { throw new Error("write failed"); };
  assert.throws(() => repairMemberName(repo, key, true), /write failed/);
  assert.deepEqual(repo.getGroup("1044162764"), before);
  assert.deepEqual(repo.getDocument("release-policy-backup", "v3.0.46-member-names", {}), {});
  repo.saveGroup = save;
  save({ ...before, manualIdentities: [{ ...before.manualIdentities![0]!, names: ["管理员后续新名"] }] });
  assert.equal(repairMemberName(repo, key, true).reason, "record_changed_or_missing");
  assert.deepEqual(repo.getGroup("1044162764")!.manualIdentities![0]!.names, ["管理员后续新名"]);
});
