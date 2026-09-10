import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBlacklistedAtMemeImageFile } from "./blacklisted-at-meme.js";

const BLACKLISTED_AT_MEME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "blacklisted-at-meme.jpg",
);
const EXPECTED_SHA256 = "16ce93780758afb70f3532c3a105e1b7b3d653e9008298136e73b244860d8227";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("blacklisted @ meme preserves the bundled bytes in a cached OneBot base64 file", async () => {
  const firstLoad = getBlacklistedAtMemeImageFile();
  const secondLoad = getBlacklistedAtMemeImageFile();

  // A shared promise means repeated messages do not repeatedly read the release asset.
  assert.strictEqual(secondLoad, firstLoad);

  const [imageFile, bundledAsset] = await Promise.all([
    firstLoad,
    readFile(BLACKLISTED_AT_MEME_PATH),
  ]);

  assert.ok(imageFile.startsWith("base64://"));
  const decodedImage = Buffer.from(imageFile.slice("base64://".length), "base64");
  assert.deepEqual(decodedImage, bundledAsset);
  assert.equal(decodedImage.length, 26_442);
  assert.deepEqual(decodedImage.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.equal(createHash("sha256").update(decodedImage).digest("hex"), EXPECTED_SHA256);
});
