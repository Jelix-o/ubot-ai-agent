import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { importMemePack, PRESET_MEME_PACKS, type MemePackInventory } from "./meme-pack-import-service.js";
import type { MemeAsset, MemeTag } from "./meme-library-service.js";

test("bundled inventory pins all 331 source blobs and includes the eight GIFs above 5 MiB", async () => {
  const index = JSON.parse(await readFile(new URL("../../assets/meme-pack-index.json", import.meta.url), "utf8")) as { packs: MemePackInventory[] };
  let large = 0;
  for (const pack of PRESET_MEME_PACKS) {
    const source = index.packs.find(item => item.id === pack.id)!;
    assert.equal(source.ref, pack.ref);
    assert.equal(source.files.length, pack.count);
    assert.equal(source.manifest.version, pack.version);
    assert.equal(new Set(source.files.map(file => file.path)).size, pack.count);
    assert.ok(source.files.every(file => /^[a-f0-9]{40}$/.test(file.sha) && file.size <= 10 * 1024 * 1024));
    large += source.files.filter(file => file.size > 5 * 1024 * 1024).length;
  }
  assert.equal(large, 8);
});

test("import reports each failed file, verifies hashes and retries only missing files", async () => {
  const pack = PRESET_MEME_PACKS[0];
  const data = Buffer.from("GIF89a-fixture");
  const sha = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  const inventory: MemePackInventory = { id: pack.id, ref: pack.ref, manifest: { id: pack.id, version: pack.version, categories: { happy: { description: "开心" } } }, files: Array.from({ length: pack.count }, (_, n) => ({ path: `memes/happy/${n}.gif`, sha, size: data.length })) };
  const assets: MemeAsset[] = [];
  let requests = 0, fail = true;
  const library = {
    async listTags() { return [] as MemeTag[]; },
    async createTag() { return { id: "happy-tag" } as MemeTag; },
    async listAssets() { return assets; },
    async uploadAsset(input: { sourcePath?: string }) { const asset = { id: input.sourcePath, packId: pack.id, sourcePath: input.sourcePath, sourceRef: pack.ref } as MemeAsset; assets.push(asset); return asset; },
    async readAssetBytes() { return { data, asset: {} as MemeAsset }; },
  };
  const fetcher: typeof fetch = async url => { requests++; return new Response(fail && String(url).endsWith("/1.gif") ? "invalid" : data); };
  let last = -1;
  const first = await importMemePack(library, pack.id, async percent => { assert.ok(percent >= last); last = percent; }, fetcher, inventory);
  assert.equal(first.imported, 156);
  assert.deepEqual(first.failed, [{ path: "memes/happy/1.gif", error: "meme_pack_hash_mismatch" }]);
  fail = false;
  requests = 0;
  const second = await importMemePack(library, pack.id, undefined, fetcher, inventory);
  assert.equal(second.imported, 1);
  assert.equal(second.skipped, 156);
  assert.equal(second.failed.length, 0);
  assert.equal(requests, 1);
  await assert.rejects(() => importMemePack(library, "arbitrary-repository"), /meme_pack_unknown/);
});
