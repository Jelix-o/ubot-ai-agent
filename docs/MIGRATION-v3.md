# UBot V3 State Migration

This procedure moves an RC.2 or earlier installation to the V3 SQLite
authority. It is a one-way cutover: after the marker is written, V3 does not
read or write the former JSON runtime stores.

## Preconditions

1. Use the release that matches the target version. For production, use only
   the published GitHub Release archive and its matching SHA-256 manifest.
2. Confirm that `UBOT_STATE_ENCRYPTION_KEY` is present in the persistent
   `.env` and encodes exactly 32 bytes as 64 hexadecimal characters or
   base64url. Do not put the value in a command line, release bundle, issue,
   or log.
3. Stop every UBot writer. On the production layout, both `ai-project.service`
   and `ubot.target` must be inactive before a manual migration.
4. Inspect the existing SQLite database with `PRAGMA integrity_check` and take
   a restricted backup of `/opt/ai-project/.env`, `data`, `config`, `skills`,
   and the NapCat JSON configuration. Before stopping writers, confirm the
   deployment user can atomically replace `.env` and the NapCat JSON, write
   SQLite and `data/v3-rollback`, and remove the legacy JSON and `skills`
   paths being archived. The deployment script proves these permissions and
   checks before starting the irreversible cutover.
5. Do not attempt to resend historical Outbox rows. Resolve or preserve their
   state before cutover; V3 never automatically replays pending or ambiguous
   QQ deliveries.

## Preview And Execute

From an unpacked release directory with its persistent `.env` and `data`
available, run a dry preview first:

```bash
npm run migrate:v3
```

Review the reported source counts and archive plan. Then run the one-time
write operation:

```bash
npm run migrate:v3 -- --execute
```

The production deployer invokes the same command only after it has stopped
writers, checked the Release SHA-256 and SQLite integrity, and created its
restricted backup.

## Imported And Archived Data

- Group configuration, system settings, approved explicit memories, knowledge,
  reminders, reports, countdown state, tasks, audit data, and health history
  are imported into SQLite.
- Only memories with source `admin`, `explicit_command`, or
  `explicit_request` enter the V3 runtime database.
- Candidate memory, automatic memory, profile data, historical personas,
  legacy conversations/topics, and retired JSON source material are encrypted
  into the seven-day restricted rollback archive. They do not become V3
  runtime inputs.
- The migration enforces seven-day raw message and attachment metadata
  retention before recording the cutover marker.

## Completion Checks

1. Confirm the SQLite migration ledger contains versions `1` through `8` and
   `v3_state_meta` contains the V3 cutover marker.
2. Start `ubot.target`, then confirm `ubot-ingress.service`,
   `ubot-worker.service`, and `ubot-admin.service` are active.
3. Confirm `ubot-maintenance.timer` is enabled. It removes expired raw message
   metadata and encrypted rollback archives.
4. Sign in over HTTPS, complete TOTP enrollment when required, and perform one
   `@机器人` message plus one reply to a confirmed bot message.

For the production release switch and NapCat configuration update, follow
[OPERATIONS-v3.md](OPERATIONS-v3.md). For a failure before or after the
cutover marker, follow [ROLLBACK-v3.md](ROLLBACK-v3.md).
