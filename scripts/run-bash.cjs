// Runs a release shell script on Linux/macOS and also supports Windows hosts
// with Git for Windows installed but no WSL distribution configured.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { delimiter, dirname, join } = require("node:path");

const args = process.argv.slice(2);
const minimumNodeMajor = 22;
if (args.length === 0) {
  console.error("Usage: node scripts/run-bash.cjs <script> [args...]");
  process.exit(1);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
  console.error(`run-bash must run on Node.js ${minimumNodeMajor} or newer. Invoke it through scripts/run-node22.cjs.`);
  process.exit(1);
}

const nodeBinary = process.execPath;
const npmCli = resolveNpmCli(nodeBinary);
if (!npmCli) {
  console.error("The npm CLI paired with the selected Node.js runtime was not found.");
  process.exit(1);
}

function candidates() {
  if (process.platform !== "win32") return [process.env.UBOT_BASH || "bash"];

  const resolved = [];
  if (process.env.UBOT_BASH) resolved.push(process.env.UBOT_BASH);

  for (const entry of (process.env.PATH || "").split(delimiter)) {
    const cleaned = entry.replace(/[\\/]+$/, "");
    if (/[\\/]git[\\/](cmd|bin)$/i.test(cleaned)) {
      resolved.push(join(dirname(cleaned), "bin", "bash.exe"));
    }
  }

  resolved.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "D:\\Software\\Git\\bin\\bash.exe",
    "bash",
  );
  return [...new Set(resolved)];
}

for (const bash of candidates()) {
  if (bash.includes("\\") && !existsSync(bash)) continue;
  const result = spawnSync(bash, args, {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      UBOT_NODE_BIN: nodeBinary,
      UBOT_NPM_CLI: npmCli,
    },
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error("Bash was not found. Install Git for Windows, WSL, or set UBOT_BASH.");
process.exit(1);

function resolveNpmCli(node) {
  const nodeDirectory = dirname(node);
  const candidates = [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
