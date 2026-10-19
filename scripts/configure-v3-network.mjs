#!/usr/bin/env node
import { chmod, chown, lstat, rename, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const ingressTokenOnly = args.includes("--ingress-token-only");
const requiredValue = (name) => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const envPath = path.resolve(requiredValue("--env"));
if (ingressTokenOnly) {
  if (args.length !== 3 || !args.includes("--env")) {
    throw new Error("Usage: configure-v3-network.mjs --ingress-token-only --env /path/to/.env");
  }
  const envMetadata = await requireRegularFile(envPath);
  const envText = (await readFile(envPath, "utf8")).replace(/^\uFEFF/, "");
  const existingIngressReadApiToken = readEnvValue(envText, "INGRESS_READ_API_TOKEN");
  const ingressReadApiToken = isIngressReadApiToken(existingIngressReadApiToken)
    ? existingIngressReadApiToken
    : randomBytes(32).toString("base64url");
  const nextEnv = setEnvValues(envText, { INGRESS_READ_API_TOKEN: ingressReadApiToken });
  if (nextEnv !== envText) await writeAtomic(envPath, nextEnv, envMetadata);
  process.stdout.write("Ingress Read API token normalized.\n");
  process.exit(0);
}
const napcatConfigPath = path.resolve(requiredValue("--napcat-config"));
const reverseUrl = requiredValue("--reverse-url");
const requestedPath = optional("--napcat-url-path");
const htmlPreviewRoot = optional("--html-preview-root");
const approvedNapcatUrlPath = "network.websocketClients.0.url";
const managedPreviewRoot = path.resolve(process.env.UBOT_MANAGED_PREVIEW_ROOT ?? "/var/lib/ubot-preview");
const appDataRoot = path.resolve(path.dirname(envPath), "data");
const releaseRoot = path.resolve(process.env.UBOT_RELEASE_ROOT ?? "/opt/ai-project-releases");

if (reverseUrl !== "ws://172.21.0.1:6199/onebot/ws") {
  throw new Error("The V3 ingress URL must be ws://172.21.0.1:6199/onebot/ws.");
}
if (requestedPath && requestedPath !== approvedNapcatUrlPath) {
  throw new Error(`The only approved NapCat URL path is ${approvedNapcatUrlPath}.`);
}
if (htmlPreviewRoot && (
  !path.isAbsolute(htmlPreviewRoot) ||
  htmlPreviewRoot.includes("\0") ||
  htmlPreviewRoot !== path.resolve(htmlPreviewRoot) ||
  !isSafeAbsolutePath(htmlPreviewRoot) ||
  isWithinOrEqual(releaseRoot, htmlPreviewRoot) ||
  (htmlPreviewRoot !== managedPreviewRoot && !isStrictChildPath(appDataRoot, htmlPreviewRoot))
)) {
  throw new Error("--html-preview-root must be the managed preview root or a normalized child of persistent data.");
}

const envMetadata = await requireRegularFile(envPath);
const napcatMetadata = await requireRegularFile(napcatConfigPath);
if (htmlPreviewRoot) await requireDirectoryIfPresent(htmlPreviewRoot);
const envText = (await readFile(envPath, "utf8")).replace(/^\uFEFF/, "");
const existingIngressReadApiToken = readEnvValue(envText, "INGRESS_READ_API_TOKEN");
const ingressReadApiToken = isIngressReadApiToken(existingIngressReadApiToken)
  ? existingIngressReadApiToken
  : randomBytes(32).toString("base64url");
const nextEnv = setEnvValues(envText, {
  NAPCAT_MODE: "reverse",
  NAPCAT_REVERSE_WS_HOST: "172.21.0.1",
  NAPCAT_REVERSE_WS_PORT: "6199",
  NAPCAT_REVERSE_WS_PATH: new URL(reverseUrl).pathname,
  // This is intentionally written even though the runtime has the same
  // default. It makes the production-only loopback boundary explicit.
  INGRESS_READ_API_PORT: "6198",
  // Keep only a previously provisioned token that already satisfies the
  // runtime contract. An invalid legacy value is replaced before the V3
  // migration starts, preventing a post-cutover health-check failure.
  INGRESS_READ_API_TOKEN: ingressReadApiToken,
  ...(htmlPreviewRoot ? { HTML_PREVIEW_ROOT: htmlPreviewRoot } : {}),
});

const napcatText = await readFile(napcatConfigPath, "utf8");
const napcat = JSON.parse(napcatText);
const target = resolvePath(napcat, approvedNapcatUrlPath);
if (!target || typeof target.container[target.key] !== "string" || !/^wss?:\/\//.test(target.container[target.key])) {
  throw new Error(`Could not validate ${approvedNapcatUrlPath} in the supplied NapCat JSON.`);
}
target.container[target.key] = reverseUrl;

// Validate both documents before modifying either one. If the dotenv replacement
// fails after NapCat was atomically replaced, restore the exact original NapCat
// document and its ownership/mode before returning a failure to the deployer.
await writePairedAtomically({
  filePath: napcatConfigPath,
  contents: `${JSON.stringify(napcat, null, 2)}\n`,
  originalContents: napcatText,
  metadata: napcatMetadata,
}, {
  filePath: envPath,
  contents: nextEnv,
  metadata: envMetadata,
});

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

function readEnvValue(text, key) {
  const line = text.split(/\r?\n/).find((candidate) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(candidate));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value || undefined;
}

function isIngressReadApiToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
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

async function requireRegularFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing to replace a non-regular file: ${filePath}`);
  }
  return metadata;
}

async function requireDirectoryIfPresent(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing HTML preview root that is not a real directory: ${filePath}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function isStrictChildPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSafeAbsolutePath(value) {
  // The deployer runs on Linux and allows only ordinary POSIX path
  // characters. The same configurator test is intentionally exercised on
  // Windows CI, where a canonical absolute path includes a drive letter and
  // backslashes. Boundary checks above remain path-module based on both.
  return process.platform === "win32"
    ? /^[A-Za-z]:[A-Za-z0-9._\\/-]+$/.test(value)
    : /^[A-Za-z0-9._/-]+$/.test(value);
}

function isWithinOrEqual(root, candidate) {
  return path.resolve(root) === path.resolve(candidate) || isStrictChildPath(root, candidate);
}

async function writeAtomic(filePath, contents, metadata) {
  const temporaryPath = `${filePath}.ubot-v3-${process.pid}.tmp`;
  let temporaryCreated = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: metadata.mode & 0o777 });
    temporaryCreated = true;
    await chmod(temporaryPath, metadata.mode & 0o777);
    if (process.platform !== "win32") {
      await chown(temporaryPath, metadata.uid, metadata.gid);
    }
    await rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function writePairedAtomically(first, second) {
  let firstWritten = false;
  try {
    await writeAtomic(first.filePath, first.contents, first.metadata);
    firstWritten = true;
    await writeAtomic(second.filePath, second.contents, second.metadata);
  } catch (error) {
    if (!firstWritten) throw error;
    try {
      await writeAtomic(first.filePath, first.originalContents, first.metadata);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Could not update V3 network files and could not restore the original NapCat configuration.",
      );
    }
    throw new Error(
      "Could not update V3 network files; the original NapCat configuration was restored.",
      { cause: error },
    );
  }
}
