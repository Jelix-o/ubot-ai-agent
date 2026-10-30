import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import { SelfMemoryService } from "./self-memory-service.js";
import type { GroupMemory } from "../types.js";

async function fixture(run: (service: SelfMemoryService, repo: V3StateRepository) => void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-self-memory-"));
  const db = new SharedDb(path.join(dir, "state.db"));
  try {
    const repo = new V3StateRepository(db, { stateEncryptionKey: "0".repeat(64) });
    for (const groupId of ["10001", "10002"]) repo.saveGroup({ groupId, enabled: true, currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], groupExperienceEnabled: true });
    for (let i = 0; i < 7; i++) repo.saveMemory(memory(`explicit-${i}`, "10001", "20001"));
    repo.saveMemory(memory("another-person", "10001", "20002"));
    repo.saveMemory(memory("another-group", "10002", "20001"));
    repo.saveMemory({ ...memory("admin-profile", "10001", "20001"), source: "admin" });
    run(new SelfMemoryService(repo), repo);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
function memory(id: string, groupId: string, subjectUserId: string): GroupMemory {
  return { id, groupId, subjectUserId, type: "member_profile", title: "显式偏好", content: "喜欢无糖茶", source: "explicit_command", confidence: 1, enabled: true, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" };
}
test("self memory paginates owned explicit records and guards writes by ownership and revision", async () => fixture((service, repo) => {
  assert.equal(service.list("10001", "20001").items.length, 5);
  assert.equal(service.list("10001", "20001", 2).items.length, 2);
  assert.equal(service.list("10001", "20001").total, 7);
  const item = service.resolve("10001", "20001", "explicit-0");
  service.edit("10001", "20001", item.id, "喜欢柠檬水", item.revision);
  assert.throws(() => service.remove("10001", "20001", item.id, item.revision), /target_changed/);
  for (const id of ["another-person", "another-group", "admin-profile"]) assert.throws(() => service.resolve("10001", "20001", id), /memory_not_found/);
  assert.equal(repo.getMemory(item.id)?.content, "喜欢柠檬水");
  const audit = JSON.stringify(repo.listDocuments("admin-operation"));
  assert.doesNotMatch(audit, /喜欢|柠檬|无糖/);
}));
test("delete all confirmation is bound to member, group, snapshot and expiry and survives service restart", async () => fixture((service, repo) => {
  let code = service.prepareDeleteAll("10001", "20001", 1000);
  assert.throws(() => service.confirmDeleteAll("10002", "20001", code, 2000), /confirmation_invalid/);
  assert.throws(() => service.confirmDeleteAll("10001", "20002", code, 2000), /confirmation_invalid/);
  assert.throws(() => service.confirmDeleteAll("10001", "20001", code, 31_000), /confirmation_invalid/);
  code = service.prepareDeleteAll("10001", "20001", 32_000);
  repo.saveMemory(memory("explicit-new", "10001", "20001"));
  assert.throws(() => service.confirmDeleteAll("10001", "20001", code, 33_000), /target_changed/);
  code = service.prepareDeleteAll("10001", "20001", 34_000);
  assert.equal(new SelfMemoryService(repo).confirmDeleteAll("10001", "20001", code, 35_000), 8);
  assert.throws(() => service.confirmDeleteAll("10001", "20001", code, 35_001), /confirmation_invalid/);
  assert.ok(repo.getMemory("admin-profile")); assert.ok(repo.getMemory("another-group")); assert.ok(repo.getMemory("another-person"));
}));
test("privacy opt-out, disabled groups and sensitive content are enforced at mutation time", async () => fixture((service, repo) => {
  const item = service.resolve("10001", "20001", "explicit-0");
  assert.throws(() => service.edit("10001", "20001", item.id, "我的密码是 abcdef123456", item.revision), /sensitive_content/);
  const group = repo.getGroup("10001")!;
  repo.saveGroup({ ...group, memoryDisabledUserIds: ["20001"] });
  assert.throws(() => service.remove("10001", "20001", item.id, item.revision), /memory_unavailable/);
  repo.saveGroup({ ...group, enabled: false });
  assert.throws(() => service.list("10001", "20001"), /memory_unavailable/);
}));
