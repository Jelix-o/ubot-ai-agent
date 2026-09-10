import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { V3StateRepository } from "./v3-state-repository.js";

export const MEME_LIBRARY_DOCUMENT_TYPE = "meme-library";
export const MEME_LIBRARY_DOCUMENT_KEY = "default";
export const MEME_LIBRARY_TAG_DOCUMENT_TYPE = "meme-library-tags";
export const MEME_LIBRARY_TAG_DOCUMENT_KEY = "default";
export const MEME_LIBRARY_ASSET_DOCUMENT_TYPE = "meme-library-assets";
export const MEME_LIBRARY_ASSET_DOCUMENT_KEY = "default";
export const MEME_LIBRARY_COOLDOWN_DOCUMENT_TYPE = "meme-library-cooldown";
export const MEME_LIBRARY_BLACKLISTED_SELECTION_DOCUMENT_TYPE = "meme-library-blacklisted-selection";
export const MEME_LIBRARY_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const BLACKLISTED_AT_MEME_SEED_ID = "blacklisted-at-meme-seed";

export type MemeScope = "normal_chat" | "blacklisted_at";

export interface MemeLibraryPolicy {
  enabled: boolean;
  probabilityPercent: number;
  cooldownSeconds: number;
}

export interface MemeTag {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemeAsset {
  id: string;
  name: string;
  scope: MemeScope;
  enabled: boolean;
  tags: string[];
  mimeType: MemeImageMimeType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  protected: boolean;
}

export type MemeImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface MemeImageSelection {
  asset: MemeAsset;
  /** OneBot 11 `image.file` payload (`base64://...`). */
  imageFile: string;
}

export interface MemeLibraryUploadInput {
  name: string;
  scope: MemeScope;
  tags?: string[];
  data: Buffer;
  enabled?: boolean;
}

export interface MemeLibraryAssetPatch {
  name?: string;
  enabled?: boolean;
  tags?: string[];
}

export interface MemeLibraryTagInput {
  name: string;
  description?: string;
  keywords: string[];
}

export interface MemeLibraryTagPatch {
  name?: string;
  description?: string;
  keywords?: string[];
}

export interface MemeLibraryOptions {
  /** Overrides the bundled blacklist seed for tests or a custom release build. */
  seedAssetPath?: string;
  now?: () => number;
  random?: () => number;
}

interface MemeLibraryDocument {
  policy: MemeLibraryPolicy;
}

interface MemeTagDocument {
  tags: MemeTag[];
}

interface MemeAssetDocument {
  assets: MemeAsset[];
}

interface MemeCooldownDocument {
  lastSentAt: number;
  lastAssetId?: string;
}

interface MemeLastSelectionDocument {
  lastAssetId?: string;
}

interface LoadedMemeAsset {
  asset: MemeAsset;
  imageFile: string;
}

export type MemeNormalChatImageClaimReason =
  | "sent_candidate"
  | "no_match"
  | "policy_disabled"
  | "probability_miss"
  | "cooldown"
  | "asset_unavailable";

/**
 * Contains only library metadata, never the source chat text. Callers can
 * safely log `reason` and `matchedTagIds` for configuration diagnostics.
 */
export interface MemeNormalChatImageClaim {
  reason: MemeNormalChatImageClaimReason;
  matchedTagIds: string[];
  selection?: MemeImageSelection;
}

export const DEFAULT_MEME_LIBRARY_POLICY: MemeLibraryPolicy = Object.freeze({
  enabled: true,
  probabilityPercent: 30,
  cooldownSeconds: 600,
});

const DEFAULT_LIBRARY_DOCUMENT: MemeLibraryDocument = { policy: DEFAULT_MEME_LIBRARY_POLICY };
const DEFAULT_TAG_DOCUMENT: MemeTagDocument = { tags: [] };
const DEFAULT_ASSET_DOCUMENT: MemeAssetDocument = { assets: [] };
const DEFAULT_COOLDOWN_DOCUMENT: MemeCooldownDocument = { lastSentAt: 0 };
const DEFAULT_LAST_SELECTION_DOCUMENT: MemeLastSelectionDocument = {};
const BUNDLED_BLACKLISTED_AT_MEME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "blacklisted-at-meme.jpg",
);

const MIME_EXTENSIONS: Record<MemeImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export class MemeLibraryValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "MemeLibraryValidationError";
  }
}

/**
 * Global image library backed by V3 documents and an adjacent persistent file
 * directory. The service intentionally has no legacy JSON fallback: without
 * V3, callers receive empty reads/selections and can keep their primary flow.
 */
export class MemeLibraryService {
  private readonly seedAssetPath: string;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly dataDir: string,
    private readonly v3State?: V3StateRepository,
    options: MemeLibraryOptions = {},
  ) {
    this.seedAssetPath = options.seedAssetPath ?? BUNDLED_BLACKLISTED_AT_MEME_PATH;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  getStorageDirectory(): string {
    return path.resolve(this.dataDir, "meme-library");
  }

  isAvailable(): boolean {
    return Boolean(this.repository());
  }

  /** Idempotently installs the release-provided protected blacklist meme. */
  async initialize(): Promise<void> {
    const repository = this.repository();
    if (!repository) return;

    const seedData = await readFile(this.seedAssetPath);
    const detected = validateMemeImage(seedData);
    const now = this.now();
    const timestamp = toIso(now);
    const seed: MemeAsset = {
      id: BLACKLISTED_AT_MEME_SEED_ID,
      name: "黑名单@表情包",
      scope: "blacklisted_at",
      enabled: true,
      tags: [],
      mimeType: detected.mimeType,
      sizeBytes: seedData.length,
      sha256: sha256(seedData),
      createdAt: timestamp,
      updatedAt: timestamp,
      protected: true,
    };

    await this.writeAssetFile(seed, seedData);
    repository.runAtomically(() => {
      const tags = this.readTagDocument(repository);
      const assets = this.readAssetDocument(repository);
      migrateLegacyNormalChatAssets(assets, tags, now);

      const existing = assets.assets.findIndex((asset) => asset.id === BLACKLISTED_AT_MEME_SEED_ID);
      if (existing >= 0) {
        const previous = assets.assets[existing]!;
        assets.assets[existing] = {
          ...seed,
          createdAt: previous.createdAt || timestamp,
        };
      } else {
        assets.assets.push(seed);
      }

      // Persist normalised legacy tag metadata and any automatically assigned
      // normal-chat tag bindings together, so a restart cannot see half of
      // the compatibility upgrade.
      repository.updateDocument<MemeTagDocument>(
        MEME_LIBRARY_TAG_DOCUMENT_TYPE,
        MEME_LIBRARY_TAG_DOCUMENT_KEY,
        DEFAULT_TAG_DOCUMENT,
        () => tags,
        now,
      );
      repository.updateDocument<MemeAssetDocument>(
        MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
        MEME_LIBRARY_ASSET_DOCUMENT_KEY,
        DEFAULT_ASSET_DOCUMENT,
        () => assets,
        now,
      );
    });
  }

  async getPolicy(): Promise<MemeLibraryPolicy> {
    const repository = this.repository();
    return repository ? clonePolicy(this.readLibraryDocument(repository).policy) : clonePolicy(DEFAULT_MEME_LIBRARY_POLICY);
  }

  async updatePolicy(patch: Partial<MemeLibraryPolicy>): Promise<MemeLibraryPolicy> {
    const repository = this.repository();
    if (!repository) return clonePolicy(DEFAULT_MEME_LIBRARY_POLICY);
    validatePolicyPatch(patch);
    let result = clonePolicy(DEFAULT_MEME_LIBRARY_POLICY);
    repository.updateDocument<MemeLibraryDocument>(
      MEME_LIBRARY_DOCUMENT_TYPE,
      MEME_LIBRARY_DOCUMENT_KEY,
      DEFAULT_LIBRARY_DOCUMENT,
      (current) => {
        const document = normalizeLibraryDocument(current);
        result = normalizePolicy({ ...document.policy, ...patch });
        return { policy: result };
      },
      this.now(),
    );
    return clonePolicy(result);
  }

  async listTags(): Promise<MemeTag[]> {
    const repository = this.repository();
    if (!repository) return [];
    return this.readTagDocument(repository).tags
      .sort(compareTags)
      .map(cloneTag);
  }

  async createTag(input: MemeLibraryTagInput): Promise<MemeTag | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const now = this.now();
    const tag: MemeTag = {
      id: randomUUID(),
      name: normalizeTagName(input.name),
      description: normalizeTagDescription(input.description),
      keywords: normalizeTagKeywords(input.keywords),
      createdAt: toIso(now),
      updatedAt: toIso(now),
    };
    let created: MemeTag | undefined;
    repository.updateDocument<MemeTagDocument>(
      MEME_LIBRARY_TAG_DOCUMENT_TYPE,
      MEME_LIBRARY_TAG_DOCUMENT_KEY,
      DEFAULT_TAG_DOCUMENT,
      (current) => {
        const document = normalizeTagDocument(current);
        if (document.tags.some((candidate) => tagNameKey(candidate.name) === tagNameKey(tag.name))) {
          throw new MemeLibraryValidationError("meme_tag_name_conflict");
        }
        document.tags.push(tag);
        created = tag;
        return document;
      },
      now,
    );
    return created ? cloneTag(created) : undefined;
  }

  async updateTag(id: string, patch: MemeLibraryTagPatch): Promise<MemeTag | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const tagId = normalizeId(id, "meme_tag_id_invalid");
    validateTagPatch(patch);
    const now = this.now();
    let updated: MemeTag | undefined;
    repository.updateDocument<MemeTagDocument>(
      MEME_LIBRARY_TAG_DOCUMENT_TYPE,
      MEME_LIBRARY_TAG_DOCUMENT_KEY,
      DEFAULT_TAG_DOCUMENT,
      (current) => {
        const document = normalizeTagDocument(current);
        const index = document.tags.findIndex((candidate) => candidate.id === tagId);
        if (index < 0) return document;
        const previous = document.tags[index]!;
        const name = patch.name === undefined ? previous.name : normalizeTagName(patch.name);
        if (document.tags.some((candidate) => candidate.id !== tagId && tagNameKey(candidate.name) === tagNameKey(name))) {
          throw new MemeLibraryValidationError("meme_tag_name_conflict");
        }
        updated = {
          ...previous,
          name,
          description: patch.description === undefined ? previous.description : normalizeTagDescription(patch.description),
          keywords: patch.keywords === undefined ? previous.keywords : normalizeTagKeywords(patch.keywords),
          updatedAt: toIso(now),
        };
        document.tags[index] = updated;
        return document;
      },
      now,
    );
    return updated ? cloneTag(updated) : undefined;
  }

  async removeTag(id: string): Promise<boolean> {
    const repository = this.repository();
    if (!repository) return false;
    const tagId = normalizeId(id, "meme_tag_id_invalid");
    const now = this.now();
    let removed = false;
    repository.runAtomically(() => {
      const tags = this.readTagDocument(repository);
      if (!tags.tags.some((tag) => tag.id === tagId)) return;
      const referenced = this.readAssetDocument(repository).assets.some((asset) => (
        asset.scope === "normal_chat" && asset.tags.includes(tagId)
      ));
      if (referenced) {
        throw new MemeLibraryValidationError("meme_tag_in_use");
      }
      repository.updateDocument<MemeTagDocument>(
        MEME_LIBRARY_TAG_DOCUMENT_TYPE,
        MEME_LIBRARY_TAG_DOCUMENT_KEY,
        DEFAULT_TAG_DOCUMENT,
        () => ({ tags: tags.tags.filter((tag) => tag.id !== tagId) }),
        now,
      );
      removed = true;
    });
    return removed;
  }

  async listAssets(scope?: MemeScope): Promise<MemeAsset[]> {
    const repository = this.repository();
    if (!repository) return [];
    const normalizedScope = scope === undefined ? undefined : normalizeScope(scope);
    return this.readAssetDocument(repository).assets
      .filter((asset) => !normalizedScope || asset.scope === normalizedScope)
      .sort(compareAssetsNewestFirst)
      .map(cloneAsset);
  }

  async getAsset(id: string): Promise<MemeAsset | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const assetId = normalizeId(id, "meme_asset_id_invalid");
    const asset = this.readAssetDocument(repository).assets.find((candidate) => candidate.id === assetId);
    return asset ? cloneAsset(asset) : undefined;
  }

  async uploadAsset(input: MemeLibraryUploadInput): Promise<MemeAsset | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const scope = normalizeScope(input.scope);
    const name = normalizeAssetName(input.name);
    const detected = validateMemeImage(input.data);
    const tags = scope === "normal_chat" ? normalizeTagIds(input.tags) : [];
    if (scope === "normal_chat" && tags.length === 0) {
      throw new MemeLibraryValidationError("meme_asset_tags_required");
    }
    const now = this.now();
    const asset: MemeAsset = {
      id: randomUUID(),
      name,
      scope,
      enabled: input.enabled !== false,
      tags,
      mimeType: detected.mimeType,
      sizeBytes: input.data.length,
      sha256: sha256(input.data),
      createdAt: toIso(now),
      updatedAt: toIso(now),
      protected: false,
    };
    await this.writeAssetFile(asset, input.data);
    try {
      // Tags and assets live in separate documents. Keep their validation and
      // write in one immediate transaction so an admin-side tag deletion
      // cannot leave a newly uploaded asset pointing at a removed tag.
      repository.runAtomically(() => {
        ensureKnownTags(tags, this.readTagDocument(repository).tags);
        repository.updateDocument<MemeAssetDocument>(
          MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
          MEME_LIBRARY_ASSET_DOCUMENT_KEY,
          DEFAULT_ASSET_DOCUMENT,
          (current) => {
            const document = normalizeAssetDocument(current);
            document.assets.push(asset);
            return document;
          },
          now,
        );
      });
    } catch (error) {
      await rm(this.assetPath(asset), { force: true }).catch(() => undefined);
      throw error;
    }
    return cloneAsset(asset);
  }

  async updateAsset(id: string, patch: MemeLibraryAssetPatch): Promise<MemeAsset | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const assetId = normalizeId(id, "meme_asset_id_invalid");
    validateAssetPatch(patch);
    const tags = patch.tags === undefined ? undefined : normalizeTagIds(patch.tags);
    const now = this.now();
    let updated: MemeAsset | undefined;
    repository.runAtomically(() => {
      if (tags) {
        ensureKnownTags(tags, this.readTagDocument(repository).tags);
      }
      repository.updateDocument<MemeAssetDocument>(
        MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
        MEME_LIBRARY_ASSET_DOCUMENT_KEY,
        DEFAULT_ASSET_DOCUMENT,
        (current) => {
          const document = normalizeAssetDocument(current);
          const index = document.assets.findIndex((asset) => asset.id === assetId);
          if (index < 0) return document;
          const previous = document.assets[index]!;
          if (previous.protected) {
            throw new MemeLibraryValidationError("meme_asset_protected");
          }
          if (previous.scope === "blacklisted_at" && tags && tags.length > 0) {
            throw new MemeLibraryValidationError("meme_blacklisted_asset_tags_forbidden");
          }
          const nextTags = previous.scope === "blacklisted_at" ? [] : tags ?? previous.tags;
          if (previous.scope === "normal_chat" && nextTags.length === 0) {
            throw new MemeLibraryValidationError("meme_asset_tags_required");
          }
          updated = {
            ...previous,
            name: patch.name === undefined ? previous.name : normalizeAssetName(patch.name),
            enabled: patch.enabled === undefined ? previous.enabled : patch.enabled,
            tags: nextTags,
            updatedAt: toIso(now),
          };
          document.assets[index] = updated;
          return document;
        },
        now,
      );
    });
    return updated ? cloneAsset(updated) : undefined;
  }

  async removeAsset(id: string): Promise<boolean> {
    const repository = this.repository();
    if (!repository) return false;
    const assetId = normalizeId(id, "meme_asset_id_invalid");
    let removed: MemeAsset | undefined;
    repository.updateDocument<MemeAssetDocument>(
      MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
      MEME_LIBRARY_ASSET_DOCUMENT_KEY,
      DEFAULT_ASSET_DOCUMENT,
      (current) => {
        const document = normalizeAssetDocument(current);
        const asset = document.assets.find((candidate) => candidate.id === assetId);
        if (!asset) return document;
        if (asset.protected) {
          throw new MemeLibraryValidationError("meme_asset_protected");
        }
        removed = asset;
        return { assets: document.assets.filter((candidate) => candidate.id !== assetId) };
      },
      this.now(),
    );
    if (!removed) return false;
    await rm(this.assetPath(removed), { force: true }).catch(() => undefined);
    return true;
  }

  async readAssetBytes(id: string): Promise<{ asset: MemeAsset; data: Buffer } | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const assetId = normalizeId(id, "meme_asset_id_invalid");
    const asset = this.readAssetDocument(repository).assets.find((candidate) => candidate.id === assetId);
    if (!asset) return undefined;
    const loaded = await this.readStoredAsset(asset);
    return loaded ? { asset: cloneAsset(loaded.asset), data: Buffer.from(loaded.imageFile.slice("base64://".length), "base64") } : undefined;
  }

  async loadImageFile(id: string): Promise<string | undefined> {
    const loaded = await this.readAssetBytes(id);
    return loaded ? `base64://${loaded.data.toString("base64")}` : undefined;
  }

  /**
   * Matches the source text against administrator-owned tag keywords and
   * claims the normal-chat cooldown in one V3 transaction. The source text is
   * deliberately never retained or returned from this method.
   */
  async claimNormalChatImage(args: {
    groupId: string;
    userText: string;
    now?: number;
  }): Promise<MemeNormalChatImageClaim> {
    const repository = this.repository();
    const groupId = normalizeGroupId(args.groupId);
    const userText = normalizeMemeMatchText(args.userText);
    const now = normalizeNow(args.now ?? this.now());
    if (!repository || !groupId || !userText) {
      return { reason: "no_match", matchedTagIds: [] };
    }

    const initialTags = this.readTagDocument(repository).tags;
    const initialAssets = this.readAssetDocument(repository).assets;
    const initialTagIds = matchingNormalChatTagIds(initialTags, initialAssets, userText);
    if (initialTagIds.length === 0) {
      return { reason: "no_match", matchedTagIds: [] };
    }
    const loadedCandidates = await this.loadCandidates(initialAssets
      .filter((asset) => matchesNormalChatTags(asset, initialTagIds)));
    if (loadedCandidates.length === 0) {
      return { reason: "asset_unavailable", matchedTagIds: initialTagIds };
    }

    let result: MemeNormalChatImageClaim = {
      reason: "asset_unavailable",
      matchedTagIds: initialTagIds,
    };
    repository.updateDocument<MemeCooldownDocument>(
      MEME_LIBRARY_COOLDOWN_DOCUMENT_TYPE,
      groupId,
      DEFAULT_COOLDOWN_DOCUMENT,
      (current) => {
        const cooldown = normalizeCooldownDocument(current);
        const library = this.readLibraryDocument(repository);
        if (!library.policy.enabled || library.policy.probabilityPercent <= 0) {
          result = { reason: "policy_disabled", matchedTagIds: initialTagIds };
          return cooldown;
        }
        if (isCooldownActive(cooldown, library.policy.cooldownSeconds, now)) {
          result = { reason: "cooldown", matchedTagIds: initialTagIds };
          return cooldown;
        }

        const currentTags = this.readTagDocument(repository).tags;
        const currentAssets = this.readAssetDocument(repository).assets;
        const matchedTagIds = matchingNormalChatTagIds(currentTags, currentAssets, userText);
        if (matchedTagIds.length === 0) {
          result = { reason: "no_match", matchedTagIds: [] };
          return cooldown;
        }
        if (randomPercent(this.random) >= library.policy.probabilityPercent) {
          result = { reason: "probability_miss", matchedTagIds };
          return cooldown;
        }

        const viable = loadedCandidates.flatMap((candidate) => {
          const currentAsset = currentAssets.find((asset) => (
            asset.id === candidate.asset.id
            && asset.scope === "normal_chat"
            && asset.enabled
            && asset.sha256 === candidate.asset.sha256
            && matchesNormalChatTags(asset, matchedTagIds)
          ));
          return currentAsset ? [{ asset: currentAsset, imageFile: candidate.imageFile }] : [];
        });
        const chosen = pickNonRepeating(viable, cooldown.lastAssetId, this.random);
        if (!chosen) {
          result = { reason: "asset_unavailable", matchedTagIds };
          return cooldown;
        }
        const selection = { asset: cloneAsset(chosen.asset), imageFile: chosen.imageFile };
        result = { reason: "sent_candidate", matchedTagIds, selection };
        return { lastSentAt: now, lastAssetId: chosen.asset.id };
      },
      now,
    );
    return result;
  }

  /** Selects a blacklist response image without applying normal chat policy or cooldown. */
  async selectBlacklistedAtImage(groupId?: string): Promise<MemeImageSelection | undefined> {
    const repository = this.repository();
    if (!repository) return undefined;
    const initialAssets = this.readAssetDocument(repository).assets
      .filter((asset) => asset.scope === "blacklisted_at" && asset.enabled);
    const loaded = await this.loadCandidates(initialAssets);
    if (loaded.length === 0) return undefined;

    const selectionKey = normalizeGroupId(groupId ?? "") || "global";
    let selected: MemeImageSelection | undefined;
    repository.updateDocument<MemeLastSelectionDocument>(
      MEME_LIBRARY_BLACKLISTED_SELECTION_DOCUMENT_TYPE,
      selectionKey,
      DEFAULT_LAST_SELECTION_DOCUMENT,
      (current) => {
        const lastSelection = normalizeLastSelectionDocument(current);
        const currentAssets = this.readAssetDocument(repository).assets;
        const viable = loaded.flatMap((candidate) => {
          const currentAsset = currentAssets.find((asset) => (
            asset.id === candidate.asset.id
            && asset.scope === "blacklisted_at"
            && asset.enabled
            && asset.sha256 === candidate.asset.sha256
          ));
          return currentAsset ? [{ asset: currentAsset, imageFile: candidate.imageFile }] : [];
        });
        const chosen = pickNonRepeating(viable, lastSelection.lastAssetId, this.random);
        if (!chosen) return lastSelection;
        selected = { asset: cloneAsset(chosen.asset), imageFile: chosen.imageFile };
        return { lastAssetId: chosen.asset.id };
      },
      this.now(),
    );
    return selected;
  }

  private repository(): V3StateRepository | undefined {
    return this.v3State?.isCutover() ? this.v3State : undefined;
  }

  private readLibraryDocument(repository: V3StateRepository): MemeLibraryDocument {
    return normalizeLibraryDocument(repository.getDocument(
      MEME_LIBRARY_DOCUMENT_TYPE,
      MEME_LIBRARY_DOCUMENT_KEY,
      DEFAULT_LIBRARY_DOCUMENT,
    ));
  }

  private readTagDocument(repository: V3StateRepository): MemeTagDocument {
    return normalizeTagDocument(repository.getDocument(
      MEME_LIBRARY_TAG_DOCUMENT_TYPE,
      MEME_LIBRARY_TAG_DOCUMENT_KEY,
      DEFAULT_TAG_DOCUMENT,
    ));
  }

  private readAssetDocument(repository: V3StateRepository): MemeAssetDocument {
    return normalizeAssetDocument(repository.getDocument(
      MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
      MEME_LIBRARY_ASSET_DOCUMENT_KEY,
      DEFAULT_ASSET_DOCUMENT,
    ));
  }

  private async loadCandidates(assets: MemeAsset[]): Promise<LoadedMemeAsset[]> {
    const loaded: LoadedMemeAsset[] = [];
    for (const asset of assets) {
      const item = await this.readStoredAsset(asset).catch(() => undefined);
      if (item) loaded.push(item);
    }
    return loaded;
  }

  private async readStoredAsset(asset: MemeAsset): Promise<LoadedMemeAsset | undefined> {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(this.assetPath(asset));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MEME_LIBRARY_MAX_IMAGE_BYTES || metadata.size !== asset.sizeBytes) {
      return undefined;
    }
    const data = await readFile(this.assetPath(asset));
    const detected = detectMemeImageMimeType(data);
    if (!detected || detected !== asset.mimeType || sha256(data) !== asset.sha256) {
      return undefined;
    }
    return { asset: cloneAsset(asset), imageFile: `base64://${data.toString("base64")}` };
  }

  private assetPath(asset: Pick<MemeAsset, "id" | "mimeType">): string {
    return path.join(this.getStorageDirectory(), `${normalizeId(asset.id, "meme_asset_id_invalid")}.${MIME_EXTENSIONS[asset.mimeType]}`);
  }

  private async writeAssetFile(asset: MemeAsset, data: Buffer): Promise<void> {
    const directory = this.getStorageDirectory();
    await mkdir(directory, { recursive: true });
    const destination = this.assetPath(asset);
    const temporary = path.join(directory, `.${asset.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, data, { mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (process.platform === "win32" && (known.code === "EPERM" || known.code === "EEXIST")) {
        await rm(destination, { force: true });
        await rename(temporary, destination);
        return;
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function detectMemeImageMimeType(data: Buffer): MemeImageMimeType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && (data.subarray(0, 6).equals(Buffer.from("GIF87a")) || data.subarray(0, 6).equals(Buffer.from("GIF89a")))) {
    return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).equals(Buffer.from("RIFF")) && data.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "image/webp";
  }
  return undefined;
}

function validateMemeImage(data: Buffer): { mimeType: MemeImageMimeType } {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MEME_LIBRARY_MAX_IMAGE_BYTES) {
    throw new MemeLibraryValidationError("meme_image_size_invalid");
  }
  const mimeType = detectMemeImageMimeType(data);
  if (!mimeType) {
    throw new MemeLibraryValidationError("meme_image_type_invalid");
  }
  return { mimeType };
}

function normalizeLibraryDocument(value: unknown): MemeLibraryDocument {
  const candidate = asRecord(value);
  return { policy: normalizePolicy(candidate?.policy) };
}

function normalizePolicy(value: unknown): MemeLibraryPolicy {
  const candidate = asRecord(value);
  return {
    enabled: candidate?.enabled !== false,
    probabilityPercent: boundedNumber(candidate?.probabilityPercent, DEFAULT_MEME_LIBRARY_POLICY.probabilityPercent, 0, 100),
    cooldownSeconds: boundedInteger(candidate?.cooldownSeconds, DEFAULT_MEME_LIBRARY_POLICY.cooldownSeconds, 0, 86_400),
  };
}

function validatePolicyPatch(patch: Partial<MemeLibraryPolicy>): void {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new MemeLibraryValidationError("meme_policy_invalid");
  }
  if (patch.probabilityPercent !== undefined && (!Number.isFinite(patch.probabilityPercent) || patch.probabilityPercent < 0 || patch.probabilityPercent > 100)) {
    throw new MemeLibraryValidationError("meme_policy_invalid");
  }
  if (patch.cooldownSeconds !== undefined && (!Number.isFinite(patch.cooldownSeconds) || patch.cooldownSeconds < 0 || patch.cooldownSeconds > 86_400)) {
    throw new MemeLibraryValidationError("meme_policy_invalid");
  }
}

function normalizeTagDocument(value: unknown): MemeTagDocument {
  const candidate = asRecord(value);
  const seen = new Set<string>();
  const tags = Array.isArray(candidate?.tags)
    ? candidate.tags.flatMap((tag) => {
      const normalized = normalizeTag(tag);
      if (!normalized || seen.has(normalized.id)) return [];
      seen.add(normalized.id);
      return [normalized];
    })
    : [];
  return { tags };
}

function normalizeTag(value: unknown): MemeTag | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  const id = normalizeOptionalId(candidate.id);
  const name = normalizeOptionalText(candidate.name, 64);
  if (!id || !name) return undefined;
  const now = toIso(Date.now());
  return {
    id,
    name,
    description: normalizeOptionalText(candidate.description, 500),
    // Legacy tags did not have keywords. Their names are a useful, stable
    // fallback and `initialize` persists it before normal routing starts.
    keywords: normalizeTagKeywordsSafe(candidate.keywords, name),
    createdAt: normalizeTimestamp(candidate.createdAt, now),
    updatedAt: normalizeTimestamp(candidate.updatedAt, now),
  };
}

function normalizeAssetDocument(value: unknown): MemeAssetDocument {
  const candidate = asRecord(value);
  const seen = new Set<string>();
  const assets = Array.isArray(candidate?.assets)
    ? candidate.assets.flatMap((asset) => {
      const normalized = normalizeAsset(asset);
      if (!normalized || seen.has(normalized.id)) return [];
      seen.add(normalized.id);
      return [normalized];
    })
    : [];
  return { assets };
}

function normalizeAsset(value: unknown): MemeAsset | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  const id = normalizeOptionalId(candidate.id);
  const name = normalizeOptionalText(candidate.name, 100);
  const scope = candidate.scope === "normal_chat" || candidate.scope === "blacklisted_at" ? candidate.scope : undefined;
  const mimeType = isMemeImageMimeType(candidate.mimeType) ? candidate.mimeType : undefined;
  const sizeBytes = Number(candidate.sizeBytes);
  const sha = typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/i.test(candidate.sha256) ? candidate.sha256.toLowerCase() : undefined;
  if (!id || !name || !scope || !mimeType || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MEME_LIBRARY_MAX_IMAGE_BYTES || !sha) {
    return undefined;
  }
  const now = toIso(Date.now());
  return {
    id,
    name,
    scope,
    enabled: candidate.enabled !== false,
    tags: scope === "normal_chat" ? normalizeTagIdsSafe(candidate.tags) : [],
    mimeType,
    sizeBytes,
    sha256: sha,
    createdAt: normalizeTimestamp(candidate.createdAt, now),
    updatedAt: normalizeTimestamp(candidate.updatedAt, now),
    protected: candidate.protected === true,
  };
}

/**
 * Releases before keyword matching allowed normal assets with no tags, and
 * tags themselves had no keyword data. Make those records usable without
 * touching blacklisted-only assets or overwriting administrator choices.
 */
function migrateLegacyNormalChatAssets(
  assets: MemeAssetDocument,
  tags: MemeTagDocument,
  now: number,
): void {
  const timestamp = toIso(now);
  const tagsByName = new Map(tags.tags.map((tag, index) => [tagNameKey(tag.name), index]));

  for (const [assetIndex, asset] of assets.assets.entries()) {
    if (asset.scope !== "normal_chat" || asset.tags.length > 0) continue;

    const tagName = normalizeTagName(asset.name);
    const tagKey = tagNameKey(tagName);
    let tagIndex = tagsByName.get(tagKey);
    if (tagIndex === undefined) {
      const tag: MemeTag = {
        id: randomUUID(),
        name: tagName,
        description: "",
        keywords: [normalizeKeyword(asset.name)],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      tagIndex = tags.tags.length;
      tags.tags.push(tag);
      tagsByName.set(tagKey, tagIndex);
    } else {
      const existing = tags.tags[tagIndex]!;
      const assetNameKeyword = normalizeKeyword(asset.name);
      if (!existing.keywords.includes(assetNameKeyword)) {
        tags.tags[tagIndex] = {
          ...existing,
          keywords: [...existing.keywords, assetNameKeyword].slice(0, 30),
          updatedAt: timestamp,
        };
      }
    }

    assets.assets[assetIndex] = {
      ...asset,
      tags: [tags.tags[tagIndex]!.id],
      updatedAt: timestamp,
    };
  }
}

function normalizeCooldownDocument(value: unknown): MemeCooldownDocument {
  const candidate = asRecord(value);
  return {
    lastSentAt: Math.max(0, boundedInteger(candidate?.lastSentAt, 0, 0, Number.MAX_SAFE_INTEGER)),
    ...(normalizeOptionalId(candidate?.lastAssetId) ? { lastAssetId: normalizeOptionalId(candidate?.lastAssetId) } : {}),
  };
}

function normalizeLastSelectionDocument(value: unknown): MemeLastSelectionDocument {
  const candidate = asRecord(value);
  const lastAssetId = normalizeOptionalId(candidate?.lastAssetId);
  return lastAssetId ? { lastAssetId } : {};
}

function normalizeScope(value: unknown): MemeScope {
  if (value === "normal_chat" || value === "blacklisted_at") return value;
  throw new MemeLibraryValidationError("meme_scope_invalid");
}

function normalizeAssetName(value: unknown): string {
  const name = normalizeOptionalText(value, 100);
  if (!name) throw new MemeLibraryValidationError("meme_asset_name_required");
  return name;
}

function normalizeTagName(value: unknown): string {
  const name = normalizeOptionalText(value, 64);
  if (!name) throw new MemeLibraryValidationError("meme_tag_name_required");
  return name;
}

function normalizeTagDescription(value: unknown): string {
  return normalizeOptionalText(value, 500);
}

function normalizeTagKeywords(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new MemeLibraryValidationError("meme_tag_keywords_required");
  }
  const keywords: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      throw new MemeLibraryValidationError("meme_tag_keywords_invalid");
    }
    const keyword = normalizeKeyword(value);
    if (!keyword || keywords.includes(keyword)) continue;
    keywords.push(keyword);
    if (keywords.length > 30) {
      throw new MemeLibraryValidationError("meme_tag_keywords_invalid");
    }
  }
  if (keywords.length === 0) {
    throw new MemeLibraryValidationError("meme_tag_keywords_required");
  }
  return keywords;
}

function normalizeTagKeywordsSafe(value: unknown, fallbackName: string): string[] {
  if (Array.isArray(value)) {
    const keywords: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const keyword = normalizeKeyword(item);
      if (!keyword || keywords.includes(keyword)) continue;
      keywords.push(keyword);
      if (keywords.length >= 30) break;
    }
    if (keywords.length > 0) return keywords;
  }
  return [normalizeKeyword(fallbackName)];
}

function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim().slice(0, 64);
}

function normalizeMemeMatchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function tagNameKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function validateTagPatch(patch: MemeLibraryTagPatch): void {
  if (patch.name !== undefined && typeof patch.name !== "string") {
    throw new MemeLibraryValidationError("meme_tag_name_required");
  }
  if (patch.description !== undefined && typeof patch.description !== "string") {
    throw new MemeLibraryValidationError("meme_tag_description_invalid");
  }
  if (patch.keywords !== undefined && !Array.isArray(patch.keywords)) {
    throw new MemeLibraryValidationError("meme_tag_keywords_invalid");
  }
}

function validateAssetPatch(patch: MemeLibraryAssetPatch): void {
  if (patch.name !== undefined && typeof patch.name !== "string") {
    throw new MemeLibraryValidationError("meme_asset_name_required");
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new MemeLibraryValidationError("meme_asset_enabled_invalid");
  }
  if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
    throw new MemeLibraryValidationError("meme_asset_tags_invalid");
  }
}

function normalizeTagIds(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new MemeLibraryValidationError("meme_asset_tags_invalid");
    const id = normalizeOptionalId(value);
    if (!id) throw new MemeLibraryValidationError("meme_asset_tags_invalid");
    if (!result.includes(id)) result.push(id);
    if (result.length > 30) throw new MemeLibraryValidationError("meme_asset_tags_invalid");
  }
  return result;
}

function normalizeTagIdsSafe(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeOptionalId).filter((id): id is string => Boolean(id)))].slice(0, 30);
}

function ensureKnownTags(tagIds: string[], tags: MemeTag[]): void {
  const known = new Set(tags.map((tag) => tag.id));
  if (tagIds.some((tag) => !known.has(tag))) {
    throw new MemeLibraryValidationError("meme_tag_not_found");
  }
}

function matchesNormalChatTags(asset: MemeAsset, tagIds: string[]): boolean {
  return asset.scope === "normal_chat"
    && asset.enabled
    && asset.tags.some((tag) => tagIds.includes(tag));
}

function matchingNormalChatTagIds(tags: MemeTag[], assets: MemeAsset[], userText: string): string[] {
  const usedTagIds = new Set(assets
    .filter((asset) => asset.scope === "normal_chat" && asset.enabled)
    .flatMap((asset) => asset.tags));
  return tags
    .filter((tag) => usedTagIds.has(tag.id) && tag.keywords.some((keyword) => userText.includes(keyword)))
    .map((tag) => tag.id);
}

function pickNonRepeating<T extends { asset: MemeAsset }>(items: T[], lastAssetId: string | undefined, random: () => number): T | undefined {
  if (items.length === 0) return undefined;
  const withoutLast = items.length > 1 && lastAssetId
    ? items.filter((item) => item.asset.id !== lastAssetId)
    : items;
  const candidates = withoutLast.length > 0 ? withoutLast : items;
  return candidates[randomIndex(candidates.length, random)];
}

function randomPercent(random: () => number): number {
  return randomIndex(1_000_000, random) / 10_000;
}

function randomIndex(length: number, random: () => number): number {
  const value = Number(random());
  const bounded = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return Math.floor(bounded * length);
}

function isCooldownActive(cooldown: MemeCooldownDocument, cooldownSeconds: number, now: number): boolean {
  return cooldown.lastSentAt > 0 && now - cooldown.lastSentAt < cooldownSeconds * 1_000;
}

function normalizeGroupId(value: string): string | undefined {
  const groupId = String(value ?? "").trim();
  return /^\d{5,20}$/.test(groupId) ? groupId : undefined;
}

function normalizeId(value: unknown, errorCode: string): string {
  const id = normalizeOptionalId(value);
  if (!id) throw new MemeLibraryValidationError(errorCode);
  return id;
}

function normalizeOptionalId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9-]{2,80}$/i.test(id) ? id : undefined;
}

function normalizeOptionalText(value: unknown, maximumLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number * 100) / 100));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function normalizeNow(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
}

function isMemeImageMimeType(value: unknown): value is MemeImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toIso(value: number): string {
  return new Date(normalizeNow(value)).toISOString();
}

function clonePolicy(policy: MemeLibraryPolicy): MemeLibraryPolicy {
  return { ...policy };
}

function cloneTag(tag: MemeTag): MemeTag {
  return { ...tag, keywords: [...tag.keywords] };
}

function cloneAsset(asset: MemeAsset): MemeAsset {
  return { ...asset, tags: [...asset.tags] };
}

function compareTags(left: MemeTag, right: MemeTag): number {
  return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
}

function compareAssetsNewestFirst(left: MemeAsset, right: MemeAsset): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}
