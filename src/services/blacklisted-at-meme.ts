import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BLACKLISTED_AT_MEME_BYTES = 2 * 1024 * 1024;
const BLACKLISTED_AT_MEME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "blacklisted-at-meme.jpg",
);

let cachedImageFile: Promise<string> | undefined;

/**
 * Returns the bundled blacklist reply image in the OneBot base64 file form.
 * The asset path is anchored to this runtime module, so source and packaged
 * builds both resolve the release-root `assets/` directory.
 */
export function getBlacklistedAtMemeImageFile(): Promise<string> {
  if (!cachedImageFile) {
    cachedImageFile = loadBlacklistedAtMemeImageFile().catch((error: unknown) => {
      cachedImageFile = undefined;
      throw error;
    });
  }
  return cachedImageFile;
}

async function loadBlacklistedAtMemeImageFile(): Promise<string> {
  const metadata = await stat(BLACKLISTED_AT_MEME_PATH);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_BLACKLISTED_AT_MEME_BYTES) {
    throw new Error("blacklisted_at_meme_asset_invalid");
  }

  const image = await readFile(BLACKLISTED_AT_MEME_PATH);
  if (!isSupportedImage(image)) {
    throw new Error("blacklisted_at_meme_asset_not_image");
  }
  return `base64://${image.toString("base64")}`;
}

function isSupportedImage(image: Buffer): boolean {
  const isJpeg = image.length >= 2 && image[0] === 0xff && image[1] === 0xd8;
  const isPng = image.length >= 8 && image.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return isJpeg || isPng;
}
