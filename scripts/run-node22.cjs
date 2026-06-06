const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const fallbackWindowsNode = "D:\\environment\\nvm\\v22.17.0\\node.exe";
const node = process.env.UBOT_NODE || (existsSync(fallbackWindowsNode) ? fallbackWindowsNode : "node");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-node22.cjs <script> [args...]");
  process.exit(1);
}

const result = spawnSync(node, args, { stdio: "inherit", shell: false });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
