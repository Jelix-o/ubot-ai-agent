import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { ImageIntentRouteRepository } from "./image-intent-route-repository.js";
import {
  ImagePendingRequestRepository,
  parseImageIntentMaterialization,
  serializeImageIntentMaterialization,
} from "./image-pending-request-repository.js";

const NOW = Date.parse("2026-10-29T08:00:00.000Z");

test("pending image requests continue once and then consume the same-member wait", async t => {
  const fixture = await createFixture(t);
  const sourceRowId = insertMessage(fixture.db, "request");
  assert.equal(fixture.repository.settle({ sourceRowId, outcome: "waiting", now: NOW }), true);

  const firstFollowupId = insertMessage(fixture.db, "followup-1");
  const pending = fixture.repository.get(firstFollowupId, NOW + 1);
  assert.deepEqual(pending, {
    sourceRowId,
    latestSourceRowId: sourceRowId,
    expiresAt: NOW + 120_000,
  });
  assert.ok(pending);
  assert.equal(
    fixture.repository.settle({
      sourceRowId: firstFollowupId,
      outcome: "waiting",
      continuation: pending,
      now: NOW + 1,
    }),
    true,
  );

  const secondFollowupId = insertMessage(fixture.db, "followup-2");
  const continued = fixture.repository.get(secondFollowupId, NOW + 2);
  assert.deepEqual(continued, {
    sourceRowId,
    latestSourceRowId: firstFollowupId,
    expiresAt: NOW + 120_000,
  });
  assert.ok(continued);
  assert.equal(
    fixture.repository.settle({
      sourceRowId: secondFollowupId,
      outcome: "completed",
      continuation: continued,
      now: NOW + 2,
    }),
    true,
  );
  assert.equal(fixture.repository.get(insertMessage(fixture.db, "after-completion"), NOW + 3), undefined);
  const consumed = fixture.db.db.prepare("SELECT latest_source_row_id, status FROM image_pending_requests WHERE source_row_id = ?").get(sourceRowId) as {
    latest_source_row_id: number;
    status: string;
  };
  assert.equal(consumed.latest_source_row_id, secondFollowupId);
  assert.equal(consumed.status, "completed");
});

test("pending requests isolate members, expire, cancel, and reject a stale concurrent continuation", async t => {
  const fixture = await createFixture(t);
  const sourceRowId = insertMessage(fixture.db, "request");
  assert.equal(fixture.repository.settle({ sourceRowId, outcome: "waiting", now: NOW }), true);

  assert.equal(
    fixture.repository.get(insertMessage(fixture.db, "another-user", { userId: "member-2" }), NOW + 1),
    undefined,
  );
  assert.equal(
    fixture.repository.get(insertMessage(fixture.db, "another-group", { groupId: "group-2" }), NOW + 1),
    undefined,
  );

  const followupId = insertMessage(fixture.db, "followup");
  const pending = fixture.repository.get(followupId, NOW + 1);
  assert.ok(pending);
  assert.equal(
    fixture.repository.settle({ sourceRowId: followupId, outcome: "cancelled", continuation: pending, now: NOW + 1 }),
    true,
  );
  assert.equal(
    fixture.repository.settle({ sourceRowId: followupId, outcome: "completed", continuation: pending, now: NOW + 1 }),
    false,
    "only one concurrent continuation may consume a waiting request",
  );

  const expiredSourceId = insertMessage(fixture.db, "expired-request", { userId: "member-3" });
  assert.equal(fixture.repository.settle({ sourceRowId: expiredSourceId, outcome: "waiting", now: NOW }), true);
  assert.equal(
    fixture.repository.get(insertMessage(fixture.db, "expired-followup", { userId: "member-3" }), NOW + 120_000),
    undefined,
  );
});

test("a resolved new request replaces a prior wait and prevents an older classifier from restoring it", async t => {
  const fixture = await createFixture(t);
  const waitingSourceId = insertMessage(fixture.db, "old-request");
  assert.equal(fixture.repository.settle({ sourceRowId: waitingSourceId, outcome: "waiting", now: NOW }), true);
  const resolvedSourceId = insertMessage(fixture.db, "new-request");
  assert.equal(fixture.repository.settle({ sourceRowId: resolvedSourceId, outcome: "completed", now: NOW + 1 }), true);
  assert.equal(
    (fixture.db.db.prepare("SELECT status FROM image_pending_requests WHERE source_row_id = ?").get(waitingSourceId) as { status: string }).status,
    "cancelled",
  );
  assert.equal(
    fixture.db.db.prepare("SELECT count(*) AS count FROM image_pending_requests WHERE source_row_id = ?").get(resolvedSourceId)?.count,
    1,
  );
  assert.equal(fixture.repository.settle({ sourceRowId: waitingSourceId, outcome: "waiting", now: NOW + 2 }), false);
  assert.equal(fixture.repository.get(insertMessage(fixture.db, "after-new-request"), NOW + 3), undefined);
});

test("a failed route commit rolls back pending consumption in the same transaction", async t => {
  const fixture = await createFixture(t);
  const routes = new ImageIntentRouteRepository(fixture.db);
  const sourceRowId = insertMessage(fixture.db, "waiting");
  fixture.repository.settle({ sourceRowId, outcome: "waiting", now: NOW });
  const followupId = insertMessage(fixture.db, "followup");
  const pending = fixture.repository.get(followupId, NOW + 1);
  assert.ok(pending);
  const claim = routes.claim({ sourceRowId: followupId, now: NOW, leaseMs: 1_000 });
  assert.equal(claim.state, "claimed");
  if (claim.state !== "claimed") return;
  assert.throws(() => routes.runAtomically(() => {
    assert.equal(fixture.repository.settle({ sourceRowId: followupId, outcome: "completed", continuation: pending, now: NOW + 1 }), true);
    const completed = routes.complete({ sourceRowId: followupId, leaseToken: claim.leaseToken, action: "generate", now: NOW + 1_000 });
    if (!completed) throw new Error("route_commit_failed");
  }), /route_commit_failed/);
  assert.deepEqual(fixture.repository.get(followupId, NOW + 2), pending);
});

test("materialization metadata is reconstructed from an allowlist without durable content fields", () => {
  assert.deepEqual(
    parseImageIntentMaterialization(JSON.stringify({
      sourceRowIds: [11, 15],
      target: { sourceRowId: 11, start: 2, end: 5 },
      missingFields: ["instruction"],
      pendingSourceRowId: 11,
      cancelled: false,
    })),
    {
      sourceRowIds: [11, 15],
      target: { sourceRowId: 11, start: 2, end: 5 },
      missingFields: ["instruction"],
      pendingSourceRowId: 11,
      cancelled: false,
    },
  );
  assert.equal(
    parseImageIntentMaterialization(JSON.stringify({
      sourceRowIds: [11],
      missingFields: [],
      prompt: "must never be read from the route ledger",
    })),
    undefined,
  );
  assert.equal(
    parseImageIntentMaterialization(JSON.stringify({
      sourceRowIds: [11],
      missingFields: ["target", "target"],
    })),
    undefined,
  );
  assert.equal(
    parseImageIntentMaterialization(JSON.stringify({
      sourceRowIds: [11],
      target: { sourceRowId: 11, start: 0, end: 2, text: "member" },
      missingFields: [],
    })),
    undefined,
  );
  assert.deepEqual(
    JSON.parse(serializeImageIntentMaterialization({ sourceRowIds: [11], missingFields: [] })),
    { sourceRowIds: [11], missingFields: [] },
  );
  assert.throws(
    () => serializeImageIntentMaterialization({
      sourceRowIds: [11],
      missingFields: [],
      prompt: "must never be persisted",
    } as never),
    /image_intent_materialization_invalid/,
  );
});

interface Fixture {
  root: string;
  db: SharedDb;
  repository: ImagePendingRequestRepository;
}

async function createFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-pending-"));
  const db = new SharedDb(path.join(root, "shared.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, repository: new ImagePendingRequestRepository(db) };
}

function insertMessage(
  db: SharedDb,
  msgId: string,
  input: { groupId?: string; userId?: string } = {},
): number {
  return db.insertMessage({
    groupId: input.groupId ?? "group-1",
    userId: input.userId ?? "member-1",
    selfId: "bot-1",
    msgId,
    msgTime: NOW,
    text: "pending image request",
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: NOW,
  });
}
