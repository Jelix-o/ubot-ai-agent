import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { SystemSettingsStore } from "./system-settings-store.js";
import {
  ConfiguredImageGenerationService,
  ImageGenerationError,
  isGeneratedImagePath,
} from "./image-generation-service.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");

test("configured image generation calls the selected model and stages a validated image", async (t) => {
  const fixture = await makeFixture(t, async (url, init) => {
    assert.equal(url, "https://primary.example/v1/images/generations");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer primary-key");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      model: "image-primary",
      prompt: "draw a lighthouse",
      n: 1,
      size: "1024x1024",
      quality: "auto",
      output_format: "png",
    });
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  });

  const result = await fixture.service.generate({ groupId: "100", userId: "200", prompt: " draw a lighthouse " });
  assert.equal(result.modelId, "primary");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(await readFile(result.filePath), PNG);
  assert.equal(isGeneratedImagePath(fixture.imageRoot, result.filePath), true);
});

test("configured image generation falls back only after a retryable failure", async (t) => {
  const urls: string[] = [];
  const fixture = await makeFixture(t, async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? jsonResponse(503, { error: { message: "temporarily unavailable" } })
      : jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  });
  const result = await fixture.service.generate({ groupId: "100", userId: "200", prompt: "fallback" });
  assert.equal(result.modelId, "backup");
  assert.equal(result.fallbackUsed, true);
  assert.equal(urls.length, 2);
});

test("authentication and invalid image responses remain attached to the selected upstream", async (t) => {
  for (const scenario of [
    () => jsonResponse(401, { error: { message: "invalid api key" } }),
    () => jsonResponse(400, { error: { message: "content policy rejection" } }),
    () => jsonResponse(200, { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
    () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(30 * 1024 * 1024) },
    }),
  ]) {
    let calls = 0;
    const fixture = await makeFixture(t, async () => {
      calls += 1;
      return scenario();
    });
    await assert.rejects(
      fixture.service.generate({ groupId: `group-${calls}`, userId: "200", prompt: "reject" }),
      (error: unknown) => error instanceof ImageGenerationError &&
        (error.code === "upstream_rejected" || error.code === "invalid_image_response"),
    );
    assert.equal(calls, 1);
  }
});

test("an upstream timeout switches to the next configured image model", async (t) => {
  let calls = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = [
    { ...model("primary", "https://primary.example/v1", "image-primary", "primary-key"), requestTimeoutMs: 10 },
    { ...model("backup", "https://backup.example/v1", "image-backup", "backup-key"), requestTimeoutMs: 10 },
  ];
  const settings = {
    async getInternal() {
      return { models, selectedModelIds: { image: "primary" } };
    },
  } as SystemSettingsStore;
  const service = new ConfiguredImageGenerationService(settings, path.join(root, "images"), undefined, undefined, async (_url, init) => {
    calls += 1;
    if (calls > 1) return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const result = await service.generate({ groupId: "timeout", userId: "200", prompt: "timeout" });
  assert.equal(result.modelId, "backup");
  assert.equal(calls, 2);
});

test("successful image generation applies a per-group per-user cooldown", async (t) => {
  let now = 10_000;
  let calls = 0;
  const fixture = await makeFixture(t, async () => {
    calls += 1;
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  }, () => now);
  await fixture.service.generate({ groupId: "100", userId: "200", prompt: "first" });
  await assert.rejects(
    fixture.service.generate({ groupId: "100", userId: "200", prompt: "second" }),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "cooldown" && error.retryAfterSeconds === 60,
  );
  now += 60_000;
  await fixture.service.generate({ groupId: "100", userId: "200", prompt: "third" });
  assert.equal(calls, 2);
});

test("generated image path validation rejects the root itself and sibling paths", () => {
  const root = path.resolve("managed-images");
  assert.equal(isGeneratedImagePath(root, root), false);
  assert.equal(isGeneratedImagePath(root, path.join(root, "ok.png")), true);
  assert.equal(isGeneratedImagePath(root, path.join(root, "..", "escape.png")), false);
  assert.equal(isGeneratedImagePath(root, path.join(root, "not-image.txt")), false);
});

test("request cancellation does not fall back to another upstream", async (t) => {
  let calls = 0;
  const fixture = await makeFixture(t, async (_url, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = fixture.service.generate({ groupId: "cancel", userId: "200", prompt: "cancel", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(calls, 1);
});

test("invalid JSON and URL-only responses do not fall back", async (t) => {
  for (const response of [
    new Response("{", { status: 200 }),
    jsonResponse(200, { data: [{ url: "https://untrusted.example/image.png" }] }),
  ]) {
    let calls = 0;
    const fixture = await makeFixture(t, async () => {
      calls += 1;
      return response.clone();
    });
    await assert.rejects(
      fixture.service.generate({ groupId: `invalid-${calls}`, userId: "200", prompt: "invalid" }),
      (error: unknown) => error instanceof ImageGenerationError && error.code === "invalid_image_response",
    );
    assert.equal(calls, 1);
  }
});

async function makeFixture(
  t: TestContext,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): Promise<{ service: ConfiguredImageGenerationService; imageRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SystemSettingsStore(path.join(root, "settings.json"));
  await store.update({
    models: [
      model("primary", "https://primary.example/v1", "image-primary", "primary-key"),
      model("backup", "https://backup.example/v1", "image-backup", "backup-key"),
    ],
    selectedModelIds: { image: "primary" },
  });
  const imageRoot = path.join(root, "images");
  return {
    service: new ConfiguredImageGenerationService(store, imageRoot, undefined, undefined, fetchImpl, now),
    imageRoot,
  };
}

function model(id: string, baseUrl: string, modelName: string, apiKey: string) {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    shortName: id,
    baseUrl,
    model: modelName,
    purpose: "image" as const,
    apiKey,
    hasApiKey: true,
    enabled: true,
    apiProtocol: "openai" as const,
    createdAt: now,
    updatedAt: now,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
