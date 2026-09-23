#!/usr/bin/env node
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const [rootArg, ...optionArgs] = process.argv.slice(2);
const root = path.resolve(rootArg ?? process.cwd());
const headquartersReviewEnvPath = readOption(optionArgs, "--headquarters-review-env");
if (optionArgs.length !== (headquartersReviewEnvPath ? 2 : 0)) {
  throw new Error("Usage: verify-release-source.mjs [release-root] [--headquarters-review-env /path/to/.env]");
}
const headquartersReviewVerification = headquartersReviewEnvPath
  ? await readHeadquartersReviewVerification(path.resolve(headquartersReviewEnvPath))
  : {
    approvalPublicKey: process.env.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY?.trim() || undefined,
    approvalPublicKeyId: process.env.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID?.trim() || undefined,
  };
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
  "dist/services/private-enterprise-ranking.js",
  "assets/huixian-profile.json",
  "assets/private-enterprises-2026.json",
  "assets/private-enterprises-2026-audit.json",
  "assets/private-enterprises-2026-review.md",
  "assets/private-enterprises-2026-headquarters.json",
  "assets/private-enterprises-2026-headquarters-evidence.json",
  "assets/private-enterprises-2026-headquarters-review.md",
  "assets/blacklisted-at-meme.jpg",
  "scripts/deploy-linux-release.sh",
  "scripts/configure-v3-network.mjs",
  "scripts/configure-image-model.mjs",
  "scripts/normalize-dotenv-bom.mjs",
  "scripts/migrate-v3-state.mjs",
  "scripts/verify-release-source.mjs",
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
  "assets/private-enterprises-2026.json",
  "assets/private-enterprises-2026-audit.json",
  "assets/private-enterprises-2026-review.md",
  "assets/private-enterprises-2026-headquarters.json",
  "assets/private-enterprises-2026-headquarters-evidence.json",
  "assets/private-enterprises-2026-headquarters-review.md",
  "assets/blacklisted-at-meme.jpg",
  "docs/OPERATIONS-v3.md",
  "docs/ADMIN-RECOVERY-v3.md",
  "docs/MIGRATION-v3.md",
  "docs/ROLLBACK-v3.md",
  "scripts/configure-v3-network.mjs",
  "scripts/configure-image-model.mjs",
  "scripts/deploy-linux-release.sh",
  "scripts/normalize-dotenv-bom.mjs",
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

await validatePrivateEnterpriseRankingAssets();

process.stdout.write(`${JSON.stringify({ root, version, requiredPaths }, null, 2)}\n`);

async function validatePrivateEnterpriseRankingAssets() {
  const moduleUrl = pathToFileURL(path.join(root, "dist/services/private-enterprise-ranking.js"));
  const module = await import(moduleUrl.href);
  if (typeof module.loadPrivateEnterpriseRanking !== "function") {
    throw new Error("Release ranking service does not export loadPrivateEnterpriseRanking");
  }
  const ranking = module.loadPrivateEnterpriseRanking(headquartersReviewVerification);
  if (ranking?.data?.edition !== 2026) {
    throw new Error("Release ranking service did not load the 2026 private-enterprise dataset");
  }

  const status = ranking?.headquartersResearchStatus;
  const cityCoverage = ranking?.cityCoverage;
  const cityReady = ranking?.cityReady;
  const evidenceArchiveSha256 = ranking?.headquartersEvidenceArchiveSha256;
  if (status !== "in_progress" && status !== "complete") {
    throw new Error("Release ranking service has an invalid headquarters research status");
  }
  if (!Number.isInteger(cityCoverage) || cityCoverage < 0 || cityCoverage > 500) {
    throw new Error("Release ranking service has an invalid headquarters city coverage");
  }
  if (typeof cityReady !== "boolean") {
    throw new Error("Release ranking service has an invalid headquarters city readiness flag");
  }
  if (typeof evidenceArchiveSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(evidenceArchiveSha256)) {
    throw new Error("Release ranking service has an invalid headquarters evidence archive checksum");
  }
  if (status === "in_progress" && cityReady) {
    throw new Error("In-progress headquarters research must not enable city statistics");
  }
  if (status === "complete" && (!cityReady || cityCoverage !== 500)) {
    throw new Error("Complete headquarters research must enable 500-city coverage");
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || args.indexOf(name, index + 1) >= 0) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function readHeadquartersReviewVerification(envPath) {
  const values = new Map();
  for (const raw of (await BunLikeRead(envPath)).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return {
    approvalPublicKey: values.get("UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY")?.trim() || undefined,
    approvalPublicKeyId: values.get("UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID")?.trim() || undefined,
  };
}

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
