import { pathToFileURL } from "node:url";

const releaseRoot = "/opt/ai-project-releases/current";
const { default: dotenv } = await import(pathToFileURL(`${releaseRoot}/node_modules/dotenv/lib/main.js`).href);
const { default: OpenAI } = await import(pathToFileURL(`${releaseRoot}/node_modules/openai/index.mjs`).href);
const { SharedDb } = await import(pathToFileURL(`${releaseRoot}/dist/shared/sqlite.js`).href);
const { V3StateRepository } = await import(pathToFileURL(`${releaseRoot}/dist/services/v3-state-repository.js`).href);
const { SystemSettingsStore } = await import(pathToFileURL(`${releaseRoot}/dist/services/system-settings-store.js`).href);

dotenv.config({ path: "/opt/ai-project/.env" });
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sharedDb = new SharedDb("/opt/ai-project/data/shared/bot-shared.db");
const repository = new V3StateRepository(sharedDb, { stateEncryptionKey: process.env.UBOT_STATE_ENCRYPTION_KEY });
repository.requireCutover();
const settings = await new SystemSettingsStore("unused-system-settings.json", [], undefined, repository).getInternal();
if (request.diagnose === true) {
  process.stdout.write(JSON.stringify({
    selectedModelIds: settings.selectedModelIds,
    models: settings.models.map((item) => ({
      id: item.id,
      name: item.name,
      purpose: item.purpose,
      protocol: item.apiProtocol ?? "openai",
      enabled: item.enabled,
      hasUsableKey: Boolean(item.apiKey?.trim()),
      endpointOrigin: new URL(item.baseUrl).origin,
      model: item.model,
    })),
  }));
  sharedDb.close();
  process.exit(0);
}
if (typeof request.systemPrompt !== "string" || typeof request.userPrompt !== "string") throw new Error("invalid bridge request");

const requestedId = typeof request.modelId === "string" && request.modelId.trim() ? request.modelId.trim() : "";
const candidateOrder = [
  requestedId,
  "gemini-38-flash",
  "ds",
  settings.selectedModelIds.summary,
  settings.selectedModelIds.reply,
].filter(Boolean);

const seenIds = new Set();
const candidates = [];
for (const id of candidateOrder) {
  if (seenIds.has(id)) continue;
  seenIds.add(id);
  const found = settings.models.find((item) => item.id === id && item.enabled && item.apiKey?.trim());
  if (found) candidates.push(found);
}
for (const item of settings.models) {
  if (!seenIds.has(item.id) && item.enabled && item.apiKey?.trim()) {
    seenIds.add(item.id);
    candidates.push(item);
  }
}

if (candidates.length === 0) throw new Error("no usable production model is configured");

let lastError;
for (const selected of candidates) {
  try {
    let chatCompletions;
    if (selected.apiProtocol === "anthropic") {
      const { AnthropicChatCompletions } = await import(pathToFileURL(`${releaseRoot}/dist/services/anthropic-adapter.js`).href);
      chatCompletions = new AnthropicChatCompletions(selected.baseUrl, selected.apiKey, { timeoutMs: 180_000 });
    } else {
      const client = new OpenAI({ apiKey: selected.apiKey, baseURL: selected.baseUrl, timeout: 180_000, maxRetries: 1 });
      chatCompletions = client.chat.completions;
    }
    const completion = await chatCompletions.create({
      model: selected.model,
      temperature: 0.15,
      max_tokens: 2400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "";
    if (content) {
      process.stdout.write(JSON.stringify({ content, model: completion.model ?? selected.model, modelId: selected.id }));
      sharedDb.close();
      process.exit(0);
    }
  } catch (error) {
    lastError = error;
    process.stderr.write(`Model candidate ${selected.id} (${selected.model}) failed: ${error.message}\n`);
  }
}
sharedDb.close();
throw lastError ?? new Error("all candidate models failed");
