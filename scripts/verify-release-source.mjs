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
  "COMMANDS.md",
  "README.md",
  `RELEASE-v${version}.md`,
  "assets",
  "deploy",
  "dist",
  "docs",
  "package-lock.json",
  "package.json",
  "scripts",
  "run.cmd",
  "install-deps.cmd",
]);
const requiredPaths = [
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMANDS.md",
  `RELEASE-v${version}.md`,
  "dist/index.js",
  "assets/huixian-profile.json",
  "scripts/deploy-linux-release.sh",
  "scripts/configure-v3-network.mjs",
  "scripts/migrate-v3-state.mjs",
  "deploy/systemd/ubot-ingress.service.template",
  "deploy/systemd/ubot-worker.service.template",
  "deploy/systemd/ubot-admin.service.template",
  "deploy/systemd/ubot.target.template",
  "deploy/systemd/ubot-maintenance.service.template",
  "deploy/systemd/ubot-maintenance.timer.template",
  "deploy/nginx/bot.9958.uk.conf",
  "deploy/nginx/preview.9958.uk.conf",
  "deploy/nginx/ubot-preview-static.conf",
  "docs/OPERATIONS-v3.md",
  "docs/ADMIN-RECOVERY-v3.md",
  "docs/MIGRATION-v3.md",
  "docs/ROLLBACK-v3.md",
];
// Every non-dist file is enumerated deliberately.  A release is a portable
// binary artifact, not a source checkout: accepting a broad `scripts/`,
// `assets/`, or `docs/` directory would make it too easy to ship local state
// or an operator-only helper by accident.
const approvedStaticFiles = new Set([
  ".env.example",
  ".env.server-2022.example",
  "COMMANDS.md",
  "README.md",
  `RELEASE-v${version}.md`,
  "package-lock.json",
  "package.json",
  "run.cmd",
  "install-deps.cmd",
  "assets/huixian-profile.json",
  "docs/OPERATIONS-v3.md",
  "docs/ADMIN-RECOVERY-v3.md",
  "docs/MIGRATION-v3.md",
  "docs/ROLLBACK-v3.md",
  "scripts/configure-v3-network.mjs",
  "scripts/deploy-linux-release.sh",
  "scripts/migrate-v3-state.mjs",
  "scripts/verify-release-source.mjs",
  "deploy/nginx/bot.9958.uk.conf",
  "deploy/nginx/preview.9958.uk.conf",
  "deploy/nginx/ubot-preview-static.conf",
  "deploy/systemd/ubot-ingress.service.template",
  "deploy/systemd/ubot-worker.service.template",
  "deploy/systemd/ubot-admin.service.template",
  "deploy/systemd/ubot.target.template",
  "deploy/systemd/ubot-maintenance.service.template",
  "deploy/systemd/ubot-maintenance.timer.template",
]);
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
const forbiddenSuffixes = [
  ".pem", ".key", ".p12", ".pfx", ".sqlite", ".db", ".sqlite3",
  ".sqlite-wal", ".sqlite-shm", ".log", ".jsonl", ".enc", ".bak",
];
const forbiddenFileNames = new Set([
  "id_rsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json",
]);

const rootEntries = await readdir(root, { withFileTypes: true });
const unexpected = rootEntries
  .map((entry) => entry.name)
  .filter((name) => !allowedRootNames.has(name) && !/^RELEASE-v[0-9A-Za-z._-]+\.md$/.test(name))
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
  if (rel && !isApprovedReleasePath(rel, metadata.isDirectory())) {
    leakedFiles.push(`${rel} (not an approved release path)`);
    return;
  }
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
  if (
    lower === ".env" ||
    (lower.startsWith(".env.") && lower !== ".env.example" && lower !== ".env.server-2022.example") ||
    forbiddenFileNames.has(lower) ||
    forbiddenSuffixes.some((suffix) => lower.endsWith(suffix))
  ) {
    leakedFiles.push(rel);
    return;
  }
  if (metadata.size > 16 * 1024 * 1024) {
    leakedFiles.push(`${rel} (unexpectedly large ${metadata.size} bytes)`);
  }
}

function isApprovedReleasePath(relativePath, isDirectory) {
  if (relativePath === "dist" || relativePath.startsWith("dist/")) return true;
  if (!isDirectory) return approvedStaticFiles.has(relativePath);
  return [...approvedStaticFiles].some((candidate) => candidate.startsWith(`${relativePath}/`));
}

async function BunLikeRead(filePath) {
  const { readFile } = await import("node:fs/promises");
  return await readFile(filePath, "utf8");
}

function isNotFound(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}
