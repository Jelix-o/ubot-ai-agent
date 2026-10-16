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

The persistent `.env` must contain a non-empty `UBOT_STATE_ENCRYPTION_KEY`, encoded as 64 hexadecimal characters or base64url for exactly 32 bytes. V3 derives separate state and rollback-archive keys with HKDF; `ADMIN_SESSION_SECRET` and `ADMIN_TOTP_ENCRYPTION_KEY` are retired names. Generate and store the master key in the approved secret manager; do not put it in GitHub Actions, a release bundle, command history, or support tickets.

The 2026 private-enterprise ranking can always answer enterprise and province
questions from its checksum-verified primary dataset. Headquarters-city answers
remain disabled while the separate research ledger is `in_progress`. Before
changing that ledger to `complete`, retain the full 500-entry evidence archive,
have an independent reviewer validate it, and inject the reviewer's base64 SPKI
Ed25519 public key plus matching key ID through
`UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY` and
`UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID`. Keep the matching
private key offline. A missing or invalid completion signature must fail the
release/startup validation rather than expose partial or self-asserted city
data. Before a completed ledger is packaged, set those same two *public*
values as GitHub Actions repository variables with the identical names, and
export them in the local shell used for `npm run package:all`; they are needed
only to validate the completed signature. The Linux deployer reads only those
two values from the persistent `.env` and verifies the compiled release before
it stops any writer. Never put the signing private key in Actions, `.env`, a
release bundle, or command history.

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

1. Download the matching `ubot-3.0.14-linux.tar.gz` and `ubot-3.0.14-linux.tar.gz.sha256` assets from the GitHub Release, then validate the archive with that manifest. Do not substitute a locally built or differently tagged bundle.
2. Confirm `systemctl status ai-project.service`, `systemctl status ubot.target`, and free disk space. The deployment user must be able to read and atomically replace `/opt/ai-project/.env` and the NapCat JSON, write/search `data`, `data/shared` and `data/generated-pages`, and use the approved non-interactive `sudo` policy for systemd plus the three dedicated preview Nginx targets. A first V3 cutover additionally needs access to legacy JSON and `skills`; an existing V3 cutover deliberately does not scan them. Install a valid preview TLS certificate before the deployer stops a service.
3. On the approved host, run `UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json UBOT_PREVIEW_CERT_PATH=/path/to/preview-cert.pem UBOT_PREVIEW_KEY_PATH=/path/to/preview-key.pem /path/to/deploy-linux-release.sh 3.0.14 ubot-3.0.14-linux.tar.gz`. The deployer permits only the approved production field `network.websocketClients.0.url` and writes only the fixed V3 Docker-gateway URL.
4. The deployer stops writers, verifies SHA-256 and SQLite, takes restricted backups (including persistent generated pages), installs runtime dependencies, performs `migrate-v3-state.mjs --execute --allow-existing-cutover`, updates the NapCat reverse URL, renders and atomically installs the dedicated preview vhost/include after `nginx -t`, installs units, switches `current`, starts V3, then restarts the running `napcat` Docker container so it reads the replacement JSON. It never replaces an existing application vhost. On an already cut-over V3 database this applies only additive SQLite migrations, V3 state cleanup and the capability-policy update; it never reads, reimports, archives, or removes legacy JSON.
5. Verify `systemctl status ubot-ingress ubot-worker ubot-admin`, `systemctl list-timers ubot-maintenance.timer`, an unauthenticated `curl -I http://127.0.0.1:6200/api/health` returning `401`, and `curl -I https://preview.9958.uk/p/not-a-valid-token/` returning `404` without a `Set-Cookie` header.
6. Sign in over HTTPS with an admin password (at least 12 characters), then perform one `@机器人` message, one reply-to-a-confirmed-bot-message test and one `#网页` preview test in an enabled group. Do not force every group to `mentions_only`.

The production NapCat configuration is `/opt/napcat/config/onebot11_428881701.json`; its approved reverse URL field is `network.websocketClients.0.url`. The deployer validates and edits a restricted staging copy, then atomically installs only that approved change through `sudo` while preserving the existing file owner, group, and mode. The running Docker container is `napcat` by default (`UBOT_NAPCAT_CONTAINER` may name the approved equivalent). NapCat does not watch a host-side JSON replacement, so after the V3 processes pass their active check the deployer restarts that running container and waits for Docker to report it running. This briefly interrupts the reverse connection but prevents it from retaining the old URL.

## Retention and migration

`migrate-v3-state.mjs --execute` imports only approved explicit memory sources, puts retired automatic/candidate/persona material into an encrypted seven-day rollback archive, writes the V3 cutover marker, and retires legacy runtime stores. `--allow-existing-cutover` is the release-upgrade mode for a marked V3 database: it runs additive SQLite migrations, appends the explicitly authorized `html_preview` capability to an existing policy, and may apply a one-time, audited profile revision from the bundled `assets/huixian-profile.json`; it never accesses old runtime JSON. The revision marker makes the change idempotent and preserves later administrator edits. `ubot-maintenance.timer` runs `--maintenance --execute` hourly to delete raw messages and attachment metadata at the seven-day receipt-time boundary, expired rollback archives, expired preview pages, stale preview leases, temporary publication directories and orphaned page files. OneBot event timestamps are never allowed to extend this retention window. Daily report outputs remain, but their source raw message content does not.

## Failure and rollback

Before V3 migration completes, the deploy script restores the old `current` selection, unit files, dotenv, dedicated preview vhost/include/enabled-link and NapCat configuration, then restarts the previously active service. It does not modify existing application Nginx vhosts. An additive upgrade from an existing V3 cutover can also restart the previous V3 target after configuration rollback. The deployer deliberately does **not** restore SQLite, generated page state, auto-start `ai-project.service`, or replay historical Outbox rows. Configuration is still restored to avoid leaving NapCat pointed at a stopped V3 ingress. At that point:

1. Leave all UBot services stopped and retain `/opt/ai-project/release-backups/<timestamp>-v3.0.14` plus `data/v3-rollback` and `data/generated-pages`.
2. If the deployer had restarted NapCat, it restores the JSON and restarts the container once more so the old connection target is loaded. Verify its connection target before any manual retry.
3. Escalate with the exact release version, migration output, unit journal, and a copy of the restricted backup. An approved operator decides whether a manual database restore or a forward-only repair is appropriate.

Never run a legacy release against a V3-migrated data directory, and never retry historical pending/sending Outbox rows automatically.

## BT search operations (v3.0.34)

Install the pinned Python and browser dependencies using `assets/bt/README.md` before enabling `#bt` / `/bt`. Keep the venv and browsers under `/opt/ai-project/bt-runtime`, and caches, site health, cookies and Chromium XDG state under persistent `data/bt/`; the service handles `ProtectHome` without accessing user home directories. Set `UBOT_BT_PROXY` to an existing verified SOCKS5 proxy if needed.

The worker owns one global search slot with four waiting requests. Full searches have a 180-second total deadline and default 30-second per-site timeout; fast searches stop at 15 seconds, returning available partial results. Command settings live in the existing backend command editor. `bt_search` is an explicit capability added by the additive upgrade while retaining existing command customizations.

Before migrating, the deployer saves the old capability policy. Restore that policy before selecting a binary that does not recognize `bt_search`; see `docs/ROLLBACK-v3.md`. Policy rollback never rewinds message or outbox state.

Starting in v3.0.35, each BT result set is one QQ merged-forward card. Each
resource is a literal text node with its complete original links; fast/cache
results have no progress bubble, and a running search emits at most one after
five seconds. Ingress owns the `send_group_forward_msg` action and confirms
the actual platform message ID. Forward rows store their payload separately
from the short fallback `text`, making v3.0.34 rollback safe.

An explicit rejection falls back to one short notice. Network/dispatch
timeouts, missing message IDs and NapCat-reported send timeouts are ambiguous
and terminal; do not replay those rows. An acknowledgement persistence failure
also remains quarantined for reconciliation. A disconnected socket before
dispatch is safe to retry. QQ card presentation is checked through the user's
normal searches; automated delivery checks use mock transports.

Starting in v3.0.38, a result set whose final resolved type is `adult` has
the fixed adult-content warning as the first line of its first forward node.
Only a successfully delivered outer QQ forward card with a real platform
message ID is eligible for silent recall: Ingress persists a recall task at
acknowledgement time, first calls `delete_msg` 90 seconds later, and may retry
once only when the first action was definitely not dispatched. It never starts
a new recall action after 105 seconds. Rejected, ambiguous, unsupported and
externally recalled cards end their task without any group notice. The fallback
text used after an explicit forward rejection is never recalled. Recall tasks
store delivery identifiers and timing only; they do not store the search query,
magnet links or card contents. Inspect task states through the shared SQLite
database and service logs when validating an upgrade; do not manually replay
terminal recall actions.

## v3.0.39 模型策略升级

发布前使用当前密钥验证 Sol、GPT、DS 的真实对话和 GPT 视觉调用；有任一必需链路失败则保留旧服务。

在新发布目录运行 `node scripts/upgrade-model-policy.mjs --check`，停止 Worker 后运行 `--apply`。环境支持 `RELEASE_ROOT`、`UBOT_APP_ROOT`、`DB_PATH`。操作在 SQLite 事务中加密备份系统配置及群模型，设置 Sol → GPT → DS、DS 上游模型为 `deepseek-flash`、全部群跟随、生图权限为全员，并记录幂等标记。重复执行不重置用户后续设置；日志不输出密钥或模型内容。回滚同时恢复 DS 的原上游模型名。

v3.0.40 起，若先前部署已经完整回滚，可显式运行 `--apply --retry-after-rollback` 重试。本选项仅识别已回滚标记，不会覆盖成功升级后的设置。启动健康检查应允许 NapCat 的重连间隔，确认 `/read/health` 返回 `ok: true` 后再完成部署。

后台「系统设置 → 对话回复」调整默认与备用、单次与总超时；「群配置 → 回复」由超级管理员设置例外；「指令设置」修改权限。模型熔断按连接配置隔离，连续失败五次暂停三十秒；慢请求仅计入延迟指标。升级后检查三项服务、实际模型路由日志、群继承及指令权限。

## v3.0.43 成员画像查询

本版无需数据库迁移或模型策略重置。明确的成员资料提问只通过真实 @、回复对象或后台人工身份表中的唯一别名确定目标，读取其已启用的 `member_profile`，不读取近期群聊证据。画像不存在或目标关闭记忆时，直接返回资料不足，不调用模型。

排查时查看 Worker 的 `memberProfileQueryIntent`、`memberProfileQueryRequested`、`savedAliasStatus`、`targetUserIds` 和 `memorySubjectUserIds`；这些字段不包含问题、画像正文或回复内容。`memoryCount` 仅表示实际注入条数，必须结合归属 QQ 判断是否注入了正确成员。升级后可复查唯一别名查询、隐私关闭和资料缺失路径；部署仍保留成人 BT 撤回任务最多 105 秒的排空要求。
