import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "./config.js";

test("release aliases use one physical data directory while a fresh install can still create data", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-config-data-"));
  const originalEnv = process.env;
  t.after(() => { process.env = originalEnv; rmSync(root, { recursive: true, force: true }); });
  process.env = {
    NAPCAT_MODE: "reverse", OPENAI_BASE_URL: "https://example.test/v1",
    OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "fixture-model",
    INGRESS_READ_API_TOKEN: "fixture-token", BOT_QQ: "12345",
  };
  const persistent = path.join(root, "persistent");
  mkdirSync(persistent);
  let cwd = "";
  t.mock.method(process, "cwd", () => cwd);
  for (const version of ["old-release", "new-release"]) {
    cwd = path.join(root, version);
    mkdirSync(cwd);
    symlinkSync(persistent, path.join(cwd, "data"), "junction");
    const config = loadConfig();
    assert.equal(config.dataDir, realpathSync(persistent));
    assert.equal(config.htmlPreviewRoot, path.join(config.dataDir, "generated-pages"));
    for (const key of ["conversationsPath", "dailyReportStorePath", "holidayCountdownStorePath",
      "scheduledReminderStorePath", "adminOperationLogPath", "groupMemoryPath", "knowledgeBasePath",
      "systemSettingsPath", "adminTasksPath", "modelHealthHistoryPath"] as const) {
      assert.equal(path.dirname(config[key]), config.dataDir, key);
    }
    assert.equal(config.groupsConfigPath, path.join(cwd, "config", "groups.json"));
  }
  cwd = path.join(root, "fresh-release");
  mkdirSync(cwd);
  const config = loadConfig();
  assert.equal(config.dataDir, path.join(cwd, "data"));
  assert.equal(existsSync(config.dataDir), false);
  mkdirSync(config.dataDir);
  assert.equal(loadConfig().dataDir, realpathSync(config.dataDir));
  process.env.HTML_PREVIEW_ROOT = path.join(root, "custom-preview");
  assert.equal(loadConfig().htmlPreviewRoot, process.env.HTML_PREVIEW_ROOT);
});

test("startup refuses a retired Gemini environment model", () => {
  const originalEnv = { ...process.env };
  try {
    process.env = { ...originalEnv, INGRESS_READ_API_TOKEN: "fixture-token", OPENAI_BASE_URL: "https://example.test/v1", OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "models/gemini-3" };
    assert.throws(() => loadConfig(), /model_retired/);
  } finally { process.env = originalEnv; }
});

test("profile AI environment variables are not part of the V3 runtime configuration", () => {
  const originalEnv = { ...process.env };
  try {
    process.env = {
      ...originalEnv,
      NAPCAT_MODE: "reverse",
      OPENAI_BASE_URL: "https://reply.example/v1",
      OPENAI_API_KEY: "reply-key",
      OPENAI_MODEL: "reply-model",
      INGRESS_READ_API_TOKEN: "test-ingress-read-token",
      BOT_QQ: "12345",
    };
    process.env.PROFILE_AI_BASE_URL = "https://profile.example/v1";
    process.env.PROFILE_AI_API_KEY = "profile-key";
    process.env.PROFILE_AI_MODEL = "profile-model";

    const configured = loadConfig();
    assert.equal(configured.openAiModel, "reply-model");
    assert.equal("profileAiBaseUrl" in configured, false);
    assert.equal("profileAiApiKey" in configured, false);
    assert.equal("profileAiModel" in configured, false);
  } finally {
    process.env = originalEnv;
  }
});

test("tts environment variables are not part of the runtime configuration", () => {
  const originalEnv = { ...process.env };
  try {
    process.env = {
      ...originalEnv,
      NAPCAT_MODE: "reverse",
      OPENAI_BASE_URL: "https://reply.example/v1",
      OPENAI_API_KEY: "reply-key",
      OPENAI_MODEL: "reply-model",
      INGRESS_READ_API_TOKEN: "test-ingress-read-token",
      BOT_QQ: "12345",
      TTS_BASE_URL: "https://custom-tts.example/v1",
      TTS_API_KEY: "tts-key",
      TTS_MODEL: "custom-tts-model",
    };

    const configured = loadConfig() as unknown as Record<string, unknown>;
    assert.equal("ttsBaseUrl" in configured, false);
    assert.equal("ttsApiKey" in configured, false);
    assert.equal("ttsModel" in configured, false);
  } finally {
    process.env = originalEnv;
  }
});

test("reverse websocket requires access token when listening publicly", () => {
  const originalEnv = { ...process.env };
  try {
    process.env = {
      ...originalEnv,
      NAPCAT_MODE: "reverse",
      NAPCAT_REVERSE_WS_HOST: "0.0.0.0",
      OPENAI_BASE_URL: "https://reply.example/v1",
      OPENAI_API_KEY: "reply-key",
      OPENAI_MODEL: "reply-model",
      INGRESS_READ_API_TOKEN: "test-ingress-read-token",
      BOT_QQ: "12345",
    };
    delete process.env.NAPCAT_ACCESS_TOKEN;

    assert.throws(
      () => loadConfig(),
      /NAPCAT_ACCESS_TOKEN is required/,
    );

    process.env.NAPCAT_ACCESS_TOKEN = "reverse-token";
    const config = loadConfig();
    assert.equal(config.napcatAccessToken, "reverse-token");
    assert.equal(config.napcatReverseWsHost, "0.0.0.0");
  } finally {
    process.env = originalEnv;
  }
});

test("ingress read API requires a separate shared bearer token", () => {
  const originalEnv = { ...process.env };
  try {
    process.env = {
      ...originalEnv,
      NAPCAT_MODE: "reverse",
      OPENAI_BASE_URL: "https://reply.example/v1",
      OPENAI_API_KEY: "reply-key",
      OPENAI_MODEL: "reply-model",
      BOT_QQ: "12345",
    };
    delete process.env.INGRESS_READ_API_TOKEN;
    assert.throws(() => loadConfig(), /Missing required environment variable: INGRESS_READ_API_TOKEN/);

    process.env.INGRESS_READ_API_TOKEN = "test-ingress-read-token";
    assert.equal(loadConfig().ingressReadApiToken, "test-ingress-read-token");
  } finally {
    process.env = originalEnv;
  }
});
