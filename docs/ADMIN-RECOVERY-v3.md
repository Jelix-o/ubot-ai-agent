# UBot V3 Administrator Recovery

This retained runbook covers administrator access recovery for the V3 SQLite
runtime. It does not contain credentials or recovery codes.

## Bootstrap

1. Keep the persistent `/opt/ai-project/.env` available as `root:ubot 0640`.
   It must contain the V3 state encryption key. If the administrator table is
   empty, it may also provide the initial username and a password of at least
   twelve characters.
2. Sign in through the configured HTTPS admin origin and create separate daily
   administrator accounts. Treat a bootstrap account as emergency-only.
3. Do not reintroduce retired TOTP, recovery-code, shared-password, or legacy
   in-group administrator-list flows.

## Password Reset

When an existing account password is lost, use an interactive server terminal
while the matching current release and persistent data are intact:

```bash
cd /opt/ai-project-releases/current
npm run admin:reset-password -- --username <account> --data-dir /opt/ai-project/data
```

The command requires a TTY so the new password is not placed in shell history.
It revokes the affected account's sessions and writes an audit event. Do not
edit SQLite account, session, or audit tables by hand.

## Escalation Boundary

- A group-scoped administrator cannot read provider keys, global health
  diagnostics, unrelated groups, or other administrator accounts.
- A group owner or group administrator receives only in-group authority for
  that group; it is not a web login capability.
- If all super administrators are unavailable, reset an approved account from
  the server terminal. Do not switch to a legacy release against V3 data as an
  authentication recovery shortcut.
- Record the incident, affected account, recovery operator, and verification
  result in the approved audit channel without recording the new password.
