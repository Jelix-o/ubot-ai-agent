// Resolves a modern Node.js binary (>= 22) and spawns it with the given args.
// Priority: $UBOT_NODE env > known nvm locations > `node` on PATH (if >= 22).
const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const NVM_ROOT_CANDIDATES = [
  process.env.NVM_HOME,
  process.env.NVM_SYMLINK,
  join(os.homedir(), "AppData", "Roaming", "nvm"),
  "C:\\environment\\nvm",
  "D:\\environment\\nvm",
  "C:\\nvm",
  "D:\\nvm",
].filter(Boolean);

const NEEDED_MAJOR = 22;

function majorOf(node) {
  try {
    const result = spawnSync(node, ["--version"], { encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    const match = /^v(\d+)\./.exec((result.stdout || "").trim());
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function findNvmNode() {
  for (const root of NVM_ROOT_CANDIDATES) {
    if (!root || !existsSync(root)) {
      continue;
    }
    const dirs = [];
    try {
      dirs.push(...readdirSync(root));
    } catch {
      continue;
    }
    const versionDirs = dirs
      .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const va = a.replace(/^v/, "").split(".").map(Number);
        const vb = b.replace(/^v/, "").split(".").map(Number);
        return vb[0] - va[0] || vb[1] - va[1] || vb[2] - va[2];
      });
    for (const dir of versionDirs) {
      const candidate = join(root, dir, "node.exe");
      if (existsSync(candidate) && (majorOf(candidate) ?? 0) >= NEEDED_MAJOR) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveNode() {
  if (process.env.UBOT_NODE) {
    return process.env.UBOT_NODE;
  }
  const fromNvm = findNvmNode();
  if (fromNvm) {
    return fromNvm;
  }
  if ((majorOf("node") ?? 0) >= NEEDED_MAJOR) {
    return "node";
  }
  return "node";
}

const node = resolveNode();
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
