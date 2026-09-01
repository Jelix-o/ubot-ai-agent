import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { QqAdminAuthorizationService } from "./qq-admin-authorization-service.js";

test("QQ authorization inherits active account role and group grants without caching", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-qq-auth-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(() => { db.close(); });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const insertAccount = db.db.prepare(
    `INSERT INTO admin_accounts (id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, 'unused', ?, ?, ?)`,
  );
  insertAccount.run("super", "super", "super_admin", now, now);
  insertAccount.run("group", "group", "group_admin", now, now);
  db.db.prepare(
    "INSERT INTO admin_qq_bindings (qq_user_id, account_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("1569671790", "super", "super", now, now);
  db.db.prepare(
    "INSERT INTO admin_qq_bindings (qq_user_id, account_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("200001", "group", "super", now, now);
  db.db.prepare(
    "INSERT INTO admin_group_grants (account_id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)",
  ).run("group", "allowed", "super", now);

  const service = new QqAdminAuthorizationService(db);
  assert.equal(service.resolve("1569671790", "any-group")?.role, "super_admin");
  assert.equal(service.resolve("200001", "allowed")?.role, "group_admin");
  assert.equal(service.resolve("200001", "denied"), undefined);
  assert.equal(service.resolve("999999", "allowed"), undefined);

  db.db.prepare("UPDATE admin_accounts SET disabled_at = ? WHERE id = 'super'").run(Date.now());
  assert.equal(service.resolve("1569671790", "any-group"), undefined);
  db.db.prepare("DELETE FROM admin_group_grants WHERE account_id = 'group'").run();
  assert.equal(service.resolve("200001", "allowed"), undefined);
  db.db.prepare("DELETE FROM admin_qq_bindings WHERE account_id = 'group'").run();
  assert.equal(service.resolve("200001", "allowed"), undefined);
});
