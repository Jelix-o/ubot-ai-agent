import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const migrationScript = path.resolve("scripts/migrate-participation-mode.mjs");

test("participation migration previews missing modes without mutating groups.json", (t) => {
  const root = fixture(t, {
    groups: [group("10001"), { ...group("10002"), participationMode: "selected_members" }],
  });
  const output = execFileSync(process.execPath, [migrationScript, "--groups", root.groupsPath], { encoding: "utf8" });
  const report = JSON.parse(output) as {
    mode: string;
    targetParticipationMode: string;
    wouldUpdateGroupIds: string[];
    alreadyConfiguredGroupIds: string[];
  };

  assert.equal(report.mode, "dry-run");
  assert.equal(report.targetParticipationMode, "mentions_only");
  assert.deepEqual(report.wouldUpdateGroupIds, ["10001"]);
  assert.deepEqual(report.alreadyConfiguredGroupIds, ["10002"]);
  assert.equal(JSON.parse(readFileSync(root.groupsPath, "utf8")).groups[0].participationMode, undefined);
});

test("participation migration backs up and fills only missing modes", (t) => {
  const root = fixture(t, {
    groups: [group("10001"), { ...group("10002"), participationMode: "mentions_and_keywords" }],
  });
  const report = JSON.parse(execFileSync(
    process.execPath,
    [migrationScript, "--groups", root.groupsPath, "--mode", "mentions_only", "--execute"],
    { encoding: "utf8" },
  )) as { updatedGroupIds: string[]; backupPath: string };

  const migrated = JSON.parse(readFileSync(root.groupsPath, "utf8"));
  assert.deepEqual(migrated.groups.map((item: { participationMode: string }) => item.participationMode), [
    "mentions_only",
    "mentions_and_keywords",
  ]);
  assert.deepEqual(report.updatedGroupIds, ["10001"]);
  assert.equal(readFileSync(report.backupPath, "utf8").includes("mentions_and_keywords"), true);
  assert.equal(readdirSync(path.dirname(report.backupPath)).length, 1);
});

test("participation migration rejects invalid pre-existing modes", (t) => {
  const root = fixture(t, { groups: [{ ...group("10001"), participationMode: "noisy" }] });
  assert.throws(
    () => execFileSync(process.execPath, [migrationScript, "--groups", root.groupsPath, "--execute"], {
      encoding: "utf8",
      stdio: "pipe",
    }),
    /unsupported participationMode/,
  );
});

function fixture(t: test.TestContext, groups: unknown): { root: string; groupsPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "participation-migration-"));
  const config = path.join(root, "config");
  mkdirSync(config, { recursive: true });
  const groupsPath = path.join(config, "groups.json");
  writeFileSync(groupsPath, `${JSON.stringify(groups, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, groupsPath };
}

function group(groupId: string): Record<string, unknown> {
  return {
    groupId,
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: [],
    liveChatUserIds: [],
  };
}
