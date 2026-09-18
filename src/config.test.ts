import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("profile AI environment variables are not part of the V3 runtime configuration", () => {
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
