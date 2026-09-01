import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
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
const TOTP_LOGIN_MAX_FAILURES = 5;
const TOTP_RATE_LIMIT_SCOPE = "totp";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const CHALLENGE_TTL_MS = 10 * 60 * 1_000;
const RECENT_MFA_MS = 10 * 60 * 1_000;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;

export interface AdminAuthServiceOptions {
  /** A 32-byte master key encoded as hex, base64, or base64url. */
  stateEncryptionKey: string;
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
  totpEnabled: boolean;
  disabledAt?: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AdminAuthSession extends AdminSession {
  sessionId: string;
  /** Kept server-side only. It is never serialized in a JSON response. */
  opaqueToken: string;
  mfaVerifiedAt: number;
}

export interface AdminAuthRequestMeta {
  ip?: string;
  userAgent?: string;
}

export type PasswordLoginResult =
  | { kind: "invalid_credentials" }
  | { kind: "locked"; retryAfterSeconds: number }
  | {
    kind: "totp_required";
    loginToken: string;
    username: string;
  }
  | {
    kind: "totp_enrollment_required";
    enrollmentToken: string;
    username: string;
    totpSecret: string;
    totpUri: string;
  };

export type AuthCompletionResult =
  | { kind: "invalid_challenge" }
  | { kind: "invalid_totp" }
  | { kind: "invalid_recovery_code" }
  | { kind: "disabled" }
  | { kind: "success"; session: AdminAuthSession; recoveryCodes?: string[] };

/** Recovery codes can only begin a fresh MFA enrollment; they never create a session. */
export type RecoveryLoginResult =
  | { kind: "invalid_credentials" }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "invalid_recovery_code" }
  | { kind: "disabled" }
  | {
    kind: "totp_enrollment_required";
    enrollmentToken: string;
    username: string;
    totpSecret: string;
    totpUri: string;
  };

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
  totp_secret_ciphertext: string | null;
  totp_enabled_at: number | null;
  mfa_last_counter: number;
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
  mfa_verified_at: number;
  username: string;
  role: AdminRole;
  disabled_at: number | null;
}

interface ChallengeRow {
  id: string;
  account_id: string;
  kind: "login_totp" | "totp_enroll";
  secret_ciphertext: string | null;
  expires_at: number;
  used_at: number | null;
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
  private readonly encryptionKey: Buffer;
  private readonly sessionTtlMs: number;
  private bootstrapPromise?: Promise<void>;

  constructor(
    private readonly sharedDb: SharedDb,
    private readonly options: AdminAuthServiceOptions,
  ) {
    this.encryptionKey = deriveTotpEncryptionKey(options.stateEncryptionKey);
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
    if (!account.totp_enabled_at || !account.totp_secret_ciphertext) {
      const secret = encodeBase32(randomBytes(TOTP_SECRET_BYTES));
      const token = randomToken();
      this.insertChallenge({
        accountId: account.id,
        kind: "totp_enroll",
        token,
        secretCiphertext: this.encrypt(secret),
        meta: input.meta,
      });
      this.writeAudit({ accountId: account.id, action: "totp_enrollment_started", meta: input.meta });
      return {
        kind: "totp_enrollment_required",
        enrollmentToken: token,
        username: account.username,
        totpSecret: secret,
        totpUri: buildTotpUri(account.username, secret),
      };
    }

    const token = randomToken();
    this.insertChallenge({ accountId: account.id, kind: "login_totp", token, meta: input.meta });
    return { kind: "totp_required", loginToken: token, username: account.username };
  }

  async completeTotpEnrollment(input: {
    enrollmentToken: string;
    code: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<AuthCompletionResult> {
    await this.ensureInitialized();
    const challenge = this.consumeChallenge(input.enrollmentToken, "totp_enroll");
    if (!challenge?.secret_ciphertext) {
      return { kind: "invalid_challenge" };
    }
    const account = this.findAccountById(challenge.account_id);
    if (!account || account.disabled_at) {
      return { kind: "disabled" };
    }
    const secret = this.decrypt(challenge.secret_ciphertext);
    const rate = this.getRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    if (rate.lockedUntil && rate.lockedUntil > Date.now()) {
      this.restoreChallenge(challenge.id);
      return { kind: "invalid_totp" };
    }
    const counter = verifyTotp(secret, input.code, account.mfa_last_counter);
    if (counter === undefined) {
      this.restoreChallenge(challenge.id);
      this.recordLoginFailure(TOTP_RATE_LIMIT_SCOPE, account.id, Date.now());
      this.writeAudit({ accountId: account.id, action: "totp_enrollment_failed", meta: input.meta });
      return { kind: "invalid_totp" };
    }

    const now = Date.now();
    const recoveryCodeSet = await this.createRecoveryCodeSet();
    const advanced = this.completeTotpEnrollmentTransaction({
      account,
      counter,
      secretCiphertext: this.encrypt(secret),
      recoveryCodeHashes: recoveryCodeSet.hashes,
      now,
    });
    if (!advanced) {
      this.restoreChallenge(challenge.id);
      this.writeAudit({ accountId: account.id, action: "totp_enrollment_replayed", meta: input.meta });
      return { kind: "invalid_totp" };
    }
    this.clearRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    const session = this.createSession(account, input.meta, now);
    this.writeAudit({ accountId: account.id, action: "totp_enrollment_completed", meta: input.meta });
    return { kind: "success", session, recoveryCodes: recoveryCodeSet.codes };
  }

  async completeTotpLogin(input: {
    loginToken: string;
    code: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<AuthCompletionResult> {
    await this.ensureInitialized();
    const challenge = this.consumeChallenge(input.loginToken, "login_totp");
    if (!challenge) {
      return { kind: "invalid_challenge" };
    }
    const account = this.findAccountById(challenge.account_id);
    if (!account || account.disabled_at || !account.totp_secret_ciphertext) {
      return { kind: "disabled" };
    }
    const rate = this.getRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    if (rate.lockedUntil && rate.lockedUntil > Date.now()) {
      this.restoreChallenge(challenge.id);
      return { kind: "invalid_totp" };
    }
    const counter = verifyTotp(this.decrypt(account.totp_secret_ciphertext), input.code, account.mfa_last_counter);
    if (counter === undefined) {
      this.restoreChallenge(challenge.id);
      this.recordLoginFailure(TOTP_RATE_LIMIT_SCOPE, account.id, Date.now());
      this.writeAudit({ accountId: account.id, action: "login_totp_failed", meta: input.meta });
      return { kind: "invalid_totp" };
    }

    const now = Date.now();
    if (!this.advanceTotpCounter({
      accountId: account.id,
      previousCounter: account.mfa_last_counter,
      counter,
      now,
      updateLastLogin: true,
    })) {
      this.restoreChallenge(challenge.id);
      this.writeAudit({ accountId: account.id, action: "login_totp_replayed", meta: input.meta });
      return { kind: "invalid_totp" };
    }
    this.clearRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    const session = this.createSession(account, input.meta, now);
    this.writeAudit({ accountId: account.id, action: "login_completed", meta: input.meta });
    return { kind: "success", session };
  }

  async completeRecoveryLogin(input: {
    username: string;
    password: string;
    recoveryCode: string;
    loginKey: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<RecoveryLoginResult> {
    await this.ensureInitialized();
    const now = Date.now();
    const rate = this.getRateLimit("recovery_login", input.loginKey);
    if (rate.lockedUntil && rate.lockedUntil > now) {
      return { kind: "locked", retryAfterSeconds: Math.max(1, Math.ceil((rate.lockedUntil - now) / 1_000)) };
    }
    const username = normalizeUsername(input.username);
    const account = username ? this.findAccountByUsername(username) : undefined;
    const validPassword = Boolean(account && !account.disabled_at && await verifyPassword(input.password, account.password_hash));
    if (!validPassword || !account) {
      this.recordLoginFailure("recovery_login", input.loginKey, now);
      this.writeAudit({ action: "login_recovery_password_failed", detail: { username: username || "invalid" }, meta: input.meta });
      return { kind: "invalid_credentials" };
    }
    const candidates = this.sharedDb.db.prepare(
      "SELECT id, code_hash FROM admin_recovery_codes WHERE account_id = ? AND used_at IS NULL",
    ).all(account.id) as Array<{ id: string; code_hash: string }>;
    let code: { id: string } | undefined;
    for (const candidate of candidates) {
      if (await verifyPassword(normalizeRecoveryCode(input.recoveryCode), candidate.code_hash)) {
        code = { id: candidate.id };
        break;
      }
    }
    if (!code) {
      this.recordLoginFailure("recovery_login", input.loginKey, now);
      this.writeAudit({ accountId: account.id, action: "login_recovery_failed", meta: input.meta });
      return { kind: "invalid_recovery_code" };
    }
    const secret = encodeBase32(randomBytes(TOTP_SECRET_BYTES));
    const enrollmentToken = randomToken();
    let recoveryCodeClaimed = false;
    let accountDisabled = false;
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const currentAccount = this.findAccountById(account.id);
      if (!currentAccount || currentAccount.disabled_at) {
        this.sharedDb.db.exec("ROLLBACK");
        accountDisabled = true;
      } else {
        const consumed = this.sharedDb.db.prepare(
          "UPDATE admin_recovery_codes SET used_at = ? WHERE id = ? AND account_id = ? AND used_at IS NULL",
        ).run(now, code.id, account.id);
        if (Number(consumed.changes ?? 0) === 1) {
          // A recovery code proves account recovery, not an authenticated session.
          // Rotate every MFA credential before issuing a new enrollment challenge.
          this.sharedDb.db.prepare(
            `UPDATE admin_accounts
                SET totp_secret_ciphertext = NULL, totp_enabled_at = NULL, mfa_last_counter = -1, updated_at = ?
              WHERE id = ?`,
          ).run(now, account.id);
          this.sharedDb.db.prepare("DELETE FROM admin_recovery_codes WHERE account_id = ?").run(account.id);
          this.sharedDb.db.prepare(
            "UPDATE admin_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
          ).run(now, account.id);
          this.sharedDb.db.prepare("DELETE FROM admin_auth_challenges WHERE account_id = ?").run(account.id);
          this.insertChallenge({
            accountId: account.id,
            kind: "totp_enroll",
            token: enrollmentToken,
            secretCiphertext: this.encrypt(secret),
            meta: input.meta,
          });
          this.sharedDb.db.exec("COMMIT");
          recoveryCodeClaimed = true;
        } else {
          this.sharedDb.db.exec("ROLLBACK");
        }
      }
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    if (accountDisabled) return { kind: "disabled" };
    if (!recoveryCodeClaimed) {
      this.recordLoginFailure("recovery_login", input.loginKey, now);
      this.writeAudit({ accountId: account.id, action: "login_recovery_replayed", meta: input.meta });
      return { kind: "invalid_recovery_code" };
    }
    this.clearRateLimit("recovery_login", input.loginKey);
    this.clearRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    this.writeAudit({ accountId: account.id, action: "login_recovery_totp_reset_started", meta: input.meta });
    return {
      kind: "totp_enrollment_required",
      enrollmentToken,
      username: account.username,
      totpSecret: secret,
      totpUri: buildTotpUri(account.username, secret),
    };
  }

  getSession(opaqueToken: string | undefined): AdminAuthSession | undefined {
    if (!opaqueToken) return undefined;
    const now = Date.now();
    const row = this.sharedDb.db.prepare(
      `SELECT s.id, s.account_id, s.csrf_token_hash, s.expires_at, s.last_seen_at, s.mfa_verified_at,
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
      mfaVerifiedAt: row.mfa_verified_at,
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

  hasRecentMfa(session: AdminAuthSession): boolean {
    return session.mfaVerifiedAt >= Date.now() - RECENT_MFA_MS;
  }

  completeSessionReauth(session: AdminAuthSession, code: string, meta?: AdminAuthRequestMeta): boolean {
    const account = this.findAccountById(session.userId ?? "");
    if (!account?.totp_secret_ciphertext || account.disabled_at) return false;
    const rate = this.getRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    if (rate.lockedUntil && rate.lockedUntil > Date.now()) return false;
    const counter = verifyTotp(this.decrypt(account.totp_secret_ciphertext), code, account.mfa_last_counter);
    if (counter === undefined) {
      this.recordLoginFailure(TOTP_RATE_LIMIT_SCOPE, account.id, Date.now());
      this.writeAudit({ accountId: account.id, action: "mfa_reauthentication_failed", meta });
      return false;
    }
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.sharedDb.db.prepare(
        "UPDATE admin_accounts SET mfa_last_counter = ?, updated_at = ? WHERE id = ? AND mfa_last_counter < ?",
      ).run(counter, now, account.id, counter);
      if (Number(result.changes ?? 0) !== 1) {
        this.sharedDb.db.exec("ROLLBACK");
        return false;
      }
      const sessionUpdated = this.sharedDb.db.prepare(
        "UPDATE admin_sessions SET mfa_verified_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
      ).run(now, session.sessionId, account.id);
      if (Number(sessionUpdated.changes ?? 0) !== 1) {
        this.sharedDb.db.exec("ROLLBACK");
        return false;
      }
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    session.mfaVerifiedAt = now;
    this.clearRateLimit(TOTP_RATE_LIMIT_SCOPE, account.id);
    this.writeAudit({ accountId: account.id, action: "mfa_reauthenticated", meta });
    return true;
  }

  async regenerateRecoveryCodes(session: AdminAuthSession, meta?: AdminAuthRequestMeta): Promise<string[] | undefined> {
    if (!session.userId || !this.hasRecentMfa(session)) return undefined;
    const account = this.findAccountById(session.userId);
    if (!account || account.disabled_at) return undefined;
    const codes = await this.replaceRecoveryCodes(account.id);
    this.writeAudit({ accountId: account.id, action: "recovery_codes_regenerated", meta });
    return codes;
  }

  async changePassword(input: {
    session: AdminAuthSession;
    currentPassword: string;
    nextPassword: string;
    meta?: AdminAuthRequestMeta;
  }): Promise<"ok" | "invalid_current_password" | "recent_mfa_required"> {
    if (!input.session.userId || !this.hasRecentMfa(input.session)) return "recent_mfa_required";
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

  beginTotpReset(session: AdminAuthSession, meta?: AdminAuthRequestMeta): {
    enrollmentToken: string;
    totpSecret: string;
    totpUri: string;
  } | undefined {
    if (!session.userId || !this.hasRecentMfa(session)) return undefined;
    const account = this.findAccountById(session.userId);
    if (!account || account.disabled_at) return undefined;
    const secret = encodeBase32(randomBytes(TOTP_SECRET_BYTES));
    const enrollmentToken = randomToken();
    this.insertChallenge({
      accountId: account.id,
      kind: "totp_enroll",
      token: enrollmentToken,
      secretCiphertext: this.encrypt(secret),
      meta,
    });
    this.writeAudit({ accountId: account.id, action: "totp_reset_started", meta });
    return { enrollmentToken, totpSecret: secret, totpUri: buildTotpUri(account.username, secret) };
  }

  listAccounts(): AdminAuthAccount[] {
    const rows = this.sharedDb.db.prepare(
      `SELECT id, username, role, totp_enabled_at, disabled_at, created_at, last_login_at
         FROM admin_accounts ORDER BY created_at ASC, username COLLATE NOCASE ASC`,
    ).all() as Array<Pick<AccountRow, "id" | "username" | "role" | "totp_enabled_at" | "disabled_at" | "created_at" | "last_login_at">>;
    return rows.map((row) => {
      const qqUserId = this.getQqBinding(row.id);
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        groupIds: this.listGrantedGroupIds(row.id),
        ...(qqUserId ? { qqUserId } : {}),
        totpEnabled: Boolean(row.totp_enabled_at),
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
    const password = input.password;
    if (!password || password.length > 512) throw new AdminAuthError("invalid_password", 400);
    const accountId = randomUUID();
    const hash = await hashPassword(password);
    const groups = parseGroupIds(invite.group_ids_json);
    const secret = encodeBase32(randomBytes(TOTP_SECRET_BYTES));
    const enrollmentToken = randomToken();
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
      this.insertChallenge({ accountId, kind: "totp_enroll", token: enrollmentToken, secretCiphertext: this.encrypt(secret), meta: input.meta });
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    this.writeAudit({ accountId, action: "admin_invite_accepted", detail: { inviteId: invite.id }, meta: input.meta });
    return {
      kind: "totp_enrollment_required",
      enrollmentToken,
      username,
      totpSecret: secret,
      totpUri: buildTotpUri(username, secret),
    };
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
      `SELECT id, username, password_hash, role, totp_secret_ciphertext, totp_enabled_at,
              mfa_last_counter, disabled_at, created_at, updated_at, last_login_at
         FROM admin_accounts WHERE username = ? COLLATE NOCASE`,
    ).get(username) as AccountRow | undefined;
  }

  private findAccountById(id: string): AccountRow | undefined {
    return this.sharedDb.db.prepare(
      `SELECT id, username, password_hash, role, totp_secret_ciphertext, totp_enabled_at,
              mfa_last_counter, disabled_at, created_at, updated_at, last_login_at
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
         (id, account_id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at, mfa_verified_at, ip_hash, user_agent_hash)
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
      mfaVerifiedAt: now,
    };
  }

  private insertChallenge(input: {
    accountId: string;
    kind: ChallengeRow["kind"];
    token: string;
    secretCiphertext?: string;
    meta?: AdminAuthRequestMeta;
  }): void {
    const now = Date.now();
    this.sharedDb.db.prepare(
      `INSERT INTO admin_auth_challenges
         (id, token_hash, account_id, kind, secret_ciphertext, created_at, expires_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      hashToken(input.token),
      input.accountId,
      input.kind,
      input.secretCiphertext ?? null,
      now,
      now + CHALLENGE_TTL_MS,
      optionalHash(input.meta?.ip),
    );
  }

  private consumeChallenge(token: string, kind: ChallengeRow["kind"]): ChallengeRow | undefined {
    const row = this.sharedDb.db.prepare(
      `SELECT id, account_id, kind, secret_ciphertext, expires_at, used_at
         FROM admin_auth_challenges
        WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`,
    ).get(hashToken(token), kind, Date.now()) as ChallengeRow | undefined;
    if (!row) return undefined;
    const update = this.sharedDb.db.prepare("UPDATE admin_auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL").run(Date.now(), row.id);
    return Number(update.changes ?? 0) === 1 ? row : undefined;
  }

  private restoreChallenge(id: string): void {
    this.sharedDb.db.prepare("UPDATE admin_auth_challenges SET used_at = NULL WHERE id = ? AND expires_at > ?").run(id, Date.now());
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
    const limit = scope === TOTP_RATE_LIMIT_SCOPE || scope.startsWith("totp_") ? TOTP_LOGIN_MAX_FAILURES : LOGIN_MAX_FAILURES;
    const lockedUntil = failures >= limit ? now + LOGIN_LOCK_MS : undefined;
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

  /**
   * TOTP acceptance is a compare-and-set operation.  The caller verified the
   * counter against a snapshot, but another process may accept that same code
   * before this process writes.  The conditional update makes the replay
   * winner deterministic across all admin processes.
   */
  private advanceTotpCounter(input: {
    accountId: string;
    previousCounter: number;
    counter: number;
    now: number;
    secretCiphertext?: string;
    enroll?: boolean;
    updateLastLogin?: boolean;
  }): boolean {
    const sets = ["mfa_last_counter = ?", "updated_at = ?"];
    const values: Array<string | number | null> = [input.counter, input.now];
    if (input.enroll) {
      sets.push("totp_secret_ciphertext = ?", "totp_enabled_at = ?");
      values.push(input.secretCiphertext ?? null, input.now);
    }
    if (input.updateLastLogin) {
      sets.push("last_login_at = ?");
      values.push(input.now);
    }
    values.push(input.accountId, input.previousCounter, input.counter);
    const result = this.sharedDb.db.prepare(
      `UPDATE admin_accounts SET ${sets.join(", ")}
        WHERE id = ? AND mfa_last_counter = ? AND mfa_last_counter < ?`,
    ).run(...values);
    return Number(result.changes ?? 0) === 1;
  }

  private async replaceRecoveryCodes(accountId: string): Promise<string[]> {
    const recoveryCodeSet = await this.createRecoveryCodeSet();
    const now = Date.now();
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.replaceRecoveryCodeRows(accountId, recoveryCodeSet.hashes, now);
      this.sharedDb.db.exec("COMMIT");
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
    return recoveryCodeSet.codes;
  }

  private async createRecoveryCodeSet(): Promise<{ codes: string[]; hashes: string[] }> {
    const codes = Array.from({ length: 10 }, () => formatRecoveryCode(randomBytes(8)));
    return { codes, hashes: await Promise.all(codes.map(async (code) => hashRecoveryCode(code))) };
  }

  private completeTotpEnrollmentTransaction(input: {
    account: AccountRow;
    counter: number;
    secretCiphertext: string;
    recoveryCodeHashes: string[];
    now: number;
  }): boolean {
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sharedDb.db.prepare(
        `UPDATE admin_accounts
            SET totp_secret_ciphertext = ?, totp_enabled_at = ?, mfa_last_counter = ?, updated_at = ?
          WHERE id = ? AND mfa_last_counter = ? AND mfa_last_counter < ?`,
      ).run(
        input.secretCiphertext,
        input.now,
        input.counter,
        input.now,
        input.account.id,
        input.account.mfa_last_counter,
        input.counter,
      );
      if (Number(update.changes ?? 0) !== 1) {
        this.sharedDb.db.exec("ROLLBACK");
        return false;
      }
      this.replaceRecoveryCodeRows(input.account.id, input.recoveryCodeHashes, input.now);
      this.sharedDb.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceRecoveryCodeRows(accountId: string, hashes: readonly string[], now: number): void {
    this.sharedDb.db.prepare("DELETE FROM admin_recovery_codes WHERE account_id = ?").run(accountId);
    const insert = this.sharedDb.db.prepare(
      "INSERT INTO admin_recovery_codes (id, account_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const hash of hashes) insert.run(randomUUID(), accountId, hash, now);
  }

  private activeSuperAdminCount(): number {
    const row = this.sharedDb.db.prepare(
      "SELECT COUNT(*) AS count FROM admin_accounts WHERE role = 'super_admin' AND disabled_at IS NULL",
    ).get() as { count: number };
    return row.count;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from("ubot-v3:admin-totp", "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decrypt(value: string): string {
    const [version, ivText, tagText, ciphertextText] = value.split(".");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted TOTP secret.");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from("ubot-v3:admin-totp", "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
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

function deriveTotpEncryptionKey(value: string): Buffer {
  const master = parseStateEncryptionKey(value);
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from("ubot/admin-totp/v1"), 32));
}

function parseStateEncryptionKey(value: string): Buffer {
  const text = value.trim();
  const candidate = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (candidate.length !== 32) {
    throw new Error("UBOT_STATE_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return candidate;
}

async function hashPassword(password: string): Promise<string> {
  if (!password || password.length > 512) throw new AdminAuthError("invalid_password", 400);
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt, 32);
  return `scrypt$v1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, version, saltText, hashText] = encoded.split("$");
  if (version !== "v1" || !saltText || !hashText || !password || password.length > 512) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await derivePasswordKey(password, Buffer.from(saltText, "base64url"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(normalizeRecoveryCode(code));
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

function normalizeRecoveryCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function formatRecoveryCode(bytes: Buffer): string {
  return bytes.toString("hex").toUpperCase().match(/.{1,4}/g)?.join("-") ?? bytes.toString("hex").toUpperCase();
}

function verifyTotp(secret: string, code: string, lastCounter: number, now = Date.now()): number | undefined {
  const normalizedCode = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalizedCode)) return undefined;
  const currentCounter = Math.floor(now / (TOTP_PERIOD_SECONDS * 1_000));
  for (const counter of [currentCounter - 1, currentCounter, currentCounter + 1]) {
    if (counter <= lastCounter) continue;
    if (safeEqualText(makeTotp(secret, counter), normalizedCode)) return counter;
  }
  return undefined;
}

function makeTotp(secret: string, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(value % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

function buildTotpUri(username: string, secret: string): string {
  const issuer = "UBot";
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

function encodeBase32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const text = value.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret.");
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
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

function safeEqualText(left: string, right: string): boolean {
  return safeEqualHash(left, right);
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
