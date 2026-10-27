import assert from "node:assert/strict";
import test from "node:test";

import { AiService, ImageIntentClassificationError } from "./ai-service.js";
import { probeSystemModel } from "./model-probe-service.js";

type Health = Awaited<ReturnType<AiService["checkHealth"]>>;
type ImageIntentInput = Parameters<AiService["classifyImageIntent"]>[0];
type ImageIntentResult = Awaited<ReturnType<AiService["classifyImageIntent"]>>;

async function withStubbedHealth(run: () => Promise<void>, health: Health | (() => Promise<Health>)): Promise<void> {
  const original = AiService.prototype.checkHealth;
  AiService.prototype.checkHealth = async () => (typeof health === "function" ? health() : health);
  try {
    await run();
  } finally {
    AiService.prototype.checkHealth = original;
  }
}

async function withStubbedImageIntent(
  run: () => Promise<void>,
  classify: (input: ImageIntentInput) => Promise<ImageIntentResult>,
): Promise<void> {
  const original = AiService.prototype.classifyImageIntent;
  AiService.prototype.classifyImageIntent = classify;
  try {
    await run();
  } finally {
    AiService.prototype.classifyImageIntent = original;
  }
}

test("probeSystemModel always reports chat probe type", async () => {
  await withStubbedHealth(async () => {
    const status = await probeSystemModel({
      purpose: "custom",
      baseUrl: "https://chat.example/v1",
      apiKey: "chat-key",
      model: "chat-model",
    });
    assert.equal(status.ok, true);
    assert.equal(status.probeType, "chat");
  }, {
    ok: true,
    detail: "模型可用",
    model: "chat-model",
    baseUrl: "https://chat.example/v1",
    checkedAt: new Date().toISOString(),
    latencyMs: 3,
    cached: false,
  });
});

test("probeSystemModel keeps upstream failures classified as chat probes", async () => {
  await withStubbedHealth(async () => {
    const status = await probeSystemModel({
      purpose: "custom",
      baseUrl: "https://chat.example/v1",
      apiKey: "chat-key",
      model: "chat-model",
    });
    assert.equal(status.ok, false);
    assert.equal(status.probeType, "chat");
    assert.equal(status.upstreamStatusCode, 502);
    assert.equal(status.failureKind, "unavailable");
    assert.match(status.detail, /502|不可用|gateway/i);
  }, {
    ok: false,
    detail: "模型不可用：HTTP 502",
    model: "chat-model",
    baseUrl: "https://chat.example/v1",
    checkedAt: new Date().toISOString(),
    latencyMs: 2,
    cached: false,
    failureKind: "unavailable",
    upstreamStatusCode: 502,
  } as Health);
});

test("probeSystemModel classifies format failures", async () => {
  await withStubbedHealth(async () => {
    const status = await probeSystemModel({
      purpose: "knowledge",
      baseUrl: "https://chat.example/v1",
      apiKey: "chat-key",
      model: "chat-model",
    });
    assert.equal(status.ok, false);
    assert.equal(status.probeType, "chat");
    assert.equal(status.failureKind, "format_error");
  }, {
    ok: false,
    detail: "模型检测不通过：格式错误",
    model: "chat-model",
    baseUrl: "https://chat.example/v1",
    checkedAt: new Date().toISOString(),
    latencyMs: 1,
    cached: false,
    failureKind: "format_error",
  } as Health);
});

test("image intent probe verifies a forced native tool call", async () => {
  let received: ImageIntentInput | undefined;
  await withStubbedImageIntent(async () => {
    const status = await probeSystemModel({
      purpose: "image_intent",
      baseUrl: "https://router.example/v1",
      apiKey: "router-key",
      model: "router-model",
    });
    assert.equal(status.ok, true);
    assert.equal(status.probeType, "image_intent");
    assert.equal(status.model, "router-model-v2");
  }, async input => {
    received = input;
    return { action: "generate", model: "router-model-v2" };
  });

  assert.deepEqual(received, {
    sanitizedText: "生成一张蓝色圆形图标",
    facts: {
      hasTrustedBotMention: true,
      hasTrustedReply: false,
      replyIsGeneratedImage: false,
      attachmentCount: 0,
    },
  });
});

test("image intent probe fails when a gateway does not return a valid tool call", async () => {
  await withStubbedImageIntent(async () => {
    const status = await probeSystemModel({
      purpose: "image_intent",
      baseUrl: "https://router.example/v1",
      apiKey: "router-key",
      model: "router-model",
    });
    assert.equal(status.ok, false);
    assert.equal(status.probeType, "image_intent");
    assert.equal(status.failureKind, "format_error");
    assert.match(status.detail, /原生工具调用/);
  }, async () => {
    throw new ImageIntentClassificationError("invalid_response");
  });
});
