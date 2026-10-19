#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findPrivacyIssues } from "./public-docs.mjs";

export const HISTORICAL_RELEASE_VERSIONS = Array.from({ length: 27 }, (_, index) => `3.0.${index + 18}`);
export const RETIRED_CREDENTIAL_HELPER_PATH = "scripts/set-gemini-key-and-model.mjs";

export async function createHistoricalReleaseInventory({ root, output, historyPath = RETIRED_CREDENTIAL_HELPER_PATH }) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = assertInventoryOutputPath(resolvedRoot, output);
  const releases = HISTORICAL_RELEASE_VERSIONS.map((version) => inspectHistoricalRelease(resolvedRoot, version));
  const referenceAudit = inspectLocalReferenceAudit(resolvedRoot, historyPath);

  const inventory = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    historicalReleaseRange: {
      first: HISTORICAL_RELEASE_VERSIONS[0],
      last: HISTORICAL_RELEASE_VERSIONS.at(-1),
    },
    releases,
    credentialHistory: {
      helperPath: historyPath,
      localReferenceAudit: referenceAudit,
      localReferenceAuditLimit: "This audit enumerates named local refs of every Git object type. It is not proof that reflogs, unreachable objects, other clones, backups, renamed copies, or external release assets are clean.",
      requiredCleanupScopes: [
        "all local and remote descendant branches and tags",
        "refs/stash and Codex snapshot or turn-diff refs, including refs that point directly to trees or blobs",
        "remote-tracking refs and every linked worktree branch",
        "reflogs, loose objects, packs, local backups, server backups, and release artifacts",
        "other clones, forks, caches, renamed copies, and any external system that received the credential",
      ],
    },
    reconstructionGate: {
      status: "manual_secure_review_required",
      requirements: [
        "Rotate and revoke the exposed provider credential before changing Git history.",
        "Disable GitHub Actions or every tag-triggered release workflow before force-pushing any historical tag. The old tags embed workflow-level contents: write permissions and floating action tags; the new repository variable does not guard those old workflow files.",
        "Export each source release body and asset inventory into an access-controlled quarantine, then redact and approve it without returning secrets to Git.",
        "Rewrite every affected reference in a clean mirror, force-push only after repository-administrator approval, and require collaborators to re-clone.",
        "Recreate historical GitHub Releases through the administrator-approved workflow after cleaned tags exist; this tool never calls GitHub.",
      ],
    },
  };

  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

function inspectHistoricalRelease(root, version) {
  const tag = `v${version}`;
  const tagRef = `refs/tags/${tag}`;
  const notesPath = `RELEASE-v${version}.md`;
  const tagObjectType = gitText(root, ["cat-file", "-t", tagRef], `Cannot resolve historical tag ${tag}.`);
  if (tagObjectType !== "tag") {
    throw new Error(`Historical tag ${tag} must be an annotated tag.`);
  }

  const tagObjectOid = gitText(root, ["rev-parse", "--verify", tagRef], `Cannot resolve historical tag ${tag}.`);
  const peeledCommitOid = gitText(root, ["rev-parse", "--verify", `${tag}^{commit}`], `Cannot resolve historical tag ${tag}.`);
  const treeOid = gitText(root, ["rev-parse", "--verify", `${tag}^{tree}`], `Cannot resolve historical tag ${tag}.`);
  const packageJsonBlobOid = gitText(root, ["rev-parse", "--verify", `${tag}:package.json`], `Cannot read package.json from ${tag}.`);
  const releaseNoteBlobOid = gitText(root, ["rev-parse", "--verify", `${tag}:${notesPath}`], `Cannot read ${notesPath} from ${tag}.`);
  const packageJson = parsePackageVersion(gitBuffer(root, ["show", `${tag}:package.json`], `Cannot read package.json from ${tag}.`), tag);
  if (packageJson.version !== version) {
    throw new Error(`Historical tag ${tag} package version does not match ${version}.`);
  }
  const body = gitBuffer(root, ["show", `${tag}:${notesPath}`], `Cannot read ${notesPath} from ${tag}.`);
  const privacyIssues = findPrivacyIssues(body.toString("utf8"));

  return {
    tag,
    tagObjectOid,
    peeledCommitOid,
    treeOid,
    packageJsonBlobOid,
    packageVersion: packageJson.version,
    notesPath,
    releaseNoteBlobOid,
    sourceBodySha256: createHash("sha256").update(body).digest("hex"),
    sourceBodyBytes: body.byteLength,
    privacyIssueCounts: summarizePrivacyIssues(privacyIssues),
    privacyIssueCountsMeaning: "heuristic_only_not_a_safety_finding",
    assetInventoryStatus: "external_admin_export_required",
    exportStatus: "secure_quarantine_required",
  };
}

function parsePackageVersion(buffer, tag) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed.version !== "string") throw new Error("missing version");
    return parsed;
  } catch {
    throw new Error(`Historical tag ${tag} package.json is not a valid package manifest.`);
  }
}

function inspectLocalReferenceAudit(root, historyPath) {
  const references = listLocalReferences(root);
  const affectedRefNames = new Set();
  const affectedCommitOids = new Set();
  const helperBlobOids = new Set();
  let affectedTreeRefCount = 0;

  for (const reference of references) {
    const target = resolveReferenceTarget(reference);
    if (target.type === "commit") {
      const commits = gitLines(root, ["log", target.oid, "--format=%H", "--", historyPath]);
      if (commits.length === 0) continue;
      affectedRefNames.add(reference.name);
      for (const commit of commits) {
        affectedCommitOids.add(commit);
        const helperBlobOid = gitObjectAtPath(root, commit, historyPath);
        if (helperBlobOid) helperBlobOids.add(helperBlobOid);
      }
      continue;
    }
    if (target.type === "tree") {
      const helperBlobOid = gitObjectAtPath(root, target.oid, historyPath);
      if (!helperBlobOid) continue;
      affectedRefNames.add(reference.name);
      helperBlobOids.add(helperBlobOid);
      affectedTreeRefCount += 1;
    }
  }

  let affectedBlobRefCount = 0;
  for (const reference of references) {
    const target = resolveReferenceTarget(reference);
    if (target.type === "blob" && helperBlobOids.has(target.oid)) {
      affectedRefNames.add(reference.name);
      affectedBlobRefCount += 1;
    }
  }

  return {
    totalNamedRefCount: references.length,
    affectedNamedRefs: [...affectedRefNames].sort(),
    affectedNamedRefCount: affectedRefNames.size,
    affectedCommitCount: affectedCommitOids.size,
    affectedDirectTreeRefCount: affectedTreeRefCount,
    affectedDirectBlobRefCount: affectedBlobRefCount,
    knownHelperBlobCount: helperBlobOids.size,
    sourceCoverage: "all currently named local refs; direct blob refs are matched only when their object ID equals a helper blob found through a commit or tree ref",
  };
}

function listLocalReferences(root) {
  const rows = gitBuffer(root, ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)"], "Could not inspect Git references.")
    .toString("utf8")
    .trimEnd()
    .split(/\r?\n/u)
    .filter(Boolean);
  return rows.map((row) => {
    const [name, objectType, objectOid, peeledObjectType, peeledObjectOid] = row.split("\0");
    if (!name || !objectType || !objectOid) throw new Error("Could not parse a local Git reference.");
    return { name, objectType, objectOid, peeledObjectType, peeledObjectOid };
  });
}

function resolveReferenceTarget(reference) {
  if (reference.objectType === "tag") {
    return { type: reference.peeledObjectType, oid: reference.peeledObjectOid };
  }
  return { type: reference.objectType, oid: reference.objectOid };
}

function gitObjectAtPath(root, objectOid, historyPath) {
  try {
    return gitBuffer(root, ["rev-parse", "--verify", `${objectOid}:${historyPath}`], "").toString("utf8").trim();
  } catch {
    return null;
  }
}

function summarizePrivacyIssues(issues) {
  const counts = {};
  for (const issue of issues) counts[issue.rule] = (counts[issue.rule] ?? 0) + 1;
  return counts;
}

function assertInventoryOutputPath(root, output) {
  const resolved = path.resolve(root, output);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith(`.codex_tmp${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error("Historical release inventory output must be an ignored .codex_tmp/*.json file.");
  }
  return resolved;
}

function gitLines(root, args) {
  return gitText(root, args, "Could not inspect Git references.")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitText(root, args, message) {
  return gitBuffer(root, args, message).toString("utf8").trim();
}

function gitBuffer(root, args, message) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], shell: false });
  } catch {
    throw new Error(message);
  }
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!new Set(["--root", "--output", "--history-path"]).has(name) || !value || value.startsWith("--") || options.has(name)) {
      throw new Error("Usage: historical-release-inventory.mjs [--root project-root] [--output .codex_tmp/historical-release-inventory.json] [--history-path retired-helper-path]");
    }
    options.set(name, value);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.get("--root") ?? fileURLToPath(new URL("..", import.meta.url)));
  const output = options.get("--output") ?? ".codex_tmp/historical-release-inventory.json";
  const inventory = await createHistoricalReleaseInventory({ root, output, historyPath: options.get("--history-path") });
  process.stdout.write(`HISTORICAL_RELEASE_INVENTORY_OK ${JSON.stringify({ releases: inventory.releases.length, affectedNamedRefCount: inventory.credentialHistory.localReferenceAudit.affectedNamedRefCount })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
