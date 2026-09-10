import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import {
  BLACKLISTED_AT_MEME_SEED_ID,
  DEFAULT_MEME_LIBRARY_POLICY,
  MEME_LIBRARY_ASSET_DOCUMENT_KEY,
  MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
  MEME_LIBRARY_TAG_DOCUMENT_KEY,
  MEME_LIBRARY_TAG_DOCUMENT_TYPE,
  MEME_LIBRARY_MAX_IMAGE_BYTES,
  type MemeAsset,
  MemeLibraryService,
  MemeLibraryValidationError,
  detectMemeImageMimeType,
} from "./meme-library-service.js";
import { V3StateRepository } from "./v3-state-repository.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("seed-png"),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from("test-gif")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from("test-webp")]);

interface LibraryFixture {
  dir: string;
  dataDir: string;
  seedPath: string;
  db: SharedDb;
  repository: V3StateRepository;
  service: MemeLibraryService;
}

interface FixtureOptions {
  random?: () => number;
  now?: () => number;
  seed?: Buffer;
}

async function withLibrary<T>(
  run: (fixture: LibraryFixture) => Promise<T> | T,
  options: FixtureOptions = {},
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-meme-library-"));
  const dataDir = path.join(dir, "data");
  const seedPath = path.join(dir, "blacklisted-seed.png");
  const db = new SharedDb(path.join(dataDir, "shared", "bot-shared.db"));
  const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
  repository.markCutover();
  await writeFile(seedPath, options.seed ?? PNG);
  const service = new MemeLibraryService(dataDir, repository, {
    seedAssetPath: seedPath,
    random: options.random,
    now: options.now,
  });
  try {
    await service.initialize();
    return await run({ dir, dataDir, seedPath, db, repository, service });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function assertValidationCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof MemeLibraryValidationError && error.code === code;
}

test("MemeLibraryService seeds the protected blacklist asset in V3 and persistent data", async () => {
  await withLibrary(async ({ dataDir, repository, service }) => {
    assert.equal(service.isAvailable(), true);
    assert.deepEqual(await service.getPolicy(), DEFAULT_MEME_LIBRARY_POLICY);

    const assets = await service.listAssets("blacklisted_at");
    assert.equal(assets.length, 1);
    const [seed] = assets;
    assert.ok(seed);
    assert.equal(seed.id, BLACKLISTED_AT_MEME_SEED_ID);
    assert.equal(seed.protected, true);
    assert.equal(seed.scope, "blacklisted_at");
    assert.equal(seed.mimeType, "image/png");
    assert.deepEqual(seed.tags, []);

    const stored = await service.readAssetBytes(seed.id);
    assert.ok(stored);
    assert.equal(stored.asset.id, seed.id);
    assert.deepEqual(stored.data, PNG);
    const files = await stat(path.join(dataDir, "meme-library", `${BLACKLISTED_AT_MEME_SEED_ID}.png`));
    assert.equal(files.isFile(), true);

    const document = repository.getDocument<{ assets: Array<{ id: string }> }>(
      MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
      MEME_LIBRARY_ASSET_DOCUMENT_KEY,
      { assets: [] },
    );
    assert.deepEqual(document.assets.map((asset) => asset.id), [BLACKLISTED_AT_MEME_SEED_ID]);

    await assert.rejects(
      () => service.updateAsset(seed.id, { enabled: false }),
      assertValidationCode("meme_asset_protected"),
    );
    await assert.rejects(
      () => service.removeAsset(seed.id),
      assertValidationCode("meme_asset_protected"),
    );
  });
});

test("MemeLibraryService accepts only allowed image magic and retains true MIME metadata", async () => {
  await withLibrary(async ({ service }) => {
    const tag = await service.createTag({ name: "开心", description: "轻松、开心时使用", keywords: ["开心"] });
    assert.ok(tag);

    const png = await service.uploadAsset({ name: "png", scope: "normal_chat", tags: [tag.id], data: PNG });
    const jpeg = await service.uploadAsset({ name: "jpeg", scope: "blacklisted_at", data: JPEG });
    const gif = await service.uploadAsset({ name: "gif", scope: "blacklisted_at", data: GIF });
    const webp = await service.uploadAsset({ name: "webp", scope: "blacklisted_at", data: WEBP });
    assert.equal(png?.mimeType, "image/png");
    assert.equal(jpeg?.mimeType, "image/jpeg");
    assert.equal(gif?.mimeType, "image/gif");
    assert.equal(webp?.mimeType, "image/webp");
    assert.equal(detectMemeImageMimeType(PNG), "image/png");
    assert.equal(detectMemeImageMimeType(JPEG), "image/jpeg");
    assert.equal(detectMemeImageMimeType(GIF), "image/gif");
    assert.equal(detectMemeImageMimeType(WEBP), "image/webp");

    await assert.rejects(
      () => service.uploadAsset({ name: "not image", scope: "normal_chat", tags: [tag.id], data: Buffer.from("<svg />") }),
      assertValidationCode("meme_image_type_invalid"),
    );
    await assert.rejects(
      () => service.uploadAsset({
        name: "too large",
        scope: "normal_chat",
        tags: [tag.id],
        data: Buffer.alloc(MEME_LIBRARY_MAX_IMAGE_BYTES + 1),
      }),
      assertValidationCode("meme_image_size_invalid"),
    );
    await assert.rejects(
      () => service.uploadAsset({ name: "unknown tag", scope: "normal_chat", tags: ["does-not-exist"], data: PNG }),
      assertValidationCode("meme_tag_not_found"),
    );
  });
});

test("MemeLibraryService normalizes required tag keywords", async () => {
  await withLibrary(async ({ service }) => {
    const tag = await service.createTag({
      name: "吐槽",
      keywords: ["  吐 槽  ", "吐 槽", "ＡＢＣ", "abc", "无语"],
    });
    assert.ok(tag);
    assert.deepEqual(tag.keywords, ["吐 槽", "abc", "无语"]);

    const updated = await service.updateTag(tag.id, { keywords: ["  新词  ", "新词", "HELLO"] });
    assert.deepEqual(updated?.keywords, ["新词", "hello"]);
    await assert.rejects(
      () => service.createTag({ name: "空关键词", keywords: ["  "] }),
      assertValidationCode("meme_tag_keywords_required"),
    );
    await assert.rejects(
      () => service.updateTag(tag.id, { keywords: [42] as unknown as string[] }),
      assertValidationCode("meme_tag_keywords_invalid"),
    );
  });
});

test("MemeLibraryService migrates legacy tags and untagged normal assets idempotently", async () => {
  await withLibrary(async ({ repository, service }) => {
    const temporary = await service.createTag({ name: "临时", keywords: ["临时"] });
    assert.ok(temporary);
    const asset = await service.uploadAsset({
      name: "遗留素材",
      scope: "normal_chat",
      tags: [temporary.id],
      data: PNG,
    });
    assert.ok(asset);

    repository.updateDocument(
      MEME_LIBRARY_TAG_DOCUMENT_TYPE,
      MEME_LIBRARY_TAG_DOCUMENT_KEY,
      { tags: [] },
      () => ({
        tags: [
          {
            id: "legacy-match",
            name: "遗留素材",
            description: "旧记录",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
          {
            id: "legacy-other",
            name: "已有标签",
            description: "",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    repository.updateDocument<{ assets: MemeAsset[] }>(
      MEME_LIBRARY_ASSET_DOCUMENT_TYPE,
      MEME_LIBRARY_ASSET_DOCUMENT_KEY,
      { assets: [] },
      (current) => ({
        assets: current.assets.map((candidate) => candidate.id === asset.id ? { ...candidate, tags: [] } : candidate),
      }),
    );

    await service.initialize();
    const migratedTags = await service.listTags();
    const matched = migratedTags.find((tag) => tag.id === "legacy-match");
    const other = migratedTags.find((tag) => tag.id === "legacy-other");
    assert.deepEqual(matched?.keywords, ["遗留素材"]);
    assert.deepEqual(other?.keywords, ["已有标签"]);
    assert.deepEqual((await service.getAsset(asset.id))?.tags, ["legacy-match"]);

    await service.initialize();
    assert.equal((await service.listTags()).filter((tag) => tag.name === "遗留素材").length, 1);
    assert.deepEqual((await service.getAsset(asset.id))?.tags, ["legacy-match"]);
  });
});

test("MemeLibraryService persists uploaded metadata and bytes across a full SQLite reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-meme-library-reopen-"));
  const dataDir = path.join(dir, "data");
  const dbPath = path.join(dataDir, "shared", "bot-shared.db");
  const seedPath = path.join(dir, "blacklisted-seed.png");
  let initialDb: SharedDb | undefined;
  let reopenedDb: SharedDb | undefined;
  try {
    await writeFile(seedPath, PNG);
    initialDb = new SharedDb(dbPath);
    const initialRepository = new V3StateRepository(initialDb, { stateEncryptionKey: TEST_STATE_KEY });
    initialRepository.markCutover();
    const initialService = new MemeLibraryService(dataDir, initialRepository, { seedAssetPath: seedPath });
    await initialService.initialize();
    const tag = await initialService.createTag({ name: "重启后仍可用", description: "验证持久化", keywords: ["重启"] });
    assert.ok(tag);
    const asset = await initialService.uploadAsset({
      name: "持久化 JPEG",
      scope: "normal_chat",
      tags: [tag.id],
      data: JPEG,
    });
    assert.ok(asset);
    await initialService.updatePolicy({ probabilityPercent: 100, cooldownSeconds: 42 });
    initialDb.close();
    initialDb = undefined;

    reopenedDb = new SharedDb(dbPath);
    const reopenedRepository = new V3StateRepository(reopenedDb, { stateEncryptionKey: TEST_STATE_KEY });
    assert.equal(reopenedRepository.isCutover(), true);
    const reopenedService = new MemeLibraryService(dataDir, reopenedRepository, { seedAssetPath: seedPath });
    await reopenedService.initialize();

    assert.deepEqual(await reopenedService.getPolicy(), { enabled: true, probabilityPercent: 100, cooldownSeconds: 42 });
    assert.deepEqual(await reopenedService.getAsset(asset.id), asset);
    const reopenedSeed = await reopenedService.getAsset(BLACKLISTED_AT_MEME_SEED_ID);
    assert.equal(reopenedSeed?.protected, true);
    assert.equal(reopenedSeed?.scope, "blacklisted_at");
    assert.deepEqual(await reopenedService.listTags(), [tag]);
    const stored = await reopenedService.readAssetBytes(asset.id);
    assert.ok(stored);
    assert.deepEqual(stored.asset, asset);
    assert.deepEqual(stored.data, JPEG);
  } finally {
    initialDb?.close();
    reopenedDb?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tag referenced by a normal asset cannot be deleted", async () => {
  await withLibrary(async ({ service }) => {
    const tag = await service.createTag({ name: "惊讶", keywords: ["惊讶"] });
    assert.ok(tag);
    const asset = await service.uploadAsset({ name: "惊讶图", scope: "normal_chat", tags: [tag.id], data: PNG });
    assert.ok(asset);
    await assert.rejects(() => service.removeTag(tag.id), assertValidationCode("meme_tag_in_use"));
    assert.deepEqual((await service.getAsset(asset.id))?.tags, [tag.id]);
    assert.equal(await service.removeAsset(asset.id), true);
    assert.equal(await service.removeTag(tag.id), true);
    assert.equal(await service.getAsset(asset.id), undefined);
    assert.equal(await service.readAssetBytes(asset.id), undefined);
  });
});

test("tag deletion between image write and metadata commit cannot create a dangling asset tag", async () => {
  await withLibrary(async ({ service }) => {
    const tag = await service.createTag({ name: "竞态标签", keywords: ["竞态"] });
    assert.ok(tag);

    // Upload writes the binary before it can start a synchronous SQLite
    // transaction. Simulate an admin deleting the tag in that small window.
    // The asset write must then reject and clean up rather than persist the
    // stale tag id.
    const internals = service as unknown as {
      writeAssetFile: (asset: MemeAsset, data: Buffer) => Promise<void>;
    };
    const originalWriteAssetFile = internals.writeAssetFile.bind(service);
    internals.writeAssetFile = async (asset, data) => {
      await originalWriteAssetFile(asset, data);
      assert.equal(await service.removeTag(tag.id), true);
    };

    await assert.rejects(
      () => service.uploadAsset({ name: "不会留下", scope: "normal_chat", tags: [tag.id], data: PNG }),
      assertValidationCode("meme_tag_not_found"),
    );
    internals.writeAssetFile = originalWriteAssetFile;
    assert.deepEqual(await service.listAssets("normal_chat"), []);

    await assert.rejects(
      () => service.uploadAsset({ name: "无标签素材", scope: "normal_chat", data: PNG }),
      assertValidationCode("meme_asset_tags_required"),
    );
    const existing = await service.uploadAsset({ name: "有标签素材", scope: "normal_chat", tags: [tag.id], data: PNG }).catch(() => undefined);
    assert.equal(existing, undefined);
    const restoredTag = await service.createTag({ name: "恢复标签", keywords: ["恢复"] });
    assert.ok(restoredTag);
    const tagged = await service.uploadAsset({ name: "必须有标签", scope: "normal_chat", tags: [restoredTag.id], data: PNG });
    assert.ok(tagged);
    await assert.rejects(
      () => service.updateAsset(tagged.id, { tags: [] }),
      assertValidationCode("meme_asset_tags_required"),
    );
    assert.deepEqual((await service.getAsset(tagged.id))?.tags, [restoredTag.id]);
  });
});

test("normal meme local keyword matching claims cooldown atomically across contenders", async () => {
  let now = 1_700_000_000_000;
  await withLibrary(async ({ dataDir, repository, seedPath, service }) => {
    const tag = await service.createTag({ name: "配图", keywords: ["配图", "开心"] });
    assert.ok(tag);
    const asset = await service.uploadAsset({ name: "配图", scope: "normal_chat", tags: [tag.id], data: PNG });
    assert.ok(asset);
    await service.updatePolicy({ probabilityPercent: 100, cooldownSeconds: 600 });

    const noMatch = await service.claimNormalChatImage({ groupId: "10001", userText: "今天下雨", now });
    assert.deepEqual(noMatch, { reason: "no_match", matchedTagIds: [] });

    await service.updatePolicy({ probabilityPercent: 0 });
    assert.deepEqual(
      await service.claimNormalChatImage({ groupId: "10001", userText: "今天很开心", now }),
      { reason: "policy_disabled", matchedTagIds: [tag.id] },
    );
    await service.updatePolicy({ probabilityPercent: 100 });

    const contender = new MemeLibraryService(dataDir, repository, {
      seedAssetPath: seedPath,
      now: () => now,
      random: () => 0,
    });
    const [first, second] = await Promise.all([
      service.claimNormalChatImage({ groupId: "10001", userText: "给我来张配图", now }),
      contender.claimNormalChatImage({ groupId: "10001", userText: "给我来张配图", now }),
    ]);
    const selected = [first, second].find((result) => result.reason === "sent_candidate");
    assert.equal([first, second].filter((result) => result.reason === "sent_candidate").length, 1);
    assert.equal(selected?.selection?.asset.id, asset.id);
    assert.equal([first, second].some((result) => result.reason === "cooldown"), true);
    assert.equal((await service.claimNormalChatImage({ groupId: "10001", userText: "配图", now: now + 1 })).reason, "cooldown");

    now += 600_000;
    assert.equal((await service.claimNormalChatImage({ groupId: "10001", userText: "配图", now })).reason, "sent_candidate");
  }, { random: () => 0, now: () => now });
});

test("selection avoids an immediate repeat where multiple normal or blacklisted assets are viable", async () => {
  await withLibrary(async ({ service }) => {
    const tag = await service.createTag({ name: "贴切", keywords: ["贴切"] });
    assert.ok(tag);
    const firstNormal = await service.uploadAsset({ name: "普通一", scope: "normal_chat", tags: [tag.id], data: PNG });
    const secondNormal = await service.uploadAsset({ name: "普通二", scope: "normal_chat", tags: [tag.id], data: JPEG });
    const secondBlacklist = await service.uploadAsset({ name: "黑名单二", scope: "blacklisted_at", data: GIF });
    assert.ok(firstNormal && secondNormal && secondBlacklist);
    await service.updatePolicy({ probabilityPercent: 100, cooldownSeconds: 0 });

    const normalOne = await service.claimNormalChatImage({ groupId: "10001", userText: "贴切", now: 1000 });
    const normalTwo = await service.claimNormalChatImage({ groupId: "10001", userText: "贴切", now: 1001 });
    assert.equal(normalOne.reason, "sent_candidate");
    assert.equal(normalTwo.reason, "sent_candidate");
    assert.notEqual(normalOne.selection?.asset.id, normalTwo.selection?.asset.id);

    const blacklistedOne = await service.selectBlacklistedAtImage("10001");
    const blacklistedTwo = await service.selectBlacklistedAtImage("10001");
    assert.ok(blacklistedOne && blacklistedTwo);
    assert.notEqual(blacklistedOne.asset.id, blacklistedTwo.asset.id);
  }, { random: () => 0 });
});

test("missing V3 state is a safe no-op and never creates a persistent library", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-meme-library-unavailable-"));
  const dataDir = path.join(dir, "data");
  try {
    const service = new MemeLibraryService(dataDir);
    await service.initialize();
    assert.equal(service.isAvailable(), false);
    assert.deepEqual(await service.getPolicy(), DEFAULT_MEME_LIBRARY_POLICY);
    assert.deepEqual(await service.listAssets(), []);
    assert.equal(await service.uploadAsset({ name: "ignored", scope: "blacklisted_at", data: PNG }), undefined);
    await assert.rejects(() => stat(path.join(dataDir, "meme-library")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stored bytes are integrity checked before an image file is returned", async () => {
  await withLibrary(async ({ dataDir, service }) => {
    const tag = await service.createTag({ name: "校验", keywords: ["校验"] });
    assert.ok(tag);
    const asset = await service.uploadAsset({ name: "需要校验", scope: "normal_chat", tags: [tag.id], data: PNG });
    assert.ok(asset);
    const imagePath = path.join(dataDir, "meme-library", `${asset.id}.png`);
    await writeFile(imagePath, Buffer.from("not an image"));
    assert.equal(await service.loadImageFile(asset.id), undefined);
    assert.deepEqual(
      await service.claimNormalChatImage({ groupId: "10001", userText: "校验", now: 1000 }),
      { reason: "asset_unavailable", matchedTagIds: [tag.id] },
    );
    assert.deepEqual(await readFile(imagePath), Buffer.from("not an image"));
  }, { random: () => 0 });
});
