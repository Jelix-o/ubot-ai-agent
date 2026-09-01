import type { SharedDb } from "../shared/sqlite.js";
import type { AdminRole } from "../types.js";

export interface QqAdminPrincipal {
  accountId: string;
  username: string;
  role: AdminRole;
  qqUserId: string;
}

export interface QqAdminAuthorization {
  resolve(qqUserId: string, groupId: string): QqAdminPrincipal | undefined;
}

/**
 * Resolves a QQ sender through the authoritative V3 administrator account.
 * Queries are intentionally uncached so disable, unbind, and grant changes
 * take effect for the next command without restarting the worker.
 */
export class QqAdminAuthorizationService implements QqAdminAuthorization {
  constructor(private readonly sharedDb: SharedDb) {}

  resolve(qqUserId: string, groupId: string): QqAdminPrincipal | undefined {
    const row = this.sharedDb.db.prepare(
      `SELECT a.id AS account_id, a.username, a.role, b.qq_user_id,
              CASE WHEN a.role = 'super_admin' THEN 1
                   WHEN EXISTS (
                     SELECT 1 FROM admin_group_grants g
                      WHERE g.account_id = a.id AND g.group_id = ?
                   ) THEN 1 ELSE 0 END AS authorized
         FROM admin_qq_bindings b
         JOIN admin_accounts a ON a.id = b.account_id
        WHERE b.qq_user_id = ? AND a.disabled_at IS NULL`,
    ).get(groupId, qqUserId) as {
      account_id: string;
      username: string;
      role: AdminRole;
      qq_user_id: string;
      authorized: number;
    } | undefined;
    if (!row || row.authorized !== 1) return undefined;
    return {
      accountId: row.account_id,
      username: row.username,
      role: row.role,
      qqUserId: row.qq_user_id,
    };
  }
}
