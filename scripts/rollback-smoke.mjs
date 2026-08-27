/**
 * V3 rollback-boundary smoke test.
 *
 * A V3 deployment may restore release selection and service configuration
 * before cutover, but never rolls database state back or restarts the legacy
 * JSON runtime after migration begins. This static gate protects that promise
 * without starting a legacy process against a V3 SQLite data directory.
 *
 * Usage: node scripts/run-node22.cjs scripts/rollback-smoke.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const [deployer, rollbackDocs, operationsDocs] = await Promise.all([
  readFile(path.join(root, "scripts", "deploy-linux-release.sh"), "utf8"),
  readFile(path.join(root, "docs", "ROLLBACK-v3.md"), "utf8"),
  readFile(path.join(root, "docs", "OPERATIONS-v3.md"), "utf8"),
]);

const requiredDeployerMarkers = [
  "cutover_may_have_started=0",
  "cutover_may_have_started=1",
  "restore_napcat_config",
  "restore_persistent_env",
  "restore_nginx_config",
  "restore_unit_files",
  "if [[ \"$cutover_may_have_started\" -eq 0 && \"$old_legacy_active\" -eq 1 ]]; then",
  "Do not restart the legacy service",
  "migrate-v3-state.mjs\" --execute",
];
for (const marker of requiredDeployerMarkers) {
  if (!deployer.includes(marker)) {
    throw new Error(`V3 deployment rollback boundary is missing: ${marker}`);
  }
}

for (const forbidden of [
  "cp \"$BACKUP_DIR/bot-shared.db\" \"$DB_PATH\"",
  "sqlite3 \"$DB_PATH\"",
  "systemctl start \"$LEGACY_SERVICE\" || true\n  fi\n  if [[ \"$cutover_may_have_started\" -eq 1",
]) {
  if (deployer.includes(forbidden)) {
    throw new Error(`V3 deployer contains a forbidden automatic post-cutover recovery action: ${forbidden}`);
  }
}

for (const requiredDocumentation of [
  "never automatically restores SQLite",
  "Do not run an old release against the V3 `data/` directory",
  "never retry historical pending/sending Outbox rows automatically",
]) {
  if (!`${rollbackDocs}\n${operationsDocs}`.includes(requiredDocumentation)) {
    throw new Error(`V3 rollback documentation is missing: ${requiredDocumentation}`);
  }
}

console.log("ROLLBACK_BOUNDARY_SMOKE_OK");
