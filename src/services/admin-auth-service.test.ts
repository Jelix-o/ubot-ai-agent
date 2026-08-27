import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { AdminAuthError, AdminAuthService } from "./admin-auth-service.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function withAuth<T>(run: (auth: AdminAuthService, db: SharedDb) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-admin-auth-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  const auth = new AdminAuthService(db, {
    stateEncryptionKey: TEST_STATE_KEY,
    bootstrap: { username: "root-admin", password: "root-password" },
    sessionTtlMs: 60 * 60 * 1_000,
  });
  try {
    return await run(auth, db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function enrollBootstrap(auth: AdminAuthService) {
  const started = await auth.beginPasswordLogin({
    username: "root-admin",
    password: "root-password",
    loginKey: "bootstrap-login",
  });
  assert.equal(started.kind, "totp_enrollment_required");
  if (started.kind !== "totp_enrollment_required") throw new Error("expected_enrollment");
  const enrolled = await auth.completeTotpEnrollment({
    enrollmentToken: started.enrollmentToken,
    code: makeTotp(started.totpSecret),
  });
  assert.equal(enrolled.kind, "success");
  if (enrolled.kind !== "success") throw new Error("expected_enrollment_success");
  return { session: enrolled.session, recoveryCodes: enrolled.recoveryCodes ?? [], totpSecret: started.totpSecret };
}

test("AdminAuthService bootstraps legacy credentials once and never uses later environment credentials", async () => {
  await withAuth(async (auth, db) => {
    await auth.ensureInitialized();
    assert.deepEqual(auth.listAccounts().map((account) => ({ username: account.username, role: account.role })), [
      { username: "root-admin", role: "super_admin" },
    ]);

    const changedBootstrap = new AdminAuthService(db, {
      stateEncryptionKey: TEST_STATE_KEY,
      bootstrap: { username: "replacement-admin", password: "replacement-password" },
    });
    await changedBootstrap.ensureInitialized();
    assert.deepEqual(changedBootstrap.listAccounts().map((account) => account.username), ["root-admin"]);
    assert.equal((await changedBootstrap.beginPasswordLogin({
      username: "replacement-admin",
      password: "replacement-password",
      loginKey: "replacement-login",
    })).kind, "invalid_credentials");
  });
});

test("AdminAuthService enrollment encrypts TOTP state, rejects replay, and issues revocable opaque sessions", async () => {
  await withAuth(async (auth, db) => {
    const enrolled = await enrollBootstrap(auth);
    assert.equal(enrolled.recoveryCodes.length, 10);
    const ciphertext = db.db.prepare("SELECT totp_secret_ciphertext FROM admin_accounts WHERE username = ?")
      .get("root-admin") as { totp_secret_ciphertext: string };
    assert.ok(ciphertext.totp_secret_ciphertext);
    assert.equal(ciphertext.totp_secret_ciphertext.includes(enrolled.totpSecret), false);

    const login = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "totp-login",
    });
    assert.equal(login.kind, "totp_required");
    if (login.kind !== "totp_required") throw new Error("expected_totp_login");
    const nextCode = makeTotp(enrolled.totpSecret, Date.now() + 30_000);
    const completed = await auth.completeTotpLogin({ loginToken: login.loginToken, code: nextCode });
    assert.equal(completed.kind, "success");
    if (completed.kind !== "success") throw new Error("expected_totp_success");

    const replayLogin = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "totp-replay",
    });
    assert.equal(replayLogin.kind, "totp_required");
    if (replayLogin.kind !== "totp_required") throw new Error("expected_replay_login");
    assert.equal((await auth.completeTotpLogin({ loginToken: replayLogin.loginToken, code: nextCode })).kind, "invalid_totp");

    assert.ok(auth.getSession(completed.session.opaqueToken));
    auth.revokeSession(completed.session.sessionId, "test");
    assert.equal(auth.getSession(completed.session.opaqueToken), undefined);
  });
});

test("AdminAuthService consumes recovery codes exactly once under concurrent attempts", async () => {
  await withAuth(async (auth) => {
    const enrolled = await enrollBootstrap(auth);
    const recoveryCode = enrolled.recoveryCodes[0];
    assert.ok(recoveryCode);

    const results = await Promise.all([
      auth.completeRecoveryLogin({
        username: "root-admin",
        password: "root-password",
        recoveryCode,
        loginKey: "recovery-a",
      }),
      auth.completeRecoveryLogin({
        username: "root-admin",
        password: "root-password",
        recoveryCode,
        loginKey: "recovery-b",
      }),
    ]);
    assert.equal(results.filter((result) => result.kind === "success").length, 1);
    assert.equal(results.filter((result) => result.kind === "invalid_recovery_code").length, 1);
  });
});

test("AdminAuthService persists password rate limits", async () => {
  await withAuth(async (auth) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await auth.beginPasswordLogin({
        username: "root-admin",
        password: "wrong-password",
        loginKey: "same-client",
      })).kind, "invalid_credentials");
    }
    const locked = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "wrong-password",
      loginKey: "same-client",
    });
    assert.equal(locked.kind, "locked");
  });
});

test("AdminAuthService invitations enforce grants and protect the final super administrator", async () => {
  await withAuth(async (auth) => {
    const root = await enrollBootstrap(auth);
    const rootAccount = auth.listAccounts()[0];
    assert.ok(rootAccount);

    assert.throws(
      () => auth.createInvite({
        role: "group_admin",
        groupIds: [],
        expiresAt: Date.now() + 60_000,
        actorAccountId: root.session.userId!,
      }),
      (error: unknown) => error instanceof AdminAuthError && error.code === "group_admin_requires_group_grant",
    );
    const created = auth.createInvite({
      role: "group_admin",
      groupIds: ["10002", "10001", "10001"],
      expiresAt: Date.now() + 60_000,
      actorAccountId: root.session.userId!,
    });
    assert.deepEqual(created.invite.groupIds, ["10001", "10002"]);
    const accepted = await auth.acceptInvite({
      inviteToken: created.token,
      username: "group-operator",
      password: "group-password",
    });
    assert.equal(accepted.kind, "totp_enrollment_required");
    if (accepted.kind !== "totp_enrollment_required") throw new Error("expected_invite_enrollment");
    const groupEnrollment = await auth.completeTotpEnrollment({
      enrollmentToken: accepted.enrollmentToken,
      code: makeTotp(accepted.totpSecret),
    });
    assert.equal(groupEnrollment.kind, "success");
    const groupAccount = auth.listAccounts().find((account) => account.username === "group-operator");
    assert.ok(groupAccount);
    assert.deepEqual(groupAccount.groupIds, ["10001", "10002"]);
    assert.equal(auth.hasGroupGrant(groupAccount.id, "10001"), true);
    assert.equal(auth.hasGroupGrant(groupAccount.id, "99999"), false);

    assert.throws(
      () => auth.setGroupGrants(groupAccount.id, [], root.session.userId!),
      (error: unknown) => error instanceof AdminAuthError && error.code === "group_admin_requires_group_grant",
    );
    auth.setGroupGrants(groupAccount.id, ["10003"], root.session.userId!);
    assert.deepEqual(auth.listGrantedGroupIds(groupAccount.id), ["10003"]);

    assert.throws(
      () => auth.disableAccount(rootAccount.id, groupAccount.id),
      (error: unknown) => error instanceof AdminAuthError && error.code === "last_super_admin",
    );
  });
});

function makeTotp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const text = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid_test_totp_secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(now / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}
