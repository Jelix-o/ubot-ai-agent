const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const fallbackWindowsNode = "D:\\environment\\nvm\\v22.17.0\\node.exe";
const node = process.env.UBOT_NODE || (existsSync(fallbackWindowsNode) ? fallbackWindowsNode : "node");

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

run("build", ["scripts/build.cjs"]);
run("test", ["scripts/run-tests.cjs"]);
