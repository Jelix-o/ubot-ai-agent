// Runs a release shell script on Linux/macOS and also supports Windows hosts
// with Git for Windows installed but no WSL distribution configured.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { delimiter, dirname, join } = require("node:path");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-bash.cjs <script> [args...]");
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
  const result = spawnSync(bash, args, { stdio: "inherit", shell: false });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error("Bash was not found. Install Git for Windows, WSL, or set UBOT_BASH.");
process.exit(1);
