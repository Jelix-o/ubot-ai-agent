# UBot V3 Rollback Boundary

V3 rollback has a strict state boundary. It can restore release selection and
configuration before a cutover starts, but it must not silently turn V3 SQLite
state back into a legacy JSON runtime.

## What The Deployer Restores

On a deployment failure, the deployer stops active V3 writers and restores the
previous release link, unit files, persistent dotenv, dedicated preview Nginx
files, and approved NapCat configuration. For an existing V3 installation,
additive migration failures may restart the previous V3 target after the
configuration boundary has been restored.

The deployer restores a previously active maintenance or Cloudflare updater
timer only after their services are confirmed stopped and the old unit/config
state is back. It does not resume an interrupted one-shot maintenance or CIDR
update, preventing duplicate writes. If the Cloudflare updater cannot be
contained, its service and timer remain masked and automatic Nginx restoration
is skipped until an operator resolves the writer.

## What It Never Restores Automatically

- SQLite data after a migration may have started.
- Generated preview state or message delivery state.
- Legacy JSON services after a V3 cutover marker may have been written.
- Historical pending, sending, unknown-delivery, or terminal Outbox rows.

Do not run a legacy binary against V3 data. Do not copy old JSON stores into a
live V3 release. Do not automatically retry historical delivery or recall rows
whose external effect is uncertain.

## Operator Procedure

1. Leave UBot services stopped if the deployer reports an unquiesced writer,
   failed capability-policy restore, or a migration boundary ambiguity. A
   failed Cloudflare updater stop blocks automatic restart; when its units are
   confirmed masked, inspect the process and Nginx include, then explicitly
   unmask them only after the recovered configuration is valid.
2. Preserve the restricted release backup, journal output, migration report,
   current database files, and relevant NapCat configuration before changing
   anything else.
3. Verify SQLite integrity and the V3 marker in an isolated recovery location.
   Decide explicitly between forward repair and a full approved database
   restore; do not mix files from different backups.
4. For a binary that predates a retained capability, restore its compatible
   capability policy only after all writers are stopped and the recovery plan
   has been reviewed.
5. Validate Ingress, Worker, Admin, NapCat connectivity, timer state, Admin
   authentication, and preview access before returning traffic.

The V3 compatibility layer remains until **2027-01-31**. Before deleting it,
complete and record an isolated restore drill using a restricted backup.
