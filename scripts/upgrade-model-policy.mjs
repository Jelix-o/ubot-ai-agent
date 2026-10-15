#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "--check";
if (!["--check", "--apply", "--rollback"].includes(mode) || process.argv.length > 3) throw new Error("Usage: upgrade-model-policy.mjs [--check|--apply|--rollback]");
const root = process.env.RELEASE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = process.env.UBOT_APP_ROOT || "/opt/ai-project";
const { default: dotenv } = await import(pathToFileURL(path.join(root, "node_modules/dotenv/lib/main.js")).href);
const env = dotenv.parse(fs.readFileSync(path.join(appRoot, ".env")));
const key = process.env.UBOT_STATE_ENCRYPTION_KEY || env.UBOT_STATE_ENCRYPTION_KEY;
if (!key) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required");
const { SharedDb } = await import(pathToFileURL(path.join(root, "dist/shared/sqlite.js")).href);
const { V3StateRepository } = await import(pathToFileURL(path.join(root, "dist/services/v3-state-repository.js")).href);
const policy = await import(pathToFileURL(path.join(root, "dist/services/model-policy-upgrade.js")).href);
const db = new SharedDb(process.env.DB_PATH || path.join(appRoot, "data/shared/bot-shared.db"));
try {
  const repository = new V3StateRepository(db, { stateEncryptionKey: key });
  const result = mode === "--apply" ? policy.upgradeModelPolicy(repository, key) : mode === "--rollback" ? policy.rollbackModelPolicy(repository, key) : (policy.checkModelPolicyUpgrade(repository), { ready: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { db.close(); }
