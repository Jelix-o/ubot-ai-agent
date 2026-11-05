import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { SharedDb } from "../shared/sqlite.js";
import { RequestIntentRepository } from "./request-intent-repository.js";
import type { RequestUnderstanding } from "./request-understanding.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "request-intent-persistence-"));
  const file = path.join(root, "state.db");
  const db = new SharedDb(file), other = new SharedDb(file);
  t.after(() => { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (text: string) => db.insertMessage({ groupId: "test-group", userId: "member-a", selfId: "test-bot",
    msgId: String(Math.random()), msgTime: 1000, createdAt: 1000, text, imagesJson: "[]", hasAtBot: true, isBotMsg: false });
  const evidence = add("A fictional historical question"), source = add("");
  const repo = new RequestIntentRepository(db);
  const claim = repo.claim(source);
  assert.equal(claim.state, "claimed");
  if (claim.state !== "claimed") throw new Error("claim failed");
  const decision: RequestUnderstanding = { action: "chat", relation: "follow_up", sourceRowIds: [evidence, source],
    missingFields: [], modelId: "test-judge", model: "test-judge" };
  return { db, other, repo, source, evidence, file, token: claim.token, decision };
}

test("intent completion prevents a concurrent WAL commit between its read and write", t => {
  const f = fixture(t);
  f.other.db.exec("PRAGMA busy_timeout=0");
  const prepare = f.db.db.prepare.bind(f.db.db);
  let blocked = false;
  t.mock.method(f.db.db, "prepare", (sql: string) => {
    const stmt = prepare(sql);
    if (sql === "SELECT text FROM messages WHERE id=?") {
      const get = stmt.get.bind(stmt);
      t.mock.method(stmt, "get", (...args: Parameters<typeof get>) => {
        const value = get(...args);
        try { f.other.db.prepare("UPDATE messages SET text=? WHERE id=?").run("Concurrent update", f.evidence); }
        catch (error) { blocked = true; assert.equal((error as { errcode: number }).errcode & 0xff, 5); }
        return value;
      });
    }
    return stmt;
  });
  assert.equal(f.repo.complete(f.source, f.token, f.decision), true);
  assert.equal(blocked, true, "the writer must be acquired before the first read");
  assert.deepEqual(f.repo.get(f.source)?.result, f.decision);
  assert.equal(f.other.db.prepare("UPDATE messages SET text=? WHERE id=?").run("Update after commit", f.evidence).changes, 1);
});

test("completion rolls back both the result and partially consumed evidence", t => {
  const f = fixture(t);
  const consume = f.repo.consume.bind(f.repo);
  const injected = t.mock.method(f.repo, "consume", (source: number, ids: number[]) => {
    consume(source, ids);
    throw new Error("test persistence failure");
  });
  assert.throws(() => f.repo.complete(f.source, f.token, f.decision), /test persistence failure/);
  assert.equal(f.repo.get(f.source)?.status, "classifying");
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM request_intent_evidence").get()?.n, 0);
  injected.mock.restore();
  assert.equal(f.repo.complete(f.source, f.token, f.decision), true);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM request_intent_evidence").get()?.n, 1);
});

test("completion checks the clock after waiting for an independent writer", async t => {
  const f = fixture(t);
  const ready = new Int32Array(new SharedArrayBuffer(8));
  const writer = new Worker(`
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const state=new Int32Array(workerData.state);
    const db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    Atomics.store(state,0,1); Atomics.notify(state,0);
    Atomics.wait(state,1,0,300);
    db.exec('COMMIT'); db.close(); parentPort.postMessage('released');
  `, { eval: true, workerData: { file: f.file, state: ready.buffer } });
  const finished = new Promise<void>((resolve, reject) => { writer.once("message", () => resolve()); writer.once("error", reject); });
  t.after(async () => { await writer.terminate(); });
  assert.notEqual(Atomics.wait(ready, 0, 0, 5000), "timed-out");
  // Cross the real lease deadline only after the competing writer releases its
  // lock, without making the test wait the entire thirty-second lease.
  const expires = Number(f.db.db.prepare("SELECT lease_expires_at FROM request_intent_routes WHERE source_row_id=?").get(f.source)?.lease_expires_at);
  const exec = f.db.db.exec.bind(f.db.db);
  const clock = t.mock.method(Date, "now", () => expires - 1);
  t.mock.method(f.db.db, "exec", (sql: string) => {
    const value = exec(sql);
    if (sql === "BEGIN IMMEDIATE") clock.mock.mockImplementation(() => expires + 1);
    return value;
  });
  assert.equal(f.repo.complete(f.source, f.token, f.decision), false);
  assert.equal(f.repo.get(f.source)?.status, "classifying");
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM request_intent_evidence").get()?.n, 0);
  await finished;
});

test("a stale completion token cannot save or consume evidence", t => {
  const f = fixture(t);
  assert.equal(f.repo.complete(f.source, "old-token", f.decision), false);
  assert.equal(f.repo.get(f.source)?.status, "classifying");
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM request_intent_evidence").get()?.n, 0);
  assert.equal(f.repo.complete(f.source, f.token, f.decision), true);
});
