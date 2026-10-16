#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "--check";
if (!["--check", "--apply"].includes(mode) || process.argv.length > 3) throw new Error("Usage: repair-member-name.mjs [--check|--apply]");
const root = process.env.RELEASE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = process.env.UBOT_APP_ROOT || "/opt/ai-project";
const { default: dotenv } = await import(pathToFileURL(path.join(root, "node_modules/dotenv/lib/main.js")).href);
const env = dotenv.parse(fs.readFileSync(path.join(appRoot, ".env")));
const key = process.env.UBOT_STATE_ENCRYPTION_KEY || env.UBOT_STATE_ENCRYPTION_KEY;
if (!key) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required");
const { SharedDb } = await import(pathToFileURL(path.join(root, "dist/shared/sqlite.js")).href);
const { V3StateRepository } = await import(pathToFileURL(path.join(root, "dist/services/v3-state-repository.js")).href);
const { repairMemberName } = await import(pathToFileURL(path.join(root, "dist/services/member-name-repair.js")).href);
const db = new SharedDb(process.env.DB_PATH || path.join(appRoot, "data/shared/bot-shared.db"));
try {
  process.stdout.write(`${JSON.stringify(repairMemberName(new V3StateRepository(db, { stateEncryptionKey: key }), key, mode === "--apply"))}\n`);
} finally { db.close(); }
