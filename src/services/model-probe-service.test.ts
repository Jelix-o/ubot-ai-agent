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

test("Grok image probes use the same compatible Base64 request as runtime generation", async (t) => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://grok.example/v1/images/generations");
    const body = JSON.parse(String(init?.body));
    if ("quality" in body || "output_format" in body || "size" in body) {
      return Response.json({ error: { code: "invalid_parameter" } }, { status: 400 });
    }
    assert.equal(body.aspect_ratio, "1:1");
    return Response.json({ data: [body.response_format === "b64_json"
      ? { b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==" }
      : { url: "https://grok.example/generated.png" }] });
  };
  t.mock.method(globalThis, "fetch", fetchImpl);
  const status = await probeSystemModel({
    id: "grok", purpose: "image", model: "grok-imagine-image-2.0",
    baseUrl: "https://grok.example/v1", apiKey: "grok-test-key",
  });
  assert.equal(status.ok, true);
  assert.equal(status.probeType, "image");
  assert.equal(calls, 1);
});

test("GPT image probes retain their low-quality PNG request", async (t) => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.size, "1024x1024");
    assert.equal(body.quality, "low");
    assert.equal(body.output_format, "png");
    assert.equal(body.aspect_ratio, undefined);
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==" }] });
  };
  t.mock.method(globalThis, "fetch", fetchImpl);
  const status = await probeSystemModel({
    purpose: "image", model: "gpt-image-2.5-sunburst",
    baseUrl: "https://image.example/v1", apiKey: "image-test-key",
  });
  assert.equal(status.ok, true);
  assert.equal(status.probeType, "image");
});

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
