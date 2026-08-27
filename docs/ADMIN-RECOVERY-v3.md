# UBot V3 Administrator Recovery

The V3 admin console uses individual accounts, password verification and TOTP. The shared `ADMIN_USERNAME` / `ADMIN_PASSWORD` values exist only to bootstrap the first super administrator when the account table is empty; they are not an ongoing login path.

## First administrator

1. Set a non-empty `UBOT_STATE_ENCRYPTION_KEY` and, if the account table is empty, `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the persistent `/opt/ai-project/.env`.
2. Sign in at `https://bot.9958.uk` with the bootstrap username and password.
3. Complete the required TOTP enrollment and record the displayed one-time recovery codes in an approved password manager. The UI will not show them again.
4. Create at least one additional super administrator before treating the bootstrap account as an emergency-only account.

## Account recovery

- Use an unused recovery code only when the TOTP authenticator is unavailable. It invalidates that code and requires a fresh TOTP enrollment.
- A super administrator can disable an account, revoke sessions, issue a replacement invite, and grant or remove group access.
- Do not edit SQLite account, TOTP, session, recovery-code, or audit tables by hand. It can break replay protection and auditability.
- If every super administrator loses TOTP, stop `ubot.target` and take a restricted SQLite backup. Recovery then requires an approved, audited forward-only account procedure for the exact V3 schema; do not edit tables ad hoc, substitute an earlier release, or restore legacy JSON authentication data.

## Scope boundaries

- `group_admin` accounts can only work with explicitly granted QQ groups. They cannot inspect provider keys, health diagnostics, other administrators, or global security settings.
- A group administrator may add a member privacy exclusion but cannot re-enable it. Only a super administrator can re-enable a previously excluded member.
- Sessions are opaque server-side records. Password changes, account disablement and session revocation take effect immediately.
