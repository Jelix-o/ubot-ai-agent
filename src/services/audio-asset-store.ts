import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { V3StateRepository } from "./v3-state-repository.js";
import { isMp3Audio, type GeneratedAudio } from "./seed-audio-provider.js";

interface AudioAsset { id: string; groupId: string; size: number; sha256: string; duration: number; createdAt: number; deliveredAt?: number }
export class AudioAssetStore {
  constructor(private readonly root: string, private readonly repo: V3StateRepository) {}
  private file(id: string): string {
    if (!/^audio-[a-f0-9]{32}$/.test(id)) throw new Error("invalid_audio_asset");
    return path.join(this.root, `${id}.mp3`);
  }
  async save(id: string, groupId: string, audio: GeneratedAudio): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = this.file(id), temporary = `${file}.tmp`;
    await writeFile(temporary, audio.bytes, { mode: 0o600, flag: "wx" });
    try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
    this.repo.saveDocument("audio-asset", id, { id, groupId, size: audio.bytes.length, sha256: createHash("sha256").update(audio.bytes).digest("hex"), duration: audio.duration, createdAt: Date.now() } satisfies AudioAsset);
  }
  async load(id: string, groupId: string): Promise<Buffer> {
    const asset = this.repo.getDocument<AudioAsset | null>("audio-asset", id, null);
    if (!asset || asset.groupId !== groupId || asset.deliveredAt || Date.now() - asset.createdAt > 86_400_000) throw new Error("audio_asset_unavailable");
    const file = this.file(id), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size || info.size > 10*1024*1024 || info.size < 4 || path.dirname(await realpath(file)) !== await realpath(this.root)) throw new Error("audio_asset_invalid");
    const bytes = await readFile(file);
    if (!isMp3Audio(bytes) || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("audio_asset_invalid");
    return bytes;
  }
  async acknowledge(id: string): Promise<void> {
    const asset = this.repo.getDocument<AudioAsset | null>("audio-asset", id, null);
    if (asset) this.repo.saveDocument("audio-asset", id, { ...asset, deliveredAt: Date.now() });
    await rm(this.file(id), { force: true });
  }
  async cleanup(now = Date.now()): Promise<void> {
    for (const doc of this.repo.listDocuments<AudioAsset>("audio-asset")) {
      if (doc.value.deliveredAt || now - doc.value.createdAt > 86_400_000) {
        await rm(this.file(doc.key), { force: true });
        if (now - doc.value.createdAt > 86_400_000) this.repo.deleteDocument("audio-asset", doc.key);
      }
    }
  }
}
