import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("release ZIP writer emits a validator-compatible portable archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ubot-release-zip-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "release.zip");
  try {
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "release notes\n", "utf8");
    await writeFile(path.join(source, "nested", "runtime.js"), "export {};\n", "utf8");

    const created = spawnSync(process.execPath, ["scripts/create-release-zip.mjs", source, archive], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    assert.equal(created.status, 0, created.stderr);

    const validated = spawnSync(process.execPath, ["scripts/validate-release-zip.mjs", archive], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    assert.equal(validated.status, 0, validated.stderr);
    const payload = JSON.parse(validated.stdout);
    assert.equal(payload.entries, 2);
    assert.ok((await readFile(archive)).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
