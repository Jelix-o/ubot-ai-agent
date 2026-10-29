import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { MessageTransport } from "./bot.js";
import { deliverOutboxRow, markOutboxDeliveryFailed, OutboxAcknowledgementError } from "./index-ingress.js";
import { NapCatActionOutcomeUnknownError } from "./napcat-reverse-server.js";
import { ConfiguredImageGenerationService, IMAGE_GENERATION_MAX_BYTES } from "./services/image-generation-service.js";
import { ImagePreviewArchiveService } from "./services/image-preview-archive-service.js";
import { ImageRequestRepository } from "./services/image-request-repository.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import { SharedDb } from "./shared/sqlite.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-release-image-delivery-"));
  const persistent = path.join(root, "persistent");
  const imageRoot = path.join(persistent, "generated-images");
  mkdirSync(imageRoot, { recursive: true });
  const releases = ["old-release", "new-release"].map(version => {
    const release = path.join(root, version);
    mkdirSync(release);
    symlinkSync(persistent, path.join(release, "data"), "junction");
    return path.join(release, "data", "generated-images");
  });
  const workerDb = new SharedDb(path.join(persistent, "shared.db"));
  const ingressDb = new SharedDb(path.join(persistent, "shared.db"));
  t.after(() => { workerDb.close(); ingressDb.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, imageRoot, oldRoot: releases[0]!, newRoot: releases[1]!, workerDb, ingressDb };
}

for (const [modelName, image] of [["grok-imagine-image-2.0", JPEG], ["gpt-image-2", PNG]] as const) {
  test(`${modelName} output queued through an old release is delivered through the new release with a durable receipt`, async t => {
    const f = fixture(t);
    const model = { id: "image", model: modelName, baseUrl: "https://image.example/v1", apiKey: "fixture-key", enabled: true, hasApiKey: true, purpose: "image" };
    const settings = { async getInternal() { return { models: [model], selectedModelIds: { image: model.id } }; } } as unknown as SystemSettingsStore;
    let calls = 0;
    const generator = new ConfiguredImageGenerationService(settings, f.oldRoot, undefined, undefined, async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (modelName.startsWith("grok-")) {
        assert.equal(body.response_format, "b64_json");
        assert.equal(body.aspect_ratio, "1:1");
        assert.equal("quality" in body, false);
      } else {
        assert.equal(body.quality, "auto");
        assert.equal(body.output_format, "png");
      }
      return new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), { status: 200 });
    });
    const ledger = new ImageRequestRepository(f.workerDb);
    const { request } = ledger.claim({ groupId: "group-image", sourceMessageId: "source-image", creatorUserId: "member", requestKind: "generation", triggerSource: "natural" });
    assert.ok(ledger.beginSubmission(request.id));
    const result = await generator.generate({ groupId: request.groupId, userId: request.creatorUserId, prompt: "A blue circle", requestId: request.upstreamRequestKey });
    assert.ok(ledger.recordGenerated({ id: request.id, stagedFilePath: result.filePath, byteSize: result.byteLength, ...result }));
    const archive = new ImagePreviewArchiveService({ sharedDb: f.workerDb, rootDir: path.join(f.root, "archive"), stagedRoot: f.oldRoot });
    const preview = await archive.archive({ groupId: request.groupId, creatorUserId: request.creatorUserId, sourceMessageId: request.sourceMessageId, prompt: "A blue circle", publicationState: "pending", byteSize: result.byteLength, ...result });
    const queued = f.workerDb.enqueueGeneratedImageOutboxForRequest({ requestId: request.id, groupId: request.groupId, imagePath: result.filePath, imagePreviewId: preview.id });
    assert.equal(ledger.get(request.id)?.status, "queued");
    const row = f.ingressDb.claimOutbox(1)[0]!;
    assert.equal(row.id, queued.outboxId);
    const deliveries: string[] = [];
    const transport = { async sendGroupImage(_groupId: string, file: string) {
      deliveries.push(file);
      // Emulate a release alias disappearing after validation. Reading and
      // cleanup must continue to use the resolved persistent path.
      rmSync(path.dirname(f.oldRoot), { recursive: true, force: true });
      return { platformMessageId: "qq-generated-image" };
    } } as unknown as MessageTransport;
    assert.equal(await deliverOutboxRow(f.ingressDb, transport, row, undefined, undefined, f.newRoot), "qq-generated-image");
    assert.deepEqual(deliveries, [`base64://${image.toString("base64")}`]);
    assert.equal(calls, 1);
    assert.equal(ledger.get(request.id)?.status, "delivered");
    const stored = f.workerDb.db.prepare("SELECT status, platform_message_id FROM outbox WHERE id = ?").get(row.id);
    assert.deepEqual({ ...stored }, { status: "sent", platform_message_id: "qq-generated-image" });
    assert.equal(existsSync(path.join(f.imageRoot, path.basename(result.filePath))), false);
    assert.equal(f.ingressDb.claimOutbox(1, Date.now() + 120_000).length, 0);
  });
}

test("real path validation rejects traversal, escaping directory links, file links, and invalid image files", async t => {
  const f = fixture(t);
  const outside = path.join(f.root, "generated-images-other");
  mkdirSync(outside);
  const external = path.join(outside, "external.png");
  writeFileSync(external, PNG);
  const valid = path.join(f.imageRoot, "valid.png");
  writeFileSync(valid, PNG);
  symlinkSync(outside, path.join(f.imageRoot, "escape"), "junction");
  const paths = [external, path.join(f.oldRoot, "..", "..", "..", "generated-images-other", "external.png"), path.join(f.oldRoot, "escape", "external.png")];
  await t.test("leaf symlinks remain forbidden even if their target is inside the managed root", child => {
    try {
      symlinkSync(valid, path.join(f.imageRoot, "linked.png"), "file");
      symlinkSync(external, path.join(f.imageRoot, "linked-outside.png"), "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        child.skip("Windows file symlink privilege unavailable; exercised on Linux");
        return;
      }
      throw error;
    }
    paths.push(path.join(f.oldRoot, "linked.png"), path.join(f.oldRoot, "linked-outside.png"));
  });
  const deliveries: string[] = [];
  const transport = { async sendGroupImage(_groupId: string, file: string) { deliveries.push(file); return { platformMessageId: "qq-never" }; } } as unknown as MessageTransport;
  for (const file of paths) {
    f.workerDb.enqueueOutbox("group-image", null, file, "generated_image");
    const row = f.ingressDb.claimOutbox(1)[0]!;
    await assert.rejects(deliverOutboxRow(f.ingressDb, transport, row, undefined, undefined, f.newRoot), /outside the managed directory/);
    markOutboxDeliveryFailed(f.ingressDb, row, new Error("invalid path"));
  }
  for (const [name, bytes] of [["forged.png", Buffer.from("not an image")], ["empty.png", Buffer.alloc(0)], ["oversized.png", PNG]] as const) {
    const file = path.join(f.imageRoot, name);
    writeFileSync(file, bytes);
    if (name === "oversized.png") truncateSync(file, IMAGE_GENERATION_MAX_BYTES + 1);
    f.workerDb.enqueueOutbox("group-image", null, file, "generated_image");
    const row = f.ingressDb.claimOutbox(1)[0]!;
    await assert.rejects(deliverOutboxRow(f.ingressDb, transport, row, undefined, undefined, f.newRoot), /invalid size or type/);
    markOutboxDeliveryFailed(f.ingressDb, row, new Error("invalid image"));
    assert.equal(existsSync(file), true);
  }
  assert.deepEqual(deliveries, []);
  assert.equal(existsSync(external), true);
  assert.equal(existsSync(valid), true);
});

for (const failure of ["unknown-send", "ack-failed"] as const) {
  test(`cross-release ${failure} cannot repeat the QQ send`, async t => {
    const f = fixture(t);
    const file = path.join(f.oldRoot, "generated.png");
    writeFileSync(file, PNG);
    f.workerDb.enqueueOutbox("group-image", null, file, "generated_image");
    const row = f.ingressDb.claimOutbox(1)[0]!;
    let calls = 0;
    const transport = { async sendGroupImage() {
      calls++;
      if (failure === "unknown-send") throw new NapCatActionOutcomeUnknownError("timed out after dispatch");
      return { platformMessageId: "qq-once" };
    } } as unknown as MessageTransport;
    if (failure === "ack-failed") t.mock.method(f.ingressDb, "ackOutboxDelivery", () => { throw new Error("sqlite busy after QQ receipt"); });
    const error = await deliverOutboxRow(f.ingressDb, transport, row, undefined, undefined, f.newRoot).catch(error => error);
    assert.ok(error instanceof (failure === "unknown-send" ? NapCatActionOutcomeUnknownError : OutboxAcknowledgementError));
    assert.equal(markOutboxDeliveryFailed(f.ingressDb, row, error), "terminal");
    assert.equal(f.ingressDb.claimOutbox(1, Date.now() + 120_000).length, 0);
    assert.equal(calls, 1);
    assert.equal(existsSync(path.join(realpathSync(f.imageRoot), "generated.png")), failure === "unknown-send");
  });
}
