import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfiguredImageGenerationService, imageReferenceFromDataUrl, parseImagePrompt, requestGeneratedImage } from "./image-generation-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";
import { ImagePreviewArchiveService } from "./image-preview-archive-service.js";
import { SharedDb } from "../shared/sqlite.js";
import { WorkerTransport } from "../worker-transport.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");
const reference = imageReferenceFromDataUrl(`data:image/png;base64,${PNG.toString("base64")}`);
const model = { id: "edit", model: "image", baseUrl: "https://image.example/v1", apiKey: "test", enabled: true, hasApiKey: true, purpose: "image", capabilities: { imageEditing: true } };
const response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });

test("Grok image edits use compatible parameters while retaining the uploaded reference", async () => {
  await requestGeneratedImage({ ...model, model: "grok-imagine-image-edit" }, "Make the circle red", {
    referenceImages: [reference],
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://image.example/v1/images/edits");
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      assert.equal(form.get("aspect_ratio"), "auto");
      assert.equal(form.get("response_format"), "b64_json");
      assert.equal(form.get("prompt"), "Make the circle red");
      for (const key of ["quality", "output_format", "size"]) assert.equal(form.has(key), false);
      const file = form.get("image") as File;
      assert.equal(file.name, "image1.png");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
      return response();
    },
  });
});

test("image edit uploads real files in order and preserves explicit aspect ratio", async () => {
  for (const count of [1, 2, 4]) {
    await requestGeneratedImage(model, "combine image1 and image2", {
      requestId: `image-edit-${count}`,
      referenceImages: Array.from({ length: count }, () => reference), size: "864x1536",
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://image.example/v1/images/edits");
        assert.ok(init?.body instanceof FormData);
        assert.equal((init?.headers as Record<string, string>)["Content-Type"], undefined);
        assert.equal((init?.headers as Record<string, string>)["Idempotency-Key"], `image-edit-${count}`);
        const form = init.body;
        assert.equal(form.get("size"), "864x1536");
        assert.match(String(form.get("prompt")), /aspect ratio 9:16/);
        const files = form.getAll(count === 1 ? "image" : "image[]") as File[];
        assert.equal(files.length, count);
        for (let i = 0; i < files.length; i++) {
          assert.equal(files[i]!.name, `image${i + 1}.png`);
          assert.deepEqual(Buffer.from(await files[i]!.arrayBuffer()), PNG);
        }
        return response();
      },
    });
  }
});

test("aspect parameters take precedence over a leading Japanese ratio", () => {
  assert.equal(parseImagePrompt("9:16の縦長。 landscape").size, "864x1536");
  assert.equal(parseImagePrompt("9:16の縦長。 --比例 16:9 landscape").size, "1536x864");
  assert.equal(parseImagePrompt("--比例 2:3 landscape").prompt, "landscape");
  assert.deepEqual(parseImagePrompt("landscape"), { prompt: "landscape" });
  for (const prompt of ["--比例", "--比例 5:9", "4:5 landscape"]) assert.throws(() => parseImagePrompt(prompt));
  assert.throws(() => imageReferenceFromDataUrl("data:image/png;base64,YmFk"));
  assert.throws(() => imageReferenceFromDataUrl("data:image/gif;base64,YmFk"));
});

test("editing is explicit, never falls back to generation, and cooldown depends on requested operation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-edit-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100_000, calls = 0;
  let models = [ { ...model, capabilities: {} } ];
  const settings = { async getInternal() { return { models, selectedModelIds: { image: "edit" } }; } } as unknown as SystemSettingsStore;
  const service = new ConfiguredImageGenerationService(settings, root, undefined, undefined, async (url) => { calls++; assert.match(String(url), /images\/(?:edits|generations)$/); return response(); }, () => now);
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "edit", referenceImages: [reference] }), { code: "editing_not_configured" });
  assert.equal(calls, 0);
  models = [{ ...model }];
  await service.generate({ groupId: "g", userId: "u", prompt: "first" });
  now += 14_000;
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "edit", referenceImages: [reference] }), { code: "cooldown", retryAfterSeconds: 1 });
  now += 1_000;
  await service.generate({ groupId: "g", userId: "u", prompt: "edit", referenceImages: [reference] });
  now += 15_000;
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "new" }), { code: "cooldown", retryAfterSeconds: 45 });
  await service.generate({ groupId: "g", userId: "another", prompt: "new" });
  assert.equal(calls, 3);
});

test("same member single concurrency; moderation is terminal and does not start cooldown", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-edit-concurrency-")); t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const settings = { async getInternal() { return { models: [model, { ...model, id: "backup" }], selectedModelIds: { image: "edit" } }; } } as unknown as SystemSettingsStore;
  const service = new ConfiguredImageGenerationService(settings, root, undefined, undefined, async () => {
    calls++; entered(); await gate;
    return new Response(JSON.stringify({ error: { code: "moderation_blocked", type: "image_generation_user_error" } }), { status: 400 });
  });
  const pending = service.generate({ groupId: "g", userId: "u", prompt: "edit", referenceImages: [reference] });
  await ready;
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "other" }), { code: "busy" });
  release();
  await assert.rejects(pending, { code: "content_blocked" });
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "try again", referenceImages: [reference] }), { code: "content_blocked" });
  assert.equal(calls, 2);
  await assert.rejects(service.generate({ groupId: "g", userId: "u", prompt: "too many", referenceImages: Array(5).fill(reference) }), { code: "invalid_reference" });
});

test("receipt binds retained output atomically, survives restart, and blocks deleted, expired and recalled parents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-edit-receipt-")); t.after(() => rm(root, { recursive: true, force: true }));
  const stagedRoot = path.join(root, "staged"); await mkdir(stagedRoot);
  const filePath = path.join(stagedRoot, "test.png"); await writeFile(filePath, PNG);
  const dbPath = path.join(root, "test.db");
  let db = new SharedDb(dbPath);
  let service = new ImagePreviewArchiveService({ sharedDb: db, rootDir: path.join(root, "archive"), stagedRoot });
  const archive = async (id: string, parentIds: string[] = []) => service.archive({ groupId: "g", creatorUserId: "u", sourceMessageId: id, prompt: "landscape", filePath, modelId: "edit", model: "image", fallbackUsed: false, mimeType: "image/png", byteSize: PNG.length, ...(parentIds.length ? { operation: "edit", referenceCount: 1, parentIds, outputSize: "864x1536" } as const : {}) });
  const parent = await archive("first");
  const receipt = await new WorkerTransport(db).sendGeneratedGroupImage("g", filePath, { imagePreviewId: parent.id });
  assert.equal(
    await service.resolveReference("g", "ordinary-unarchived-image"),
    undefined,
    "only a message with no generated-image archive record may use the QQ image fallback",
  );
  assert.equal(await service.resolveReference("g", "qq-1"), undefined);
  db.ackOutboxDelivery(Number(receipt?.deliveryId?.split(":")[1]), "qq-1");
  db.ackOutboxDelivery(Number(receipt?.deliveryId?.split(":")[1]), "qq-1");
  db.close(); db = new SharedDb(dbPath);
  service = new ImagePreviewArchiveService({ sharedDb: db, rootDir: path.join(root, "archive"), stagedRoot });
  assert.deepEqual((await service.resolveReference("g", "qq-1"))?.data, PNG);
  assert.equal(await service.resolveReference("other-group", "qq-1"), undefined);
  const pending = await service.archive({
    groupId: "g",
    creatorUserId: "u",
    sourceMessageId: "pending-known-output",
    prompt: "landscape",
    filePath,
    modelId: "edit",
    model: "image",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.length,
    publicationState: "pending",
  });
  // An output id can exist after an interrupted/legacy delivery path. It is
  // still a known generated preview, so it must never become QQ-downloadable.
  db.db.prepare("UPDATE image_previews SET output_message_id = ? WHERE id = ?")
    .run("qq-pending", pending.id);
  await assert.rejects(service.resolveReference("g", "qq-pending"));
  const child = await archive("second", [parent.id]);
  assert.deepEqual((await service.getDetail(child.id))?.parentIds, [parent.id]);
  assert.equal((await service.getDetail(child.id))?.operation, "edit");
  await archive("branch", [parent.id]);
  await service.remove(parent.id);
  await assert.rejects(service.resolveReference("g", "qq-1"));
  const recalled = await archive("recalled");
  const row = db.enqueueOutbox("g", null, filePath, "generated_image", undefined, undefined, undefined, recalled.id);
  db.ackOutboxDelivery(row, "qq-2"); db.markRetracted("g", "qq-2", Date.now());
  await assert.rejects(service.resolveReference("g", "qq-2"));
  const expired = await archive("expired");
  const expRow = db.enqueueOutbox("g", null, filePath, "generated_image", undefined, undefined, undefined, expired.id);
  db.ackOutboxDelivery(expRow, "qq-3"); db.db.prepare("UPDATE image_previews SET expires_at = 1 WHERE id = ?").run(expired.id);
  await assert.rejects(service.resolveReference("g", "qq-3"));
  const recalledBeforeAck = await archive("recall-before-ack");
  const earlyRecallRow = db.enqueueOutbox("g", null, filePath, "generated_image", undefined, undefined, undefined, recalledBeforeAck.id);
  db.markRetracted("g", "qq-early-recall", Date.now());
  db.ackOutboxDelivery(earlyRecallRow, "qq-early-recall");
  await assert.rejects(service.resolveReference("g", "qq-early-recall"));
  db.close();
});
