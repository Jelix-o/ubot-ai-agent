import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts", "deploy-linux-release.sh");

test("Linux release deployer keeps persistent state, quarantines approved Outbox rows, and switches release atomically", (t) => {
  if (process.platform === "win32") {
    t.skip("Linux deployment execution requires POSIX symlink semantics");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-linux-deploy-"));
  const appRoot = path.join(root, "app");
  const releaseRoot = path.join(root, "releases");
  const systemdRoot = path.join(root, "systemd");
  const fakeBin = path.join(root, "bin");
  const logPath = path.join(root, "calls.log");
  const serviceName = "ubot-test.service";
  const oldRelease = path.join(releaseRoot, "v2.0.3");
  const newVersion = "3.0.0-rc.1";
  const newRelease = path.join(releaseRoot, `v${newVersion}`);
  const bundleRoot = path.join(root, "bundle");
  const bundlePath = path.join(root, "bundle.tar.gz");
  const dbPath = path.join(appRoot, "data", "shared", "bot-shared.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(path.join(appRoot, "data", "shared"), { recursive: true });
  mkdirSync(path.join(appRoot, "skills"), { recursive: true });
  mkdirSync(path.join(oldRelease, "config"), { recursive: true });
  mkdirSync(path.join(releaseRoot), { recursive: true });
  mkdirSync(path.join(systemdRoot, `${serviceName}.d`), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(appRoot, ".env"), "BOT_QQ=12345\n");
  writeFileSync(path.join(oldRelease, "config", "groups.json"), JSON.stringify({
    groups: [group("10001"), { ...group("10002"), participationMode: "selected_members" }],
  }, null, 2));
  writeFileSync(path.join(appRoot, "skills", "owner-skill.json"), "{\"ownerManaged\":true}\n");
  writeFileSync(path.join(systemdRoot, `${serviceName}.d`, "release-v2.0.3.conf"), "[Service]\nWorkingDirectory=old\n");
  symlinkSync(oldRelease, path.join(releaseRoot, "current"));
  createDatabase(dbPath);
  createBundle(bundleRoot, bundlePath, newVersion, root);
  writeFakeSystemctl(path.join(fakeBin, "systemctl"), logPath, oldRelease, serviceName);
  writeFakeSudo(path.join(fakeBin, "sudo"));
  writeFakePgrep(path.join(fakeBin, "pgrep"));
  writeFakeCurl(path.join(fakeBin, "curl"));

  execFileSync("bash", [scriptPath, newVersion, bundlePath, "291,292,293,294"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      UBOT_APP_ROOT: appRoot,
      UBOT_RELEASE_ROOT: releaseRoot,
      UBOT_SYSTEMD_ROOT: systemdRoot,
      UBOT_SERVICE_NAME: serviceName,
    },
  });

  assert.equal(readFileSync(path.join(appRoot, "config", "groups.json"), "utf8").includes("mentions_only"), true);
  const migrated = JSON.parse(readFileSync(path.join(appRoot, "config", "groups.json"), "utf8"));
  assert.deepEqual(migrated.groups.map((item: { participationMode: string }) => item.participationMode), [
    "mentions_only",
    "selected_members",
  ]);
  assert.equal(readFileSync(path.join(appRoot, "skills", "owner-skill.json"), "utf8"), "{\"ownerManaged\":true}\n");
  assert.equal(readFileSync(path.join(newRelease, ".env"), "utf8"), "BOT_QQ=12345\n");
  assert.equal(readFileSync(path.join(newRelease, "config", "groups.json"), "utf8").includes("mentions_only"), true);
  assert.equal(readFileSync(path.join(newRelease, "skills", "owner-skill.json"), "utf8"), "{\"ownerManaged\":true}\n");
  assert.equal(readlinkSync(path.join(releaseRoot, "current")), newRelease);
  assert.match(readFileSync(path.join(systemdRoot, `${serviceName}.d`, "release.conf"), "utf8"), new RegExp(`WorkingDirectory=${escapeRegex(newRelease)}`));
  assert.equal(readdirSync(path.join(appRoot, "release-backups")).length, 1);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.deepEqual(
    db.prepare("SELECT id, status, retry_after FROM outbox ORDER BY id").all(),
    [
      { id: 291, status: "failed", retry_after: null },
      { id: 292, status: "failed", retry_after: null },
      { id: 293, status: "failed", retry_after: null },
      { id: 294, status: "failed", retry_after: null },
    ],
  );
  db.close();
  const calls = readFileSync(logPath, "utf8");
  assert.match(calls, /stop ubot-test\.service/);
  assert.match(calls, /daemon-reload/);
  assert.match(calls, /start ubot-test\.service/);
});

test("Linux release deployer preserves the declared release safety gates", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /VACUUM INTO/);
  assert.match(source, /persistent-files\.tar\.gz/);
  assert.match(source, /status = 'failed', retry_after = NULL/);
  assert.match(source, /managed-skills\/itexpert\.json/);
  assert.match(source, /migrate-participation-mode\.mjs/);
  assert.match(source, /--mode mentions_only/);
  assert.match(source, /ln -s "\$PERSISTENT_ENV"/);
  assert.match(source, /ln -s "\$PERSISTENT_DATA"/);
  assert.match(source, /ln -s "\$PERSISTENT_SKILLS"/);
  assert.match(source, /ln -s "\$PERSISTENT_CONFIG"/);
  assert.match(source, /schema_migrations/);
  assert.match(source, /rollback\(\)/);
  assert.match(source, /rm -f "\$CONTROLLED_DROPIN"/);
});

function createDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      retry_after INTEGER,
      updated_at INTEGER
    );
    INSERT INTO outbox (id, status, retry_after) VALUES
      (291, 'failed', 1),
      (292, 'failed', 1),
      (293, 'failed', 1),
      (294, 'failed', 1);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations VALUES
      (1, 'reconcile-pre-versioned-schema', 1),
      (2, 'add-group-config-shadow-snapshots', 1),
      (3, 'add-system-settings-shadow-snapshots', 1);
  `);
  db.close();
}

function createBundle(bundleRoot: string, bundlePath: string, version: string, root: string): void {
  mkdirSync(path.join(bundleRoot, "dist"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ name: "ubot", version }));
  writeFileSync(path.join(bundleRoot, "package-lock.json"), JSON.stringify({ name: "ubot", version, lockfileVersion: 1, requires: true }));
  writeFileSync(path.join(bundleRoot, "dist", "index.js"), "export {};\n");
  writeFileSync(path.join(bundleRoot, "scripts", "start-prod.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(bundleRoot, "scripts", "migrate-participation-mode.mjs"), readFileSync(path.resolve("scripts", "migrate-participation-mode.mjs")));
  writeFileSync(path.join(bundleRoot, "scripts", "deploy-linux-release.sh"), readFileSync(scriptPath));
  execFileSync("tar", ["-C", bundleRoot, "-czf", bundlePath, "."], { cwd: root });
}

function writeFakeSystemctl(filePath: string, logPath: string, oldRelease: string, serviceName: string): void {
  writeFileSync(filePath, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${shellQuote(logPath)}
if [[ "$1" == "is-active" ]]; then echo active; exit 0; fi
if [[ "$1" == "show" && "$*" == *"WorkingDirectory"* ]]; then echo ${shellQuote(oldRelease)}; exit 0; fi
if [[ "$1" == "show" && "$*" == *"MainPID"* ]]; then echo 4242; exit 0; fi
if [[ "$1" == "start" && "$2" == ${shellQuote(serviceName)} ]]; then exit 0; fi
exit 0
`);
  chmodSync(filePath, 0o755);
}

function writeFakeSudo(filePath: string): void {
  writeFileSync(filePath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-n" && $# -eq 2 && "$2" == "true" ]]; then exit 0; fi
if [[ "$1" == "-n" ]]; then shift; fi
exec "$@"
`);
  chmodSync(filePath, 0o755);
}

function writeFakePgrep(filePath: string): void {
  writeFileSync(filePath, "#!/usr/bin/env bash\nprintf '5001\\n5002\\n5003\\n'\n");
  chmodSync(filePath, 0o755);
}

function writeFakeCurl(filePath: string): void {
  writeFileSync(filePath, "#!/usr/bin/env bash\nprintf '401'\n");
  chmodSync(filePath, 0o755);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
