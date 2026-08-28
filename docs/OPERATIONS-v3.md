# UBot V3 Operations

## Runtime layout

Production uses `/opt/ai-project-releases/current` as an atomic symbolic link to a versioned release. Persistent state remains outside a release:

| Path | Owner / purpose |
| --- | --- |
| `/opt/ai-project/.env` | Secrets and production connection settings, mode `0600` |
| `/opt/ai-project/data` | SQLite authority, encrypted V3 rollback archive, caches, logs and `generated-pages` static preview state |
| `/opt/ai-project/config`, `/opt/ai-project/skills` | Legacy input only during the one-time cutover; neither is linked into V3 runtime |
| `/opt/ai-project/release-backups` | Restricted operator backups taken before a deployment |
| `/opt/ai-project-releases/current` | Active V3 release symlink |

`ubot-ingress.service`, `ubot-worker.service`, and `ubot-admin.service` are independent processes managed by `ubot.target`. `ai-project.service` is disabled after cutover but its unit file is retained for manual disaster recovery. Do not start it alongside V3.

## Required production settings

The persistent `.env` must contain a non-empty `UBOT_STATE_ENCRYPTION_KEY`, encoded as 64 hexadecimal characters or base64url for exactly 32 bytes. V3 derives separate state, TOTP and rollback-archive keys with HKDF; `ADMIN_SESSION_SECRET` and `ADMIN_TOTP_ENCRYPTION_KEY` are retired names. Generate and store the master key in the approved secret manager; do not put it in GitHub Actions, a release bundle, command history, or support tickets.

The Linux systemd `EnvironmentFile` must not begin with a UTF-8 BOM. Starting
with V3.0.5, the deployer detects this Windows-editor artifact before stopping
writers, stores an exclusive byte-for-byte copy in the restricted release
backup, and atomically removes only the three BOM bytes while preserving the
dotenv owner and mode. A file without a BOM is not rewritten.

For this production topology, set `ADMIN_HTTP_ENABLED=true`,
`ADMIN_HTTP_HOST=127.0.0.1`, `ADMIN_HTTP_PORT=6200`, and
`INGRESS_READ_API_PORT=6198` in the persistent `.env`. The deployer fails
before cutover when the admin listener is not explicitly enabled or either
internal port is changed.

For the Docker-hosted NapCat deployment, V3 ingress binds `172.21.0.1:6199`. NapCat must use `ws://172.21.0.1:6199/onebot/ws` as its reverse URL. `6198` and `6200` stay loopback-only. Do not change UFW or AWS security groups as part of this deployment.

For static preview publication, set `HTML_PREVIEW_PUBLIC_BASE_URL=https://preview.9958.uk`. `HTML_PREVIEW_ROOT` may be empty (the default is `/opt/ai-project/data/generated-pages`) or an absolute child directory of `/opt/ai-project/data`; it must not point into a versioned release. The worker owns writes there, while Nginx needs read/traverse access to `pages/<token>/index.html` and `content.html` only.

## Preview host TLS and Nginx

`preview.9958.uk` is an isolated static-only origin for model-generated browser code. It must never be added to `bot.9958.uk`, proxied to port `6200`, or given the admin origin's cookies or API routes. The release deployer installs only these dedicated files:

| Target | Default path |
| --- | --- |
| Preview vhost | `/etc/nginx/sites-available/preview-9958` |
| Static security include | `/etc/nginx/ubot-preview-static.conf` |
| Enabled symlink | `/etc/nginx/sites-enabled/preview-9958` |

Cloudflare Origin certificates are preferred for a proxied zone. Install the certificate and key outside the release, for example at `/etc/ssl/cloudflare/preview.9958.uk.pem` and `/etc/ssl/cloudflare/preview.9958.uk.key`, before deployment. When the Cloudflare dashboard is unavailable, a host-managed certificate such as Let’s Encrypt is supported without changing the Cloudflare zone-wide SSL mode:

```bash
sudo certbot certonly --nginx -d preview.9958.uk
export UBOT_PREVIEW_CERT_PATH=/etc/letsencrypt/live/preview.9958.uk/fullchain.pem
export UBOT_PREVIEW_KEY_PATH=/etc/letsencrypt/live/preview.9958.uk/privkey.pem
```

The port-80 preview template deliberately retains `location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; try_files $uri =404; }` before its HTTPS redirect, so existing Certbot HTTP-01 renewal remains possible. Ensure `/var/www/certbot` stays available to the Certbot renewal path. The deployer validates that the certificate covers `preview.9958.uk`, that the private key matches, and that the selected paths remain beneath `/etc/`. It uses the same two variables on every subsequent upgrade. It does not change Cloudflare's SSL mode, `bot.9958.uk`, `sub.9958.uk`, UFW or AWS security groups.

The installed vhost permits only `GET`/`HEAD`, disables directory listings and symlink traversal, publishes only `/p/<43-character-token>/`, and adds `no-store`, `noindex`, `nosniff`, referrer, CSP and sandbox response protections. Deleting a preview record removes its files; the link then returns `404`.

## Release procedure

1. Download the matching `ubot-3.0.8-linux.tar.gz` and `ubot-3.0.8-linux.tar.gz.sha256` assets from the GitHub Release, then validate the archive with that manifest. Do not substitute a locally built or differently tagged bundle.
2. Confirm `systemctl status ai-project.service`, `systemctl status ubot.target`, and free disk space. The deployment user must be able to read and atomically replace `/opt/ai-project/.env` and the NapCat JSON, write/search `data`, `data/shared` and `data/generated-pages`, and use the approved non-interactive `sudo` policy for systemd plus the three dedicated preview Nginx targets. A first V3 cutover additionally needs access to legacy JSON and `skills`; an existing V3 cutover deliberately does not scan them. Install a valid preview TLS certificate before the deployer stops a service.
3. On the approved host, run `UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json UBOT_PREVIEW_CERT_PATH=/path/to/preview-cert.pem UBOT_PREVIEW_KEY_PATH=/path/to/preview-key.pem /path/to/deploy-linux-release.sh 3.0.8 ubot-3.0.8-linux.tar.gz`. The deployer permits only the approved production field `network.websocketClients.0.url` and writes only the fixed V3 Docker-gateway URL.
4. The deployer stops writers, verifies SHA-256 and SQLite, takes restricted backups (including persistent generated pages), installs runtime dependencies, performs `migrate-v3-state.mjs --execute --allow-existing-cutover`, updates the NapCat reverse URL, renders and atomically installs the dedicated preview vhost/include after `nginx -t`, installs units, switches `current`, starts V3, then restarts the running `napcat` Docker container so it reads the replacement JSON. It never replaces an existing application vhost. On an already cut-over V3 database this applies only additive SQLite migrations, V3 state cleanup and the capability-policy update; it never reads, reimports, archives, or removes legacy JSON.
5. Verify `systemctl status ubot-ingress ubot-worker ubot-admin`, `systemctl list-timers ubot-maintenance.timer`, an unauthenticated `curl -I http://127.0.0.1:6200/api/health` returning `401`, and `curl -I https://preview.9958.uk/p/not-a-valid-token/` returning `404` without a `Set-Cookie` header.
6. Sign in over HTTPS, finish TOTP enrollment if required, then perform one `@机器人` message, one reply-to-a-confirmed-bot-message test and one `#网页` preview test in an enabled group. Do not force every group to `mentions_only`.

The production NapCat configuration is `/opt/napcat/config/onebot11_428881701.json`; its approved reverse URL field is `network.websocketClients.0.url`. The deployer validates and edits a restricted staging copy, then atomically installs only that approved change through `sudo` while preserving the existing file owner, group, and mode. The running Docker container is `napcat` by default (`UBOT_NAPCAT_CONTAINER` may name the approved equivalent). NapCat does not watch a host-side JSON replacement, so after the V3 processes pass their active check the deployer restarts that running container and waits for Docker to report it running. This briefly interrupts the reverse connection but prevents it from retaining the old URL.

## Retention and migration

`migrate-v3-state.mjs --execute` imports only approved explicit memory sources, puts retired automatic/candidate/persona material into an encrypted seven-day rollback archive, writes the V3 cutover marker, and retires legacy runtime stores. `--allow-existing-cutover` is the release-upgrade mode for a marked V3 database: it runs additive SQLite migrations, appends the explicitly authorized `html_preview` capability to an existing policy, and may apply a one-time, audited profile revision from the bundled `assets/huixian-profile.json`; it never accesses old runtime JSON. The revision marker makes the change idempotent and preserves later administrator edits. `ubot-maintenance.timer` runs `--maintenance --execute` hourly to delete raw messages and attachment metadata at the seven-day receipt-time boundary, expired rollback archives, expired preview pages, stale preview leases, temporary publication directories and orphaned page files. OneBot event timestamps are never allowed to extend this retention window. Daily report outputs remain, but their source raw message content does not.

## Failure and rollback

Before V3 migration completes, the deploy script restores the old `current` selection, unit files, dotenv, dedicated preview vhost/include/enabled-link and NapCat configuration, then restarts the previously active service. It does not modify existing application Nginx vhosts. An additive upgrade from an existing V3 cutover can also restart the previous V3 target after configuration rollback. The deployer deliberately does **not** restore SQLite, generated page state, auto-start `ai-project.service`, or replay historical Outbox rows. Configuration is still restored to avoid leaving NapCat pointed at a stopped V3 ingress. At that point:

1. Leave all UBot services stopped and retain `/opt/ai-project/release-backups/<timestamp>-v3.0.8` plus `data/v3-rollback` and `data/generated-pages`.
2. If the deployer had restarted NapCat, it restores the JSON and restarts the container once more so the old connection target is loaded. Verify its connection target before any manual retry.
3. Escalate with the exact release version, migration output, unit journal, and a copy of the restricted backup. An approved operator decides whether a manual database restore or a forward-only repair is appropriate.

Never run a legacy release against a V3-migrated data directory, and never retry historical pending/sending Outbox rows automatically.
