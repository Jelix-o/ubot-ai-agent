import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

export function isImageDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\//i.test(value);
}

export function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export async function readImageFileAsDataUrl(filePath: string): Promise<string> {
  const normalizedPath = filePath.startsWith("file:///")
    ? fileURLToPath(filePath)
    : filePath.replace(/^file:\/\//i, "");
  const metadata = await stat(normalizedPath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) {
    throw new Error("image_file_size_invalid");
  }
  const buffer = await readFile(normalizedPath);
  return `data:${inferImageMimeType(normalizedPath)};base64,${buffer.toString("base64")}`;
}

export async function downloadImageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`image_download_http_${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && (contentLength <= 0 || contentLength > MAX_IMAGE_BYTES)) {
    throw new Error("image_download_size_invalid");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("image/")) {
    throw new Error("image_download_content_type_invalid");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("image_download_size_invalid");
  }
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function inferImageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
