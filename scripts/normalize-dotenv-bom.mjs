#!/usr/bin/env node
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const envPath = path.resolve(requiredValue("--env"));
const backupPath = path.resolve(requiredValue("--backup"));
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

if (envPath === backupPath) {
  throw new Error("The dotenv backup path must differ from the source path.");
}

const metadata = await lstat(envPath);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error(`Dotenv target must be a regular, non-symbolic-link file: ${envPath}`);
}

const original = await readFile(envPath);
if (!original.subarray(0, utf8Bom.length).equals(utf8Bom)) {
  process.stdout.write("Persistent dotenv has no UTF-8 BOM; no rewrite needed.\n");
  process.exit(0);
}

await copyFile(envPath, backupPath, constants.COPYFILE_EXCL);
await preserveOwnershipAndMode(backupPath, metadata);

const temporaryPath = path.join(
  path.dirname(envPath),
  `.${path.basename(envPath)}.ubot-bom-${process.pid}-${Date.now()}.tmp`,
);
let temporaryCreated = false;
try {
  const handle = await open(temporaryPath, "wx", metadata.mode & 0o777);
  temporaryCreated = true;
  try {
    await handle.writeFile(original.subarray(utf8Bom.length));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await preserveOwnershipAndMode(temporaryPath, metadata);

  // Refuse to replace a file that changed after it was backed up. This keeps
  // the normalization atomic even if an operator edits .env concurrently.
  const current = await readFile(envPath);
  if (!current.equals(original)) {
    throw new Error("Dotenv changed while its UTF-8 BOM was being normalized.");
  }

  await rename(temporaryPath, envPath);
  temporaryCreated = false;
} finally {
  if (temporaryCreated) await rm(temporaryPath, { force: true });
}

const normalized = await readFile(envPath);
if (normalized.subarray(0, utf8Bom.length).equals(utf8Bom)) {
  throw new Error("Dotenv UTF-8 BOM normalization did not take effect.");
}
if (!normalized.equals(original.subarray(utf8Bom.length))) {
  throw new Error("Dotenv content changed beyond removal of its leading UTF-8 BOM.");
}

process.stdout.write(`Removed the persistent dotenv UTF-8 BOM; original saved at ${backupPath}.\n`);

function requiredValue(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function preserveOwnershipAndMode(filePath, sourceMetadata) {
  await chmod(filePath, sourceMetadata.mode & 0o777);
  if (process.platform !== "win32") {
    await chown(filePath, sourceMetadata.uid, sourceMetadata.gid);
  }
}
