#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const [archivePath, ...extraArgs] = process.argv.slice(2);

if (!archivePath || extraArgs.length) {
  throw new Error("Usage: validate-release-zip.mjs <release.zip>");
}

const archive = await readFile(archivePath);
if (archive.length > MAX_ARCHIVE_BYTES) {
  throw new Error("Release ZIP exceeds the compressed size limit.");
}

const endOffset = findEndOfCentralDirectory(archive);
const diskNumber = archive.readUInt16LE(endOffset + 4);
const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
const entryCount = archive.readUInt16LE(endOffset + 10);
const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);

if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
  throw new Error("Release ZIP must be a single-disk archive.");
}
if (entryCount === 0 || entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
  throw new Error("Release ZIP must not use ZIP64 or an empty central directory.");
}
if (entryCount > MAX_ENTRIES) {
  throw new Error("Release ZIP exceeds the entry-count limit.");
}
if (!Number.isSafeInteger(centralDirectoryOffset + centralDirectorySize) ||
    centralDirectoryOffset + centralDirectorySize !== endOffset) {
  throw new Error("Release ZIP central directory is malformed.");
}

let offset = centralDirectoryOffset;
let totalUncompressedBytes = 0;
const entries = new Map();
const parentPaths = new Set();

for (let index = 0; index < entryCount; index += 1) {
  if (offset + 46 > endOffset || archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
    throw new Error("Release ZIP has an invalid central-directory entry.");
  }

  const versionMadeBy = archive.readUInt16LE(offset + 4);
  const flags = archive.readUInt16LE(offset + 8);
  const compressionMethod = archive.readUInt16LE(offset + 10);
  const compressedSize = archive.readUInt32LE(offset + 20);
  const uncompressedSize = archive.readUInt32LE(offset + 24);
  const fileNameLength = archive.readUInt16LE(offset + 28);
  const extraLength = archive.readUInt16LE(offset + 30);
  const commentLength = archive.readUInt16LE(offset + 32);
  const diskStart = archive.readUInt16LE(offset + 34);
  const externalAttributes = archive.readUInt32LE(offset + 38);
  const localHeaderOffset = archive.readUInt32LE(offset + 42);
  const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;
  if (!Number.isSafeInteger(nextOffset) || nextOffset > endOffset) {
    throw new Error("Release ZIP central-directory entry is truncated.");
  }
  if (diskStart !== 0 || localHeaderOffset === 0xffffffff) {
    throw new Error("Release ZIP must not use multi-disk or ZIP64 entries.");
  }
  if ((flags & ~0x0800) !== 0) {
    throw new Error("Release ZIP contains encrypted or unsupported entries.");
  }
  if (compressionMethod !== 0 && compressionMethod !== 8) {
    throw new Error("Release ZIP contains an unsupported compression method.");
  }

  const rawName = readSafeName(archive.subarray(offset + 46, offset + 46 + fileNameLength));
  const normalizedName = normalizeEntryPath(rawName);
  const entryKind = classifyEntry(versionMadeBy, externalAttributes, rawName, compressedSize, uncompressedSize);
  const canonicalName = normalizedName.toLowerCase();
  if (entries.has(canonicalName)) {
    throw new Error(`Release ZIP contains a duplicate path: ${rawName}.`);
  }
  entries.set(canonicalName, entryKind);
  const segments = normalizedName.split("/");
  for (let parentIndex = 1; parentIndex < segments.length; parentIndex += 1) {
    parentPaths.add(segments.slice(0, parentIndex).join("/").toLowerCase());
  }

  const remainingOutput = MAX_UNCOMPRESSED_BYTES - totalUncompressedBytes;
  if (remainingOutput < uncompressedSize) {
    throw new Error("Release ZIP exceeds the uncompressed size limit.");
  }
  const data = validateLocalHeader(archive, localHeaderOffset, endOffset, flags, compressionMethod, rawName, compressedSize);
  const content = compressionMethod === 0
    ? data
    : inflateRawSync(data, { maxOutputLength: remainingOutput });
  if (content.length !== uncompressedSize || crc32(content) !== archive.readUInt32LE(offset + 16)) {
    throw new Error(`Release ZIP entry data does not match its metadata: ${rawName}.`);
  }
  totalUncompressedBytes += content.length;
  offset = nextOffset;
}

if (offset !== endOffset) {
  throw new Error("Release ZIP central directory has trailing data.");
}
for (const [entry, kind] of entries) {
  if (kind === "file" && parentPaths.has(entry)) {
    throw new Error(`Release ZIP has a file-directory path collision: ${entry}.`);
  }
}

process.stdout.write(`${JSON.stringify({ archivePath, entries: entryCount, uncompressedBytes: totalUncompressedBytes })}\n`);

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("Release ZIP is missing a valid end-of-central-directory record.");
}

function readSafeName(buffer) {
  const name = buffer.toString("utf8");
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error("Release ZIP contains an unsafe or non-portable path.");
  }
  return name;
}

function normalizeEntryPath(rawName) {
  if (rawName.startsWith("/")) {
    throw new Error("Release ZIP contains an unsafe path.");
  }
  let normalized = rawName;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized) throw new Error("Release ZIP contains an unsafe path.");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Release ZIP contains an unsafe path.");
  }
  return normalized;
}

function classifyEntry(versionMadeBy, externalAttributes, rawName, compressedSize, uncompressedSize) {
  const creator = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  let kind = rawName.endsWith("/") || dosDirectory ? "directory" : "file";
  if (creator === 3 && unixMode !== 0) {
    const type = unixMode & 0o170000;
    if ((unixMode & 0o6000) !== 0 || (type !== 0 && type !== 0o100000 && type !== 0o040000)) {
      throw new Error(`Release ZIP contains a symbolic link or unsupported file type: ${rawName}.`);
    }
    if (type === 0o040000) kind = "directory";
    if (type === 0o100000) kind = "file";
  }
  if (kind === "directory" && (!rawName.endsWith("/") || compressedSize !== 0 || uncompressedSize !== 0)) {
    throw new Error(`Release ZIP contains an invalid directory entry: ${rawName}.`);
  }
  return kind;
}

function validateLocalHeader(buffer, offset, centralDirectoryOffset, expectedFlags, expectedMethod, rawName, compressedSize) {
  if (offset + 30 > centralDirectoryOffset || buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Release ZIP local header is invalid for ${rawName}.`);
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  if (flags !== expectedFlags || method !== expectedMethod || !Number.isSafeInteger(dataOffset + compressedSize) ||
      dataOffset + compressedSize > centralDirectoryOffset) {
    throw new Error(`Release ZIP local header does not match its central-directory entry: ${rawName}.`);
  }
  const localName = readSafeName(buffer.subarray(offset + 30, offset + 30 + fileNameLength));
  if (localName !== rawName) {
    throw new Error(`Release ZIP local header path does not match its central-directory entry: ${rawName}.`);
  }
  return buffer.subarray(dataOffset, dataOffset + compressedSize);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
