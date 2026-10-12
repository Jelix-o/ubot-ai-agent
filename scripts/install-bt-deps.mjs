#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const parsed = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!["--runtime-root", "--python"].includes(flag) || !value || value.startsWith("--") || parsed.has(flag)) {
    throw new Error("Usage: install-bt-deps.mjs --runtime-root /opt/ai-project/bt-runtime [--python python3]");
  }
  parsed.set(flag, value);
}
if (!parsed.has("--runtime-root")) {
  throw new Error("Usage: install-bt-deps.mjs --runtime-root /opt/ai-project/bt-runtime [--python python3]");
}
const root = path.resolve(parsed.get("--runtime-root"));
const python = parsed.get("--python") ?? (process.platform === "win32" ? "python" : "python3");
const bin = path.join(root, "venv", process.platform === "win32" ? "Scripts" : "bin");
const venvPython = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, "browsers") };
const run = (command, argv) => {
  const result = spawnSync(command, argv, { env, stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency installation failed (${result.status}): ${path.basename(command)}`);
};
mkdirSync(root, { recursive: true });
run(python, ["-m", "venv", path.join(root, "venv")]);
run(venvPython, ["-m", "pip", "install", "-r", fileURLToPath(new URL("../assets/bt/requirements.txt", import.meta.url))]);
run(path.join(bin, process.platform === "win32" ? "scrapling.exe" : "scrapling"), ["install"]);
run(venvPython, ["-c", "import importlib.metadata as m; assert m.version('curl_cffi') == '0.16.3'; assert m.version('scrapling') == '0.4.15'; from scrapling.fetchers import StealthyFetcher; print('BT dependencies verified')"]);
console.log(`BT runtime ready: ${root}`);
