#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3 || args[0] !== "--input" || !args[1] ||
  (args[2] && !["--check", "--apply"].includes(args[2]))) {
  throw new Error("Usage: maintain-member-alias.mjs --input /private/alias.json [--check|--apply]");
}
const input = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
const root = process.env.RELEASE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = process.env.UBOT_APP_ROOT || "/opt/ai-project";
const { default: dotenv } = await import(pathToFileURL(path.join(root, "node_modules/dotenv/lib/main.js")).href);
const env = dotenv.parse(fs.readFileSync(path.join(appRoot, ".env")));
const key = process.env.UBOT_STATE_ENCRYPTION_KEY || env.UBOT_STATE_ENCRYPTION_KEY;
if (!key) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required");
const { SharedDb } = await import(pathToFileURL(path.join(root, "dist/shared/sqlite.js")).href);
const { V3StateRepository } = await import(pathToFileURL(path.join(root, "dist/services/v3-state-repository.js")).href);
const { maintainMemberAlias } = await import(pathToFileURL(path.join(root, "dist/services/member-alias-maintenance.js")).href);
const db = new SharedDb(process.env.DB_PATH || path.join(appRoot, "data/shared/bot-shared.db"));
try {
  const result = maintainMemberAlias(new V3StateRepository(db, { stateEncryptionKey: key }), key, input, args[2] === "--apply");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { db.close(); }
