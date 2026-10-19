# UBot V3 Migration

V3 makes SQLite the runtime authority. The initial migration is one-way: after
the V3 cutover marker is committed, the active runtime does not resume reading
or writing legacy JSON state.

## Preconditions

1. Use the verified archive and checksum for the exact target release.
2. Confirm the persistent state encryption key is valid, SQLite passes
   `PRAGMA integrity_check`, and a restricted backup exists outside the
   release directory.
3. Stop every database writer, including `ubot.target`, any legacy service,
   `ubot-maintenance.timer`, its one-shot service, and the independent
   Cloudflare allow-list updater before changing related configuration.
4. Verify the persistent dotenv, data directory, preview root, and NapCat
   configuration can be atomically changed by the deployment procedure.
   If the independent Cloudflare updater cannot be stopped, do not proceed;
   contain and inspect it before allowing any Nginx change.

## Execution

For a diagnostic preview from a matching release:

```bash
npm run migrate:v3
```

The production deployer performs the write step only after artifact, path,
permission, Node 22, Cloudflare-origin, and database checks have passed. It
creates a restricted backup before running the migration and uses
`--allow-existing-cutover` only for additive upgrades of an already marked V3
database.

## Data Boundary

Approved group settings, explicit memories, knowledge, schedules, reports,
audit history, and health history are moved into SQLite. Candidate memories,
automatic profile data, historical personas, conversations, and retired JSON
inputs are retained only in the encrypted, time-limited rollback archive; they
do not become V3 runtime input.

The v3.0.49 migration removes the retired roast-mode field from every group
configuration in one SQLite transaction. A malformed configuration causes the
entire change to roll back rather than producing partial cleanup.

## Completion

Confirm the migration ledger and V3 marker, then start `ubot.target` and
verify Ingress, Worker, and Admin are active with zero restart count. Start
the maintenance and Cloudflare timers only after authenticated Read API and
Admin health checks pass. Verify an HTTPS admin login, a normal group reply,
and an isolated preview request.

For failures before the cutover marker, follow [ROLLBACK-v3.md](ROLLBACK-v3.md).
For normal host operation, use [OPERATIONS-v3.md](OPERATIONS-v3.md).
