#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const [archivePath, ...extraArgs] = process.argv.slice(2);

if (!archivePath || extraArgs.length) {
  throw new Error("Usage: validate-release-archive.mjs <release.tar.gz>");
}

const compressed = await readFile(archivePath);
if (compressed.length > MAX_COMPRESSED_BYTES) {
  throw new Error("Release archive exceeds the compressed size limit.");
}

const archive = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
if (archive.length < BLOCK_SIZE * 2 || archive.length % BLOCK_SIZE !== 0) {
  throw new Error("Release archive is not a complete tar stream.");
}

let offset = 0;
let sawEndOfArchive = false;
const seenPaths = new Set();

while (offset < archive.length) {
  const header = archive.subarray(offset, offset + BLOCK_SIZE);
  if (isZeroBlock(header)) {
    const nextBlock = archive.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE * 2);
    if (!isZeroBlock(nextBlock) || !isZeroBlock(archive.subarray(offset))) {
      throw new Error("Release archive has data after its tar end marker.");
    }
    sawEndOfArchive = true;
    break;
  }

  const expectedChecksum = readOctal(header.subarray(148, 156), "header checksum");
  let actualChecksum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actualChecksum !== expectedChecksum) {
    throw new Error("Release archive has an invalid tar header checksum.");
  }

  const name = readText(header.subarray(0, 100));
  const prefix = readText(header.subarray(345, 500));
  const rawPath = prefix ? `${prefix}/${name}` : name;
  const normalizedPath = validateEntryPath(rawPath);
  const mode = readOctal(header.subarray(100, 108), `mode for ${rawPath || "."}`);
  if (mode > 0o777 || (mode & 0o6000) !== 0) {
    throw new Error(`Release archive entry has unsafe file permissions: ${rawPath || "."}.`);
  }
  const type = String.fromCharCode(header[156] || 0);
  if (type !== "\0" && type !== "0" && type !== "5") {
    throw new Error(`Release archive contains an unsupported tar entry type for ${rawPath || "."}.`);
  }
  if (seenPaths.has(normalizedPath)) {
    throw new Error(`Release archive contains a duplicate path: ${rawPath || "."}.`);
  }
  seenPaths.add(normalizedPath);

  const size = readOctal(header.subarray(124, 136), `size for ${rawPath || "."}`);
  if (type === "5" && size !== 0) {
    throw new Error(`Release archive directory has non-zero content: ${rawPath || "."}.`);
  }
  const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  const nextOffset = offset + BLOCK_SIZE + paddedSize;
  if (!Number.isSafeInteger(nextOffset) || nextOffset > archive.length) {
    throw new Error(`Release archive entry is truncated: ${rawPath || "."}.`);
  }
  offset = nextOffset;
}

if (!sawEndOfArchive) {
  throw new Error("Release archive is missing its tar end marker.");
}

function isZeroBlock(block) {
  return block.length > 0 && block.every((value) => value === 0);
}

function readText(field) {
  const nullIndex = field.indexOf(0);
  const text = field.subarray(0, nullIndex === -1 ? field.length : nullIndex).toString("utf8");
  if (text.includes("\0")) {
    throw new Error("Release archive contains an invalid NUL path.");
  }
  return text;
}

function readOctal(field, label) {
  const value = field.toString("ascii").replace(/\0/g, " ").trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`Release archive has an invalid tar ${label}.`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Release archive tar ${label} is out of range.`);
  }
  return parsed;
}

function validateEntryPath(rawPath) {
  if (!rawPath || rawPath.includes("\0") || rawPath.startsWith("/")) {
    throw new Error("Release archive contains an unsafe path.");
  }

  let normalized = rawPath;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized) return ".";

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Release archive contains an unsafe path.");
  }
  return normalized;
}
