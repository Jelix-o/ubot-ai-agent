import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const validatorPath = path.resolve("scripts", "validate-release-zip.mjs");

test("release ZIP validator rejects traversal, links, and case-colliding paths", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-release-zip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const validPath = path.join(root, "valid.zip");
  writeFileSync(validPath, makeZip([{ name: "package.json", contents: Buffer.from('{"name":"ubot"}\n') }]));
  const valid = runValidator(validPath);
  assert.equal(valid.status, 0, valid.stderr);

  const traversalPath = path.join(root, "traversal.zip");
  writeFileSync(traversalPath, makeZip([{ name: "../outside", contents: Buffer.from("x") }]));
  const traversal = runValidator(traversalPath);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /unsafe path/);

  const linkPath = path.join(root, "link.zip");
  writeFileSync(linkPath, makeZip([{ name: "payload", unixMode: 0o120777, contents: Buffer.from("target") }]));
  const link = runValidator(linkPath);
  assert.notEqual(link.status, 0);
  assert.match(link.stderr, /symbolic link/);

  const duplicatePath = path.join(root, "duplicate.zip");
  writeFileSync(duplicatePath, makeZip([
    { name: "Readme.md", contents: Buffer.from("first") },
    { name: "README.md", contents: Buffer.from("second") },
  ]));
  const duplicate = runValidator(duplicatePath);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate path/);
});

function runValidator(archivePath: string) {
  return spawnSync(process.execPath, [validatorPath, archivePath], { encoding: "utf8" });
}

function makeZip(entries: Array<{ name: string; contents: Buffer; unixMode?: number }>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "ascii");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(entry.contents), 14);
    local.writeUInt32LE(entry.contents.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, name, entry.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32(entry.contents), 16);
    central.writeUInt32LE(entry.contents.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE((entry.unixMode ?? 0o100644) * 0x1_0000, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, name);
    offset += local.length + name.length + entry.contents.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
