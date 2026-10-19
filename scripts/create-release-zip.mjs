#!/usr/bin/env node
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

const MAX_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const [sourceDirectory, archivePath, ...extraArgs] = process.argv.slice(2);

if (!sourceDirectory || !archivePath || extraArgs.length) {
  throw new Error("Usage: create-release-zip.mjs <source-directory> <archive.zip>");
}

const sourceRoot = path.resolve(sourceDirectory);
const destination = path.resolve(archivePath);
const sourceMetadata = await lstat(sourceRoot);
if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
  throw new Error("Release ZIP source must be a real directory.");
}

const files = [];
await collectFiles(sourceRoot, "");
if (files.length === 0) {
  throw new Error("Release ZIP source must not be empty.");
}

let totalUncompressedBytes = 0;
let offset = 0;
const localRecords = [];
const centralRecords = [];
for (const file of files) {
  const content = await readFile(file.absolutePath);
  totalUncompressedBytes += content.length;
  if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("Release ZIP source exceeds the uncompressed size limit.");
  }

  const compressed = deflateRawSync(content, { level: 9 });
  const name = Buffer.from(file.archivePath, "utf8");
  const { dosDate, dosTime } = toDosDateTime(file.modifiedAt);
  const crc = crc32(content);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);
  localRecords.push(localHeader, name, compressed);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);
  centralRecords.push(centralHeader, name);
  offset += localHeader.length + name.length + compressed.length;
  if (offset > MAX_ARCHIVE_BYTES || offset > 0xffffffff) {
    throw new Error("Release ZIP exceeds the compressed size limit.");
  }
}

const centralDirectoryOffset = offset;
const centralDirectory = Buffer.concat(centralRecords);
if (centralDirectory.length > 0xffffffff || centralDirectoryOffset + centralDirectory.length > 0xffffffff) {
  throw new Error("Release ZIP is too large for the supported ZIP format.");
}
const endRecord = Buffer.alloc(22);
endRecord.writeUInt32LE(0x06054b50, 0);
endRecord.writeUInt16LE(0, 4);
endRecord.writeUInt16LE(0, 6);
endRecord.writeUInt16LE(files.length, 8);
endRecord.writeUInt16LE(files.length, 10);
endRecord.writeUInt32LE(centralDirectory.length, 12);
endRecord.writeUInt32LE(centralDirectoryOffset, 16);
endRecord.writeUInt16LE(0, 20);

const archive = Buffer.concat([...localRecords, centralDirectory, endRecord]);
if (archive.length > MAX_ARCHIVE_BYTES) {
  throw new Error("Release ZIP exceeds the compressed size limit.");
}
await mkdir(path.dirname(destination), { recursive: true });
const temporaryPath = `${destination}.${process.pid}.tmp`;
try {
  await writeFile(temporaryPath, archive, { flag: "wx" });
  await rename(temporaryPath, destination);
} finally {
  // A failed atomic rename can leave a partial staging file, never the target.
  try {
    await unlink(temporaryPath);
  } catch {
    // The staging file was either renamed or already absent.
  }
}

process.stdout.write(`${JSON.stringify({ archivePath: destination, entries: files.length, uncompressedBytes: totalUncompressedBytes })}\n`);

async function collectFiles(directory, relativePath) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const archiveEntryPath = normalizeArchivePath(nextRelativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release ZIP source contains a symbolic link: ${archiveEntryPath}.`);
    }
    if (metadata.isDirectory()) {
      await collectFiles(absolutePath, archiveEntryPath);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Release ZIP source contains an unsupported entry: ${archiveEntryPath}.`);
    }
    if (files.length >= MAX_ENTRIES) {
      throw new Error("Release ZIP source exceeds the entry-count limit.");
    }
    files.push({ absolutePath, archivePath: archiveEntryPath, modifiedAt: metadata.mtime });
  }
}

function normalizeArchivePath(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error("Release ZIP source contains an unsafe or non-portable path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Release ZIP source contains an unsafe path.");
  }
  return normalized;
}

function toDosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
