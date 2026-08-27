import assert from "node:assert/strict";
import test from "node:test";

import { resolveProviderCapabilities } from "./ai-provider.js";

test("Anthropic capability policy never enables OpenAI streaming or reasoning parameters", () => {
  const capabilities = resolveProviderCapabilities({
    apiProtocol: "anthropic",
    supportsVision: false,
    capabilities: {
      vision: true,
      streaming: false,
      reasoningEffort: true,
    },
  });

  assert.deepEqual(capabilities, {
    vision: true,
    streaming: false,
    reasoningEffort: false,
    requestTimeout: true,
  });
});

test("OpenAI-compatible provider capability policy can disable optional request features", () => {
  const capabilities = resolveProviderCapabilities({
    apiProtocol: "openai",
    supportsVision: true,
    capabilities: {
      vision: false,
      streaming: false,
      reasoningEffort: false,
    },
  });

  assert.deepEqual(capabilities, {
    vision: false,
    streaming: false,
    reasoningEffort: false,
    requestTimeout: true,
  });
});
