#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.length !== 2) {
  throw new Error("Usage: pipe the replacement Gemini key to rotate-gemini-reply-key.mjs; command-line secret arguments are not accepted.");
}
if (process.stdin.isTTY) {
  throw new Error("Read the replacement key from a secure source and pipe it to standard input; interactive entry is disabled to avoid terminal echo.");
}

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.resolve(process.env.RELEASE_ROOT || scriptRoot);
const appRoot = path.resolve(process.env.UBOT_APP_ROOT || "/opt/ai-project");
const dbPath = path.resolve(process.env.DB_PATH || path.join(appRoot, "data", "shared", "bot-shared.db"));

const { default: dotenv } = await import(pathToFileURL(path.join(releaseRoot, "node_modules", "dotenv", "lib", "main.js")).href);
dotenv.config({ path: path.join(appRoot, ".env") });

const encryptionKey = process.env.UBOT_STATE_ENCRYPTION_KEY?.trim();
if (!encryptionKey) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required.");

const replacementKey = await readSecretFromStdin();
if (!replacementKey) throw new Error("Provide a non-empty replacement key on standard input.");

const { SharedDb } = await import(pathToFileURL(path.join(releaseRoot, "dist", "shared", "sqlite.js")).href);
const { V3StateRepository } = await import(pathToFileURL(path.join(releaseRoot, "dist", "services", "v3-state-repository.js")).href);
const { SystemSettingsStore } = await import(pathToFileURL(path.join(releaseRoot, "dist", "services", "system-settings-store.js")).href);

const db = new SharedDb(dbPath);
try {
  const repository = new V3StateRepository(db, { stateEncryptionKey: encryptionKey });
  if (!repository.isCutover()) throw new Error("V3 state cutover is not complete.");

  const store = new SystemSettingsStore("unused.json", [], undefined, repository);
  const current = await store.getInternal();
  if (current.selectedModelIds.reply !== "sol") {
    throw new Error("Refusing Gemini rotation because the default reply model is not sol.");
  }

  const gemini = current.models.find((model) => model.id === "gemini");
  if (!gemini || gemini.purpose !== "reply") {
    throw new Error("The reply model named gemini is not configured.");
  }

  const now = new Date().toISOString();
  const models = current.models.map((model) => model.id === "gemini"
    ? { ...model, apiKey: replacementKey, hasApiKey: true, enabled: true, updatedAt: now }
    : model);
  const fallbackModelIds = [...new Set([...(current.replyRouting?.fallbackModelIds ?? []), "gemini"])];
  await store.update({
    models,
    selectedModelIds: current.selectedModelIds,
    replyRouting: {
      ...current.replyRouting,
      fallbackEnabled: true,
      fallbackModelIds,
    },
  });

  const verified = await store.getInternal();
  const configured = verified.models.find((model) => model.id === "gemini");
  if (
    verified.selectedModelIds.reply !== "sol" ||
    !configured?.enabled ||
    !configured.hasApiKey ||
    configured.apiKey !== replacementKey ||
    !verified.replyRouting?.fallbackEnabled ||
    !verified.replyRouting.fallbackModelIds.includes("gemini")
  ) {
    throw new Error("Gemini reply-key rotation verification failed.");
  }

  process.stdout.write(`${JSON.stringify({
    rotatedModelId: "gemini",
    defaultReplyModelId: verified.selectedModelIds.reply,
    fallbackEnabled: verified.replyRouting.fallbackEnabled,
    fallbackModelIds: verified.replyRouting.fallbackModelIds,
  })}\n`);
} finally {
  db.close();
}

async function readSecretFromStdin() {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 16_384) throw new Error("Standard input is unexpectedly large.");
  }
  return value.trim();
}
