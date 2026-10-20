import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";

test("secret scan fails closed when the Gitleaks binary is unavailable", () => {
  const missingBinary = path.join(process.cwd(), ".codex_tmp", "missing-gitleaks-binary");
  const result = spawnSync(
    process.execPath,
    ["scripts/secret-scan.mjs", "--source", process.cwd()],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GITLEAKS_BIN: missingBinary },
      shell: false,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Gitleaks binary is required/u);
});
