import assert from "node:assert/strict";
import test from "node:test";

import {
  ImageIntentRouterError,
  ImageIntentRouterPlugin,
  normalizeImageIntentRouterInput,
  type ImageIntentClassifier,
  type ImageIntentRouterInput,
} from "./image-intent-router-plugin.js";

const input: ImageIntentRouterInput = {
  sanitizedText: "  将 [MENTION_1] 的头像美化一下\u0000  ",
  facts: {
    hasTrustedBotMention: true,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
    attachmentCount: 9,
  },
};

test("ImageIntentRouterPlugin normalizes untrusted input and returns only a validated action route", async () => {
  let received: ImageIntentRouterInput | undefined;
  const classifier: ImageIntentClassifier = {
    async isImageIntentConfigured() { return true; },
    async classifyImageIntent(value) {
      received = value;
      return { action: "avatar_edit", modelId: "dafeiyu", model: "fish-small" };
    },
  };
  const router = new ImageIntentRouterPlugin(classifier);

  assert.equal(await router.isConfigured(), true);
  assert.deepEqual(await router.classify(input), {
    action: "avatar_edit",
    modelId: "dafeiyu",
    model: "fish-small",
  });
  assert.deepEqual(received, {
    sanitizedText: "将 [MENTION_1] 的头像美化一下",
    facts: {
      hasTrustedBotMention: true,
      hasTrustedReply: false,
      replyIsGeneratedImage: false,
      attachmentCount: 4,
    },
  });
});

test("ImageIntentRouterPlugin fails closed for unavailable or malformed classifier results", async () => {
  const unavailable = new ImageIntentRouterPlugin({
    async isImageIntentConfigured() { throw new Error("settings unavailable"); },
    async classifyImageIntent() { throw new Error("network"); },
  });
  assert.equal(await unavailable.isConfigured(), false);
  await assert.rejects(
    unavailable.classify(input),
    (error: unknown) => error instanceof ImageIntentRouterError && error.code === "unavailable",
  );

  const malformed = new ImageIntentRouterPlugin({
    async isImageIntentConfigured() { return true; },
    async classifyImageIntent() {
      return { action: "rewrite_prompt", modelId: "dafeiyu", model: "fish-small" } as never;
    },
  });
  await assert.rejects(
    malformed.classify(input),
    (error: unknown) => error instanceof ImageIntentRouterError && error.code === "invalid_response",
  );
});

test("normalizeImageIntentRouterInput clears malformed facts without adding interpretation", () => {
  assert.deepEqual(normalizeImageIntentRouterInput({
    sanitizedText: "x".repeat(4_100),
    facts: {
      hasTrustedBotMention: false,
      hasTrustedReply: true,
      replyIsGeneratedImage: true,
      attachmentCount: Number.NaN,
    },
  }), {
    sanitizedText: "x".repeat(4_000),
    facts: {
      hasTrustedBotMention: false,
      hasTrustedReply: true,
      replyIsGeneratedImage: true,
      attachmentCount: 0,
    },
  });
});
