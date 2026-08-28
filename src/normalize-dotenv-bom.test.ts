import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = path.resolve("scripts", "normalize-dotenv-bom.mjs");
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

test("dotenv BOM normalizer strips only one leading BOM and preserves CRLF bytes and mode", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-dotenv-bom-"));
  try {
    const envPath = path.join(root, ".env");
    const backupPath = path.join(root, "env.before-bom");
    const body = Buffer.from("NAPCAT_MODE=reverse\r\nADMIN_HTTP_ENABLED=true\r\n", "utf8");
    const original = Buffer.concat([bom, body]);
    await writeFile(envPath, original);
    await chmod(envPath, 0o640);

    const result = runHelper(envPath, backupPath);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(envPath), body);
    assert.deepEqual(await readFile(backupPath), original);
    assert.equal((await stat(envPath)).mode & 0o777, 0o640);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dotenv BOM normalizer leaves an ordinary file byte-for-byte untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-dotenv-plain-"));
  try {
    const envPath = path.join(root, ".env");
    const backupPath = path.join(root, "env.before-bom");
    const body = Buffer.from("NAPCAT_MODE=reverse\n", "utf8");
    await writeFile(envPath, body);
    const before = await lstat(envPath);

    const result = runHelper(envPath, backupPath);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(envPath), body);
    await assert.rejects(lstat(backupPath), { code: "ENOENT" });
    assert.equal((await lstat(envPath)).ino, before.ino);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dotenv BOM normalizer aborts without touching the source when a safe backup cannot be created", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-dotenv-blocked-"));
  try {
    const envPath = path.join(root, ".env");
    const backupPath = path.join(root, "env.before-bom");
    const original = Buffer.concat([bom, Buffer.from("NAPCAT_MODE=reverse\n", "utf8")]);
    await writeFile(envPath, original);
    await writeFile(backupPath, "do-not-overwrite\n", "utf8");

    const result = runHelper(envPath, backupPath);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(envPath), original);
    assert.equal(await readFile(backupPath, "utf8"), "do-not-overwrite\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runHelper(envPath: string, backupPath: string) {
  return spawnSync(process.execPath, [helper, "--env", envPath, "--backup", backupPath], {
    encoding: "utf8",
  });
}
