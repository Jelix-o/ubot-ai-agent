#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PARTICIPATION_MODES = new Set([
  "mentions_only",
  "mentions_and_keywords",
  "selected_members",
]);

const args = parseArgs(process.argv.slice(2));
const groupsPath = path.resolve(args.groupsPath ?? path.join(process.cwd(), "config", "groups.json"));
const targetMode = args.mode ?? "mentions_only";
const execute = args.execute === true;

if (!PARTICIPATION_MODES.has(targetMode)) {
  throw new Error(`Unsupported participation mode: ${targetMode}`);
}

const raw = await readFile(groupsPath, "utf8");
const parsed = JSON.parse(raw);
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.groups)) {
  throw new Error("groups.json must contain a groups array");
}

const missingModeGroupIds = [];
const configuredModeGroupIds = [];
for (const group of parsed.groups) {
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    throw new Error("groups.json contains an invalid group entry");
  }
  const groupId = typeof group.groupId === "string" || typeof group.groupId === "number"
    ? String(group.groupId).trim()
    : "";
  if (!groupId) {
    throw new Error("groups.json contains a group without groupId");
  }
  if (group.participationMode === undefined || group.participationMode === null || group.participationMode === "") {
    missingModeGroupIds.push(groupId);
    continue;
  }
  if (!PARTICIPATION_MODES.has(group.participationMode)) {
    throw new Error(`Group ${groupId} has an unsupported participationMode`);
  }
  configuredModeGroupIds.push(groupId);
}

const report = {
  mode: execute ? "execute" : "dry-run",
  groupsPath,
  targetParticipationMode: targetMode,
  totalGroups: parsed.groups.length,
  wouldUpdateGroupIds: missingModeGroupIds,
  alreadyConfiguredGroupIds: configuredModeGroupIds,
};

if (!execute) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const backupDir = path.join(path.dirname(groupsPath), "participation-mode-backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `${timestamp}.groups.json`);
await mkdir(backupDir, { recursive: true });
await copyFile(groupsPath, backupPath);

for (const group of parsed.groups) {
  if (group.participationMode === undefined || group.participationMode === null || group.participationMode === "") {
    group.participationMode = targetMode;
  }
}
await writeJsonAtomic(groupsPath, parsed);

process.stdout.write(`${JSON.stringify({
  ...report,
  backupPath,
  updatedGroupIds: missingModeGroupIds,
}, null, 2)}\n`);

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-participation-mode-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function parseArgs(argv) {
  const parsed = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
    } else if (arg === "--groups") {
      parsed.groupsPath = argv[++index];
    } else if (arg === "--mode") {
      parsed.mode = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run migrate:participation -- [--groups <path>] [--mode mentions_only] [--execute]\n" +
        "Default is a read-only preflight. --execute backs up groups.json before filling only missing participationMode fields.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if ((parsed.groupsPath !== undefined && !parsed.groupsPath) || (parsed.mode !== undefined && !parsed.mode)) {
    throw new Error("Missing value for option");
  }
  return parsed;
}
