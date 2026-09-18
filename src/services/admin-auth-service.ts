import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import type { SharedDb } from "../shared/sqlite.js";
import type { AdminRole, AdminSession } from "../types.js";

const LOGIN_WINDOW_MS = 10 * 60 * 1_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const RECENT_REAUTH_MS = 10 * 60 * 1_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 512;

export interface AdminAuthServiceOptions {
  bootstrap?: {
    username: string;
    password: string;
  };
  sessionTtlMs?: number;
}

export interface AdminAuthAccount {
  id: string;
  username: string;
  role: AdminRole;
  groupIds: string[];
  qqUserId?: string;
  disabledAt?: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AdminAuthSession extends AdminSession {
  sessionId: string;
  /** Kept server-side only. It is never serialized in a JSON response. */
  opaqueToken: string;
  reauthVerifiedAt: number;
}

export interface AdminAuthRequestMeta {
  ip?: string;
  userAgent?: string;
}

export type PasswordLoginResult =
  | { kind: "invalid_credentials" }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "authenticated"; session: AdminAuthSession };

export interface AdminInvite {
  id: string;
  role: AdminRole;
  groupIds: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  usedAt?: string;
}

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  disabled_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

interface SessionRow {
  id: string;
  account_id: string;
  csrf_token_hash: string;
  expires_at: number;
  last_seen_at: number;
  reauth_verified_at: number;
  username: string;
  role: AdminRole;
  disabled_at: number | null;
}

interface InviteRow {
  id: string;
  role: AdminRole;
  group_ids_json: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

/**
 * SQLite authority for the administrator login boundary. The v7 migration is
 * intentionally owned by SharedDb; this class only reads and writes those
 * tables and refuses to silently fall back to a file or signed cookie.
 */
export class AdminAuthService {
  private readonly sessionTtlMs: number;
  private bootstrapPromise?: Promise<void>;

  constructor(
    private readonly sharedDb: SharedDb,
    private readonly options: AdminAuthServiceOptions,
  ) {
    this.sessionTtlMs = Math.max(60_000, options.sessionTtlMs ?? SESSION_TTL_MS);
  }

  async ensureInitialized(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrapLegacyAdmin();
    }
    return this.bootstrapPromise;
  }

  async beginPasswordLogin(input: {
    username: string;
    password: string;
    loginKey: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<PasswordLoginResult> {
    await this.ensureInitialized();
    const now = Date.now();
    const rate = this.getRateLimit("password_login", input.loginKey);
    if (rate.lockedUntil && rate.lockedUntil > now) {
      return {
        kind: "locked",
        retryAfterSeconds: Math.max(1, Math.ceil((rate.lockedUntil - now) / 1_000)),
      };
    }

    const username = normalizeUsername(input.username);
    const account = username ? this.findAccountByUsername(username) : undefined;
    const valid = Boolean(account && !account.disabled_at && await verifyPassword(input.password, account.password_hash));
    if (!valid || !account) {
      this.recordLoginFailure("password_login", input.loginKey, now);
      this.writeAudit({
        action: "login_password_failed",
        detail: { username: username || "invalid" },
        meta: input.meta,
      });
      return { kind: "invalid_credentials" };
    }

    this.clearRateLimit("password_login", input.loginKey);
    const session = this.createSession(account, input.meta, now);
    this.sharedDb.db.prepare("UPDATE admin_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, account.id);
    this.writeAudit({ accountId: account.id, action: "login_password_success", meta: input.meta });
    return { kind: "authenticated", session };
  }

  getSession(opaqueToken: string | undefined): AdminAuthSession | undefined {
    if (!opaqueToken) return undefined;
    const now = Date.now();
    const row = this.sharedDb.db.prepare(
      `SELECT s.id, s.account_id, s.csrf_token_hash, s.expires_at, s.last_seen_at, s.reauth_verified_at,
              a.username, a.role, a.disabled_at
         FROM admin_sessions s
         JOIN admin_accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    ).get(hashToken(opaqueToken), now) as SessionRow | undefined;
    if (!row || row.disabled_at) return undefined;
    if (row.last_seen_at < now - 60_000) {
      this.sharedDb.db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id);
    }
    return {
      sessionId: row.id,
      opaqueToken,
      userId: row.account_id,
      username: row.username,
      role: row.role,
      allowedGroupIds: this.listGrantedGroupIds(row.account_id),
      csrfToken: "",
      expiresAt: new Date(row.expires_at).toISOString(),
      reauthVerifiedAt: row.reauth_verified_at,
    };
  }

  rotateCsrfToken(session: AdminAuthSession): string {
    const token = randomToken();
    this.sharedDb.db.prepare("UPDATE admin_sessions SET csrf_token_hash = ? WHERE id = ? AND revoked_at IS NULL")
      .run(hashToken(token), session.sessionId);
    return token;
  }

  validateCsrf(session: AdminAuthSession, token: string | undefined): boolean {
    if (!token) return false;
    const row = this.sharedDb.db.prepare(
      "SELECT csrf_token_hash FROM admin_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
    ).get(session.sessionId, Date.now()) as { csrf_token_hash: string } | undefined;
    return Boolean(row && safeEqualHash(hashToken(token), row.csrf_token_hash));
  }

  revokeSession(sessionId: string, reason = "logout"): void {
    const row = this.sharedDb.db.prepare("SELECT account_id FROM admin_sessions WHERE id = ?").get(sessionId) as { account_id: string } | undefined;
    this.sharedDb.db.prepare("UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(Date.now(), sessionId);
    if (row) this.writeAudit({ accountId: row.account_id, action: `session_revoked:${reason}` });
  }

  revokeAllSessions(accountId: string, actorAccountId?: string): number {
    const result = this.sharedDb.db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(Date.now(), accountId);
    this.writeAudit({ accountId: actorAccountId, targetAccountId: accountId, action: "sessions_revoked" });
    return Number(result.changes ?? 0);
  }

  hasRecentReauth(session: AdminAuthSession): boolean {
    return session.reauthVerifiedAt >= Date.now() - RECENT_REAUTH_MS;
  }

  async completeSessionReauth(session: AdminAuthSession, password: string, meta?: AdminAuthRequestMeta): Promise<boolean> {
    const account = this.findAccountById(session.userId ?? "");
    if (!account || account.disabled_at) return false;
    const rate = this.getRateLimit("password_reauth", account.id);
    if (rate.lockedUntil && rate.lockedUntil > Date.now()) return false;
    if (!await verifyPassword(password, account.password_hash)) {
      this.recordLoginFailure("password_reauth", account.id, Date.now());
      this.writeAudit({ accountId: account.id, action: "password_reauthentication_failed", meta });
      return false;
    }
    const now = Date.now();
    const result = this.sharedDb.db.prepare(
      "UPDATE admin_sessions SET reauth_verified_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    ).run(now, session.sessionId, account.id);
    if (Number(result.changes ?? 0) !== 1) return false;
    session.reauthVerifiedAt = now;
    this.clearRateLimit("password_reauth", account.id);
    this.writeAudit({ accountId: account.id, action: "password_reauthenticated", meta });
    return true;
  }

  async changePassword(input: {
    session: AdminAuthSession;
    currentPassword: string;
    nextPassword: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<"ok" | "invalid_current_password" | "recent_reauth_required"> {
    if (!input.session.userId || !this.hasRecentReauth(input.session)) return "recent_reauth_required";
    try {
      assertPasswordPolicy(input.nextPassword);
    } catch {
      this.writeAudit({ accountId: input.session.userId, action: "password_change_failed", meta: input.meta });
      throw new AdminAuthError("invalid_password", 400);
    }
    const account = this.findAccountById(input.session.userId);
    if (!account || account.disabled_at || !await verifyPassword(input.currentPassword, account.password_hash)) {
      this.writeAudit({ accountId: input.session.userId, action: "password_change_failed", meta: input.meta });
      return "invalid_current_password";
    }
    const passwordHash = await hashPassword(input.nextPassword);
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.sharedDb.db.prepare("UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, now, account.id);
      this.sharedDb.db.prepare(
        "UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND id <> ? AND revoked_at IS NULL",
      ).run(now, account.id, input.session.sessionId);
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({ accountId: account.id, action: "password_changed", meta: input.meta });
    return "ok";
  }

  async resetPasswordFromServer(usernameInput: string, nextPassword: string): Promise<void> {
    await this.ensureInitialized();
    const username = normalizeUsername(usernameInput);
    const account = username ? this.findAccountByUsername(username) : undefined;
    if (!account) throw new AdminAuthError("not_found", 404);
    assertPasswordPolicy(nextPassword);
    const passwordHash = await hashPassword(nextPassword);
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.sharedDb.db.prepare("UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now, account.id);
      this.sharedDb.db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
        .run(now, account.id);
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({
      targetAccountId: account.id,
      action: "password_reset_from_server_terminal",
      detail: { username: account.username },
    });
  }

  listAccounts(): AdminAuthAccount[] {
    const rows = this.sharedDb.db.prepare(
      `SELECT id, username, role, disabled_at, created_at, last_login_at
         FROM admin_accounts ORDER BY created_at ASC, username COLLATE NOCASE ASC`,
    ).all() as Array<Pick<AccountRow, "id" | "username" | "role" | "disabled_at" | "created_at" | "last_login_at">>;
    return rows.map((row) => {
      const qqUserId = this.getQqBinding(row.id);
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        groupIds: this.listGrantedGroupIds(row.id),
        ...(qqUserId ? { qqUserId } : {}),
        ...(row.disabled_at ? { disabledAt: new Date(row.disabled_at).toISOString() } : {}),
        createdAt: new Date(row.created_at).toISOString(),
        ...(row.last_login_at ? { lastLoginAt: new Date(row.last_login_at).toISOString() } : {}),
      };
    });
  }

  setQqBinding(accountId: string, qqUserId: string, actorAccountId: string): void {
    const account = this.findAccountById(accountId);
    if (!account) throw new AdminAuthError("not_found", 404);
    const normalized = normalizeQqUserId(qqUserId);
    if (!normalized) throw new AdminAuthError("invalid_qq_user_id", 400);
    const now = Date.now();
    try {
      this.sharedDb.db.prepare(
        `INSERT INTO admin_qq_bindings (qq_user_id, account_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           qq_user_id = excluded.qq_user_id,
           created_by = excluded.created_by,
           updated_at = excluded.updated_at`,
      ).run(normalized, accountId, actorAccountId, now, now);
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE constraint failed: admin_qq_bindings.qq_user_id")) {
        throw new AdminAuthError("qq_user_id_already_bound", 409);
      }
      throw error;
    }
    this.writeAudit({
      accountId: actorAccountId,
      targetAccountId: accountId,
      action: "admin_qq_binding_updated",
      detail: { qqUserId: normalized },
    });
  }

  removeQqBinding(accountId: string, actorAccountId: string): void {
    const account = this.findAccountById(accountId);
    if (!account) throw new AdminAuthError("not_found", 404);
    const existing = this.getQqBinding(accountId);
    if (!existing) throw new AdminAuthError("qq_binding_not_found", 404);
    this.sharedDb.db.prepare("DELETE FROM admin_qq_bindings WHERE account_id = ?").run(accountId);
    this.writeAudit({
      accountId: actorAccountId,
      targetAccountId: accountId,
      action: "admin_qq_binding_removed",
      detail: { qqUserId: existing },
    });
  }

  listInvites(): AdminInvite[] {
    const rows = this.sharedDb.db.prepare(
      `SELECT id, role, group_ids_json, created_at, expires_at, used_at, revoked_at
         FROM admin_invites ORDER BY created_at DESC`,
    ).all() as unknown as InviteRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      groupIds: parseGroupIds(row.group_ids_json),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}),
      ...(row.used_at ? { usedAt: new Date(row.used_at).toISOString() } : {}),
    }));
  }

  revokeInvite(inviteId: string, actorAccountId: string): void {
    const result = this.sharedDb.db.prepare(
      "UPDATE admin_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND used_at IS NULL",
    ).run(Date.now(), inviteId);
    if (Number(result.changes ?? 0) !== 1) throw new AdminAuthError("not_found", 404);
    this.writeAudit({ accountId: actorAccountId, action: "admin_invite_revoked", detail: { inviteId } });
  }

  createInvite(input: {
    role: AdminRole;
    groupIds: string[];
    expiresAt: number;
    actorAccountId: string;
  }): { invite: AdminInvite; token: string } {
    if (input.role === "group_admin" && input.groupIds.length === 0) {
      throw new AdminAuthError("group_admin_requires_group_grant", 400);
    }
    const now = Date.now();
    const id = randomUUID();
    const token = randomToken();
    this.sharedDb.db.prepare(
      `INSERT INTO admin_invites
         (id, token_hash, role, group_ids_json, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, hashToken(token), input.role, JSON.stringify(uniqueText(input.groupIds)), input.actorAccountId, now, input.expiresAt);
    this.writeAudit({ accountId: input.actorAccountId, action: "admin_invite_created", detail: { id, role: input.role, groupIds: uniqueText(input.groupIds) } });
    return {
      token,
      invite: {
        id,
        role: input.role,
        groupIds: uniqueText(input.groupIds),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(input.expiresAt).toISOString(),
      },
    };
  }

  async acceptInvite(input: {
    inviteToken: string;
    username: string;
    password: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<PasswordLoginResult | { kind: "invalid_invite" | "username_taken" }> {
    await this.ensureInitialized();
    const now = Date.now();
    const invite = this.sharedDb.db.prepare(
      `SELECT id, role, group_ids_json, created_at, expires_at, used_at, revoked_at
         FROM admin_invites WHERE token_hash = ?`,
    ).get(hashToken(input.inviteToken)) as InviteRow | undefined;
    const username = normalizeUsername(input.username);
    if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= now || !username) {
      return { kind: "invalid_invite" };
    }
    if (this.findAccountByUsername(username)) return { kind: "username_taken" };
    assertPasswordPolicy(input.password);
    const accountId = randomUUID();
    const hash = await hashPassword(input.password);
    const groups = parseGroupIds(invite.group_ids_json);
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.sharedDb.db.prepare(
        `INSERT INTO admin_accounts
           (id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(accountId, username, hash, invite.role, now, now);
      const grant = this.sharedDb.db.prepare(
        "INSERT INTO admin_group_grants (account_id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const groupId of groups) grant.run(accountId, groupId, `invite:${invite.id}`, now);
      const used = this.sharedDb.db.prepare(
        "UPDATE admin_invites SET used_at = ?, accepted_account_id = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
      ).run(now, accountId, invite.id);
      if (Number(used.changes ?? 0) !== 1) throw new AdminAuthError("invalid_invite", 409);
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({ accountId, action: "admin_invite_accepted", detail: { inviteId: invite.id }, meta: input.meta });
    const account = this.findAccountById(accountId);
    if (!account) throw new AdminAuthError("invalid_invite", 409);
    const session = this.createSession(account, input.meta, now);
    this.sharedDb.db.prepare("UPDATE admin_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, account.id);
    return { kind: "authenticated", session };
  }

  disableAccount(accountId: string, actorAccountId: string): void {
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const account = this.findAccountById(accountId);
      if (!account) throw new AdminAuthError("not_found", 404);
      if (account.id === actorAccountId) throw new AdminAuthError("cannot_disable_self", 400);
      if (!account.disabled_at && account.role === "super_admin" && this.activeSuperAdminCount() <= 1) {
        throw new AdminAuthError("last_super_admin", 409);
      }
      if (!account.disabled_at) {
        this.sharedDb.db.prepare("UPDATE admin_accounts SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL").run(now, now, accountId);
        this.sharedDb.db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(now, accountId);
      }
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({ accountId: actorAccountId, targetAccountId: accountId, action: "admin_account_disabled" });
  }

  enableAccount(accountId: string, actorAccountId: string): void {
    const account = this.findAccountById(accountId);
    if (!account) throw new AdminAuthError("not_found", 404);
    this.sharedDb.db.prepare("UPDATE admin_accounts SET disabled_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), accountId);
    this.writeAudit({ accountId: actorAccountId, targetAccountId: accountId, action: "admin_account_enabled" });
  }

  setGroupGrants(accountId: string, groupIds: string[], actorAccountId: string): void {
    const account = this.findAccountById(accountId);
    if (!account) throw new AdminAuthError("not_found", 404);
    const normalized = uniqueText(groupIds);
    if (account.role === "super_admin" && normalized.length) throw new AdminAuthError("super_admin_has_global_access", 400);
    if (account.role === "group_admin" && normalized.length === 0) throw new AdminAuthError("group_admin_requires_group_grant", 400);
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.sharedDb.db.prepare("DELETE FROM admin_group_grants WHERE account_id = ?").run(accountId);
      const insert = this.sharedDb.db.prepare(
        "INSERT INTO admin_group_grants (account_id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const groupId of normalized) insert.run(accountId, groupId, actorAccountId, now);
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({ accountId: actorAccountId, targetAccountId: accountId, action: "admin_group_grants_updated", detail: { groupIds: normalized } });
  }

  listGrantedGroupIds(accountId: string): string[] {
    return (this.sharedDb.db.prepare(
      "SELECT group_id FROM admin_group_grants WHERE account_id = ? ORDER BY group_id ASC",
    ).all(accountId) as Array<{ group_id: string }>).map((row) => row.group_id);
  }

  private getQqBinding(accountId: string): string | undefined {
    return (this.sharedDb.db.prepare(
      "SELECT qq_user_id FROM admin_qq_bindings WHERE account_id = ?",
    ).get(accountId) as { qq_user_id: string } | undefined)?.qq_user_id;
  }

  hasGroupGrant(accountId: string, groupId: string): boolean {
    return Boolean(this.sharedDb.db.prepare(
      "SELECT 1 AS present FROM admin_group_grants WHERE account_id = ? AND group_id = ?",
    ).get(accountId, groupId));
  }

  listAuthAudit(limit = 100): Array<{
    id: number;
    accountId?: string;
    action: string;
    targetAccountId?: string;
    detail: Record<string, unknown>;
    createdAt: string;
  }> {
    const rows = this.sharedDb.db.prepare(
      `SELECT id, account_id, action, target_account_id, detail_json, created_at
         FROM admin_auth_audit ORDER BY id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(500, limit))) as Array<{
      id: number;
      account_id: string | null;
      action: string;
      target_account_id: string | null;
      detail_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ...(row.account_id ? { accountId: row.account_id } : {}),
      action: row.action,
      ...(row.target_account_id ? { targetAccountId: row.target_account_id } : {}),
      detail: parseDetail(row.detail_json),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  private async bootstrapLegacyAdmin(): Promise<void> {
    const bootstrap = this.options.bootstrap;
    if (!bootstrap?.username || !bootstrap.password) return;
    const username = normalizeUsername(bootstrap.username);
    if (!username) throw new Error("ADMIN_USERNAME is invalid for bootstrap.");
    try {
      assertPasswordPolicy(bootstrap.password);
    } catch {
      throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
    }
    const existing = this.sharedDb.db.prepare("SELECT COUNT(*) AS count FROM admin_accounts").get() as { count: number };
    if (existing.count > 0) return;
    const now = Date.now();
    const passwordHash = await hashPassword(bootstrap.password);
    try {
      this.sharedDb.db.prepare(
        `INSERT INTO admin_accounts (id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, 'super_admin', ?, ?)`,
      ).run(randomUUID(), username, passwordHash, now, now);
      this.writeAudit({ action: "legacy_super_admin_bootstrapped", detail: { username } });
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  private findAccountByUsername(username: string): AccountRow | undefined {
    return this.sharedDb.db.prepare(
      `SELECT id, username, password_hash, role, disabled_at, created_at, updated_at, last_login_at
         FROM admin_accounts WHERE username = ? COLLATE NOCASE`,
    ).get(username) as AccountRow | undefined;
  }

  private findAccountById(id: string): AccountRow | undefined {
    return this.sharedDb.db.prepare(
      `SELECT id, username, password_hash, role, disabled_at, created_at, updated_at, last_login_at
         FROM admin_accounts WHERE id = ?`,
    ).get(id) as AccountRow | undefined;
  }

  private createSession(account: AccountRow, meta: AdminAuthRequestMeta | undefined, now: number): AdminAuthSession {
    const opaqueToken = randomToken();
    const csrfToken = randomToken();
    const id = randomUUID();
    const expiresAt = now + this.sessionTtlMs;
    this.sharedDb.db.prepare(
      `INSERT INTO admin_sessions
         (id, account_id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at, reauth_verified_at, ip_hash, user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      account.id,
      hashToken(opaqueToken),
      hashToken(csrfToken),
      now,
      expiresAt,
      now,
      now,
      optionalHash(meta?.ip),
      optionalHash(meta?.userAgent),
    );
    return {
      sessionId: id,
      opaqueToken,
      userId: account.id,
      username: account.username,
      role: account.role,
      allowedGroupIds: this.listGrantedGroupIds(account.id),
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
      reauthVerifiedAt: now,
    };
  }

  private getRateLimit(scope: string, rawKey: string): { failures: number; windowStartedAt: number; lockedUntil?: number } {
    const row = this.sharedDb.db.prepare(
      "SELECT failures, window_started_at, locked_until FROM admin_login_rate_limits WHERE scope = ? AND key_hash = ?",
    ).get(scope, hashToken(rawKey)) as { failures: number; window_started_at: number; locked_until: number | null } | undefined;
    if (!row) return { failures: 0, windowStartedAt: Date.now() };
    if (row.window_started_at < Date.now() - LOGIN_WINDOW_MS) {
      return { failures: 0, windowStartedAt: Date.now() };
    }
    return { failures: row.failures, windowStartedAt: row.window_started_at, ...(row.locked_until ? { lockedUntil: row.locked_until } : {}) };
  }

  private recordLoginFailure(scope: string, rawKey: string, now: number): void {
    const keyHash = hashToken(rawKey);
    const current = this.getRateLimit(scope, rawKey);
    const inWindow = current.windowStartedAt >= now - LOGIN_WINDOW_MS;
    const failures = inWindow ? current.failures + 1 : 1;
    const windowStartedAt = inWindow ? current.windowStartedAt : now;
    const lockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : undefined;
    this.sharedDb.db.prepare(
      `INSERT INTO admin_login_rate_limits (scope, key_hash, window_started_at, failures, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key_hash) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         failures = excluded.failures,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
    ).run(scope, keyHash, windowStartedAt, failures, lockedUntil ?? null, now);
  }

  private clearRateLimit(scope: string, rawKey: string): void {
    this.sharedDb.db.prepare("DELETE FROM admin_login_rate_limits WHERE scope = ? AND key_hash = ?").run(scope, hashToken(rawKey));
  }


  private activeSuperAdminCount(): number {
    const row = this.sharedDb.db.prepare(
      "SELECT COUNT(*) AS count FROM admin_accounts WHERE role = 'super_admin' AND disabled_at IS NULL",
    ).get() as { count: number };
    return row.count;
  }


  private writeAudit(input: {
    accountId?: string;
    targetAccountId?: string;
    action: string;
    detail?: Record<string, unknown>;
    meta?: AdminAuthRequestMeta;
  }): void {
    this.sharedDb.db.prepare(
      `INSERT INTO admin_auth_audit (account_id, action, target_account_id, detail_json, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.accountId ?? null,
      input.action,
      input.targetAccountId ?? null,
      JSON.stringify(input.detail ?? {}),
      optionalHash(input.meta?.ip),
      Date.now(),
    );
  }
}

export class AdminAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
  }
}

function assertPasswordPolicy(password: string): void {
  if (!password || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AdminAuthError("invalid_password", 400);
  }
}

async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt, 32);
  return `scrypt$v1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, version, saltText, hashText] = encoded.split("$");
  if (version !== "v1" || !saltText || !hashText || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await derivePasswordKey(password, Buffer.from(saltText, "base64url"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function derivePasswordKey(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derived));
    });
  });
}

function normalizeUsername(value: string): string | undefined {
  const username = value.trim();
  return /^[\p{L}\p{N}_.-]{3,64}$/u.test(username) ? username : undefined;
}

function normalizeQqUserId(value: string): string | undefined {
  const normalized = String(value ?? "").trim();
  return /^[1-9]\d{4,11}$/.test(normalized) ? normalized : undefined;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function optionalHash(value: string | undefined): string | null {
  return value ? hashToken(value) : null;
}

function safeEqualHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function uniqueText(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function parseGroupIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? uniqueText(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

function parseDetail(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
