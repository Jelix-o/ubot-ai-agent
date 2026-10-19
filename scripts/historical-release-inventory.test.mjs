import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

test("historical release inventory records immutable identities without release bodies", async (t) => {
  const root = await createHistoricalFixture(t);
  const result = runInventory(root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private historical body/u);
  const inventory = await readInventory(root);
  const firstRelease = inventory.releases[0];
  assert.equal(inventory.releases.length, 27);
  assert.equal(firstRelease.tag, "v3.0.18");
  assert.equal(inventory.releases.at(-1).tag, "v3.0.44");
  assert.equal(firstRelease.packageVersion, "3.0.18");
  for (const property of ["tagObjectOid", "peeledCommitOid", "treeOid", "packageJsonBlobOid", "releaseNoteBlobOid", "sourceBodySha256"]) {
    assert.match(firstRelease[property], /^[a-f0-9]{40,64}$/u);
  }
  assert.equal(firstRelease.sourceBodyBytes > 0, true);
  assert.equal(firstRelease.assetInventoryStatus, "external_admin_export_required");
  assert.equal(firstRelease.privacyIssueCountsMeaning, "heuristic_only_not_a_safety_finding");
  assert.equal("body" in firstRelease, false);
  assert.equal(inventory.credentialHistory.localReferenceAudit.affectedNamedRefs.includes("refs/codex/turn-diffs/helper-tree"), true);
  assert.equal(inventory.credentialHistory.localReferenceAudit.affectedDirectTreeRefCount, 1);
  assert.doesNotMatch(JSON.stringify(inventory), /private historical body/u);
});

test("historical release inventory rejects a lightweight historical tag", async (t) => {
  const root = await createHistoricalFixture(t);
  execGit(root, ["tag", "-d", "v3.0.18"]);
  execGit(root, ["tag", "v3.0.18"]);
  const result = runInventory(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an annotated tag/u);
});

test("historical release inventory refuses a tracked output location", () => {
  const result = spawnSync(process.execPath, [
    "scripts/historical-release-inventory.mjs",
    "--output", "historical-release-inventory.json",
  ], { cwd: projectRoot, encoding: "utf8", shell: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ignored \.codex_tmp/u);
});

async function createHistoricalFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-release-inventory-"));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await mkdir(path.join(root, ".codex_tmp"));
  execGit(root, ["init"]);
  execGit(root, ["config", "user.email", "test@example.invalid"]);
  execGit(root, ["config", "user.name", "Release Inventory Test"]);

  for (let version = 18; version <= 44; version += 1) {
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ version: `3.0.${version}` })}\n`, "utf8");
    await writeFile(path.join(root, `RELEASE-v3.0.${version}.md`), `# UBot v3.0.${version}\n\nprivate historical body\n`, "utf8");
    if (version === 18) await writeFile(path.join(root, "removed-helper.mjs"), "private retired helper\n", "utf8");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-m", `fixture ${version}`]);
    execGit(root, ["tag", "-a", `v3.0.${version}`, "-m", `fixture ${version}`]);
  }

  const treeOid = execGitText(root, ["rev-parse", "HEAD^{tree}"]);
  execGit(root, ["update-ref", "refs/codex/turn-diffs/helper-tree", treeOid]);
  return root;
}

function runInventory(root) {
  return spawnSync(process.execPath, [
    "scripts/historical-release-inventory.mjs",
    "--root", root,
    "--output", ".codex_tmp/inventory.json",
    "--history-path", "removed-helper.mjs",
  ], { cwd: projectRoot, encoding: "utf8", shell: false });
}

async function readInventory(root) {
  return JSON.parse(await readFile(path.join(root, ".codex_tmp", "inventory.json"), "utf8"));
}

function execGit(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore", shell: false });
}

function execGitText(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false }).trim();
}
