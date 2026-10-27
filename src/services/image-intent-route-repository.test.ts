import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { ImageIntentRouteRepository } from "./image-intent-route-repository.js";

const NOW = Date.parse("2026-10-26T08:00:00.000Z");

test("claims one source row once and reuses a completed classified route", async (t) => {
  const fixture = await createFixture(t);
  const sourceRowId = insertMessage(fixture.db, "route-classified");

  const initial = fixture.repository.claim({ sourceRowId, now: NOW, leaseMs: 1_000 });
  assert.equal(initial.state, "claimed");
  if (initial.state !== "claimed") throw new Error("expected claimed image intent route");
  assert.equal(initial.created, true);
  assert.equal(initial.route.modelId, undefined);
  assert.equal(initial.route.model, undefined);

  const duplicate = fixture.repository.claim({ sourceRowId, now: NOW + 1, leaseMs: 1_000 });
  assert.equal(duplicate.state, "busy");
  assert.equal(duplicate.route.leaseToken, initial.leaseToken);

  const classified = fixture.repository.complete({
    sourceRowId,
    leaseToken: initial.leaseToken,
    action: "avatar_edit",
    modelId: "intent-primary",
    model: "fat-fish-router",
    now: NOW + 2,
  });
  assert.deepEqual(
    pickRoute(classified),
    {
      status: "classified",
      action: "avatar_edit",
      modelId: "intent-primary",
      model: "fat-fish-router",
      errorCode: undefined,
      classifiedAt: NOW + 2,
      unavailableAt: undefined,
    },
  );

  const replay = fixture.repository.claim({
    sourceRowId,
    modelId: "another-model",
    model: "must-not-overwrite",
    now: NOW + 3,
  });
  assert.equal(replay.state, "resolved");
  assert.deepEqual(pickRoute(replay.route), pickRoute(classified));
  assert.equal(
    fixture.repository.complete({
      sourceRowId,
      leaseToken: initial.leaseToken,
      action: "generate",
      now: NOW + 3,
    }),
    undefined,
    "a terminal route cannot be rewritten by a repeated Worker stage",
  );

  const columns = fixture.db.db.prepare("PRAGMA table_info(image_intent_routes)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const prohibited of ["group_id", "user_id", "source_message_id", "prompt", "text", "target_user_id"]) {
    assert.equal(names.has(prohibited), false, `${prohibited} must not enter the route ledger`);
  }
  assert.ok(fixture.db.listSchemaMigrations().some((migration) => migration.version === 27));
});

test("turns expired classifier leases into terminal unknown results without resubmitting", async (t) => {
  const fixture = await createFixture(t);
  const sourceRowId = insertMessage(fixture.db, "route-recovery");
  const original = fixture.repository.claim({
    sourceRowId,
    modelId: "intent-old",
    model: "old-router",
    now: NOW,
    leaseMs: 1_000,
  });
  assert.equal(original.state, "claimed");
  if (original.state !== "claimed") throw new Error("expected claimed image intent route");

  const live = fixture.repository.claim({ sourceRowId, now: NOW + 999, leaseMs: 1_000 });
  assert.equal(live.state, "busy");

  const expired = fixture.repository.claim({
    sourceRowId,
    modelId: "intent-new",
    model: "new-router",
    now: NOW + 1_000,
    leaseMs: 2_000,
  });
  assert.equal(expired.state, "resolved");
  assert.deepEqual(
    pickRoute(expired.route),
    {
      status: "unavailable",
      action: undefined,
      modelId: "intent-old",
      model: "old-router",
      errorCode: "result_unknown",
      classifiedAt: undefined,
      unavailableAt: NOW + 1_000,
    },
  );

  assert.equal(
    fixture.repository.complete({
      sourceRowId,
      leaseToken: original.leaseToken,
      action: "edit",
      now: NOW + 1_001,
    }),
    undefined,
  );
  assert.equal(
    fixture.repository.renewLease({
      sourceRowId,
      leaseToken: original.leaseToken,
      now: NOW + 1_001,
    }),
    false,
  );

});

test("persists unavailable routes as terminal failures without retrying the classifier", async (t) => {
  const fixture = await createFixture(t);
  const unavailableRowId = insertMessage(fixture.db, "route-no-model");
  const firstUnavailable = fixture.repository.recordUnavailable({
    sourceRowId: unavailableRowId,
    errorCode: "intent_model_unavailable",
    now: NOW,
  });
  assert.equal(firstUnavailable.created, true);
  assert.deepEqual(
    pickRoute(firstUnavailable.route),
    {
      status: "unavailable",
      action: undefined,
      modelId: undefined,
      model: undefined,
      errorCode: "intent_model_unavailable",
      classifiedAt: undefined,
      unavailableAt: NOW,
    },
  );
  const unavailableReplay = fixture.repository.claim({ sourceRowId: unavailableRowId, now: NOW + 1 });
  assert.equal(unavailableReplay.state, "resolved");
  assert.equal(unavailableReplay.route.status, "unavailable");

  const failedRowId = insertMessage(fixture.db, "route-tool-invalid");
  const claimed = fixture.repository.claim({ sourceRowId: failedRowId, now: NOW, leaseMs: 1_000 });
  assert.equal(claimed.state, "claimed");
  if (claimed.state !== "claimed") throw new Error("expected claimed image intent route");
  const unavailable = fixture.repository.markUnavailable({
    sourceRowId: failedRowId,
    leaseToken: claimed.leaseToken,
    errorCode: "invalid_tool_result",
    modelId: "intent-primary",
    model: "fat-fish-router",
    now: NOW + 1,
  });
  assert.deepEqual(
    pickRoute(unavailable),
    {
      status: "unavailable",
      action: undefined,
      modelId: "intent-primary",
      model: "fat-fish-router",
      errorCode: "invalid_tool_result",
      classifiedAt: undefined,
      unavailableAt: NOW + 1,
    },
  );
  assert.equal(
    fixture.repository.markUnavailable({
      sourceRowId: failedRowId,
      leaseToken: claimed.leaseToken,
      errorCode: "timeout",
      now: NOW + 2,
    }),
    undefined,
  );
  const failedReplay = fixture.repository.claim({ sourceRowId: failedRowId, now: NOW + 2 });
  assert.equal(failedReplay.state, "resolved");
  assert.equal(failedReplay.route.errorCode, "invalid_tool_result");
});

test("requires a persisted message source and bounded controlled metadata", async (t) => {
  const fixture = await createFixture(t);
  assert.throws(
    () => fixture.repository.claim({ sourceRowId: 999_999, now: NOW }),
    /image_intent_route_source_row_not_found/,
  );
  const sourceRowId = insertMessage(fixture.db, "route-validation");
  assert.throws(
    () => fixture.repository.claim({ sourceRowId, modelId: "intent-only", now: NOW }),
    /image_intent_route_model_metadata_invalid/,
  );
  assert.throws(
    () => fixture.repository.recordUnavailable({ sourceRowId, errorCode: "contains spaces", now: NOW }),
    /image_intent_route_error_code_invalid/,
  );
  assert.throws(
    () => fixture.repository.claim({ sourceRowId, leaseMs: 999, now: NOW }),
    /image_intent_route_lease_invalid/,
  );
});

function pickRoute(route: ReturnType<ImageIntentRouteRepository["getBySourceRow"]>): {
  status: string | undefined;
  action: string | undefined;
  modelId: string | undefined;
  model: string | undefined;
  errorCode: string | undefined;
  classifiedAt: number | undefined;
  unavailableAt: number | undefined;
} {
  return {
    status: route?.status,
    action: route?.action,
    modelId: route?.modelId,
    model: route?.model,
    errorCode: route?.errorCode,
    classifiedAt: route?.classifiedAt,
    unavailableAt: route?.unavailableAt,
  };
}

function insertMessage(db: SharedDb, msgId: string): number {
  return db.insertMessage({
    groupId: "group-1",
    userId: "member-1",
    selfId: "bot-1",
    msgId,
    msgTime: NOW,
    text: "intent route source",
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: NOW,
  });
}

interface Fixture {
  root: string;
  db: SharedDb;
  repository: ImageIntentRouteRepository;
}

async function createFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-image-intent-route-"));
  const db = new SharedDb(path.join(root, "shared.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    repository: new ImageIntentRouteRepository(db),
  };
}
