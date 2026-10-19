#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sourceArg = readOption(args, "--source");
if (args.length !== (sourceArg ? 2 : 0)) {
  throw new Error("Usage: secret-scan.mjs [--source directory]");
}

const source = path.resolve(sourceArg ?? scriptRoot);
const config = path.join(scriptRoot, ".gitleaks.toml");
if (!existsSync(source) || !statSync(source).isDirectory()) {
  throw new Error("Secret scan source must be an existing directory.");
}
if (!existsSync(config)) {
  throw new Error("Gitleaks configuration is missing.");
}

const binary = process.env.GITLEAKS_BIN?.trim() || "gitleaks";
const result = spawnSync(binary, [
  "detect",
  "--source", source,
  "--no-git",
  "--redact",
  "--config", config,
], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("Gitleaks binary is required for secret scanning. Install Gitleaks 8.24.3 or set GITLEAKS_BIN.");
  } else {
    console.error(`Gitleaks could not start: ${result.error.message}`);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--") || values.indexOf(name, index + 1) >= 0) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}
