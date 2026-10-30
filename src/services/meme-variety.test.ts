import test from "node:test";
import assert from "node:assert/strict";
import { appendMemeUse, pickVariedMeme, resolveMemeCategory, type MemeUse } from "./meme-variety.js";
import type { MemeAsset } from "./meme-library-service.js";

const asset = (id: string, packId: string, sha256 = id) => ({ id, packId, sha256 }) as MemeAsset;

test("variety balances uneven packs and exhausts fresh content before repeating", () => {
  const pool = [asset("a", "blue"), asset("b", "blue"), asset("c", "blue"), asset("d", "fan")];
  let history: MemeUse[] = [];
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const chosen = pickVariedMeme(pool, history, () => 0)!;
    seen.push(chosen.id); history = appendMemeUse(history, chosen);
  }
  assert.equal(seen[1], "d");
  assert.equal(new Set(seen).size, 4);
  assert.equal(pickVariedMeme(pool, history, () => 0)?.id, seen[0]);
  assert.equal(pickVariedMeme([pool[0]!], history, () => 0)?.id, "a");
  assert.equal(pickVariedMeme([], history, () => 0), undefined);
});

test("variety avoids duplicate bytes across packs and all ten recent images", () => {
  const pool = Array.from({ length: 12 }, (_, i) => asset(String(i), i % 2 ? "blue" : "fan"));
  const history = pool.slice(0, 10).map(a => ({ assetId: a.id, sha256: a.sha256, packId: a.packId! }));
  assert.ok(["10", "11"].includes(pickVariedMeme([...pool, asset("copy", "local", "0")], history, () => 0)!.id));
  assert.equal(appendMemeUse(history, pool[11]!).length, 10);
});

test("Chinese aliases preserve administrator-defined labels and ids", () => {
  const work = { id: "work-id", name: "work" };
  assert.equal(resolveMemeCategory([work], "摸鱼"), work);
  assert.equal(resolveMemeCategory([work], "WORK"), work);
  const custom = { id: "custom", name: "摸鱼" };
  assert.equal(resolveMemeCategory([work, custom], "摸鱼"), custom);
  assert.equal(resolveMemeCategory([work], "不存在"), undefined);
});
