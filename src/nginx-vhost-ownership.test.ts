import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const verifierPath = path.resolve("scripts", "verify-nginx-vhost-ownership.mjs");
const botConfig = "/etc/nginx/sites-available/bot-9958";
const botEnabled = "/etc/nginx/sites-enabled/bot-9958";
const previewConfig = "/etc/nginx/sites-available/preview-9958";
const previewEnabled = "/etc/nginx/sites-enabled/preview-9958";

test("Nginx vhost verifier requires the two controlled hostname listeners", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-nginx-vhost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const valid = path.join(root, "valid.txt");
  writeFileSync(valid, renderConfig());
  assert.equal(runVerifier(valid).status, 0);

  const omitted = path.join(root, "omitted.txt");
  writeFileSync(omitted, renderConfig({ botSource: "/etc/nginx/sites-enabled/legacy-bot" }));
  const omittedResult = runVerifier(omitted);
  assert.notEqual(omittedResult.status, 0);
  assert.match(omittedResult.stderr, /unexpected source/);

  const duplicate = path.join(root, "duplicate.txt");
  writeFileSync(duplicate, `${renderConfig()}\n${section("/etc/nginx/sites-enabled/legacy-bot", "bot.9958.uk", 80)}`);
  const duplicateResult = runVerifier(duplicate);
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /exactly two effective server blocks/);

  const unguarded = path.join(root, "unguarded.txt");
  writeFileSync(unguarded, renderConfig({ withoutGate: true }));
  const unguardedResult = runVerifier(unguarded);
  assert.notEqual(unguardedResult.status, 0);
  assert.match(unguardedResult.stderr, /does not enforce the Cloudflare real-IP and origin gate/);
});

function runVerifier(renderedPath: string) {
  return spawnSync(process.execPath, [
    verifierPath,
    renderedPath,
    botConfig,
    botEnabled,
    "bot.9958.uk",
    previewConfig,
    previewEnabled,
    "preview.9958.uk",
  ], { encoding: "utf8" });
}

function renderConfig({ botSource = botEnabled, withoutGate = false }: { botSource?: string; withoutGate?: boolean } = {}) {
  return [
    "nginx: configuration file /etc/nginx/nginx.conf test is successful",
    section(botSource, "bot.9958.uk", 80, withoutGate),
    section(botSource, "bot.9958.uk", 443, withoutGate),
    section(previewEnabled, "preview.9958.uk", 80, withoutGate),
    section(previewEnabled, "preview.9958.uk", 443, withoutGate),
  ].join("\n");
}

function section(source: string, hostname: string, port: number, withoutGate = false) {
  const boundary = withoutGate
    ? ""
    : "  include /etc/nginx/ubot-cloudflare-realip.conf;\n  if ($ubot_cloudflare_origin_allowed = 0) {\n    return 403;\n  }\n";
  return `# configuration file ${source}:\nserver {\n  listen ${port};\n  server_name ${hostname};\n${boundary}}`;
}
