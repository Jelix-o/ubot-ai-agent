import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { ConversationContextRepository, type ConversationRoute } from "./conversation-context-repository.js";
import { V3StateRepository } from "./v3-state-repository.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "conversation-orchestration-"));
  const file = path.join(dir, "bot.db");
  let db = new SharedDb(file);
  let repository = new ConversationContextRepository(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const add = (text: string, id: string, options: { userId?: string; groupId?: string; now?: number; image?: boolean; parent?: ConversationRoute; topicId?: string } = {}) => {
    const userId = options.userId ?? "a", groupId = options.groupId ?? "g", now = options.now ?? 1_000;
    const rowId = db.insertMessage({ groupId, userId, selfId: "bot", msgId: id, msgTime: now, text, imagesJson: options.image ? '[{"url":"https://example.test/image.png"}]' : "[]", hasAtBot: true, isBotMsg: false, createdAt: now });
    const route = repository.saveMessageRoute({ sourceRowId: rowId, groupId, userId, sourceMessageId: id, content: text, createdAt: now,
      routeReason: options.parent ? "resolved-follow-up" : "new-topic", branchId: options.parent?.branchId, topicId: options.parent?.topicId ?? options.topicId });
    return route;
  };
  const draft = (route: ConversationRoute, text: string) => {
    const id = db.enqueueOutbox("g", route.sourceMessageId, text, "text", { topicId: route.topicId, branchId: route.branchId, sourceTurnId: route.turnId });
    return id;
  };
  const publish = (route: ConversationRoute, ids: number[], content: string) => repository.appendAssistantTurn({ topicId: route.topicId, branchId: route.branchId, parentTurnId: route.turnId, content,
    createdAt: 1_500, deliveryId: `outbox:${ids[0]}`, deliveryIds: ids.map(id => `outbox:${id}`), stateUpdate: {
      value: { knownFacts: [{ userId: "a", text: "只有游戏时紧张", sourceMessageIds: [route.sourceMessageId] }], coveredPoints: ["喝水习惯建议"], questions: [{ key: "where", userId: "a", text: "只在游戏时吗", status: "answered" }] },
      route, sources: new Map([[route.sourceMessageId, "a"]]), expectedRevision: 0,
    } });
  return { get db() { return db; }, get repository() { return repository; }, add, draft, publish,
    reopen() { db.close(); db = new SharedDb(file); repository = new ConversationContextRepository(db); } };
}

test("queued, failed and partially delivered replies never mark unsent advice as explained, including after restart", t => {
  const f = fixture(t), route = f.add("只有打游戏时这样", "first");
  const one = f.draft(route, "第一条"), two = f.draft(route, "未发送建议");
  const answer = f.publish(route, [one, two], "第一条\n\n未发送建议");
  const read = () => f.repository.orchestration.readState(f.repository.getCausalTurns(route.branchId));
  assert.equal(read().revision, 0);
  f.db.markOutboxFailed(one, null);
  assert.equal(read().coveredPoints.length, 0);
  f.db.ackOutboxDelivery(one, "receipt-one", 2_000);
  // Bot passes already-filtered history to readState; do not treat that partial
  // text as proof that the entire structured state update was delivered.
  const filtered = f.repository.getCausalTurns(route.branchId).map(turn => turn.id === answer.id ? { ...turn, content: "第一条" } : turn);
  const partial = f.repository.orchestration.readState(filtered);
  assert.deepEqual(partial.coveredPoints, ["第一条"]);
  assert.equal(partial.knownFacts.length, 0);
  f.reopen();
  assert.deepEqual(read().coveredPoints, ["第一条"]);
  f.db.ackOutboxDelivery(two, "receipt-two", 3_000);
  assert.equal(read().knownFacts[0]?.userId, "a");
  assert.equal(read().questions[0]?.status, "answered");
});

test("a supplement supersedes unpublished drafts and cancels retryable deliveries, without merging another user", t => {
  const f = fixture(t), first = f.add("看图", "pic", { image: true });
  const store = f.repository.orchestration;
  store.registerTask(first, "g", "a", "new");
  store.setTaskStatus(first.sourceRowId, "running");
  const oldDraft = f.draft(first, "old draft");
  f.publish(first, [oldDraft], "old draft");
  f.db.markOutboxFailed(oldDraft, 2_000);
  const other = f.add("他在吹牛", "other", { userId: "b", topicId: first.topicId });
  store.registerTask(other, "g", "b", "supplement");
  assert.equal(store.isTaskCurrent(first.sourceRowId), true);
  const follow = f.add("看图说话", "follow", { parent: first, now: 16_000 });
  store.registerTask(follow, "g", "a", "supplement");
  assert.equal(store.isTaskCurrent(first.sourceRowId), false);
  assert.equal(store.isTaskCurrent(other.sourceRowId), true);
  assert.equal(f.db.db.prepare("SELECT status FROM outbox WHERE id = ?").get(oldDraft)?.status, "cancelled");
  assert.match(store.mergedInput(follow.sourceRowId, "g", "a").text!, /看图\n看图说话/);
  assert.equal(store.mergedInput(follow.sourceRowId, "g", "a").images.length, 1);
  assert.throws(() => f.publish(first, [], "late state"), /superseded/);
  assert.equal(store.readState(f.repository.getCausalTurns(follow.branchId)).knownFacts.length, 0);
});

test("sending/acknowledged replies cannot be replaced by a later supplement", t => {
  const f = fixture(t), first = f.add("原问题", "first");
  const store = f.repository.orchestration;
  store.registerTask(first, "g", "a", "new");
  const id = f.draft(first, "已进入发送");
  f.publish(first, [id], "已进入发送");
  f.db.claimOutbox(1);
  const follow = f.add("补充", "second", { parent: first, now: 2_000 });
  store.registerTask(follow, "g", "a", "supplement");
  assert.equal(store.isTaskCurrent(first.sourceRowId), true);
  assert.equal(store.mergedInput(follow.sourceRowId, "g", "a").text, undefined);
});

test("media association is scoped by author, group, receipt window and actual task state", t => {
  const f = fixture(t), first = f.add("战绩图", "pic", { image: true });
  f.repository.orchestration.registerTask(first, "g", "a", "new");
  f.add("other", "other-user-pic", { image: true, userId: "b", now: 2_000 });
  f.add("other group", "other-group-pic", { image: true, groupId: "elsewhere", now: 3_000 });
  const follow = f.add("看图说话", "follow", { parent: first, now: 16_000 });
  const store = f.repository.orchestration;
  assert.deepEqual(store.recentMedia("g", "a", follow.sourceRowId, 16_000).map(item => item.sourceMessageId), ["pic"]);
  assert.deepEqual(store.recentMedia("g", "a", follow.sourceRowId, 122_000), []);
  assert.deepEqual(store.mediaByIds("g", ["other-group-pic"], follow.sourceRowId), []);
  assert.deepEqual(store.pendingMedia(follow), [{ sourceMessageId: "pic", status: "queued" }]);
  store.setTaskStatus(first.sourceRowId, "running");
  assert.equal(store.pendingMedia(follow)[0].status, "processing");
  const out = f.draft(first, "看到战绩了");
  f.publish(first, [out], "看到战绩了");
  store.setTaskStatus(first.sourceRowId, "awaiting_delivery");
  assert.equal(store.pendingMedia(follow)[0].status, "awaiting_delivery");
  f.db.ackOutboxDelivery(out, "receipt", 17_000);
  assert.deepEqual(store.pendingMedia(follow), []);
});

test("state follows causal ancestors, never sibling branches, another group or an excluded author", t => {
  const f = fixture(t), root = f.add("根问题", "root");
  const left = f.add("左分支", "left", { topicId: root.topicId });
  const out = f.draft(left, "左分支建议");
  f.publish(left, [out], "左分支建议");
  f.db.ackOutboxDelivery(out, "left-receipt", 2_000);
  const sibling = f.add("右分支", "right", { topicId: root.topicId });
  const unrelated = f.add("其他群", "other", { groupId: "other" });
  const store = f.repository.orchestration;
  assert.equal(store.readState(f.repository.getCausalTurns(left.branchId)).knownFacts.length, 1);
  assert.equal(store.readState(f.repository.getCausalTurns(left.branchId), ["a"]).knownFacts.length, 0);
  assert.equal(store.readState(f.repository.getCausalTurns(sibling.branchId)).revision, 0);
  assert.equal(store.readState(f.repository.getCausalTurns(unrelated.branchId)).revision, 0);
});

test("shared-discussion conditions and quoted image observations survive recovery with group and author validation", t => {
  const f = fixture(t);
  const original = f.add("本人只在游戏时这样", "personal", { userId: "b", image: true });
  const foreign = f.add("other group", "foreign", { groupId: "elsewhere" });
  const question = f.add("你怎么看上面的情况", "evaluation");
  const out = f.draft(question, "已经给了看法");
  f.repository.appendAssistantTurn({ topicId: question.topicId, branchId: question.branchId, parentTurnId: question.turnId,
    content: "已经给了看法", createdAt: 1_500, deliveryId: `outbox:${out}`, deliveryIds: [`outbox:${out}`],
    stateUpdate: { route: question, expectedRevision: 0, sources: new Map([[original.sourceMessageId, "b"], [foreign.sourceMessageId, "a"]]), value: {
      knownFacts: [{ userId: "b", text: "只在游戏时这样", sourceMessageIds: [original.sourceMessageId] }, { userId: "a", text: "串群事实", sourceMessageIds: [foreign.sourceMessageId] }],
      mediaObservations: [{ sourceMessageId: original.sourceMessageId, text: "有一张战绩截图" }],
    } },
  });
  f.db.ackOutboxDelivery(out, "receipt", 2_000);
  f.reopen();
  const state = f.repository.orchestration.readState(f.repository.getCausalTurns(question.branchId));
  assert.deepEqual(state.knownFacts.map(fact => fact.userId), ["b"]);
  assert.equal(state.mediaObservations[0]?.sourceMessageId, original.sourceMessageId);
  assert.equal(f.repository.orchestration.readState(f.repository.getCausalTurns(question.branchId), ["b"]).knownFacts.length, 0);
});

test("legacy direct replies are committed and cannot be cancelled as unpublished outbox drafts", t => {
  const f = fixture(t), first = f.add("第一个问题", "first");
  f.repository.orchestration.registerTask(first, "g", "a", "new");
  f.repository.appendAssistantTurn({ topicId: first.topicId, branchId: first.branchId, parentTurnId: first.turnId, content: "已直接发送", createdAt: 1_500, platformMessageId: "direct-receipt" });
  const second = f.add("补充", "second", { parent: first, now: 2_000 });
  f.repository.orchestration.registerTask(second, "g", "a", "supplement");
  assert.equal(f.repository.orchestration.isTaskCurrent(first.sourceRowId), true);
  assert.equal(f.repository.orchestration.mergedInput(second.sourceRowId, "g", "a").text, undefined);
});

test("acknowledged bot quotes remain recoverable when other members are excluded", t => {
  const f = fixture(t);
  const outboxId = f.db.enqueueOutbox("g", null, "机器人已经说过的话", "text");
  f.db.ackOutboxDelivery(outboxId, "bot-receipt", 2_000);

  assert.deepEqual(
    f.repository.orchestration.reference("g", "bot-receipt", Number.MAX_SAFE_INTEGER, ["opted-out-member"]),
    { messageId: "bot-receipt", text: "机器人已经说过的话", images: [] },
  );
});

test("raw retention removes recoverable short-term facts and source-bound plans/tasks", t => {
  const f = fixture(t), route = f.add("过期条件", "old");
  const store = f.repository.orchestration;
  store.registerTask(route, "g", "a", "new");
  store.saveResolution(route.sourceRowId, "g", "a", { intent: "chat", relation: "new", resolvedInput: "过期条件", selectedMessageIds: [], mediaSourceMessageIds: [], needsMoreContext: false, source: "rules" });
  const out = f.draft(route, "已经回答"); f.publish(route, [out], "已经回答");
  new V3StateRepository(f.db).pruneRawMessageRetention(1_100);
  for (const table of ["conversation_state_updates", "conversation_reply_tasks", "conversation_reply_plans"]) {
    assert.equal(f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
  }
});
