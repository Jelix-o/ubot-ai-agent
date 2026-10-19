import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("release ZIP writer refuses symlinked source files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "ubot-release-zip-link-"));
  const source = path.join(root, "source");
  const target = path.join(root, "outside.txt");
  const archive = path.join(root, "release.zip");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(target, "outside\n", "utf8");
    try {
      await symlink(target, path.join(source, "linked.txt"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        context.skip("current Windows account cannot create test symlinks");
        return;
      }
      throw error;
    }

    const created = spawnSync(process.execPath, ["scripts/create-release-zip.mjs", source, archive], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    assert.notEqual(created.status, 0);
    assert.match(`${created.stdout}\n${created.stderr}`, /symbolic link|unsupported entry/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release ZIP writer refuses Windows-reserved paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ubot-release-zip-portability-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "release.zip");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "CON.txt"), "reserved\n", "utf8");

    const reservedName = spawnSync(process.execPath, ["scripts/create-release-zip.mjs", source, archive], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    assert.notEqual(reservedName.status, 0);
    assert.match(`${reservedName.stdout}\n${reservedName.stderr}`, /Windows-reserved path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release ZIP writer refuses case-insensitive path collisions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "ubot-release-zip-collision-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "release.zip");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "readme.txt"), "lowercase\n", "utf8");
    await writeFile(path.join(source, "README.txt"), "uppercase\n", "utf8");
    const names = await readdir(source);
    if (!names.includes("readme.txt") || !names.includes("README.txt")) {
      context.skip("current filesystem is case-insensitive");
      return;
    }

    const collision = spawnSync(process.execPath, ["scripts/create-release-zip.mjs", source, archive], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    assert.notEqual(collision.status, 0);
    assert.match(`${collision.stdout}\n${collision.stderr}`, /case-insensitive path collision/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
