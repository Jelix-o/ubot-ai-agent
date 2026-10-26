import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { createImagePreviewId, ImagePreviewRepository } from "./image-preview-repository.js";
import {
  ImageRequestRepository,
  type ImageRequestRecord,
} from "./image-request-repository.js";

const NOW = Date.parse("2026-10-26T08:00:00.000Z");

test("claims one durable request per inbound message and verifies its source row", async (t) => {
  const fixture = await createFixture(t);
  const sourceRowId = insertMessage(fixture.db, "message-1");
  const first = fixture.repository.claim({
    groupId: "group-1",
    sourceMessageId: "message-1",
    sourceRowId,
    creatorUserId: "member-1",
    requestKind: "generation",
    triggerSource: "natural",
    now: NOW,
  });
  const duplicate = fixture.repository.claim({
    groupId: "group-1",
    sourceMessageId: "message-1",
    sourceRowId,
    creatorUserId: "member-1",
    requestKind: "generation",
    triggerSource: "natural",
    now: NOW + 1,
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.request.id, first.request.id);
  assert.equal(duplicate.request.upstreamRequestKey, first.request.upstreamRequestKey);
  assert.equal(fixture.repository.getSafeBySource("group-1", "message-1")?.status, "accepted");
  assert.throws(
    () => fixture.repository.claim({
      groupId: "group-1",
      sourceMessageId: "wrong-message",
      sourceRowId,
      creatorUserId: "member-1",
      requestKind: "generation",
      triggerSource: "natural",
    }),
    /image_request_source_row_mismatch/,
  );
  assert.ok(fixture.db.listSchemaMigrations().some(row => row.version === 25));
});

test("quarantines accepted, submitting, and generated requests without reopening their submission boundary", async (t) => {
  const fixture = await createFixture(t);
  const accepted = claim(fixture, "message-2-accepted");
  const submitting = claim(fixture, "message-2-submitting");
  const generated = claim(fixture, "message-2-generated");
  assert.equal(fixture.repository.beginSubmission(submitting.id, NOW)?.status, "submitting");
  assert.equal(fixture.repository.beginSubmission(generated.id, NOW)?.status, "submitting");
  assert.ok(fixture.repository.recordGenerated({
    id: generated.id,
    stagedFilePath: path.join(fixture.root, "unpublished.png"),
    modelId: "image-primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: 68,
    now: NOW + 1,
  }));

  for (const request of [accepted, submitting, generated]) {
    const unknown = fixture.repository.markOutcomeUnknown(request.id, "upstream_timeout", NOW + 2);
    assert.equal(unknown?.status, "outcome_unknown");
    assert.equal(fixture.repository.beginSubmission(request.id, NOW + 3), undefined);
    assert.equal(fixture.repository.markFailed(request.id, "content_blocked", NOW + 4), undefined);
  }
});

test("links preview and generated-image Outbox atomically, then upgrades on QQ receipt", async (t) => {
  const fixture = await createFixture(t);
  const request = claim(fixture, "message-3");
  assert.ok(fixture.repository.beginSubmission(request.id, NOW));
  assert.ok(fixture.repository.recordGenerated({
    id: request.id,
    stagedFilePath: path.join(fixture.root, "staged.png"),
    modelId: "image-primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: 68,
    outputSize: "864x1536",
    now: NOW + 1,
  }));
  const preview = createPreview(fixture, "message-3");
  assert.throws(
    () => fixture.db.enqueueOutbox(
      "group-1",
      null,
      path.join(fixture.root, "staged.png"),
      "generated_image",
      undefined,
      undefined,
      undefined,
      preview.id,
    ),
    /image_preview_delivery_invalid/,
    "the generic Outbox path must not bypass a worker-owned pending preview",
  );
  assert.equal(
    (fixture.db.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'generated_image'").get() as { count: number }).count,
    0,
  );
  const queued = fixture.db.enqueueGeneratedImageOutboxForRequest({
    requestId: request.id,
    groupId: "group-1",
    imagePath: path.join(fixture.root, "staged.png"),
    imagePreviewId: preview.id,
    now: NOW + 2,
  });
  const replay = fixture.db.enqueueGeneratedImageOutboxForRequest({
    requestId: request.id,
    groupId: "group-1",
    imagePath: path.join(fixture.root, "other.png"),
    imagePreviewId: preview.id,
    now: NOW + 3,
  });

  assert.equal(queued.created, true);
  assert.deepEqual(replay, { outboxId: queued.outboxId, created: false });
  const beforeReceipt = fixture.repository.getForImagePreview("group-1", preview.id);
  assert.deepEqual(
    {
      status: beforeReceipt?.status,
      outboxId: beforeReceipt?.outboxId,
      imagePreviewId: beforeReceipt?.imagePreviewId,
      outputSize: beforeReceipt?.outputSize,
    },
    { status: "queued", outboxId: queued.outboxId, imagePreviewId: preview.id, outputSize: "864x1536" },
  );
  assert.equal("upstreamRequestKey" in (beforeReceipt ?? {}), false);
  assert.equal("stagedFilePath" in (beforeReceipt ?? {}), false);

  fixture.db.ackOutboxDelivery(queued.outboxId, "qq-image-1", NOW + 4);
  const delivered = fixture.repository.getSafe(request.id);
  assert.deepEqual(
    { status: delivered?.status, errorCode: delivered?.errorCode, completedAt: delivered?.completedAt },
    { status: "delivered", errorCode: undefined, completedAt: NOW + 1 },
  );
  const output = fixture.db.db.prepare(
    "SELECT output_message_id FROM image_previews WHERE id = ?",
  ).get(preview.id) as { output_message_id: string | null };
  assert.equal(output.output_message_id, "qq-image-1");
  const publication = fixture.db.db.prepare(
    "SELECT publication_state FROM image_previews WHERE id = ?",
  ).get(preview.id) as { publication_state: string };
  assert.equal(publication.publication_state, "published");
});

test("rolls back the Outbox and ledger link when a pending preview cannot be published", async (t) => {
  const fixture = await createFixture(t);
  const request = claim(fixture, "message-publish-rollback");
  assert.ok(fixture.repository.beginSubmission(request.id, NOW));
  assert.ok(fixture.repository.recordGenerated({
    id: request.id,
    stagedFilePath: path.join(fixture.root, "staged.png"),
    modelId: "image-primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: 68,
    now: NOW + 1,
  }));
  const preview = createPreview(fixture, "message-publish-rollback");
  fixture.db.db.prepare("UPDATE image_previews SET publication_state = 'published' WHERE id = ?").run(preview.id);

  assert.throws(() => fixture.db.enqueueGeneratedImageOutboxForRequest({
    requestId: request.id,
    groupId: "group-1",
    imagePath: path.join(fixture.root, "staged.png"),
    imagePreviewId: preview.id,
    now: NOW + 2,
  }), /image_request_preview_not_pending/);
  assert.equal(fixture.repository.get(request.id)?.status, "generated");
  assert.equal(fixture.repository.get(request.id)?.imagePreviewId, undefined);
  assert.equal(
    (fixture.db.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'generated_image'").get() as { count: number }).count,
    0,
  );
});

test("terminal Outbox failure becomes delivery_unknown and a late receipt remains authoritative", async (t) => {
  const fixture = await createFixture(t);
  const request = claim(fixture, "message-4");
  fixture.repository.beginSubmission(request.id, NOW);
  fixture.repository.recordGenerated({
    id: request.id, stagedFilePath: path.join(fixture.root, "staged.png"), modelId: "primary", model: "image",
    fallbackUsed: false, mimeType: "image/png", byteSize: 1, now: NOW + 1,
  });
  const preview = createPreview(fixture, "message-4");
  const queued = fixture.db.enqueueGeneratedImageOutboxForRequest({
    requestId: request.id, groupId: "group-1", imagePath: path.join(fixture.root, "staged.png"), imagePreviewId: preview.id, now: NOW + 2,
  });
  fixture.db.db.prepare("UPDATE outbox SET attempts = 3 WHERE id = ?").run(queued.outboxId);
  fixture.db.markOutboxFailed(queued.outboxId, 1_000);
  assert.deepEqual(
    pickDelivery(fixture.repository.getSafe(request.id)),
    { status: "delivery_unknown", errorCode: "delivery_unknown" },
  );

  fixture.db.ackOutboxDelivery(queued.outboxId, "late-qq-image", NOW + 3);
  assert.deepEqual(pickDelivery(fixture.repository.getSafe(request.id)), { status: "delivered", errorCode: undefined });
});

function pickDelivery(record: ReturnType<ImageRequestRepository["getSafe"]>): { status: string | undefined; errorCode: string | undefined } {
  return { status: record?.status, errorCode: record?.errorCode };
}

function claim(fixture: Fixture, messageId: string): ImageRequestRecord {
  const sourceRowId = insertMessage(fixture.db, messageId);
  return fixture.repository.claim({
    groupId: "group-1",
    sourceMessageId: messageId,
    sourceRowId,
    creatorUserId: "member-1",
    requestKind: "edit",
    triggerSource: "command",
    now: NOW,
  }).request;
}

function createPreview(fixture: Fixture, sourceMessageId: string) {
  return fixture.previewRepository.create({
    id: createImagePreviewId(),
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId,
    prompt: "private prompt",
    promptSummary: "private prompt",
    modelId: "image-primary",
    model: "image-model",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: 68,
    contentSha256: "a".repeat(64),
    publicationState: "pending",
    now: NOW,
  });
}

function insertMessage(db: SharedDb, msgId: string): number {
  return db.insertMessage({
    groupId: "group-1",
    userId: "member-1",
    selfId: "bot-1",
    msgId,
    msgTime: NOW,
    text: "image request",
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: NOW,
  });
}

interface Fixture {
  root: string;
  db: SharedDb;
  repository: ImageRequestRepository;
  previewRepository: ImagePreviewRepository;
}

async function createFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-request-"));
  const db = new SharedDb(path.join(root, "shared.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    repository: new ImageRequestRepository(db),
    previewRepository: new ImagePreviewRepository(db),
  };
}
