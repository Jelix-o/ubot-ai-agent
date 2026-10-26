import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MemeLibraryService } from "./meme-library-service.js";

export const PRESET_MEME_PACKS = [
  { id: "blue-fat-fish-meme-pack", name: "蓝色大肥鱼", version: "1.0.0", ref: "0bbf1c546135ad55e6049241922a90fcb5332777", count: 157 },
  { id: "deepseek-fanart-meme-pack", name: "DeepSeek 二创", version: "1.0.0", ref: "86841e222b1c26a3d4d307e7224963e8a271f9e9", count: 174 },
] as const;

export type MemePackImportResult = { packId: string; imported: number; skipped: number; failed: Array<{ path: string; error: string }> };
type Fetcher = typeof fetch;
export interface MemePackInventory {
  id: string; ref: string;
  manifest: { id: string; version: string; categories: Record<string, { description: string }>; license?: string };
  files: Array<{ path: string; sha: string; size: number }>;
}

async function fetchBytes(url: string, maxBytes: number, fetcher: Fetcher): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "UBot-meme-import" } });
  if (!response.ok) throw new Error(`download_http_${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("meme_image_size_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("download_empty");
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) { throw new Error("meme_image_size_invalid"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Downloads only two pinned, reviewed sources; never executes a third-party importer. */
export async function importMemePack(
  library: Pick<MemeLibraryService, "listTags" | "createTag" | "listAssets" | "uploadAsset">,
  packId: string,
  progress: (percent: number, detail: string) => Promise<unknown> = async () => undefined,
  fetcher: Fetcher = fetch,
  inventoryOverride?: MemePackInventory,
): Promise<MemePackImportResult> {
  const pack = PRESET_MEME_PACKS.find(item => item.id === packId);
  if (!pack) throw new Error("meme_pack_unknown");
  const base = `https://raw.githubusercontent.com/anka-afk/${pack.id}/${pack.ref}`;
  const inventory = inventoryOverride ?? (JSON.parse(await readFile(new URL("../../assets/meme-pack-index.json", import.meta.url), "utf8")) as { packs: MemePackInventory[] }).packs.find(item => item.id === pack.id);
  if (!inventory || inventory.id !== pack.id || inventory.ref !== pack.ref) throw new Error("meme_pack_source_invalid");
  const { manifest, files } = inventory;
  if (manifest.id !== pack.id || !manifest.categories || typeof manifest.categories !== "object") throw new Error("meme_pack_manifest_invalid");
  if (manifest.version !== pack.version || files.length !== pack.count || new Set(files.map(file => file.path)).size !== files.length || files.some(file => !/^memes\/[a-z][a-z0-9-]*\/[^/]+\.(gif|png|jpe?g|webp)$/i.test(file.path) || !/^[a-f0-9]{40}$/.test(file.sha) || file.size <= 0 || file.size > 10 * 1024 * 1024)) throw new Error("meme_pack_file_count_invalid");
  const tags = await library.listTags();
  const categories = new Map<string, string>();
  for (const [name, category] of Object.entries(manifest.categories)) {
    const existing = tags.find(tag => tag.name === name);
    const tag = existing ?? await library.createTag({ name, description: String(category.description ?? "").slice(0, 2000), keywords: [name] });
    if (!tag) throw new Error("meme_library_unavailable");
    categories.set(name, tag.id);
  }
  const assets = await library.listAssets();
  const result: MemePackImportResult = { packId, imported: 0, skipped: 0, failed: [] };
  let next = 0, completed = 0;
  await progress(0, `${pack.name} 准备下载 ${files.length} 张`);
  await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < files.length) {
    const file = files[next++]!;
    try {
      const existing = assets.find(asset => asset.packId === packId && asset.sourcePath === file.path && asset.sourceRef === pack.ref);
      if (existing && await (library as Partial<MemeLibraryService>).readAssetBytes?.(existing.id)) {
        result.skipped++;
      } else {
        const data = await fetchBytes(`${base}/${file.path.split("/").map(encodeURIComponent).join("/")}`, 10 * 1024 * 1024, fetcher);
        // Verify the immutable Git blob, including its length-prefixed header.
        const blobHash = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
        if (blobHash !== file.sha || data.length !== file.size) throw new Error("meme_pack_hash_mismatch");
        const tagId = categories.get(file.path.split("/")[1]!);
        if (!tagId) throw new Error("meme_pack_category_invalid");
        const uploaded = await library.uploadAsset({ name: file.path.split("/").at(-1)!, scope: "normal_chat", tags: [tagId], data,
          packId, sourcePath: file.path, sourceRef: pack.ref, sourceLicense: manifest.license ?? "原素材许可未指定" });
        if (!uploaded) throw new Error("meme_library_unavailable");
        result.imported++;
      }
    } catch (error) {
      result.failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
    }
    completed++;
    await progress(Math.floor(completed / files.length * 100), `${pack.name} ${completed}/${files.length}，失败 ${result.failed.length}`);
  }
  }));
  return result;
}
