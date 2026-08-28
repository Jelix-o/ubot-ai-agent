#!/usr/bin/env node
import { rename, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const requiredValue = (name) => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const envPath = path.resolve(requiredValue("--env"));
const napcatConfigPath = path.resolve(requiredValue("--napcat-config"));
const reverseUrl = requiredValue("--reverse-url");
const requestedPath = optional("--napcat-url-path");
const approvedNapcatUrlPath = "network.websocketClients.0.url";

if (reverseUrl !== "ws://172.21.0.1:6199/onebot/ws") {
  throw new Error("The V3 ingress URL must be ws://172.21.0.1:6199/onebot/ws.");
}
if (requestedPath && requestedPath !== approvedNapcatUrlPath) {
  throw new Error(`The only approved NapCat URL path is ${approvedNapcatUrlPath}.`);
}

const envText = (await readFile(envPath, "utf8")).replace(/^\uFEFF/, "");
const nextEnv = setEnvValues(envText, {
  NAPCAT_MODE: "reverse",
  NAPCAT_REVERSE_WS_HOST: "172.21.0.1",
  NAPCAT_REVERSE_WS_PORT: "6199",
  NAPCAT_REVERSE_WS_PATH: new URL(reverseUrl).pathname,
  // This is intentionally written even though the runtime has the same
  // default. It makes the production-only loopback boundary explicit.
  INGRESS_READ_API_PORT: "6198",
});

const napcat = JSON.parse(await readFile(napcatConfigPath, "utf8"));
const target = resolvePath(napcat, approvedNapcatUrlPath);
if (!target || typeof target.container[target.key] !== "string" || !/^wss?:\/\//.test(target.container[target.key])) {
  throw new Error(`Could not validate ${approvedNapcatUrlPath} in the supplied NapCat JSON.`);
}
target.container[target.key] = reverseUrl;

// Validate both documents before modifying either one. Deployment has its own
// restricted backups for rollback, but this keeps a direct operator run from
// partially changing the dotenv file when the NapCat configuration is invalid.
await writeAtomic(napcatConfigPath, `${JSON.stringify(napcat, null, 2)}\n`);
await writeAtomic(envPath, nextEnv);

process.stdout.write("V3 ingress and NapCat reverse URL configuration updated.\n");

function optional(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function setEnvValues(text, values) {
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Z0-9_]+)(\s*=).*$/);
    if (!match || !(match[2] in values)) return line;
    seen.add(match[2]);
    return `${match[1]}${match[2]}${match[3]}${values[match[2]]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function resolvePath(value, dotPath) {
  const parts = dotPath.split(".").filter(Boolean);
  if (!parts.length) throw new Error("--napcat-url-path cannot be empty");
  let container = value;
  for (const part of parts.slice(0, -1)) {
    if (!container || typeof container !== "object" || !(part in container)) {
      throw new Error("--napcat-url-path does not exist in the supplied NapCat JSON");
    }
    container = container[part];
  }
  return { container, key: parts.at(-1) };
}

async function writeAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.ubot-v3-${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, filePath);
}
