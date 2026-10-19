import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { SharedDb } from "../dist/shared/sqlite.js";
import { SystemSettingsStore } from "../dist/services/system-settings-store.js";
import { V3StateRepository } from "../dist/services/v3-state-repository.js";

const stateEncryptionKey = "0".repeat(64);
const replacement = "rotation-test-key-not-a-production-secret";

test("Gemini key rotation reads only stdin and preserves sol as default with Gemini fallback", async (t) => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "ubot-gemini-key-rotation-"));
  t.after(async () => { await rm(appRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await mkdir(path.join(appRoot, "data", "shared"), { recursive: true });
  await writeFile(path.join(appRoot, ".env"), `UBOT_STATE_ENCRYPTION_KEY=${stateEncryptionKey}\n`, "utf8");

  const dbPath = path.join(appRoot, "data", "shared", "bot-shared.db");
  const db = new SharedDb(dbPath);
  const repository = new V3StateRepository(db, { stateEncryptionKey });
  repository.markCutover();
  const store = new SystemSettingsStore("unused.json", [], undefined, repository);
  const now = new Date().toISOString();
  await store.update({
    models: ["sol", "gpt", "gemini"].map((id) => ({
      id,
      name: id,
      shortName: id,
      baseUrl: "https://test.invalid/v1",
      model: id,
      purpose: "reply",
      apiKey: id === "gemini" ? "old-test-key" : `${id}-test-key`,
      hasApiKey: true,
      enabled: id !== "gemini",
      createdAt: now,
      updatedAt: now,
    })),
    selectedModelIds: { reply: "sol" },
    replyRouting: {
      fallbackEnabled: true,
      fallbackModelIds: ["gpt"],
      chatAttemptTimeoutMs: 45_000,
      chatTotalTimeoutMs: 120_000,
      htmlAttemptTimeoutMs: 120_000,
      htmlTotalTimeoutMs: 300_000,
    },
  });
  db.close();

  const result = await runRotation({ appRoot, replacement });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(replacement, "u"));
  assert.deepEqual(JSON.parse(result.stdout), {
    rotatedModelId: "gemini",
    defaultReplyModelId: "sol",
    fallbackEnabled: true,
    fallbackModelIds: ["gpt", "gemini"],
  });

  const verifiedDb = new SharedDb(dbPath);
  try {
    const verifiedStore = new SystemSettingsStore("unused.json", [], undefined, new V3StateRepository(verifiedDb, { stateEncryptionKey }));
    const settings = await verifiedStore.getInternal();
    assert.equal(settings.selectedModelIds.reply, "sol");
    assert.deepEqual(settings.replyRouting.fallbackModelIds, ["gpt", "gemini"]);
    assert.equal(settings.models.find((model) => model.id === "gemini")?.apiKey, replacement);
    assert.equal(settings.models.find((model) => model.id === "gemini")?.enabled, true);
  } finally {
    verifiedDb.close();
  }
});

test("Gemini key rotation refuses command-line key arguments without echoing them", async () => {
  const forbiddenArgument = "must-not-be-accepted-as-a-key";
  const result = await runRotation({ args: [forbiddenArgument], replacement: "ignored-stdin-value" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /command-line secret arguments are not accepted/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(forbiddenArgument, "u"));
});

function runRotation({ appRoot, replacement, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/rotate-gemini-reply-key.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, RELEASE_ROOT: process.cwd(), ...(appRoot ? { UBOT_APP_ROOT: appRoot } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${replacement}\n`);
  });
}
