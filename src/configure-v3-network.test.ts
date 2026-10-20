import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts", "configure-v3-network.mjs");
const reverseUrl = "ws://172.21.0.1:6199/onebot/ws";

test("V3 network configuration updates only the approved NapCat endpoint and loopback-only internal ports", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-network-"));
  const envPath = path.join(root, ".env");
  const napcatPath = path.join(root, "napcat.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(envPath, `\uFEFF${[
    "NAPCAT_MODE=forward",
    "NAPCAT_REVERSE_WS_HOST=127.0.0.1",
    "NAPCAT_REVERSE_WS_PORT=6201",
    "NAPCAT_REVERSE_WS_PATH=/old",
    "ADMIN_HTTP_PORT=6200",
    "KEEP_THIS=value",
    "",
  ].join("\n")}`);
  writeFileSync(napcatPath, JSON.stringify({
    network: {
      websocketClients: [{ url: "ws://172.21.0.1:6198/old" }],
    },
    unrelated: { url: "ws://unchanged.example/endpoint" },
  }));

  execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
  ], { encoding: "utf8" });

  const env = readFileSync(envPath, "utf8");
  assert.doesNotMatch(env, /^\uFEFF/);
  assert.match(env, /^NAPCAT_MODE=reverse$/m);
  assert.match(env, /^NAPCAT_REVERSE_WS_HOST=172\.21\.0\.1$/m);
  assert.match(env, /^NAPCAT_REVERSE_WS_PORT=6199$/m);
  assert.match(env, /^NAPCAT_REVERSE_WS_PATH=\/onebot\/ws$/m);
  assert.match(env, /^INGRESS_READ_API_PORT=6198$/m);
  assert.match(env, /^INGRESS_READ_API_TOKEN=[A-Za-z0-9_-]{43}$/m);
  assert.match(env, /^ADMIN_HTTP_PORT=6200$/m);
  assert.match(env, /^KEEP_THIS=value$/m);
  const napcat = JSON.parse(readFileSync(napcatPath, "utf8"));
  assert.equal(napcat.network.websocketClients[0].url, reverseUrl);
  assert.equal(napcat.unrelated.url, "ws://unchanged.example/endpoint");
});

test("V3 network configuration permits only the managed preview root or a real child of persistent data", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-preview-root-"));
  const envPath = path.join(root, ".env");
  const napcatPath = path.join(root, "napcat.json");
  const allowedPreviewRoot = path.join(root, "data", "generated-pages");
  const rejectedPreviewRoot = path.join(root, "outside-preview");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(envPath, "NAPCAT_MODE=forward\n");
  writeFileSync(napcatPath, JSON.stringify({
    network: { websocketClients: [{ url: "ws://172.21.0.1:6198/old" }] },
  }));

  execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
    "--html-preview-root", allowedPreviewRoot,
  ], { encoding: "utf8" });
  assert.match(readFileSync(envPath, "utf8"), new RegExp(`^HTML_PREVIEW_ROOT=${escapeRegExp(allowedPreviewRoot)}$`, "m"));

  const envBefore = readFileSync(envPath, "utf8");
  assert.throws(() => execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
    "--html-preview-root", rejectedPreviewRoot,
  ], { encoding: "utf8", stdio: "pipe" }));
  assert.equal(readFileSync(envPath, "utf8"), envBefore);
});

test("V3 network configuration preserves only a valid existing ingress read token", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-network-token-"));
  const envPath = path.join(root, ".env");
  const napcatPath = path.join(root, "napcat.json");
  const validToken = "a".repeat(43);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(envPath, `INGRESS_READ_API_TOKEN=not valid\n`);
  writeFileSync(napcatPath, JSON.stringify({
    network: { websocketClients: [{ url: "ws://172.21.0.1:6198/old" }] },
  }));
  execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
  ], { encoding: "utf8" });
  const rotated = readFileSync(envPath, "utf8").match(/^INGRESS_READ_API_TOKEN=(.+)$/m)?.[1];
  assert.match(rotated ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated, "not valid");

  writeFileSync(envPath, `INGRESS_READ_API_TOKEN=${validToken}\n`);
  execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
  ], { encoding: "utf8" });
  assert.match(readFileSync(envPath, "utf8"), new RegExp(`^INGRESS_READ_API_TOKEN=${validToken}$`, "m"));
});

test("ingress-token-only mode changes no network configuration before cutover", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-network-token-only-"));
  const envPath = path.join(root, ".env");
  const envBefore = "NAPCAT_MODE=forward\nNAPCAT_REVERSE_WS_PORT=6201\nINGRESS_READ_API_TOKEN=invalid\n";
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(envPath, envBefore);
  execFileSync(process.execPath, [
    scriptPath,
    "--ingress-token-only",
    "--env", envPath,
  ], { encoding: "utf8" });
  const envAfter = readFileSync(envPath, "utf8");
  assert.match(envAfter, /^NAPCAT_MODE=forward$/m);
  assert.match(envAfter, /^NAPCAT_REVERSE_WS_PORT=6201$/m);
  assert.match(envAfter, /^INGRESS_READ_API_TOKEN=[A-Za-z0-9_-]{43}$/m);
});

test("V3 network configuration refuses a non-approved NapCat field without changing dotenv", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-network-"));
  const envPath = path.join(root, ".env");
  const napcatPath = path.join(root, "napcat.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const envBefore = "NAPCAT_MODE=forward\nKEEP_THIS=value\n";
  const napcatBefore = JSON.stringify({
    network: { websocketClients: [{ url: "ws://a" }] },
    second: { wsUrl: "ws://b" },
  });
  writeFileSync(envPath, envBefore);
  writeFileSync(napcatPath, napcatBefore);

  assert.throws(() => execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
    "--napcat-url-path", "second.wsUrl",
  ], { encoding: "utf8", stdio: "pipe" }));
  assert.equal(readFileSync(envPath, "utf8"), envBefore);
  assert.equal(readFileSync(napcatPath, "utf8"), napcatBefore);
});

test("V3 network configuration restores NapCat when the paired dotenv replacement fails", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory permission failure is only reliable for a non-root POSIX test process");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-network-rollback-"));
  const envDirectory = path.join(root, "env");
  const napcatDirectory = path.join(root, "napcat");
  const envPath = path.join(envDirectory, ".env");
  const napcatPath = path.join(napcatDirectory, "napcat.json");
  const envBefore = "NAPCAT_MODE=forward\nKEEP_THIS=value\n";
  const napcatBefore = `${JSON.stringify({
    network: { websocketClients: [{ url: "ws://172.21.0.1:6198/old" }] },
  }, null, 2)}\n`;

  t.after(() => {
    chmodSync(envDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(envDirectory);
  mkdirSync(napcatDirectory);
  writeFileSync(envPath, envBefore, { mode: 0o600 });
  writeFileSync(napcatPath, napcatBefore, { mode: 0o600 });
  chmodSync(envDirectory, 0o500);

  assert.throws(() => execFileSync(process.execPath, [
    scriptPath,
    "--env", envPath,
    "--napcat-config", napcatPath,
    "--reverse-url", reverseUrl,
  ], { encoding: "utf8", stdio: "pipe" }));
  assert.equal(readFileSync(envPath, "utf8"), envBefore);
  assert.equal(readFileSync(napcatPath, "utf8"), napcatBefore);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
