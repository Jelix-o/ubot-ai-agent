#!/usr/bin/env node
// Restore only capability policy, never rewind messages or outbox state.
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";

const [mode, dbPath, snapshotPath] = process.argv.slice(2);
if (!["backup", "restore"].includes(mode) || !dbPath || !snapshotPath || process.argv.length !== 5) {
  throw new Error("Usage: bt-capability-policy.mjs backup|restore /path/to/db /path/to/snapshot.json");
}
const db = new DatabaseSync(dbPath, { readOnly: mode === "backup" });
try {
  const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v3_capability_policies'").get());
  if (mode === "backup") {
    const row = hasTable ? db.prepare("SELECT policy_key, policy_json, updated_at FROM v3_capability_policies WHERE policy_key='default'").get() : undefined;
    await writeFile(snapshotPath, JSON.stringify({ version: 1, row: row ?? null }), { mode: 0o600 });
  } else {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    const row = snapshot.row;
    if (snapshot.version !== 1 || (row !== null && (!row || row.policy_key !== "default" || typeof row.policy_json !== "string" || !Number.isSafeInteger(row.updated_at)))) {
      throw new Error("Invalid capability policy snapshot");
    }
    if (row) JSON.parse(row.policy_json);
    if (!hasTable && row) throw new Error("Capability policy table is missing");
    if (hasTable) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM v3_capability_policies WHERE policy_key='default'").run();
        if (row) db.prepare("INSERT INTO v3_capability_policies (policy_key, policy_json, updated_at) VALUES (?, ?, ?)").run(row.policy_key, row.policy_json, row.updated_at);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  }
} finally { db.close(); }
