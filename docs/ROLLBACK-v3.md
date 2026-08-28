# UBot V3 Rollback Boundaries

V3 can restore release selection and service configuration before data cutover,
but it never automatically restores SQLite or replays QQ history after the V3
cutover marker may have been written. This protects message causality and
prevents accidental duplicate sends.

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
