import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("profile ai config falls back to openai config and supports overrides", () => {
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
    delete process.env.PROFILE_AI_BASE_URL;
    delete process.env.PROFILE_AI_API_KEY;
    delete process.env.PROFILE_AI_MODEL;

    const fallback = loadConfig();
    assert.equal(fallback.profileAiBaseUrl, "https://reply.example/v1");
    assert.equal(fallback.profileAiApiKey, "reply-key");
    assert.equal(fallback.profileAiModel, "reply-model");

    process.env.PROFILE_AI_BASE_URL = "https://profile.example/v1";
    process.env.PROFILE_AI_API_KEY = "profile-key";
    process.env.PROFILE_AI_MODEL = "profile-model";

    const configured = loadConfig();
    assert.equal(configured.openAiModel, "reply-model");
    assert.equal(configured.profileAiBaseUrl, "https://profile.example/v1");
    assert.equal(configured.profileAiApiKey, "profile-key");
    assert.equal(configured.profileAiModel, "profile-model");
  } finally {
    process.env = originalEnv;
  }
});
