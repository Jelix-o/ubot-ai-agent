import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import {
  IMAGE_PREVIEW_ORPHAN_MIN_AGE_MS,
  ImagePreviewArchiveError,
  ImagePreviewArchiveService,
} from "./image-preview-archive-service.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==",
  "base64",
);

test("archives a verified staged image privately and returns only a redacted list record", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "source.png");
  const prompt = `draw ${"x".repeat(200)}`;
  const preview = await fixture.service.archive({
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId: "message-1",
    prompt,
    filePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: true,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    now: fixture.now.value,
  });

  assert.equal(preview.status, "available");
  assert.equal(Array.from(preview.promptSummary).length, 160);
  assert.equal("prompt" in preview, false);
  const privateFile = path.join(fixture.archiveRoot, `${preview.id}.png`);
  assert.deepEqual(await readFile(privateFile), PNG);

  const [listed, detail, image] = await Promise.all([
    fixture.service.listPage({ groupId: "group-1" }),
    fixture.service.getDetail(preview.id),
    fixture.service.loadImage(preview.id),
  ]);
  assert.equal(listed.items.length, 1);
  assert.equal("prompt" in listed.items[0]!, false);
  assert.equal(detail?.prompt, prompt);
  assert.deepEqual(image?.data, PNG);
  assert.equal(image?.mimeType, "image/png");

  const stored = fixture.db.db.prepare(
    "SELECT prompt, prompt_summary, fallback_used, mime_type, byte_size, content_sha256 FROM image_previews WHERE id = ?",
  ).get(preview.id) as {
    prompt: string;
    prompt_summary: string;
    fallback_used: number;
    mime_type: string;
    byte_size: number;
    content_sha256: string;
  };
  assert.equal(stored.prompt, prompt);
  assert.equal(stored.prompt_summary, preview.promptSummary);
  assert.equal(stored.fallback_used, 1);
  assert.equal(stored.mime_type, "image/png");
  assert.equal(stored.byte_size, PNG.byteLength);
  assert.match(stored.content_sha256, /^[a-f0-9]{64}$/);
});

test("projects only safe linked request-ledger status into archived image metadata", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "ledger.png");
  const claim = fixture.service.imageRequestRepository.claim({
    groupId: "group-1",
    sourceMessageId: "ledger-source",
    creatorUserId: "member-1",
    requestKind: "avatar_edit",
    triggerSource: "natural",
    now: fixture.now.value,
  });
  assert.equal(claim.created, true);
  assert.ok(fixture.service.imageRequestRepository.beginSubmission(claim.request.id, fixture.now.value + 1));
  assert.ok(fixture.service.imageRequestRepository.recordGenerated({
    id: claim.request.id,
    stagedFilePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    outputSize: "1024x1024",
    now: fixture.now.value + 2,
  }));
  const preview = await fixture.service.archive({
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId: "ledger-source",
    prompt: "private avatar edit prompt",
    filePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    now: fixture.now.value + 3,
  });
  assert.ok(fixture.service.imageRequestRepository.linkPreview(claim.request.id, preview.id, fixture.now.value + 4));
  fixture.db.db.prepare(
    "UPDATE image_requests SET status = 'delivery_unknown', error_code = 'delivery_unknown' WHERE id = ?",
  ).run(claim.request.id);

  const [listed, detail] = await Promise.all([
    fixture.service.listPage({ groupId: "group-1" }),
    fixture.service.getDetail(preview.id),
  ]);
  const metadata = listed.items[0]!;
  assert.equal(metadata.requestKind, "avatar_edit");
  assert.equal(metadata.triggerSource, "natural");
  assert.equal(metadata.requestStatus, "delivery_unknown");
  assert.equal(metadata.failureReason, "delivery_unknown");
  assert.equal(detail?.requestKind, "avatar_edit");
  assert.equal(detail?.failureReason, "delivery_unknown");
  assert.equal("sourceMessageId" in metadata, true);
  assert.equal("upstreamRequestKey" in metadata, false);
  assert.equal("stagedFilePath" in metadata, false);
  assert.equal("requestId" in metadata, false);
});

test("keeps a Worker-owned preview invisible until its outbox link commits and reclaims it after a crash", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "pending-recovery.png");
  const claim = fixture.service.imageRequestRepository.claim({
    groupId: "group-1",
    sourceMessageId: "pending-recovery",
    creatorUserId: "member-1",
    requestKind: "generation",
    triggerSource: "natural",
    now: fixture.now.value,
  });
  assert.ok(fixture.service.imageRequestRepository.beginSubmission(claim.request.id, fixture.now.value + 1));
  assert.ok(fixture.service.imageRequestRepository.recordGenerated({
    id: claim.request.id,
    stagedFilePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    outputSize: "1024x1024",
    now: fixture.now.value + 2,
  }));
  const preview = await fixture.service.archive({
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId: "pending-recovery",
    prompt: "private pending image",
    filePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    publicationState: "pending",
    now: fixture.now.value + 3,
  });
  const privateFile = path.join(fixture.archiveRoot, `${preview.id}.png`);
  assert.deepEqual(await readFile(privateFile), PNG);
  assert.equal(await fixture.service.get(preview.id), undefined);
  assert.equal(await fixture.service.getDetail(preview.id), undefined);
  assert.equal(await fixture.service.loadImage(preview.id), undefined);
  assert.equal((await fixture.service.listPage({ groupId: "group-1" })).items.length, 0);

  assert.equal(await fixture.service.recoverUnpublished(fixture.now.value + 4), 1);
  await assert.rejects(access(privateFile), { code: "ENOENT" });
  await assert.rejects(access(source), { code: "ENOENT" });
  const stored = fixture.db.db.prepare(
    "SELECT status, publication_state, prompt FROM image_previews WHERE id = ?",
  ).get(preview.id) as { status: string; publication_state: string; prompt: string | null };
  assert.deepEqual({ ...stored }, { status: "deleted", publication_state: "pending", prompt: null });
  const request = fixture.service.imageRequestRepository.get(claim.request.id);
  assert.deepEqual({ status: request?.status, errorCode: request?.errorCode }, {
    status: "failed",
    errorCode: "delivery_not_queued",
  });
});

test("never republishes a pending preview from an incomplete legacy Outbox link", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "partial-outbox.png");
  const claim = fixture.service.imageRequestRepository.claim({
    groupId: "group-1",
    sourceMessageId: "partial-outbox",
    creatorUserId: "member-1",
    requestKind: "generation",
    triggerSource: "natural",
    now: fixture.now.value,
  });
  assert.ok(fixture.service.imageRequestRepository.beginSubmission(claim.request.id, fixture.now.value + 1));
  assert.ok(fixture.service.imageRequestRepository.recordGenerated({
    id: claim.request.id,
    stagedFilePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    outputSize: "1024x1024",
    now: fixture.now.value + 2,
  }));
  const preview = await fixture.service.archive({
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId: "partial-outbox",
    prompt: "private partial image",
    filePath: source,
    modelId: "primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    publicationState: "pending",
    now: fixture.now.value + 3,
  });
  const outboxId = Number(fixture.db.db.prepare(
    `INSERT INTO outbox (group_id, kind, text, status, image_preview_id, created_at)
     VALUES (?, 'generated_image', ?, 'pending', ?, ?)`,
  ).run("group-1", source, preview.id, fixture.now.value + 4).lastInsertRowid);
  fixture.db.db.prepare(
    `UPDATE image_requests
        SET status = 'queued', image_preview_id = ?, outbox_id = ?
      WHERE id = ?`,
  ).run(preview.id, outboxId, claim.request.id);

  assert.equal(await fixture.service.recoverUnpublished(fixture.now.value + 5), 1);
  const stored = fixture.db.db.prepare(
    "SELECT status, publication_state FROM image_previews WHERE id = ?",
  ).get(preview.id) as { status: string; publication_state: string };
  assert.deepEqual({ ...stored }, { status: "deleted", publication_state: "pending" });
  const outbox = fixture.db.db.prepare(
    "SELECT status, retry_after FROM outbox WHERE id = ?",
  ).get(outboxId) as { status: string; retry_after: number | null };
  assert.deepEqual({ ...outbox }, { status: "failed", retry_after: null });
  const request = fixture.service.imageRequestRepository.get(claim.request.id);
  assert.deepEqual({ status: request?.status, errorCode: request?.errorCode }, {
    status: "delivery_unknown",
    errorCode: "delivery_unknown",
  });
  assert.deepEqual(fixture.db.claimOutbox(1, fixture.now.value + 6), []);
});

test("refuses paths outside the managed staging root and mismatched image metadata", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside.png");
  await writeFile(outside, PNG);
  await assert.rejects(
    fixture.service.archive({
      groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "outside", prompt: "draw",
      filePath: outside, modelId: "primary", model: "image-model", fallbackUsed: false,
      mimeType: "image/png", byteSize: PNG.byteLength,
    }),
    (error: unknown) => error instanceof ImagePreviewArchiveError && error.code === "image_preview_source_path_invalid",
  );

  const staged = await stage(fixture, "wrong-type.png");
  await assert.rejects(
    fixture.service.archive({
      groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "wrong-type", prompt: "draw",
      filePath: staged, modelId: "primary", model: "image-model", fallbackUsed: false,
      mimeType: "image/jpeg", byteSize: PNG.byteLength,
    }),
    (error: unknown) => error instanceof ImagePreviewArchiveError && error.code === "image_preview_source_type_invalid",
  );
  assert.equal((fixture.db.db.prepare("SELECT COUNT(*) AS count FROM image_previews").get() as { count: number }).count, 0);
});

test("does not allow an archive caller to extend the thirty-day retention window", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "retention.png");
  await assert.rejects(
    fixture.service.archive({
      groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "retention", prompt: "draw",
      filePath: source, modelId: "primary", model: "image-model", fallbackUsed: false,
      mimeType: "image/png", byteSize: PNG.byteLength, now: fixture.now.value,
      expiresAt: fixture.now.value + 30 * 24 * 60 * 60 * 1_000 + 1,
    }),
    (error: unknown) => error instanceof ImagePreviewArchiveError && error.code === "image_preview_expiry_invalid",
  );
});

test("expiry removes private bytes and clears both the prompt and its summary", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "expires.png");
  const preview = await fixture.service.archive({
    groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "expires", prompt: "private prompt",
    filePath: source, modelId: "primary", model: "image-model", fallbackUsed: false,
    mimeType: "image/png", byteSize: PNG.byteLength,
    now: fixture.now.value, expiresAt: fixture.now.value + 10,
  });
  const privateFile = path.join(fixture.archiveRoot, `${preview.id}.png`);
  fixture.now.value += 10;
  const result = await fixture.service.cleanup(fixture.now.value);
  assert.equal(result.expired, 1);
  await assert.rejects(access(privateFile));
  assert.equal((await fixture.service.get(preview.id))?.status, "expired");
  assert.equal(await fixture.service.getDetail(preview.id), undefined);
  assert.equal(await fixture.service.loadImage(preview.id), undefined);
  const stored = fixture.db.db.prepare(
    "SELECT prompt, prompt_summary, status FROM image_previews WHERE id = ?",
  ).get(preview.id) as { prompt: string | null; prompt_summary: string; status: string };
  assert.equal(stored.prompt, null);
  assert.equal(stored.prompt_summary, "");
  assert.equal(stored.status, "expired");
});

test("manual deletion clears the prompt and orphan cleanup only removes untracked stale files", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "delete.png");
  const preview = await fixture.service.archive({
    groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "delete", prompt: "delete me",
    filePath: source, modelId: "primary", model: "image-model", fallbackUsed: false,
    mimeType: "image/png", byteSize: PNG.byteLength,
    now: fixture.now.value,
  });
  assert.equal(await fixture.service.remove(preview.id, fixture.now.value + 1), true);
  assert.equal((await fixture.service.get(preview.id))?.status, "deleted");
  assert.equal(await fixture.service.getDetail(preview.id), undefined);
  const stored = fixture.db.db.prepare(
    "SELECT prompt, prompt_summary, status FROM image_previews WHERE id = ?",
  ).get(preview.id) as { prompt: string | null; prompt_summary: string; status: string };
  assert.equal(stored.prompt, null);
  assert.equal(stored.prompt_summary, "");
  assert.equal(stored.status, "deleted");

  const orphan = path.join(fixture.archiveRoot, `${"a".repeat(43)}.png`);
  const temporary = path.join(fixture.archiveRoot, `.${"b".repeat(43)}.1234-deadbeef.tmp`);
  await writeFile(orphan, PNG);
  await writeFile(temporary, PNG);
  const old = new Date(fixture.now.value - IMAGE_PREVIEW_ORPHAN_MIN_AGE_MS - 1);
  await Promise.all([utimes(orphan, old, old), utimes(temporary, old, old)]);
  const cleanup = await fixture.service.cleanup(fixture.now.value);
  assert.equal(cleanup.orphans, 1);
  assert.equal(cleanup.temp, 1);
  await assert.rejects(access(orphan));
  await assert.rejects(access(temporary));
});

test("purges metadata even when the private image path cannot be removed", async (t) => {
  const fixture = await createFixture(t);
  const source = await stage(fixture, "blocked-delete.png");
  const preview = await fixture.service.archive({
    groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "blocked-delete", prompt: "remove now",
    filePath: source, modelId: "primary", model: "image-model", fallbackUsed: false,
    mimeType: "image/png", byteSize: PNG.byteLength, now: fixture.now.value,
  });
  const privatePath = path.join(fixture.archiveRoot, `${preview.id}.png`);
  await rm(privatePath);
  await mkdir(privatePath);

  assert.equal(await fixture.service.remove(preview.id, fixture.now.value + 1), true);
  const deleted = fixture.db.db.prepare("SELECT prompt, prompt_summary, status FROM image_previews WHERE id = ?").get(preview.id) as {
    prompt: string | null; prompt_summary: string; status: string;
  };
  assert.equal(deleted.prompt, null);
  assert.equal(deleted.prompt_summary, "");
  assert.equal(deleted.status, "deleted");

  const expiringSource = await stage(fixture, "blocked-expiry.png");
  const expiring = await fixture.service.archive({
    groupId: "group-1", creatorUserId: "member-1", sourceMessageId: "blocked-expiry", prompt: "expire now",
    filePath: expiringSource, modelId: "primary", model: "image-model", fallbackUsed: false,
    mimeType: "image/png", byteSize: PNG.byteLength, now: fixture.now.value, expiresAt: fixture.now.value + 10,
  });
  const expiringPath = path.join(fixture.archiveRoot, `${expiring.id}.png`);
  await rm(expiringPath);
  await mkdir(expiringPath);
  const cleanup = await fixture.service.cleanup(fixture.now.value + 10);
  assert.equal(cleanup.expired, 1);
  const expired = fixture.db.db.prepare("SELECT prompt, prompt_summary, status FROM image_previews WHERE id = ?").get(expiring.id) as {
    prompt: string | null; prompt_summary: string; status: string;
  };
  assert.equal(expired.prompt, null);
  assert.equal(expired.prompt_summary, "");
  assert.equal(expired.status, "expired");
});

async function createFixture(t: test.TestContext): Promise<{
  root: string;
  archiveRoot: string;
  stagedRoot: string;
  db: SharedDb;
  now: { value: number };
  service: ImagePreviewArchiveService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-preview-archive-"));
  const db = new SharedDb(path.join(root, "shared.db"));
  const now = { value: Date.UTC(2026, 9, 22, 12, 0, 0) };
  const archiveRoot = path.join(root, "generated-image-previews");
  const stagedRoot = path.join(root, "generated-images");
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    archiveRoot,
    stagedRoot,
    db,
    now,
    service: new ImagePreviewArchiveService({
      sharedDb: db,
      rootDir: archiveRoot,
      stagedRoot,
      now: () => now.value,
    }),
  };
}

async function stage(fixture: { stagedRoot: string }, name: string): Promise<string> {
  const target = path.join(fixture.stagedRoot, name);
  await mkdir(fixture.stagedRoot, { recursive: true });
  await writeFile(target, PNG, { mode: 0o600 });
  return target;
}
