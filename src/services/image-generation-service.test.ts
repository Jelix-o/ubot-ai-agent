import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { SystemSettingsStore } from "./system-settings-store.js";
import {
  countImagePromptCharacters,
  ConfiguredImageGenerationService,
  IMAGE_GENERATION_MAX_PROMPT_CHARS,
  ImageGenerationError,
  isGeneratedImagePath,
} from "./image-generation-service.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");

test("configured image generation calls the selected model and stages a validated image", async (t) => {
  let started = 0;
  const fixture = await makeFixture(t, async (url, init) => {
    assert.equal(started, 1);
    assert.equal(url, "https://primary.example/v1/images/generations");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer primary-key");
    assert.equal((init?.headers as Record<string, string>)["Idempotency-Key"], "image-request-1");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      model: "image-primary",
      prompt: "draw a lighthouse\n\nOutput canvas: aspect ratio 1:1 (1024x1024 pixels). Adjust the framing to fill this canvas. This output format takes precedence over other aspect ratios in the description.",
      n: 1,
      size: "1024x1024",
      quality: "auto",
      output_format: "png",
    });
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  });

  const result = await fixture.service.generate({
    groupId: "100",
    userId: "200",
    prompt: " draw a lighthouse ",
    requestId: "image-request-1",
    onStarted: () => { started += 1; },
  });
  assert.equal(result.modelId, "primary");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(await readFile(result.filePath), PNG);
  assert.equal(isGeneratedImagePath(fixture.imageRoot, result.filePath), true);
});

test("prompt limits count Unicode code points and do not announce rejected work", async (t) => {
  let calls = 0;
  let started = 0;
  const fixture = await makeFixture(t, async () => {
    calls += 1;
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  });
  const accepted = "😀".repeat(IMAGE_GENERATION_MAX_PROMPT_CHARS);
  assert.equal(countImagePromptCharacters(accepted), IMAGE_GENERATION_MAX_PROMPT_CHARS);
  await fixture.service.generate({
    groupId: "unicode-ok",
    userId: "200",
    prompt: accepted,
    onStarted: () => { started += 1; },
  });
  await assert.rejects(
    fixture.service.generate({
      groupId: "unicode-long",
      userId: "200",
      prompt: `${accepted}😀`,
      onStarted: () => { started += 1; },
    }),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "prompt_too_long",
  );
  assert.equal(calls, 1);
  assert.equal(started, 1);
});

test("configured image generation falls back only after an explicit rate-limit rejection", async (t) => {
  const urls: string[] = [];
  const idempotencyKeys: Array<string | undefined> = [];
  const fixture = await makeFixture(t, async (url, init) => {
    urls.push(String(url));
    idempotencyKeys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
    return urls.length === 1
      ? jsonResponse(429, { error: { code: "rate_limit_exceeded", type: "rate_limit_error" } })
      : jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  });
  const result = await fixture.service.generate({ groupId: "100", userId: "200", prompt: "fallback", requestId: "image-request-fallback" });
  assert.equal(result.modelId, "backup");
  assert.equal(result.fallbackUsed, true);
  assert.equal(urls.length, 2);
  assert.deepEqual(idempotencyKeys, ["image-request-fallback", "image-request-fallback"]);
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

test("an upstream timeout does not submit the same image request to another model", async (t) => {
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
  } as unknown as SystemSettingsStore;
  const service = new ConfiguredImageGenerationService(settings, path.join(root, "images"), undefined, undefined, async (_url, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  await assert.rejects(
    service.generate({ groupId: "timeout", userId: "200", prompt: "timeout" }),
    (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.code, "upstream_unavailable");
      assert.equal(error.diagnostics?.modelId, "primary");
      assert.equal(error.diagnostics?.failureKind, "timeout");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("an unclassified transport failure does not submit the same image request to another model", async (t) => {
  let calls = 0;
  const fixture = await makeFixture(t, async () => {
    calls += 1;
    throw new Error("opaque_transport_failure");
  });
  await assert.rejects(
    fixture.service.generate({ groupId: "transport", userId: "200", prompt: "draw" }),
    (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.code, "upstream_unavailable");
      assert.equal(error.diagnostics?.modelId, "primary");
      assert.equal(error.diagnostics?.failureKind, "unknown");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("structured moderation errors take priority over transient wording and retain safe diagnostics", async (t) => {
  for (const statusCode of [400, 502]) {
    let calls = 0;
    const fixture = await makeFixture(t, async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: {
        code: "moderation_blocked",
        type: "image_generation_user_error",
        message: "Upstream unavailable: request ID 87920751-7b8b-4501-80c6-b6b5255c1a51. echoed primary-key and private prompt",
        moderation_details: { moderation_stage: "output", categories: ["sexual"] },
      } }), { status: statusCode, headers: { "x-request-id": "gateway-request-id" } });
    });
    await assert.rejects(
      fixture.service.generate({ groupId: "100", userId: "200", prompt: "private prompt" }),
      (error: unknown) => {
        assert.ok(error instanceof ImageGenerationError);
        assert.equal(error.code, "content_blocked");
        assert.deepEqual(error.diagnostics, {
          modelId: "primary", model: "image-primary", statusCode,
          upstreamCode: "moderation_blocked", upstreamType: "image_generation_user_error",
          moderationStage: "output", moderationCategories: ["sexual"],
          requestId: "gateway-request-id", upstreamRequestId: "87920751-7b8b-4501-80c6-b6b5255c1a51",
          failureKind: "content_blocked",
        });
        assert.doesNotMatch(JSON.stringify(error), /primary-key|private prompt|echoed/);
        return true;
      },
    );
    assert.equal(calls, 1, "a moderation rejection must not retry or switch models");
  }
});

test("gateway moderation errors without details retain their request id and mark the stage unknown", async t => {
  let calls = 0;
  const fixture = await makeFixture(t, async () => {
    calls += 1;
    return jsonResponse(400, { error: {
      type: "image_generation_user_error", code: "moderation_blocked",
      message: "Request was rejected. Include the request ID 87920751-7b8b-4501-80c6-b6b5255c1a51. safety_violations=[sexual].",
    } });
  });
  await assert.rejects(fixture.service.generate({ groupId: "100", userId: "200", prompt: "draw" }), (error: unknown) => {
    assert.ok(error instanceof ImageGenerationError);
    assert.equal(error.code, "content_blocked");
    assert.equal(error.diagnostics?.moderationStage, "unknown");
    assert.equal(error.diagnostics?.upstreamRequestId, "87920751-7b8b-4501-80c6-b6b5255c1a51");
    return true;
  });
  assert.equal(calls, 1);
});

test("user-correctable image errors do not fall back and proxy errors retain HTTP diagnostics", async (t) => {
  for (const body of [
    JSON.stringify({ error: { type: "image_generation_user_error", code: "invalid_prompt", message: "Upstream temporarily unavailable" } }),
    "<html>Invalid request</html>",
    "null",
  ]) {
    let calls = 0;
    const fixture = await makeFixture(t, async () => {
      calls += 1;
      return new Response(body, { status: 400, headers: { "x-request-id": "request-400" } });
    });
    await assert.rejects(fixture.service.generate({ groupId: "100", userId: "200", prompt: "draw" }), (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.code, "upstream_rejected");
      assert.equal(error.diagnostics?.statusCode, 400);
      assert.equal(error.diagnostics?.requestId, "request-400");
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("rate limits fall back while exhausted transient failures preserve the last upstream diagnostics", async (t) => {
  const urls: string[] = [];
  const fixture = await makeFixture(t, async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", type: "rate_limit_error" } }), {
      status: 429, headers: { "x-request-id": `request-${urls.length}` },
    });
  });
  await assert.rejects(fixture.service.generate({ groupId: "100", userId: "200", prompt: "draw" }), (error: unknown) => {
    assert.ok(error instanceof ImageGenerationError);
    assert.equal(error.code, "upstream_unavailable");
    assert.equal(error.diagnostics?.modelId, "backup");
    assert.equal(error.diagnostics?.statusCode, 429);
    assert.equal(error.diagnostics?.upstreamCode, "rate_limit_exceeded");
    assert.equal(error.diagnostics?.requestId, "request-2");
    assert.equal(error.diagnostics?.failureKind, "rate_limit");
    return true;
  });
  assert.equal(urls.length, 2);
});

test("successful image generation applies a per-group per-user cooldown", async (t) => {
  let now = 10_000;
  let calls = 0;
  let started = 0;
  const fixture = await makeFixture(t, async () => {
    calls += 1;
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64") }] });
  }, () => now);
  await fixture.service.generate({
    groupId: "100",
    userId: "200",
    prompt: "first",
    onStarted: () => { started += 1; },
  });
  await assert.rejects(
    fixture.service.generate({
      groupId: "100",
      userId: "200",
      prompt: "second",
      onStarted: () => { started += 1; },
    }),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "cooldown" && error.retryAfterSeconds === 60,
  );
  now += 60_000;
  await fixture.service.generate({
    groupId: "100",
    userId: "200",
    prompt: "third",
    onStarted: () => { started += 1; },
  });
  assert.equal(calls, 2);
  assert.equal(started, 2);
});

test("missing image configuration fails before the generation announcement", async (t) => {
  let started = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-not-configured-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = {
    async getInternal() {
      return { models: [], selectedModelIds: {} };
    },
  } as unknown as SystemSettingsStore;
  const service = new ConfiguredImageGenerationService(settings, path.join(root, "images"));
  await assert.rejects(
    service.generate({
      groupId: "100",
      userId: "200",
      prompt: "draw",
      onStarted: () => { started += 1; },
    }),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "not_configured",
  );
  assert.equal(started, 0);
});

test("generated image path validation rejects the root itself and sibling paths", () => {
  const root = path.resolve("managed-images");
  assert.equal(isGeneratedImagePath(root, root), false);
  assert.equal(isGeneratedImagePath(root, path.join(root, "ok.png")), true);
  assert.equal(isGeneratedImagePath(root, path.join(root, "..", "escape.png")), false);
  assert.equal(isGeneratedImagePath(root, path.join(root, "not-image.txt")), false);
});

test("request cancellation before dispatch does not call or fall back to an upstream", async (t) => {
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
  assert.equal(calls, 0);
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
