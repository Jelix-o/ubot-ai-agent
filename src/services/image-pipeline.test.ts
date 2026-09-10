import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ImagePipeline, ImagePipelineError } from "./image-pipeline.js";

async function startImageServer(
  t: { after(callback: () => void): void },
  statusCode = 200,
): Promise<string> {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "image/png");
    response.end(Buffer.from("89504e470d0a1a0a", "hex"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/image.png`;
}

test("stage1 uses the local cache first and falls back to proxy fetch", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localFile = path.join(dir, "a.png");
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  writeFileSync(localFile, png);

  const pipeline = new ImagePipeline({
    localize: async () => localFile,
    ocr: undefined,
    metrics: undefined,
  });

  const [image] = await pipeline.resolveForVision([{ file: localFile }]);
  assert.ok(image?.dataUrl.startsWith("data:image/png;base64,"));
});

test("stage1 returns image_unavailable when the local cache rejects", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pipeline = new ImagePipeline({
    localize: async () => {
      throw new Error("no local cache");
    },
  });

  await assert.rejects(
    () => pipeline.resolveForVision([{ file: "missing-napcat-file" }]),
    (error: unknown) => {
      assert.ok(error instanceof ImagePipelineError);
      assert.equal(error.tier, "image_unavailable");
      return true;
    },
  );
});

test("stage1 throws ImagePipelineError with tier image_unavailable on full failure", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pipeline = new ImagePipeline({
    localize: async () => undefined,
  });

  await assert.rejects(
    () => pipeline.resolveForVision([{ file: "missing-napcat-file" }]),
    (error: unknown) => {
      assert.ok(error instanceof ImagePipelineError);
      assert.equal(error.tier, "image_unavailable");
      return true;
    },
  );
});

test("text path injects OCR caption when configured", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localFile = path.join(dir, "b.png");
  writeFileSync(localFile, Buffer.from("89504e470d0a1a0a", "hex"));

  const pipeline = new ImagePipeline({
    localize: async () => localFile,
    ocr: async () => "[图片内容: 白屏截图，无文字]",
  });

  const [image] = await pipeline.resolveForText([{ file: localFile }]);
  assert.equal(image?.caption, "[图片内容: 白屏截图，无文字]");
});

test("data URLs pass through stage1 without fetching", async () => {
  const pipeline = new ImagePipeline({
    localize: async () => {
      throw new Error("must not be called");
    },
  });
  const [image] = await pipeline.resolveForVision([{ url: "data:image/png;base64,abc" }]);
  assert.equal(image?.dataUrl, "data:image/png;base64,abc");
});

test("localizeDataUrl takes precedence and feeds the vision path", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pipeline = new ImagePipeline({
    localizeDataUrl: async () => "data:image/png;base64,cafebabe",
    localize: async () => {
      throw new Error("localize must not be called when localizeDataUrl exists");
    },
  });
  const [image] = await pipeline.resolveForVision([{ file: "some-napcat-file" }]);
  assert.equal(image?.dataUrl, "data:image/png;base64,cafebabe");
});

test("stage1 prefers a reachable HTTP image URL before the NapCat data-url bridge", async (t) => {
  const imageUrl = await startImageServer(t);
  let bridgeCalls = 0;
  const pipeline = new ImagePipeline({
    localizeDataUrl: async () => {
      bridgeCalls += 1;
      return "data:image/png;base64,cafebabe";
    },
  });

  const [image] = await pipeline.resolveForVision([{ url: imageUrl, file: "napcat-file.image" }]);
  assert.equal(bridgeCalls, 0);
  assert.ok(image?.dataUrl.startsWith("data:image/png;base64,"));
});

test("stage1 falls back to the NapCat data-url bridge when the HTTP image URL fails", async (t) => {
  const imageUrl = await startImageServer(t, 503);
  let bridgeCalls = 0;
  let bridgeInput: { url?: string; file?: string } | undefined;
  const pipeline = new ImagePipeline({
    localizeDataUrl: async (image) => {
      bridgeCalls += 1;
      bridgeInput = image;
      return "data:image/png;base64,cafebabe";
    },
    proxySoftTimeoutMs: 20,
    proxyHardTimeoutMs: 30,
  });

  const [image] = await pipeline.resolveForVision([{ url: imageUrl, file: "napcat-file.image" }]);
  assert.equal(bridgeCalls, 1);
  assert.deepEqual(bridgeInput, { url: undefined, file: "napcat-file.image" });
  assert.equal(image?.dataUrl, "data:image/png;base64,cafebabe");
});

test("cross-process data-url resolution has an independent timeout from local cache reads", async () => {
  const pipeline = new ImagePipeline({
    localizeDataUrl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "data:image/png;base64,cafebabe";
    },
    localSoftTimeoutMs: 1,
  });

  const [image] = await pipeline.resolveForVision([{ file: "pending-napcat-file" }]);
  assert.equal(image?.dataUrl, "data:image/png;base64,cafebabe");
});

test("stage1 preserves materialized images when another attachment cannot be resolved", async () => {
  const pipeline = new ImagePipeline({
    localizeDataUrl: async (image) => image.file === "available.image"
      ? "data:image/png;base64,cafebabe"
      : undefined,
  });

  const images = await pipeline.resolveForVision([
    { file: "available.image" },
    { file: "stale.image" },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.input.file, "available.image");
});

test("stage1 times out a pending cross-process data-url operation", async () => {
  const pipeline = new ImagePipeline({
    localizeDataUrl: async () => new Promise<never>(() => undefined),
    localizeDataUrlTimeoutMs: 20,
  });

  await assert.rejects(
    () => pipeline.resolveForVision([{ file: "pending-napcat-file" }]),
    (error: unknown) => error instanceof ImagePipelineError && error.tier === "image_unavailable",
  );
});
