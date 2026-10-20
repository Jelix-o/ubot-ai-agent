const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

if (Number.parseInt(process.versions.node, 10) < 22) {
  const result = spawnSync(process.execPath, ["scripts/run-node22.cjs", __filename], {
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

const node = process.execPath;

function findTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const tests = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...findTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(path);
    }
  }

  return tests;
}

if (!statSync("dist", { throwIfNoEntry: false })?.isDirectory()) {
  console.error("dist directory not found. Run npm run build first.");
  process.exit(1);
}

const tests = findTests("dist");

if (tests.length === 0) {
  console.error("No compiled test files found under dist.");
  process.exit(1);
}

function run(label, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(node, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("compiled service tests", ["--test", "--experimental-test-isolation=none", ...tests]);
run("QQ member-profile batch tests", ["--test", "scripts/qq-member-profile-batch.test.mjs"]);
run("admin authentication recovery tests", ["--import", "tsx", "--test", "scripts/admin-api.test.mjs"]);
run("secret scan tests", ["--test", "scripts/secret-scan.test.mjs"]);
run("release ZIP writer tests", ["--test", "scripts/create-release-zip.test.mjs"]);
run("historical release inventory tests", ["--test", "scripts/historical-release-inventory.test.mjs"]);

const btTests = findTests("assets/bt/scripts/tests");
if (btTests.length === 0) {
  console.error("No BT test files found under assets/bt/scripts/tests.");
  process.exit(1);
}
run("BT adapter tests", ["--test", ...btTests]);
