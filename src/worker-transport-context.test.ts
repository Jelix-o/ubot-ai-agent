import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "./shared/sqlite.js";
import { WorkerTransport } from "./worker-transport.js";
import { ConversationContextRepository } from "./services/conversation-context-repository.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meme-context-"));
  const file = path.join(dir, "state.db");
  let db = new SharedDb(file);
  let repository = new ConversationContextRepository(db);
  let transport = new WorkerTransport(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const answer = async (userId: string) => {
    const now = Date.now();
    const source = db.insertMessage({ groupId: "g1", userId, selfId: "bot", msgId: `question-${userId}`,
      msgTime: now, createdAt: now, text: `question from ${userId}`, imagesJson: "[]", hasAtBot: true, isBotMsg: false });
    const route = repository.saveMessageRoute({ sourceRowId: source, groupId: "g1", userId, sourceMessageId: `question-${userId}`,
      content: `question from ${userId}`, createdAt: now, routeReason: "new-topic" });
    const receipt = await transport.runWithRequestContext(source, () => transport.runWithConversationContext(route,
      () => transport.sendGroupMessage("g1", `answer for ${userId}`)));
    assert.ok(receipt?.deliveryId);
    const turn = repository.appendAssistantTurn({ topicId: route.topicId, branchId: route.branchId, parentTurnId: route.turnId,
      content: `answer for ${userId}`, createdAt: now, deliveryId: receipt.deliveryId, deliveryIds: [receipt.deliveryId] });
    const id = Number(receipt.deliveryId.split(":")[1]);
    db.ackOutboxDelivery(id, `answer-${id}`);
    return { source, route, turn, receipt, id };
  };
  return { get db() { return db; }, get repository() { return repository; }, get transport() { return transport; }, answer,
    reopen() { db.close(); db = new SharedDb(file); repository = new ConversationContextRepository(db); transport = new WorkerTransport(db); },
  };
}

test("concurrent accompanying memes bind to their exact parent answer and duplicate acknowledgments stay idempotent", async t => {
  const f = fixture(t);
  const a = await f.answer("member-a"), b = await f.answer("member-b");
  const receipts = await Promise.all([a, b].map(parent => f.transport.runWithRequestContext(parent.source,
    () => f.transport.sendMemeGroupImage("g1", "reaction", parent.receipt.deliveryId))));
  for (const [index, receipt] of receipts.entries()) {
    const parent = [a, b][index]!;
    const id = Number(receipt.deliveryId!.split(":")[1]);
    assert.equal(f.repository.getMessageContext("g1", `meme-${id}`), undefined);
    f.db.ackOutboxDelivery(id, `meme-${id}`);
    f.db.ackOutboxDelivery(id, `meme-${id}`);
    const anchor = f.repository.getMessageContext("g1", `meme-${id}`)!;
    assert.equal(anchor.turnId, parent.turn.id);
    assert.equal(anchor.branchId, parent.route.branchId);
    assert.equal(f.repository.orchestration.reference("g1", `meme-${id}`)?.text, parent.turn.content);
    assert.equal(f.repository.getMessageContext("g2", `meme-${id}`), undefined);
    assert.equal(f.repository.getCausalTurns(parent.route.branchId).length, 2);
    assert.equal(f.repository.getMessageContext("g1", `answer-${parent.id}`)?.turnId, parent.turn.id);
  }
  const wrongGroup = await f.transport.runWithRequestContext(a.source,
    () => f.transport.sendMemeGroupImage("g2", "reaction", a.receipt.deliveryId));
  const wrongId = Number(wrongGroup.deliveryId!.split(":")[1]);
  f.db.ackOutboxDelivery(wrongId, "wrong-group-meme");
  assert.equal(f.repository.getMessageContext("g2", "wrong-group-meme"), undefined);
});

test("legacy meme recovery survives a database restart and rejects ambiguity, withdrawal and unrelated requests", async t => {
  const f = fixture(t);
  const a = await f.answer("member-a"), b = await f.answer("member-b");
  const legacy = await f.transport.runWithRequestContext(a.source, () => f.transport.sendMemeGroupImage("g1", "legacy"));
  const id = Number(legacy.deliveryId!.split(":")[1]);
  f.db.ackOutboxDelivery(id, "legacy-meme");
  const orphan = await f.transport.sendMemeGroupImage("g1", "orphan");
  f.db.ackOutboxDelivery(Number(orphan.deliveryId!.split(":")[1]), "orphan-meme");
  f.reopen();
  assert.equal(f.repository.getMessageContext("g1", "legacy-meme")?.turnId, a.turn.id);
  assert.equal(f.repository.orchestration.reference("g1", "legacy-meme")?.text, a.turn.content);
  assert.equal(f.repository.getMessageContext("g1", "orphan-meme"), undefined);
  assert.equal(f.repository.getMessageContext("g2", "legacy-meme"), undefined);
  f.db.db.prepare("UPDATE outbox SET request_source_row_id=? WHERE id=?").run(a.source, b.id);
  assert.equal(f.repository.getMessageContext("g1", "legacy-meme"), undefined, "two possible answers must not choose a branch");
  f.db.db.prepare("UPDATE outbox SET request_source_row_id=? WHERE id=?").run(b.source, b.id);
  f.db.markRetracted("g1", "legacy-meme", Date.now());
  assert.equal(f.repository.getMessageContext("g1", "legacy-meme"), undefined);
  assert.equal(f.repository.orchestration.reference("g1", "legacy-meme"), undefined);
});
