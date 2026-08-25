import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { ConversationContextRepository } from "./conversation-context-repository.js";

function fixture(t: test.TestContext): { db: SharedDb; repository: ConversationContextRepository } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "context-repository-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, repository: new ConversationContextRepository(db) };
}

test("source DB row id makes route persistence idempotent across repository instances", (t) => {
  const { db, repository } = fixture(t);
  const first = repository.saveMessageRoute({
    sourceRowId: 11,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "m1",
    routeReason: "new-topic",
    content: "company question",
    createdAt: 1_000,
  });
  const reopened = new ConversationContextRepository(db);
  const duplicate = reopened.saveMessageRoute({
    sourceRowId: 11,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "m1",
    routeReason: "fail-closed",
    content: "must not replace the first turn",
    createdAt: 2_000,
  });

  assert.deepEqual(duplicate, first);
  assert.equal(repository.getCausalTurns(first.branchId).length, 1);
  assert.deepEqual(repository.getMessageContext("g1", "m1"), {
    groupId: "g1",
    platformMessageId: "m1",
    topicId: first.topicId,
    branchId: first.branchId,
    turnId: first.turnId,
    direction: "user",
    createdAt: 1_000,
  });
});

test("source row lookup is scoped by group", (t) => {
  const { db, repository } = fixture(t);
  const base = {
    userId: "u1", selfId: "bot", msgId: "same", msgTime: 1,
    text: "x", imagesJson: "[]", hasAtBot: true, isBotMsg: false, createdAt: 1,
  };
  const first = db.insertMessage({ ...base, groupId: "g1" });
  const second = db.insertMessage({ ...base, groupId: "g2" });
  assert.equal(repository.getSourceRowId("g1", "same"), first);
  assert.equal(repository.getSourceRowId("g2", "same"), second);
  assert.equal(repository.getSourceRowId("g3", "same"), undefined);
});

test("causal history follows parent turns and excludes sibling branches", (t) => {
  const { db, repository } = fixture(t);
  const root = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "question",
    routeReason: "new-topic",
    content: "root question",
    createdAt: 1,
  });
  const answer = repository.appendAssistantTurn({
    topicId: root.topicId,
    branchId: root.branchId,
    parentTurnId: root.turnId,
    content: "root answer",
    platformMessageId: "answer",
    createdAt: 2,
  });
  assert.equal(db.isKnownBotMessage("g1", "answer"), true);
  assert.equal(db.isKnownBotMessage("other-group", "answer"), false);
  const siblingA = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "reply-a",
    replyToMessageId: "answer",
    routeReason: "explicit-reply",
    topicId: root.topicId,
    parentTurnId: answer.id,
    content: "branch A",
    createdAt: 3,
  });
  const siblingB = repository.saveMessageRoute({
    sourceRowId: 3,
    groupId: "g1",
    userId: "u3",
    sourceMessageId: "reply-b",
    replyToMessageId: "answer",
    routeReason: "explicit-reply",
    topicId: root.topicId,
    branchId: siblingA.branchId,
    parentTurnId: answer.id,
    content: "branch B",
    createdAt: 4,
  });

  assert.equal(siblingA.routeReason, "explicit-reply");
  assert.equal(siblingB.routeReason, "explicit-reply-fork");
  assert.notEqual(siblingA.branchId, siblingB.branchId);
  assert.deepEqual(
    repository.getCausalTurns(siblingA.branchId).map((turn) => turn.content),
    ["root question", "root answer", "branch A"],
  );
  assert.deepEqual(
    repository.getCausalTurns(siblingB.branchId).map((turn) => turn.content),
    ["root question", "root answer", "branch B"],
  );
});

test("a late assistant reply is spliced before an already-routed same-branch follow-up", (t) => {
  const { repository } = fixture(t);
  const first = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "first",
    routeReason: "new-topic",
    content: "first question",
    createdAt: 1,
  });
  const queuedFollowUp = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "second",
    routeReason: "same-user-follow-up",
    topicId: first.topicId,
    branchId: first.branchId,
    parentTurnId: first.turnId,
    content: "second question",
    createdAt: 2,
  });

  assert.deepEqual(repository.getCausalTurnsBeforeTurn(first.branchId, first.turnId), []);
  assert.deepEqual(
    repository.getCausalTurnsBeforeTurn(queuedFollowUp.branchId, queuedFollowUp.turnId).map((turn) => turn.content),
    ["first question"],
  );

  const firstAnswer = repository.appendAssistantTurn({
    topicId: first.topicId,
    branchId: first.branchId,
    parentTurnId: first.turnId,
    content: "first answer",
    createdAt: 3,
  });

  assert.deepEqual(
    repository.getCausalTurns(queuedFollowUp.branchId).map((turn) => turn.content),
    ["first question", "first answer", "second question"],
  );
  assert.deepEqual(
    repository.getCausalTurnsBeforeTurn(queuedFollowUp.branchId, queuedFollowUp.turnId).map((turn) => turn.content),
    ["first question", "first answer"],
  );
  assert.deepEqual(repository.getCausalTurnsBeforeTurn(first.branchId, first.turnId), []);
  assert.equal(repository.getRouteBySourceRowId(2)?.parentTurnId, firstAnswer.id);
  assert.equal(repository.getBranch(first.branchId)?.headTurnId, queuedFollowUp.turnId);
});

test("late assistant reply does not rewrite an explicit reply's quoted parent", (t) => {
  const { repository } = fixture(t);
  const root = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "root",
    routeReason: "new-topic",
    content: "root question",
    createdAt: 1,
  });
  const quotedReply = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "quoted-reply",
    replyToMessageId: "root",
    routeReason: "explicit-reply",
    topicId: root.topicId,
    branchId: root.branchId,
    parentTurnId: root.turnId,
    content: "reply written before bot answer",
    createdAt: 2,
  });

  repository.appendAssistantTurn({
    topicId: root.topicId,
    branchId: root.branchId,
    parentTurnId: root.turnId,
    content: "late bot answer",
    createdAt: 3,
  });

  assert.equal(repository.getRouteBySourceRowId(quotedReply.sourceRowId)?.parentTurnId, root.turnId);
  assert.deepEqual(
    repository.getCausalTurns(quotedReply.branchId, quotedReply.turnId).map((turn) => turn.content),
    ["root question", "reply written before bot answer"],
  );
});

test("late assistant reply is spliced into an implicit continuation", (t) => {
  const { repository } = fixture(t);
  const root = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "root",
    routeReason: "new-topic",
    content: "root question",
    createdAt: 1,
  });
  const continuation = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "continuation",
    routeReason: "same-user-follow-up",
    topicId: root.topicId,
    branchId: root.branchId,
    parentTurnId: root.turnId,
    content: "continue",
    createdAt: 2,
  });
  const answer = repository.appendAssistantTurn({
    topicId: root.topicId,
    branchId: root.branchId,
    parentTurnId: root.turnId,
    content: "root answer",
    createdAt: 3,
  });

  assert.equal(repository.getRouteBySourceRowId(continuation.sourceRowId)?.parentTurnId, answer.id);
  assert.deepEqual(
    repository.getCausalTurns(continuation.branchId, continuation.turnId).map((turn) => turn.content),
    ["root question", "root answer", "continue"],
  );
  assert.deepEqual(
    repository.getCausalTurnsBeforeTurn(continuation.branchId, continuation.turnId).map((turn) => turn.content),
    ["root question", "root answer"],
  );
});

test("message anchors are isolated by group even when QQ ids collide", (t) => {
  const { repository } = fixture(t);
  const first = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "same-id",
    routeReason: "new-topic",
    content: "first group",
    createdAt: 1,
  });
  const second = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g2",
    userId: "u1",
    sourceMessageId: "same-id",
    routeReason: "new-topic",
    content: "second group",
    createdAt: 2,
  });

  assert.equal(repository.getMessageContext("g1", "same-id")?.topicId, first.topicId);
  assert.equal(repository.getMessageContext("g2", "same-id")?.topicId, second.topicId);
  assert.notEqual(first.topicId, second.topicId);
});

test("explicit reply resolver inherits a fresh anchor and fails closed for stale or missing anchors", (t) => {
  const { repository } = fixture(t);
  const root = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "root",
    routeReason: "new-topic",
    content: "root",
    createdAt: 1_000,
  });
  const answer = repository.appendAssistantTurn({
    topicId: root.topicId,
    branchId: root.branchId,
    content: "answer",
    platformMessageId: "answer-id",
    createdAt: 2_000,
  });
  const inherited = repository.saveExplicitReplyRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "fresh-reply",
    replyToMessageId: "answer-id",
    content: "fresh",
    createdAt: 3_000,
  }, 60_000);
  assert.equal(inherited.topicId, root.topicId);
  assert.equal(inherited.parentTurnId, answer.id);
  assert.equal(inherited.routeReason, "explicit-reply");

  const stale = repository.saveExplicitReplyRoute({
    sourceRowId: 3,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "stale-reply",
    replyToMessageId: "answer-id",
    content: "stale",
    createdAt: 100_000,
  }, 60_000);
  assert.notEqual(stale.topicId, root.topicId);
  assert.equal(stale.parentTurnId, undefined);
  assert.equal(stale.routeReason, "explicit-reply-miss");

  const missing = repository.saveExplicitReplyRoute({
    sourceRowId: 4,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "missing-reply",
    replyToMessageId: "unknown-id",
    content: "missing",
    createdAt: 4_000,
  }, 60_000);
  assert.notEqual(missing.topicId, root.topicId);
  assert.equal(missing.routeReason, "explicit-reply-miss");
});

test("user clear removes private context but preserves a topic used by another participant", (t) => {
  const { repository } = fixture(t);
  const privateRoute = repository.saveMessageRoute({
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "private",
    routeReason: "new-topic",
    content: "private topic",
    createdAt: 1,
  });
  const sharedRoot = repository.saveMessageRoute({
    sourceRowId: 2,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "shared-root",
    routeReason: "new-topic",
    content: "shared root",
    createdAt: 2,
  });
  const rootAnswer = repository.appendAssistantTurn({
    topicId: sharedRoot.topicId,
    branchId: sharedRoot.branchId,
    content: "shared answer",
    createdAt: 3,
  });
  const participant = repository.saveMessageRoute({
    sourceRowId: 3,
    groupId: "g1",
    userId: "u2",
    sourceMessageId: "participant",
    routeReason: "explicit-reply",
    topicId: sharedRoot.topicId,
    branchId: sharedRoot.branchId,
    parentTurnId: rootAnswer.id,
    content: "another participant",
    createdAt: 4,
  });

  repository.clearUser("g1", "u1");
  assert.equal(repository.getRouteBySourceRowId(privateRoute.sourceRowId), undefined);
  assert.ok(repository.getRouteBySourceRowId(participant.sourceRowId));
  assert.equal(repository.getActiveRoute("g1", "u1"), undefined);
  assert.ok(repository.getActiveRoute("g1", "u2"));
});

test("user clear removes an unshared private fork inside a shared topic", (t) => {
  const { db, repository } = fixture(t);
  const root = repository.saveMessageRoute({
    sourceRowId: 1, groupId: "g1", userId: "u2", sourceMessageId: "root",
    routeReason: "new-topic", content: "shared root", createdAt: 1,
  });
  const fork = repository.saveMessageRoute({
    sourceRowId: 2, groupId: "g1", userId: "u3", sourceMessageId: "shared-head",
    routeReason: "explicit-reply", topicId: root.topicId, branchId: root.branchId,
    parentTurnId: root.turnId, content: "advance shared head", createdAt: 2,
  });
  const privateFork = repository.saveMessageRoute({
    sourceRowId: 3, groupId: "g1", userId: "u1", sourceMessageId: "private-fork",
    routeReason: "explicit-reply", topicId: root.topicId, branchId: fork.branchId,
    parentTurnId: root.turnId, content: "private fork", createdAt: 3,
  });
  assert.notEqual(privateFork.branchId, root.branchId);
  db.registerInflight(`g1:${privateFork.branchId}`, "task", 4, "token");
  const privateDraft = db.enqueueOutbox("g1", null, "private draft", "text", {
    topicId: privateFork.topicId,
    branchId: privateFork.branchId,
    sourceTurnId: privateFork.turnId,
  });

  repository.clearUser("g1", "u1");

  assert.equal(repository.getBranch(privateFork.branchId), undefined);
  assert.equal(repository.getMessageContext("g1", "private-fork"), undefined);
  assert.equal(db.getInflight(`g1:${privateFork.branchId}`), undefined);
  const clearedDraft = db.db.prepare(
    "SELECT status, topic_id, branch_id, source_turn_id, turn_id FROM outbox WHERE id = ?",
  ).get(privateDraft) as {
    status: string;
    topic_id: string | null;
    branch_id: string | null;
    source_turn_id: number | null;
    turn_id: number | null;
  };
  assert.deepEqual({ ...clearedDraft }, {
    status: "cancelled",
    topic_id: null,
    branch_id: null,
    source_turn_id: null,
    turn_id: null,
  });
  assert.ok(repository.getBranch(root.branchId));
  assert.ok(repository.getMessageContext("g1", "root"));
});

test("assistant turn and multipart outbox publication roll back together", (t) => {
  const { db, repository } = fixture(t);
  const route = repository.saveMessageRoute({
    sourceRowId: 1, groupId: "g1", userId: "u1", sourceMessageId: "m1",
    routeReason: "new-topic", content: "question", createdAt: 1,
  });
  const validId = db.enqueueOutbox("g1", null, "part one", "text", {
    topicId: route.topicId,
    branchId: route.branchId,
  });

  assert.throws(
    () => repository.appendAssistantTurn({
      topicId: route.topicId,
      branchId: route.branchId,
      parentTurnId: route.turnId,
      content: "multipart reply",
      createdAt: 2,
      deliveryIds: [`outbox:${validId}`, "outbox:99999"],
    }),
    /does not exist/,
  );

  const assistantCount = db.db
    .prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE role = 'assistant'")
    .get() as { count: number };
  const outbox = db.db.prepare("SELECT status, turn_id FROM outbox WHERE id = ?").get(validId) as {
    status: string;
    turn_id: number | null;
  };
  assert.equal(assistantCount.count, 0);
  assert.deepEqual({ ...outbox }, { status: "preparing", turn_id: null });
});

test("group clear removes only that group and cutover keeps audit messages", (t) => {
  const { db, repository } = fixture(t);
  const g1 = repository.saveMessageRoute({
    sourceRowId: 1, groupId: "g1", userId: "u1", sourceMessageId: "m1",
    routeReason: "new-topic", content: "g1", createdAt: 1,
  });
  const g2 = repository.saveMessageRoute({
    sourceRowId: 2, groupId: "g2", userId: "u2", sourceMessageId: "m2",
    routeReason: "new-topic", content: "g2", createdAt: 2,
  });
  const g1Draft = db.enqueueOutbox("g1", null, "g1 draft", "text", {
    topicId: g1.topicId,
    branchId: g1.branchId,
    sourceTurnId: g1.turnId,
  });
  repository.clearGroup("g1");
  assert.equal(repository.getRouteBySourceRowId(g1.sourceRowId), undefined);
  assert.ok(repository.getRouteBySourceRowId(g2.sourceRowId));
  const clearedGroupDraft = db.db.prepare(
    "SELECT status, topic_id, branch_id, source_turn_id FROM outbox WHERE id = ?",
  ).get(g1Draft) as {
    status: string;
    topic_id: string | null;
    branch_id: string | null;
    source_turn_id: number | null;
  };
  assert.deepEqual({ ...clearedGroupDraft }, {
    status: "cancelled",
    topic_id: null,
    branch_id: null,
    source_turn_id: null,
  });

  const messageId = db.insertMessage({
    groupId: "g2", userId: "u2", selfId: "bot", msgId: "audit", msgTime: 3,
    text: "retained audit", imagesJson: "[]", hasAtBot: true, isBotMsg: false, createdAt: 3,
  });
  assert.ok(messageId > 0);
  assert.equal(repository.cutoverShortTermContext(), messageId);
  assert.equal(repository.getRouteBySourceRowId(g2.sourceRowId), undefined);
  const auditCount = db.db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
  assert.equal(auditCount.count, 1);
  assert.equal(db.pollMessages("post-cutover", 10).length, 0);
});
