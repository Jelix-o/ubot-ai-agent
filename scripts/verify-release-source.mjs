#!/usr/bin/env node
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? process.cwd());
const packageJson = JSON.parse(await BunLikeRead(path.join(root, "package.json")));
const version = String(packageJson.version ?? "").trim();
if (!version) {
  throw new Error("Release bundle package.json has no version");
}

const allowedRootNames = new Set([
  ".env.example",
  ".env.server-2022.example",
  ".gitattributes",
  ".github",
  ".gitignore",
  ".npmrc",
  "COMMANDS.md",
  "README.md",
  "RELEASE-v1.0.1.md",
  "RELEASE-v1.0.2.md",
  "RELEASE-v1.1.0.md",
  "RELEASE-v2.0.0.md",
  "RELEASE-v2.0.1.md",
  "RELEASE-v2.0.2.md",
  "RELEASE-v2.0.3.md",
  `RELEASE-v${version}.md`,
  "V1.0.1-LOCAL-AUDIT.md",
  "V1.0.2-LOCAL-AUDIT.md",
  "admin",
  "dist",
  "managed-skills",
  "package-lock.json",
  "package.json",
  "run.cmd",
  "scripts",
  "src",
  "tsconfig.json",
]);
const requiredPaths = [
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMANDS.md",
  `RELEASE-v${version}.md`,
  "dist/index.js",
  "managed-skills/itexpert.json",
  "scripts/start-prod.sh",
  "scripts/deploy-linux-release.sh",
  "scripts/migrate-participation-mode.mjs",
];
const forbiddenRootNames = new Set([
  ".env",
  ".git",
  ".claude",
  ".codex_tmp",
  ".mimocode",
  ".npm-cache",
  "config",
  "data",
  "node_modules",
  "release",
  "skills",
]);
const forbiddenSuffixes = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".db"];

const rootEntries = await readdir(root, { withFileTypes: true });
const unexpected = rootEntries
  .map((entry) => entry.name)
  .filter((name) => !allowedRootNames.has(name))
  .sort();
const forbidden = rootEntries
  .map((entry) => entry.name)
  .filter((name) => forbiddenRootNames.has(name))
  .sort();
const missing = [];
for (const relativePath of requiredPaths) {
  try {
    await lstat(path.join(root, relativePath));
  } catch (error) {
    if (isNotFound(error)) missing.push(relativePath);
    else throw error;
  }
}

const leakedFiles = [];
for (const entry of rootEntries) {
  if (allowedRootNames.has(entry.name)) {
    await scan(path.join(root, entry.name));
  }
}

if (unexpected.length || forbidden.length || missing.length || leakedFiles.length) {
  process.stderr.write(`${JSON.stringify({ root, unexpected, forbidden, missing, leakedFiles }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ root, version, requiredPaths }, null, 2)}\n`);

async function scan(target) {
  const metadata = await lstat(target);
  const rel = path.relative(root, target).split(path.sep).join("/");
  if (metadata.isSymbolicLink()) {
    leakedFiles.push(`${rel} (symbolic links are forbidden in release bundles)`);
    return;
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      await scan(path.join(target, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) return;

  const lower = path.basename(target).toLowerCase();
  if (lower === ".env" || forbiddenSuffixes.some((suffix) => lower.endsWith(suffix))) {
    leakedFiles.push(rel);
    return;
  }
  if (metadata.size > 16 * 1024 * 1024) {
    leakedFiles.push(`${rel} (unexpectedly large ${metadata.size} bytes)`);
  }
}

async function BunLikeRead(filePath) {
  const { readFile } = await import("node:fs/promises");
  return await readFile(filePath, "utf8");
}

function isNotFound(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}
