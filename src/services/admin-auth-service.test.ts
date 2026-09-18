import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { AdminAuthError, AdminAuthService } from "./admin-auth-service.js";

async function withAuth<T>(run: (auth: AdminAuthService, db: SharedDb) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-admin-auth-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  const auth = new AdminAuthService(db, {
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

async function loginRoot(auth: AdminAuthService, loginKey: string) {
  const result = await auth.beginPasswordLogin({
    username: "root-admin",
    password: "root-password",
    loginKey,
  });
  assert.equal(result.kind, "authenticated");
  if (result.kind !== "authenticated") throw new Error("expected_authenticated_login");
  return result.session;
}

test("AdminAuthService bootstraps legacy credentials once and never uses later environment credentials", async () => {
  await withAuth(async (auth, db) => {
    await auth.ensureInitialized();
    assert.deepEqual(auth.listAccounts().map((account) => ({ username: account.username, role: account.role })), [
      { username: "root-admin", role: "super_admin" },
    ]);

    const changedBootstrap = new AdminAuthService(db, {
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

test("AdminAuthService password login succeeds, rejects bad credentials, and rate-limits the client key", async () => {
  await withAuth(async (auth) => {
    const success = await loginRoot(auth, "password-success");
    assert.equal(success.username, "root-admin");
    assert.equal(success.role, "super_admin");
    assert.ok(success.userId);
    assert.ok(success.opaqueToken);
    assert.ok(success.csrfToken);
    assert.ok(success.expiresAt);
    assert.ok(success.reauthVerifiedAt > 0);
    assert.deepEqual(success.allowedGroupIds, []);

    assert.equal((await auth.beginPasswordLogin({
      username: "root-admin",
      password: "not-the-password",
      loginKey: "password-failure",
    })).kind, "invalid_credentials");
    assert.equal((await auth.beginPasswordLogin({
      username: "missing-admin",
      password: "root-password",
      loginKey: "password-missing-user",
    })).kind, "invalid_credentials");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await auth.beginPasswordLogin({
        username: "root-admin",
        password: "wrong-password!",
        loginKey: "rate-limited-client",
      })).kind, "invalid_credentials");
    }
    const locked = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "rate-limited-client",
    });
    assert.equal(locked.kind, "locked");
    if (locked.kind !== "locked") throw new Error("expected_locked");
    assert.ok(locked.retryAfterSeconds > 0);

    const otherClient = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "rate-limit-other-client",
    });
    assert.equal(otherClient.kind, "authenticated");
  });
});

test("AdminAuthService resolves sessions, validates CSRF, rotates tokens, and revokes on logout", async () => {
  await withAuth(async (auth) => {
    const session = await loginRoot(auth, "session-lifecycle");

    const resolved = auth.getSession(session.opaqueToken);
    assert.ok(resolved);
    assert.equal(resolved?.sessionId, session.sessionId);
    assert.equal(resolved?.username, "root-admin");
    assert.equal(resolved?.role, "super_admin");
    // CSRF stays server-side; getSession never re-exposes the opaque token material.
    assert.equal(resolved?.csrfToken, "");
    assert.equal(auth.getSession(undefined), undefined);
    assert.equal(auth.getSession("not-a-real-token"), undefined);

    assert.equal(auth.validateCsrf(session, session.csrfToken), true);
    assert.equal(auth.validateCsrf(session, "wrong-csrf"), false);
    assert.equal(auth.validateCsrf(session, undefined), false);

    const rotated = auth.rotateCsrfToken(session);
    assert.ok(rotated);
    assert.notEqual(rotated, session.csrfToken);
    assert.equal(auth.validateCsrf(session, session.csrfToken), false);
    assert.equal(auth.validateCsrf(session, rotated), true);

    auth.revokeSession(session.sessionId, "logout");
    assert.equal(auth.getSession(session.opaqueToken), undefined);
  });
});

test("AdminAuthService password change requires recent reauth, enforces min length 12, and revokes other sessions", async () => {
  await withAuth(async (auth, db) => {
    const first = await loginRoot(auth, "password-change-first");
    const second = await loginRoot(auth, "password-change-second");

    db.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ? WHERE id = ?")
      .run(Date.now() - 15 * 60 * 1_000, first.sessionId);
    const stale = auth.getSession(first.opaqueToken);
    assert.ok(stale);

    assert.equal(await auth.changePassword({
      session: stale!,
      currentPassword: "root-password",
      nextPassword: "next-root-password-12",
    }), "recent_reauth_required");

    assert.equal(await auth.completeSessionReauth(stale!, "wrong-password"), false);
    assert.equal(await auth.completeSessionReauth(stale!, "root-password"), true);

    await assert.rejects(
      () => auth.changePassword({
        session: stale!,
        currentPassword: "root-password",
        nextPassword: "too-short",
      }),
      (error: unknown) => error instanceof AdminAuthError && error.code === "invalid_password",
    );

    assert.equal(await auth.changePassword({
      session: stale!,
      currentPassword: "not-the-current-password",
      nextPassword: "next-root-password-12",
    }), "invalid_current_password");

    assert.equal(await auth.changePassword({
      session: stale!,
      currentPassword: "root-password",
      nextPassword: "next-root-password-12",
    }), "ok");

    assert.equal(auth.getSession(second.opaqueToken), undefined);
    assert.ok(auth.getSession(first.opaqueToken));

    assert.equal((await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "password-change-old",
    })).kind, "invalid_credentials");
    const nextLogin = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "next-root-password-12",
      loginKey: "password-change-new",
    });
    assert.equal(nextLogin.kind, "authenticated");
  });
});

test("AdminAuthService invitations enforce grants, password policy, revocation, and unique usernames", async () => {
  await withAuth(async (auth) => {
    const root = await loginRoot(auth, "invite-root");
    const rootAccountId = root.userId;
    assert.ok(rootAccountId);

    assert.throws(
      () => auth.createInvite({
        role: "group_admin",
        groupIds: [],
        expiresAt: Date.now() + 60_000,
        actorAccountId: rootAccountId!,
      }),
      (error: unknown) => error instanceof AdminAuthError && error.code === "group_admin_requires_group_grant",
    );

    const created = auth.createInvite({
      role: "group_admin",
      groupIds: ["10002", "10001", "10001"],
      expiresAt: Date.now() + 60_000,
      actorAccountId: rootAccountId!,
    });
    assert.ok(created.token);
    assert.deepEqual(created.invite.groupIds, ["10001", "10002"]);

    await assert.rejects(
      () => auth.acceptInvite({
        inviteToken: created.token,
        username: "group-operator",
        password: "short",
      }),
      (error: unknown) => error instanceof AdminAuthError && error.code === "invalid_password",
    );

    const accepted = await auth.acceptInvite({
      inviteToken: created.token,
      username: "group-operator",
      password: "group-password-12",
    });
    assert.equal(accepted.kind, "authenticated");
    if (accepted.kind !== "authenticated") throw new Error("expected_invite_authenticated");
    assert.equal(accepted.session.username, "group-operator");
    assert.equal(accepted.session.role, "group_admin");
    assert.deepEqual(accepted.session.allowedGroupIds, ["10001", "10002"]);

    const groupAccount = auth.listAccounts().find((account) => account.username === "group-operator");
    assert.ok(groupAccount);
    assert.deepEqual(groupAccount.groupIds, ["10001", "10002"]);
    assert.equal(auth.hasGroupGrant(groupAccount.id, "10001"), true);
    assert.equal(auth.hasGroupGrant(groupAccount.id, "99999"), false);

    assert.throws(
      () => auth.setGroupGrants(groupAccount.id, [], rootAccountId!),
      (error: unknown) => error instanceof AdminAuthError && error.code === "group_admin_requires_group_grant",
    );
    auth.setGroupGrants(groupAccount.id, ["10003"], rootAccountId!);
    assert.deepEqual(auth.listGrantedGroupIds(groupAccount.id), ["10003"]);

    const reused = auth.createInvite({
      role: "group_admin",
      groupIds: ["20001"],
      expiresAt: Date.now() + 60_000,
      actorAccountId: rootAccountId!,
    });
    const taken = await auth.acceptInvite({
      inviteToken: reused.token,
      username: "group-operator",
      password: "another-password-12",
    });
    assert.equal(taken.kind, "username_taken");

    const revokedInvite = auth.createInvite({
      role: "group_admin",
      groupIds: ["30001"],
      expiresAt: Date.now() + 60_000,
      actorAccountId: rootAccountId!,
    });
    auth.revokeInvite(revokedInvite.invite.id, rootAccountId!);
    const afterRevoke = await auth.acceptInvite({
      inviteToken: revokedInvite.token,
      username: "revoked-operator",
      password: "revoked-password-12",
    });
    assert.equal(afterRevoke.kind, "invalid_invite");
  });
});

test("AdminAuthService manages unique QQ bindings and records their audit trail", async () => {
  await withAuth(async (auth, db) => {
    await auth.ensureInitialized();
    const account = auth.listAccounts()[0];
    assert.ok(account);

    auth.setQqBinding(account.id, "1569671790", account.id);
    assert.equal(auth.listAccounts()[0]?.qqUserId, "1569671790");
    assert.throws(() => auth.setQqBinding(account.id, "abc", account.id), (error: unknown) => (
      error instanceof AdminAuthError && error.code === "invalid_qq_user_id"
    ));

    const secondId = "second-admin";
    db.db.prepare(
      `INSERT INTO admin_accounts (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, 'super_admin', ?, ?)`,
    ).run(secondId, "second", "unused", Date.now(), Date.now());
    assert.throws(() => auth.setQqBinding(secondId, "1569671790", account.id), (error: unknown) => (
      error instanceof AdminAuthError && error.code === "qq_user_id_already_bound"
    ));

    auth.removeQqBinding(account.id, account.id);
    assert.equal(auth.listAccounts()[0]?.qqUserId, undefined);
    const actions = auth.listAuthAudit().map((entry) => entry.action);
    assert.ok(actions.includes("admin_qq_binding_updated"));
    assert.ok(actions.includes("admin_qq_binding_removed"));

    auth.setQqBinding(secondId, "1569671790", account.id);
    db.db.prepare("DELETE FROM admin_accounts WHERE id = ?").run(secondId);
    assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM admin_qq_bindings").get() as { count: number }).count, 0);
  });
});

test("AdminAuthService disableAccount blocks login and protects the last super administrator", async () => {
  await withAuth(async (auth) => {
    const root = await loginRoot(auth, "disable-root");
    const rootAccountId = root.userId;
    assert.ok(rootAccountId);
    const rootAccount = auth.listAccounts().find((account) => account.username === "root-admin");
    assert.ok(rootAccount);

    const groupInvite = auth.createInvite({
      role: "group_admin",
      groupIds: ["67890"],
      expiresAt: Date.now() + 60_000,
      actorAccountId: rootAccountId!,
    });
    const groupAccepted = await auth.acceptInvite({
      inviteToken: groupInvite.token,
      username: "disable-operator",
      password: "disable-password-12",
    });
    assert.equal(groupAccepted.kind, "authenticated");
    if (groupAccepted.kind !== "authenticated") throw new Error("expected_group_invite");
    const groupAccountId = groupAccepted.session.userId;
    assert.ok(groupAccountId);

    assert.throws(
      () => auth.disableAccount(rootAccountId!, rootAccountId!),
      (error: unknown) => error instanceof AdminAuthError && error.code === "cannot_disable_self",
    );
    assert.throws(
      () => auth.disableAccount(rootAccountId!, groupAccountId!),
      (error: unknown) => error instanceof AdminAuthError && error.code === "last_super_admin",
    );

    const superInvite = auth.createInvite({
      role: "super_admin",
      groupIds: [],
      expiresAt: Date.now() + 60_000,
      actorAccountId: rootAccountId!,
    });
    const superAccepted = await auth.acceptInvite({
      inviteToken: superInvite.token,
      username: "second-root",
      password: "second-root-password-12",
    });
    assert.equal(superAccepted.kind, "authenticated");
    if (superAccepted.kind !== "authenticated") throw new Error("expected_super_invite");

    auth.disableAccount(rootAccountId!, superAccepted.session.userId!);
    assert.equal((await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "disabled-root-login",
    })).kind, "invalid_credentials");
    assert.equal(auth.getSession(root.opaqueToken), undefined);

    const secondLogin = await auth.beginPasswordLogin({
      username: "second-root",
      password: "second-root-password-12",
      loginKey: "second-root-login",
    });
    assert.equal(secondLogin.kind, "authenticated");
  });
});

test("AdminAuthService resetPasswordFromServer revokes every session and installs the new password", async () => {
  await withAuth(async (auth) => {
    const session = await loginRoot(auth, "reset-password-session");
    await auth.resetPasswordFromServer("root-admin", "brand-new-password-12");

    assert.equal(auth.getSession(session.opaqueToken), undefined);
    assert.equal((await auth.beginPasswordLogin({
      username: "root-admin",
      password: "root-password",
      loginKey: "reset-old-password",
    })).kind, "invalid_credentials");

    const next = await auth.beginPasswordLogin({
      username: "root-admin",
      password: "brand-new-password-12",
      loginKey: "reset-new-password",
    });
    assert.equal(next.kind, "authenticated");
  });
});
