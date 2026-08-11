import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { InflightManager } from "./inflight-manager.js";

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inflight-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "bot-shared.db");
}

test("begin/end tracks the in-flight task and signal aborts after cancel", (t) => {
  const db = new SharedDb(tempDb(t));
  const manager = new InflightManager(db);
  const key = "10001:20001:t1";

  const { taskId, cancel } = manager.begin(key);
  const row = db.getInflight(key);
  assert.equal(row?.task_id, taskId);
  assert.equal(manager.signalFor(key).aborted, false);

  cancel();
  assert.equal(db.getInflight(key)?.cancel_requested, 1);
  assert.equal(manager.signalFor(key).aborted, true, "signal must reflect the cancel request");

  manager.end(key);
  assert.equal(db.getInflight(key), undefined);
  db.close();
});

test("new message older than 20s triggers cancel_and_rerun merge", (t) => {
  const db = new SharedDb(tempDb(t));
  const manager = new InflightManager(db, { cancelAfterMs: 20_000 });
  const key = "10001:20001:t1";
  manager.begin(key);
  const startedAt = db.getInflight(key)!.started_at;

  const decision = manager.decideNewMessage(key, "你到底回不回", startedAt + 25_000);
  assert.equal(decision.action, "merge");
  assert.equal(decision.reason, "cancel_and_rerun");
  assert.equal(decision.mergeText, "你到底回不回");
  assert.equal(db.getInflight(key)?.cancel_requested, 1, "must request cancel of the old task");
  db.close();
});

test("young task with append/correction text merges; long unrelated text is dropped", (t) => {
  const db = new SharedDb(tempDb(t));
  const manager = new InflightManager(db, { cancelAfterMs: 20_000, mergeShortTextChars: 10 });
  const key = "10001:20001:t1";
  manager.begin(key);
  const startedAt = db.getInflight(key)!.started_at;

  const append = manager.decideNewMessage(key, "补充一点：其实还有别的问题", startedAt + 5_000);
  assert.equal(append.action, "merge");
  assert.equal(append.reason, "append_correction");

  const short = manager.decideNewMessage(key, "快", startedAt + 6_000);
  assert.equal(short.action, "merge", "short messages are treated as follow-ups");

  const unrelated = manager.decideNewMessage(key, "帮我查一下今天杭州的天气怎么样", startedAt + 7_000);
  assert.equal(unrelated.action, "drop");
  assert.equal(unrelated.reason, "duplicate_trigger");
  assert.equal(db.getInflight(key)?.cancel_requested, 0);
  db.close();
});

test("decideNewMessage with no in-flight task drops (should never happen)", (t) => {
  const db = new SharedDb(tempDb(t));
  const manager = new InflightManager(db);
  const decision = manager.decideNewMessage("10001:20001:t1", "hi");
  assert.equal(decision.action, "drop");
  assert.equal(decision.reason, "no_inflight");
  db.close();
});
