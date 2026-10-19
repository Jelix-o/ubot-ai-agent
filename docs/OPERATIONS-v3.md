# UBot V3 Operations

This retained runbook is the current operational reference. The repository
does not store production credentials, Cloudflare tokens, Origin CA private
keys, or live chat data.

## Runtime Layout

| Path | Purpose and ownership |
| --- | --- |
| `/opt/ai-project/.env` | Persistent secrets; `root:ubot 0640` |
| `/opt/ai-project/data` | SQLite state and BT state; writable by `ubot` |
| `/var/lib/ubot-preview` | Generated preview pages; writable by `ubot` |
| `/opt/ai-project-releases/current` | Root-owned link to the active immutable release |
| `/opt/ubot-runtime/node22` | Root-owned, pinned Node 22 runtime |
| `/opt/ai-project/release-backups` | Restricted pre-deploy backups |

`ubot-ingress.service`, `ubot-worker.service`, and `ubot-admin.service` are
started by `ubot.target` under the non-login `ubot` account. The account must
not have sudo, Docker, or other privileged group membership. The `ubot` group
may not contain any other supplementary or primary member because it can read
the persistent dotenv.

## Deployment Contract

1. Start only from a root-owned, non-symlink bootstrap directory containing a
   verified release archive and checksum.
2. Install the pinned Node 22 runtime. The installer accepts only reviewed
   architecture-specific digests and writes a root-owned provenance receipt.
   An existing runtime without that receipt is rejected rather than reused;
   stop UBot and replace that entire version directory from a verified archive.
   A different Node version needs a reviewed digest change in a later release.
3. Before turning on the Cloudflare origin gate, obtain Origin CA certificates
   through the approved control-plane change, preflight all proxied origins in
   the zone, and switch the zone to Full (strict) in the same approved window.
4. The deployer stops the independent SQLite maintenance timer/service and
   Cloudflare CIDR updater before backups or Nginx changes. It preserves their
   prior timer state on rollback and starts them only after service health. If
   the Cloudflare updater cannot be stopped, rollback attempts to confirm a
   mask; regardless of that result it blocks automatic restart and leaves
   Nginx restoration for an explicit operator recovery.
5. The deployer atomically updates the release link, approved Nginx files,
   persistent configuration, and NapCat setting. It rejects restart counts
   above zero during startup or later health checks.

## Health Checks

After deployment, verify:

```bash
systemctl status ubot-ingress ubot-worker ubot-admin --no-pager
systemctl show ubot-ingress ubot-worker ubot-admin -p NRestarts --no-pager
systemctl list-timers ubot-maintenance.timer ubot-cloudflare-allowlist.timer
curl -I http://127.0.0.1:6200/api/health
```

The unauthenticated Admin endpoint may return `401`; that proves the auth
boundary rather than a failed service. The deployer separately checks the
authenticated local Read API JSON health without placing its Bearer token in a
command line. Verify normal HTTPS access through Cloudflare and that direct
origin access to the two UBot vhosts is rejected.

## Timers And Maintenance

- `ubot-maintenance.timer` runs the V3 retention job. Its service is part of
  `ubot.target`; an interrupted one-shot task is not resumed during rollback.
- `ubot-cloudflare-allowlist.timer` refreshes only the two UBot vhost CIDR
  includes. It retains the last valid configuration when fetch, syntax test,
  or Nginx reload fails.
- Do not alter other same-host vhosts or global cloud firewall rules as part of
  this release procedure.

## Sensitive Operations

Gemini rotation consumes a replacement only from standard input and refuses an
unchanged value. The issuer-side revoke operation remains mandatory and is not
performed by the repository. Historical Git cleanup, backup cleanup, and
Cloudflare changes require their own approved change window; see
[RELEASE-RECONSTRUCTION-v3.0.18-v3.0.44.md](RELEASE-RECONSTRUCTION-v3.0.18-v3.0.44.md).
