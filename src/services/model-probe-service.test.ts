import assert from "node:assert/strict";
import test from "node:test";

import { AiService } from "./ai-service.js";
import { probeSystemModel } from "./model-probe-service.js";

type Health = Awaited<ReturnType<AiService["checkHealth"]>>;

async function withStubbedHealth(run: () => Promise<void>, health: Health | (() => Promise<Health>)): Promise<void> {
  const original = AiService.prototype.checkHealth;
  AiService.prototype.checkHealth = async () => (typeof health === "function" ? health() : health);
  try {
    await run();
  } finally {
    AiService.prototype.checkHealth = original;
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
