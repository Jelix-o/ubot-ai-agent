# UBot V3 Operations

## Runtime layout

Production uses `/opt/ai-project-releases/current` as an atomic symbolic link to a versioned release. Persistent state remains outside a release:

| Path | Owner / purpose |
| --- | --- |
| `/opt/ai-project/.env` | Secrets and production connection settings, mode `0600` |
| `/opt/ai-project/data` | SQLite authority, encrypted V3 rollback archive, caches and logs |
| `/opt/ai-project/config`, `/opt/ai-project/skills` | Legacy input only during the one-time cutover; neither is linked into V3 runtime |
| `/opt/ai-project/release-backups` | Restricted operator backups taken before a deployment |
| `/opt/ai-project-releases/current` | Active V3 release symlink |

`ubot-ingress.service`, `ubot-worker.service`, and `ubot-admin.service` are independent processes managed by `ubot.target`. `ai-project.service` is disabled after cutover but its unit file is retained for manual disaster recovery. Do not start it alongside V3.

## Required production settings

The persistent `.env` must contain a non-empty `UBOT_STATE_ENCRYPTION_KEY`, encoded as 64 hexadecimal characters or base64url for exactly 32 bytes. V3 derives separate state, TOTP and rollback-archive keys with HKDF; `ADMIN_SESSION_SECRET` and `ADMIN_TOTP_ENCRYPTION_KEY` are retired names. Generate and store the master key in the approved secret manager; do not put it in GitHub Actions, a release bundle, command history, or support tickets.

For this production topology, set `ADMIN_HTTP_ENABLED=true`,
`ADMIN_HTTP_HOST=127.0.0.1`, `ADMIN_HTTP_PORT=6200`, and
`INGRESS_READ_API_PORT=6198` in the persistent `.env`. The deployer fails
before cutover when the admin listener is not explicitly enabled or either
internal port is changed.

For the Docker-hosted NapCat deployment, V3 ingress binds `172.21.0.1:6199`. NapCat must use `ws://172.21.0.1:6199/onebot/ws` as its reverse URL. `6198` and `6200` stay loopback-only. Do not change UFW or AWS security groups as part of this deployment.

## Release procedure

1. Download the matching `ubot-3.0.1-linux.tar.gz` and `ubot-3.0.1-linux.tar.gz.sha256` assets from the GitHub Release, then validate the archive with that manifest. Do not substitute a locally built or differently tagged bundle.
2. Confirm `systemctl status ai-project.service`, `systemctl status ubot.target`, and free disk space. The deployment user must be able to read and atomically replace `/opt/ai-project/.env` and the NapCat JSON, and write/search `data` and `data/shared`. A first V3 cutover additionally needs access to legacy JSON and `skills`; an existing V3 cutover deliberately does not scan them. The systemd and Nginx target directories must be writable through the approved non-interactive `sudo` policy. The deployer proves these permissions with disposable probes before it stops either service; fix an access failure instead of bypassing this preflight.
3. On the approved host, run `UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json UBOT_NGINX_CONFIG=/absolute/path/to/active-bot.9958.uk.conf /path/to/deploy-linux-release.sh 3.0.1 ubot-3.0.1-linux.tar.gz`. The deployer permits only the approved production field `network.websocketClients.0.url` and writes only the fixed V3 Docker-gateway URL.
4. The deployer stops writers, verifies SHA-256 and SQLite, takes restricted backups, installs runtime dependencies, performs `migrate-v3-state.mjs --execute --allow-existing-cutover`, updates the NapCat reverse URL, installs the reviewed Nginx template after `nginx -t`, installs units, switches `current`, starts V3, then restarts the running `napcat` Docker container so it reads the replacement JSON. On an already cut-over V3 database this applies only additive SQLite migrations and V3 state cleanup; it never reads, reimports, archives, or removes legacy JSON.
5. Verify `systemctl status ubot-ingress ubot-worker ubot-admin`, `systemctl list-timers ubot-maintenance.timer`, and an unauthenticated `curl -I http://127.0.0.1:6200/api/health` returning `401`.
6. Sign in over HTTPS, finish TOTP enrollment if required, then perform one `@机器人` message and one reply-to-a-confirmed-bot-message test in each existing participation policy. Do not force every group to `mentions_only`.

The production NapCat configuration is `/opt/napcat/config/onebot11_428881701.json`; its approved reverse URL field is `network.websocketClients.0.url`. The deployer validates and edits a restricted staging copy, then atomically installs only that approved change through `sudo` while preserving the existing file owner, group, and mode. The running Docker container is `napcat` by default (`UBOT_NAPCAT_CONTAINER` may name the approved equivalent). NapCat does not watch a host-side JSON replacement, so after the V3 processes pass their active check the deployer restarts that running container and waits for Docker to report it running. This briefly interrupts the reverse connection but prevents it from retaining the old URL.

## Retention and migration

`migrate-v3-state.mjs --execute` imports only approved explicit memory sources, puts retired automatic/candidate/persona material into an encrypted seven-day rollback archive, writes the V3 cutover marker, and retires legacy runtime stores. `--allow-existing-cutover` is the release-upgrade mode for a marked V3 database: it runs additive SQLite migrations and never accesses old JSON. `ubot-maintenance.timer` runs `--maintenance --execute` hourly to delete raw messages and attachment metadata at the seven-day receipt-time boundary and expired rollback archives. OneBot event timestamps are never allowed to extend this retention window. Daily report outputs remain, but their source raw message content does not.

## Failure and rollback

Before V3 migration completes, the deploy script restores the old `current` selection, unit files, dotenv, Nginx and NapCat configuration, then restarts the previously active service. An additive upgrade from an existing V3 cutover can also restart the previous V3 target after configuration rollback. The deployer deliberately does **not** restore SQLite, auto-start `ai-project.service`, or replay historical Outbox rows. Configuration is still restored to avoid leaving NapCat pointed at a stopped V3 ingress. At that point:

1. Leave all UBot services stopped and retain `/opt/ai-project/release-backups/<timestamp>-v3.0.1` plus `data/v3-rollback`.
2. If the deployer had restarted NapCat, it restores the JSON and restarts the container once more so the old connection target is loaded. Verify its connection target before any manual retry.
3. Escalate with the exact release version, migration output, unit journal, and a copy of the restricted backup. An approved operator decides whether a manual database restore or a forward-only repair is appropriate.

Never run a legacy release against a V3-migrated data directory, and never retry historical pending/sending Outbox rows automatically.
