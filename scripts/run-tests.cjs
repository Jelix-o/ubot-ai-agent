const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const fallbackWindowsNode = "D:\\environment\\nvm\\v22.17.0\\node.exe";
const node = process.env.UBOT_NODE || (require("node:fs").existsSync(fallbackWindowsNode) ? fallbackWindowsNode : "node");

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

const result = spawnSync(node, ["--test", "--experimental-test-isolation=none", ...tests], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
