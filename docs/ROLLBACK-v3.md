# UBot V3 Rollback Boundaries

V3 can restore release selection and service configuration before data cutover,
but it never automatically restores SQLite or replays QQ history after the V3
cutover marker may have been written. This protects message causality and
prevents accidental duplicate sends.

## v3.0.43 member-profile query rollback

This patch changes routing and prompt rules only, with no database schema or
model-policy upgrade. Switching back to v3.0.42 keeps the same persisted member
profiles, command permissions and model selection. Do not run the v3.0.39
model-policy rollback for this patch. Preserve the adult-card recall drain
window below before stopping Ingress, and do not rewind SQLite or replay outbox
rows.

## v3.0.38 adult-card recall rollback

Migration 20 is additive: it adds nullable recall-policy fields to `outbox`
and the `message_recalls` table. It does not alter card payloads, historic
messages or completed outbox rows. Preserve these fields and the table when
selecting an earlier binary; an older release can safely ignore them.

Before stopping v3.0.38 for a rollback, leave the new Ingress running for up
to 105 seconds after the last successful adult BT card delivery. This lets its
durable silent-recall tasks reach their final action deadline. Do not manually
replay pending or sending recall tasks under the old binary. If an immediate
rollback is unavoidable, retain the SQLite state and restore v3.0.38 later to
reconcile the retained task records; do not send any compensating group
message.

## v3.0.35 forward-message rollback

The upgrade adds a nullable `outbox.forward_payload_json` column and the
`forward` kind. Existing rows keep a null payload. A forward row's `text`
contains only a short BT fallback notice, so v3.0.34's text delivery branch
can safely consume a pending row after rollback without exposing its JSON or
splitting complete magnets into ordinary group messages. Retain the additive
column; do not rewind SQLite or replay terminal/ambiguous sending rows.

v3.0.36 records the column addition as migration 19 for existing versioned
databases. The migration also accepts a column already added during v3.0.35
recovery. Keep migration history when switching back to an earlier binary.

## v3.0.34 capability policy rollback

The deployer saves `capability-policy.json` next to the offline SQLite backup
before enabling `bt_search`. A failed additive upgrade restores this exact
policy before starting the prior target. It does not rewind messages/outbox.

For a manual rollback to v3.0.33 or earlier, stop all V3 services, restore the
policy with the v3.0.34 helper, then select the prior release and restart:

```bash
sudo systemctl stop ubot.target
sudo -u ubuntu node /opt/ai-project-releases/v3.0.34/scripts/bt-capability-policy.mjs \
  restore /opt/ai-project/data/shared/bot-shared.db \
  /opt/ai-project/release-backups/<deployment>-v3.0.34/capability-policy.json
# Select the verified prior release using the established atomic-link procedure.
sudo systemctl start ubot.target
```

Keep services stopped if policy restore fails. Older binaries reject unknown
capabilities, so switching only the release symlink is insufficient.

## Before State Cutover

If the deployment fails before `migrate-v3-state.mjs --execute` starts, the
deployer restores:

- the prior `/opt/ai-project-releases/current` symbolic link;
- installed V3 unit files;
- the dedicated `preview.9958.uk` Nginx vhost, static-security include and
  enabled symlink with a validated reload; existing application vhosts are not
  modified by this deployment;
- the NapCat reverse WebSocket JSON field and, if V3 had restarted it, the `napcat` Docker container so it reloads that restored field;
- the persistent `.env` copy; and
- the service that was active before deployment.

Inspect the restricted backup under
`/opt/ai-project/release-backups/<timestamp>-v<version>` before attempting
another deployment.

## After State Cutover Begins

Once cutover may have started, leave all UBot processes stopped if the deployer
reports failure. It may restore the release pointer, Nginx, dotenv, unit files,
and NapCat JSON, but it intentionally does not:

- restore `bot-shared.db` automatically;
- restore, remove or recreate persistent generated preview pages automatically;
- start `ai-project.service` against V3 state;
- replay Outbox rows; or
- extract the encrypted seven-day rollback archive into the runtime database.

Do not run an old release against the V3 `data/` directory. Do not copy JSON
stores back into a live V3 release.

## Manual Recovery

1. Preserve the deployment output, unit journals, release version, and the
   restricted backup directory. Do not delete the encrypted archive in
   `data/v3-rollback`.
2. Verify NapCat points to the intended reverse URL after the deployer-controlled restart. If its running state was not restored, restart the approved `napcat` container manually only after checking the JSON.
   The V3 production value is `ws://172.21.0.1:6199/onebot/ws`.
3. Have an approved operator decide between a forward-only repair and an
   audited, offline database restore. A database restore requires all UBot
   services stopped and a new integrity check before any service starts.
4. If an offline database restore is approved, restore the complete SQLite
   backup as a unit, not individual tables. Revalidate the marker, schema,
   service configuration, and message/outbox state before resuming service.

The legacy `ai-project.service` file remains on the host for manual disaster
recovery only. It stays disabled after a V3 deployment and must never run in
parallel with `ubot.target`.

## v3.0.39 模型策略回滚

先停止 Worker 接收新任务，等待最近成人 BT 卡片的撤回任务最多 105 秒结束，再停止新版 Ingress 与 Admin。保留新版发布目录，用新版 `scripts/upgrade-model-policy.mjs --rollback` 恢复加密备份中的系统模型策略、指令权限和原群模型选择，然后切回旧发布并启动三项服务。工具读取持久目录 `.env` 中的状态加密密钥，不输出备份内容。不要只切换程序而保留新版权限策略；旧版仍按自身固定权限执行。重复回滚为无操作，升级标记保留，避免意外再次覆盖配置。
