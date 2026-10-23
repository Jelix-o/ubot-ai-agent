import assert from "node:assert/strict";
import test from "node:test";

import {
  QqAvatarReferenceError,
  QqAvatarReferenceService,
  qqAvatarReferenceUrl,
} from "./qq-avatar-reference-service.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");
// The image-generation reference validator identifies JPEG by its required SOI/EOI markers.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const WEBP = Buffer.from("UklGRkQAAABXRUJQVlA4IDgAAAAwAwCdASoRAB0APm0ylkekIyIhKAgAgA2JZQDJAoAAQFBQAP7rB//bZg+g/d/rUyMfVTHJvQAAAA==", "base64");

test("QQ avatar references use one fixed HTTPS endpoint and reject arbitrary IDs before fetch", async () => {
  const url = qqAvatarReferenceUrl("123456");
  assert.equal(url.toString(), "https://q1.qlogo.cn/g?b=qq&nk=123456&s=640");

  let calls = 0;
  const service = new QqAvatarReferenceService({ fetchImpl: async () => { calls += 1; return imageResponse(PNG, "image/png"); } });
  for (const value of ["", " 123456", "123456?next=https://example.test", "https://example.test/avatar.png", "000123", "-123"]) {
    await assert.rejects(service.resolve(value), hasCode("invalid_user_id"));
  }
  assert.equal(calls, 0);
});

test("QQ avatar requests prohibit redirects and retain only valid response bytes", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const service = new QqAvatarReferenceService({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return imageResponse(PNG, "image/png");
    },
  });
  const reference = await service.resolve("123456");
  assert.equal(reference.mimeType, "image/png");
  assert.deepEqual(reference.data, PNG);
  assert.deepEqual(calls.map(item => item.url), ["https://q1.qlogo.cn/g?b=qq&nk=123456&s=640"]);
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.ok(calls[0]!.init?.signal);

  const redirecting = new QqAvatarReferenceService({ fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://example.test/" } }) });
  await assert.rejects(redirecting.resolve("123456"), hasCode("redirect_rejected"));
});

test("QQ avatar references require a supported image content type, bounded body, and valid image bytes", async () => {
  const nonImage = new QqAvatarReferenceService({ fetchImpl: async () => new Response("not an image", { headers: { "Content-Type": "text/html" } }) });
  await assert.rejects(nonImage.resolve("123456"), hasCode("invalid_content_type"));
  const unsupported = new QqAvatarReferenceService({ fetchImpl: async () => new Response("GIF89a", { headers: { "Content-Type": "image/gif" } }) });
  await assert.rejects(unsupported.resolve("123456"), hasCode("invalid_content_type"));

  const oversized = new QqAvatarReferenceService({ maxBytes: 4, fetchImpl: async () => imageResponse(PNG, "image/png") });
  await assert.rejects(oversized.resolve("123456"), hasCode("image_too_large"));

  const invalidBytes = new QqAvatarReferenceService({ fetchImpl: async () => imageResponse(Buffer.from("not an image"), "image/png") });
  await assert.rejects(invalidBytes.resolve("123456"), hasCode("invalid_image"));
});

test("QQ avatar references accept validated PNG, JPEG, and WebP responses", async () => {
  for (const [data, mimeType] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [WEBP, "image/webp"]] as const) {
    const service = new QqAvatarReferenceService({ fetchImpl: async () => imageResponse(data, mimeType) });
    const reference = await service.resolve("123456");
    assert.equal(reference.mimeType, mimeType);
    assert.deepEqual(reference.data, data);
  }
});

test("QQ avatar downloads time out through the controlled request signal", async () => {
  const service = new QqAvatarReferenceService({
    timeoutMs: 1,
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(service.resolve("123456"), hasCode("download_timeout"));
});

function imageResponse(data: Buffer, mimeType: string): Response {
  return new Response(new Uint8Array(data), { headers: { "Content-Type": mimeType, "Content-Length": String(data.length) } });
}

function hasCode(code: QqAvatarReferenceError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof QqAvatarReferenceError && error.code === code;
}
