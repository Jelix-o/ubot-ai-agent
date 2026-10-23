import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SharedDb } from "../shared/sqlite.js";
import { isGeneratedImagePath, isSupportedGeneratedImage } from "./image-generation-service.js";
import {
  IMAGE_PREVIEW_RETENTION_MS,
  createImagePreviewId,
  ImagePreviewRepository,
  isImagePreviewToken,
  type ImagePreviewListArgs,
  type ImagePreviewRecord,
  type ImagePreviewStatus,
} from "./image-preview-repository.js";
import { assertRevision, type MutationGuard } from "./state-mutation.js";

export const IMAGE_PREVIEW_PROMPT_SUMMARY_CHARS = 160;
export const IMAGE_PREVIEW_ORPHAN_MIN_AGE_MS = 15 * 60 * 1_000;

export type ImagePreviewMimeType = "image/png" | "image/jpeg" | "image/webp";

/** Safe for list, bulk-operation and audit paths. It excludes the raw prompt. */
export interface ImagePreviewMetadata {
  id: string;
  groupId: string;
  creatorUserId: string;
  sourceMessageId: string;
  operation?: "generation" | "edit";
  referenceCount?: number;
  parentIds?: string[];
  outputSize?: string;
  outputMessageId?: string;

  promptSummary: string;
  modelId: string;
  model: string;
  fallbackUsed: boolean;
  mimeType: ImagePreviewMimeType;
  byteSize: number;
  status: ImagePreviewStatus;
  createdAt: string;
  expiresAt: string;
  expiredAt?: string;
  deletedAt?: string;
}

/** Returned only by the single-item, authorized detail endpoint. */
export interface ImagePreviewDetail extends ImagePreviewMetadata {
  prompt?: string;
}

export interface ImagePreviewArchiveOptions {
  sharedDb: SharedDb;
  /** Private directory for retained image copies. It must never be web served. */
  rootDir: string;
  /** Managed temporary image directory that generation writes before QQ delivery. */
  stagedRoot: string;
  now?: () => number;
}

export interface ImagePreviewArchiveInput {
  groupId: string;
  creatorUserId: string;
  sourceMessageId: string;
  operation?: "generation" | "edit";
  referenceCount?: number;
  parentIds?: string[];
  outputSize?: string;

  prompt: string;
  filePath: string;
  modelId: string;
  model: string;
  fallbackUsed: boolean;
  mimeType: ImagePreviewMimeType;
  byteSize: number;
  now?: number;
  expiresAt?: number;
}

/**
 * Stores a private, verified copy of a worker-staged image. Metadata is
 * durable in SQLite, while raw image bytes remain outside the web root.
 */
export class ImagePreviewArchiveService {
  readonly repository: ImagePreviewRepository;
  private readonly rootDir: string;
  private readonly stagedRoot: string;
  private readonly now: () => number;

  constructor(options: ImagePreviewArchiveOptions) {
    this.repository = new ImagePreviewRepository(options.sharedDb);
    this.rootDir = path.resolve(options.rootDir);
    this.stagedRoot = path.resolve(options.stagedRoot);
    this.now = options.now ?? Date.now;
  }

  /**
   * Archive before handing the staged path to ingress. A copy failure does not
   * alter the source, allowing the caller to continue normal QQ delivery.
   */
  async archive(input: ImagePreviewArchiveInput): Promise<ImagePreviewMetadata> {
    const now = input.now ?? this.now();
    const source = this.stagedPath(input.filePath);
    const prompt = normalizePrompt(input.prompt);
    const declaredMime = normalizeMimeType(input.mimeType);
    const declaredByteSize = normalizeByteSize(input.byteSize);
    const expiresAt = normalizeExpiresAt(input.expiresAt, now);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new ImagePreviewArchiveError("image_preview_source_unsafe");
    }
    if (sourceInfo.size !== declaredByteSize) {
      throw new ImagePreviewArchiveError("image_preview_source_size_mismatch");
    }
    const bytes = await readFile(source);
    if (bytes.byteLength !== declaredByteSize) {
      throw new ImagePreviewArchiveError("image_preview_source_size_mismatch");
    }
    const detected = detectImageType(bytes);
    if (!detected || !isSupportedGeneratedImage(bytes) || detected.mimeType !== declaredMime) {
      throw new ImagePreviewArchiveError("image_preview_source_type_invalid");
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const id = createImagePreviewId();
    try {
      await this.writeImageFile(id, bytes, detected.extension);
      const metadata = this.repository.create({
        id,
        groupId: input.groupId,
        creatorUserId: input.creatorUserId,
        sourceMessageId: input.sourceMessageId,
        prompt,
        promptSummary: summarizePrompt(prompt),
        modelId: input.modelId,
        model: input.model,
        fallbackUsed: Boolean(input.fallbackUsed),
        mimeType: declaredMime,
        byteSize: declaredByteSize,
        contentSha256,
        now,
        operation: input.operation, referenceCount: input.referenceCount,
        parentIds: input.parentIds, outputSize: input.outputSize,
        expiresAt,
      });
      return toMetadata(metadata, now);
    } catch (error) {
      await this.removeImageFileById(id, declaredMime).catch(() => undefined);
      if (error instanceof Error && error.message === "image_preview_source_conflict") {
        const existing = this.repository.getBySource(input.groupId.trim(), input.sourceMessageId.trim());
        if (existing) return toMetadata(existing, now);
      }
      throw error;
    }
  }

  async resolveReference(groupId: string, messageId: string): Promise<{ previewId: string; data: Buffer; mimeType: ImagePreviewMimeType } | undefined> {
    const record = this.repository.getByOutput(groupId, messageId);
    if (!record) return undefined;
    const image = await this.loadImage(record.id);
    if (!image) throw new ImagePreviewArchiveError("image_preview_reference_unavailable");
    return { previewId: record.id, data: image.data, mimeType: image.mimeType };
  }

  get(id: string): Promise<ImagePreviewMetadata | undefined> {
    const record = this.repository.get(id);
    return Promise.resolve(record ? toMetadata(record, this.now()) : undefined);
  }

  getDetail(id: string): Promise<ImagePreviewDetail | undefined> {
    const record = this.repository.get(id);
    const now = this.now();
    if (!record || effectiveStatus(record, now) !== "available") return Promise.resolve(undefined);
    return Promise.resolve(toDetail(record, now));
  }

  listPage(args: ImagePreviewListArgs = {}): Promise<{
    items: ImagePreviewMetadata[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const now = this.now();
    const page = this.repository.listPage({ ...args, now });
    return Promise.resolve({ ...page, items: page.items.map(record => toMetadata(record, now)) });
  }

  /** Loads bytes only after the caller checks both group authorization and status. */
  async loadImage(id: string): Promise<{ data: Buffer; mimeType: ImagePreviewMimeType; byteSize: number } | undefined> {
    const record = this.repository.get(id);
    if (!record || record.status !== "available" || record.expiresAt <= this.now()) return undefined;
    const target = this.imagePath(record.id, extensionForMime(record.mimeType));
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== record.byteSize) return undefined;
      const data = await readFile(target);
      if (createHash("sha256").update(data).digest("hex") !== record.contentSha256) return undefined;
      const detected = detectImageType(data);
      if (!detected || detected.mimeType !== record.mimeType) return undefined;
      return { data, mimeType: record.mimeType, byteSize: record.byteSize };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Makes the metadata terminal before best-effort byte removal. A filesystem
   * fault must never keep a private prompt readable; hourly cleanup retries
   * the private-byte removal for terminal records.
   */
  async remove(id: string, now = this.now(), guard?: MutationGuard): Promise<boolean> {
    const record = this.repository.get(id);
    if (!record || record.status === "deleted") return false;
    assertRevision(toMetadata(record, now), guard);
    const removed = this.repository.runAtomically(() => {
      const current = this.repository.get(id);
      assertRevision(current ? toMetadata(current, now) : undefined, guard);
      const removed = this.repository.markDeleted(record.id, now);
      if (removed) guard?.committed?.();
      return removed;
    });
    if (removed) await this.removeImageFile(record).catch(() => undefined);
    return removed;
  }

  /** Removes expired images and stale unknown files without exposing private paths. */
  async cleanup(now = this.now()): Promise<{ expired: number; temp: number; orphans: number }> {
    await this.ensureStorageReady();
    let expired = 0;
    const purgeCandidates = new Map<string, ImagePreviewRecord>();
    for (const record of this.repository.listExpired(now)) {
      // Clear prompt metadata before byte removal. The record is no longer
      // readable through the API even if a damaged private path needs a retry.
      if (this.repository.markExpired(record.id, now)) expired += 1;
      purgeCandidates.set(record.id, record);
    }
    for (const record of this.repository.listTerminal()) purgeCandidates.set(record.id, record);
    for (const record of purgeCandidates.values()) {
      await this.removeImageFile(record).catch(() => undefined);
    }
    const knownIds = new Set(this.repository.listIds());
    let temp = 0;
    let orphans = 0;
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      const candidate = path.resolve(this.rootDir, entry.name);
      if (path.dirname(candidate) !== this.rootDir) continue;
      try {
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink() || now - info.mtimeMs < IMAGE_PREVIEW_ORPHAN_MIN_AGE_MS) continue;
        if (isImagePreviewTemporaryFileName(entry.name)) {
          await rm(candidate, { force: true });
          temp += 1;
          continue;
        }
        if (!isImagePreviewFileName(entry.name)) continue;
        const id = entry.name.slice(0, IMAGE_PREVIEW_ID_PREFIX_LENGTH);
        if (knownIds.has(id)) continue;
        await rm(candidate, { force: true });
        orphans += 1;
      } catch {
        // A concurrent archive can own this path; cleanup remains best effort.
      }
    }
    return { expired, temp, orphans };
  }

  private async ensureStorageReady(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700).catch(() => undefined);
  }

  private stagedPath(filePath: string): string {
    if (!isGeneratedImagePath(this.stagedRoot, filePath)) {
      throw new ImagePreviewArchiveError("image_preview_source_path_invalid");
    }
    return path.resolve(filePath);
  }

  private imagePath(id: string, extension: string): string {
    if (!isImagePreviewToken(id)) throw new ImagePreviewArchiveError("image_preview_id_invalid");
    const target = path.resolve(this.rootDir, `${id}.${extension}`);
    if (path.dirname(target) !== this.rootDir) throw new ImagePreviewArchiveError("image_preview_path_unsafe");
    return target;
  }

  private async writeImageFile(id: string, data: Buffer, extension: string): Promise<void> {
    await this.ensureStorageReady();
    const finalPath = this.imagePath(id, extension);
    const temporaryPath = this.temporaryPath(id);
    try {
      // Avoid writing directly into the final name so an admin request never
      // observes a partial image after the metadata transaction completes.
      await writePrivateFile(temporaryPath, data);
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async removeImageFile(record: ImagePreviewRecord): Promise<void> {
    await this.removeImageFileById(record.id, record.mimeType);
  }

  private async removeImageFileById(id: string, mimeType: ImagePreviewMimeType): Promise<void> {
    const image = this.imagePath(id, extensionForMime(mimeType));
    try {
      const info = await lstat(image);
      if (info.isSymbolicLink()) {
        await rm(image, { force: true });
        return;
      }
      if (!info.isFile()) throw new ImagePreviewArchiveError("image_preview_path_unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(image, { force: true });
  }

  private temporaryPath(id: string): string {
    if (!isImagePreviewToken(id)) throw new ImagePreviewArchiveError("image_preview_id_invalid");
    const target = path.resolve(this.rootDir, `.${id}.${randomSuffix()}.tmp`);
    if (path.dirname(target) !== this.rootDir) throw new ImagePreviewArchiveError("image_preview_path_unsafe");
    return target;
  }
}

export class ImagePreviewArchiveError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ImagePreviewArchiveError";
  }
}

const IMAGE_PREVIEW_ID_PREFIX_LENGTH = 43;

function toMetadata(record: ImagePreviewRecord, now = Date.now()): ImagePreviewMetadata {
  const status = effectiveStatus(record, now);
  return {
    id: record.id,
    groupId: record.groupId,
    creatorUserId: record.creatorUserId,
    sourceMessageId: record.sourceMessageId,
    operation: record.operation, referenceCount: record.referenceCount,
    parentIds: record.parentIds, outputSize: record.outputSize,
    outputMessageId: record.outputMessageId,
    promptSummary: status === "available" ? record.promptSummary : "",
    modelId: record.modelId,
    model: record.model,
    fallbackUsed: record.fallbackUsed,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    status,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    ...(record.expiredAt === undefined ? {} : { expiredAt: new Date(record.expiredAt).toISOString() }),
    ...(record.deletedAt === undefined ? {} : { deletedAt: new Date(record.deletedAt).toISOString() }),
  };
}

function toDetail(record: ImagePreviewRecord, now = Date.now()): ImagePreviewDetail {
  const metadata = toMetadata(record, now);
  return {
    ...metadata,
    ...(metadata.status === "available" && record.prompt !== undefined ? { prompt: record.prompt } : {}),
  };
}

function effectiveStatus(record: ImagePreviewRecord, now: number): ImagePreviewStatus {
  return record.status === "available" && record.expiresAt <= now ? "expired" : record.status;
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || Array.from(prompt).length > 5_000) throw new ImagePreviewArchiveError("image_preview_prompt_invalid");
  return prompt;
}

function summarizePrompt(prompt: string): string {
  return Array.from(prompt).slice(0, IMAGE_PREVIEW_PROMPT_SUMMARY_CHARS).join("");
}

function normalizeByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 20 * 1024 * 1024) {
    throw new ImagePreviewArchiveError("image_preview_byte_size_invalid");
  }
  return value;
}

function normalizeExpiresAt(value: number | undefined, now: number): number {
  const maximum = now + IMAGE_PREVIEW_RETENTION_MS;
  const expiresAt = value ?? maximum;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > maximum) {
    throw new ImagePreviewArchiveError("image_preview_expiry_invalid");
  }
  return expiresAt;
}

function normalizeMimeType(value: string): ImagePreviewMimeType {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
  throw new ImagePreviewArchiveError("image_preview_mime_type_invalid");
}

function extensionForMime(mimeType: ImagePreviewMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

function detectImageType(data: Buffer): { mimeType: ImagePreviewMimeType; extension: "png" | "jpg" | "webp" } | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

function isImagePreviewFileName(name: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${IMAGE_PREVIEW_ID_PREFIX_LENGTH}}\\.(?:png|jpg|webp)$`).test(name);
}

function isImagePreviewTemporaryFileName(name: string): boolean {
  return new RegExp(`^\\.[A-Za-z0-9_-]{${IMAGE_PREVIEW_ID_PREFIX_LENGTH}}\\.[a-z0-9-]+\\.tmp$`, "i").test(name);
}

function randomSuffix(): string {
  return `${process.pid}-${randomBytes(8).toString("hex")}`;
}

async function writePrivateFile(filePath: string, data: Buffer): Promise<void> {
  // `copyFile` is intentionally not used here: the verified bytes are already
  // in memory and a new 0600 file avoids inheriting an unsafe source mode.
  await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}
