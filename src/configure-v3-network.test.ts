import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(env, /^ADMIN_HTTP_PORT=6200$/m);
  assert.match(env, /^KEEP_THIS=value$/m);
  const napcat = JSON.parse(readFileSync(napcatPath, "utf8"));
  assert.equal(napcat.network.websocketClients[0].url, reverseUrl);
  assert.equal(napcat.unrelated.url, "ws://unchanged.example/endpoint");
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
