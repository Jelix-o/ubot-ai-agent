import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ImagePipeline, ImagePipelineError } from "./image-pipeline.js";

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

test("stage1 falls back to proxy when localize rejects", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pipeline = new ImagePipeline({
    localize: async () => {
      throw new Error("no local cache");
    },
  });

  // Localize fails → proxy attempt → proxy also fails → tier image_unavailable.
  await assert.rejects(
    () => pipeline.resolveForVision([{ url: "https://example.invalid/x.png" }]),
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
    () => pipeline.resolveForVision([{ url: "https://example.invalid/x.png" }]),
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

test("stage1 times out a pending local cache operation when it is the only active handle", async () => {
  const pipeline = new ImagePipeline({
    localizeDataUrl: async () => new Promise<never>(() => undefined),
    localSoftTimeoutMs: 20,
  });

  await assert.rejects(
    () => pipeline.resolveForVision([{ file: "pending-napcat-file" }]),
    (error: unknown) => error instanceof ImagePipelineError && error.tier === "image_unavailable",
  );
});
