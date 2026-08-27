#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = path.resolve(option("--directory") ?? "release");
const packagePath = path.resolve(option("--package") ?? "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const version = String(option("--version") ?? packageJson.version ?? "").trim();
if (!version) throw new Error("A release version is required.");

const assetNames = [
  `ubot-${version}-win.zip`,
  `ubot-${version}-linux.tar.gz`,
];
const results = [];
for (const assetName of assetNames) {
  const assetPath = path.join(root, assetName);
  const checksumPath = `${assetPath}.sha256`;
  const asset = await stat(assetPath);
  if (!asset.isFile() || asset.size === 0) {
    throw new Error(`Release asset is empty or not a file: ${assetPath}`);
  }
  const expectedLine = (await readFile(checksumPath, "utf8")).trim();
  const match = expectedLine.match(/^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/);
  if (!match || match[2] !== assetName) {
    throw new Error(`Invalid SHA-256 manifest for ${assetName}: ${checksumPath}`);
  }
  const actualHash = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (actualHash !== match[1].toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${assetName}`);
  }
  results.push({ asset: assetName, bytes: asset.size, sha256: actualHash });
}

process.stdout.write(`${JSON.stringify({ root, version, assets: results }, null, 2)}\n`);
