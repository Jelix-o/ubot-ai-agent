import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const validatorPath = path.resolve("scripts", "validate-release-archive.mjs");

test("release archive validator accepts a normal USTAR payload and rejects link or traversal entries", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ubot-release-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const validPath = path.join(root, "valid.tar.gz");
  writeFileSync(validPath, makeArchive([
    { name: "./", type: "5" },
    { name: "./package.json", contents: Buffer.from('{"name":"ubot"}\n') },
  ]));
  const valid = runValidator(validPath);
  assert.equal(valid.status, 0, valid.stderr);

  const linkPath = path.join(root, "link.tar.gz");
  writeFileSync(linkPath, makeArchive([{ name: "./package.json", type: "2" }]));
  const link = runValidator(linkPath);
  assert.notEqual(link.status, 0);
  assert.match(link.stderr, /unsupported tar entry type/);

  const traversalPath = path.join(root, "traversal.tar.gz");
  writeFileSync(traversalPath, makeArchive([{ name: "../outside", contents: Buffer.from("x") }]));
  const traversal = runValidator(traversalPath);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /unsafe path/);

  const suidPath = path.join(root, "suid.tar.gz");
  writeFileSync(suidPath, makeArchive([{ name: "./bin/unsafe", mode: 0o4755, contents: Buffer.from("x") }]));
  const suid = runValidator(suidPath);
  assert.notEqual(suid.status, 0);
  assert.match(suid.stderr, /unsafe file permissions/);
});

function runValidator(archivePath: string) {
  return spawnSync(process.execPath, [validatorPath, archivePath], { encoding: "utf8" });
}

function makeArchive(entries: Array<{ name: string; type?: string; mode?: number; contents?: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = entry.contents ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
