#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

const releaseRoot = process.env.RELEASE_ROOT || "/opt/ai-project-releases/current";
const appRoot = process.env.UBOT_APP_ROOT || "/opt/ai-project";
const dbPath = process.env.DB_PATH || `${appRoot}/data/shared/bot-shared.db`;

const { default: dotenv } = await import(pathToFileURL(`${releaseRoot}/node_modules/dotenv/lib/main.js`).href);
dotenv.config({ path: `${appRoot}/.env` });

const encryptionKey = process.env.UBOT_STATE_ENCRYPTION_KEY?.trim();
if (!encryptionKey) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required.");

const apiKey = await readSecretFromStdin();
if (!apiKey) throw new Error("Provide the image model API key on standard input.");

const { SharedDb } = await import(pathToFileURL(`${releaseRoot}/dist/shared/sqlite.js`).href);
const { V3StateRepository } = await import(pathToFileURL(`${releaseRoot}/dist/services/v3-state-repository.js`).href);
const { SystemSettingsStore } = await import(pathToFileURL(`${releaseRoot}/dist/services/system-settings-store.js`).href);

const db = new SharedDb(dbPath);
try {
  const repository = new V3StateRepository(db, { stateEncryptionKey: encryptionKey });
  if (!repository.isCutover()) throw new Error("V3 state cutover is not complete.");

  const store = new SystemSettingsStore("unused.json", [], undefined, repository);
  const current = await store.getInternal();
  const id = "gpt-image-sunburst";
  const existing = current.models.find((model) => model.id === id);
  if (existing && existing.purpose !== "image") {
    throw new Error("The configured image model id conflicts with a non-image model.");
  }
  const now = new Date().toISOString();
  const imageModel = {
    ...(existing ?? {}),
    id,
    name: "GPT Image 2.5 Sunburst",
    shortName: "Sunburst",
    baseUrl: "http://127.0.0.1:18080/v1",
    model: "gpt-image-2.5-sunburst",
    purpose: "image",
    apiProtocol: "openai",
    apiKey,
    hasApiKey: true,
    enabled: true,
    supportsVision: false,
    capabilities: {
      vision: false,
      streaming: false,
      reasoningEffort: false,
      requestTimeout: true,
      imageGeneration: true,
    },
    requestTimeoutMs: 180_000,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const models = existing
    ? current.models.map((model) => model.id === id ? imageModel : model)
    : [...current.models, imageModel];

  await store.update({
    models,
    selectedModelIds: { ...current.selectedModelIds, image: id },
  });

  const verified = await store.getInternal();
  const configured = verified.models.find((model) => model.id === id);
  const groupRows = db.db.prepare("SELECT config_json FROM v3_groups").all();
  const imageEnabledGroupCount = groupRows.reduce((count, row) => {
    const config = JSON.parse(row.config_json);
    return count + (config.imageGenerationEnabled === true ? 1 : 0);
  }, 0);
  if (!configured?.hasApiKey || configured.apiKey !== apiKey || verified.selectedModelIds.image !== id) {
    throw new Error("The encrypted image model configuration could not be verified.");
  }
  if (imageEnabledGroupCount !== 0) {
    throw new Error("At least one group unexpectedly has image generation enabled.");
  }

  process.stdout.write(`${JSON.stringify({
    configuredModelId: id,
    selected: true,
    enabled: configured.enabled,
    hasApiKey: configured.hasApiKey,
    replyModelCount: verified.models.filter((model) => model.purpose === "reply").length,
    imageModelCount: verified.models.filter((model) => model.purpose === "image").length,
    groupCount: groupRows.length,
    imageEnabledGroupCount,
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
