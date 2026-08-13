import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import {
  ConversationContextRepository,
  type ConversationRoute,
  type SaveMessageRouteInput,
} from "./conversation-context-repository.js";
import {
  characterJaccard,
  ConversationContextRouter,
  isDirectFollowUp,
  type ConversationRouteInput,
} from "./conversation-context-router.js";

function fixture(t: test.TestContext): {
  db: SharedDb;
  repository: ConversationContextRepository;
  router: ConversationContextRouter;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "context-router-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  const repository = new ConversationContextRepository(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, repository, router: new ConversationContextRouter(repository) };
}

function input(overrides: Partial<ConversationRouteInput> = {}): ConversationRouteInput {
  return {
    sourceRowId: 1,
    groupId: "g1",
    userId: "u1",
    sourceMessageId: "m1",
    text: "武汉公司招聘前端工程师",
    nowMs: 1_000,
    ...overrides,
  };
}

function appendAnswer(
  repository: ConversationContextRepository,
  route: ConversationRoute,
  createdAt: number,
  platformMessageId = `answer-${route.sourceRowId}`,
): number {
  return repository.appendAssistantTurn({
    topicId: route.topicId,
    branchId: route.branchId,
    parentTurnId: route.turnId,
    content: "assistant answer",
    platformMessageId,
    createdAt,
  }).id;
}

test("a source row is routed once and duplicate delivery reuses the persisted route", (t) => {
  const { repository, router } = fixture(t);
  const first = router.resolve(input());
  const duplicate = router.resolve(input({
    groupId: "different-group",
    userId: "different-user",
    sourceMessageId: "different-message",
    replyToMessageId: "unknown",
    text: "different content",
    nowMs: 9_999,
  }));

  assert.deepEqual(duplicate, first);
  assert.equal(repository.getCausalTurns(first.branchId).length, 1);
});

test("an explicit reply restores an anchor through the exact one-hour boundary", (t) => {
  const { repository, router } = fixture(t);
  const root = router.resolve(input());
  const answerId = appendAnswer(repository, root, 2_000, "bot-message");
  const reply = router.resolve(input({
    sourceRowId: 2,
    userId: "u2",
    sourceMessageId: "m2",
    replyToMessageId: "bot-message",
    text: "跨用户明确引用",
    nowMs: 2_000 + 60 * 60 * 1_000,
  }));

  assert.equal(reply.topicId, root.topicId);
  assert.equal(reply.branchId, root.branchId);
  assert.equal(reply.parentTurnId, answerId);
  assert.equal(reply.routeReason, "explicit-reply");
});

test("stale, missing, future, or turn-less explicit anchors create isolated branches", (t) => {
  const { db, repository, router } = fixture(t);
  const root = router.resolve(input());
  appendAnswer(repository, root, 2_000, "old-answer");

  const stale = router.resolve(input({
    sourceRowId: 2,
    sourceMessageId: "stale",
    replyToMessageId: "old-answer",
    text: "仅保留当前引用证据",
    nowMs: 2_000 + 60 * 60 * 1_000 + 1,
  }));
  const missing = router.resolve(input({
    sourceRowId: 3,
    sourceMessageId: "missing",
    replyToMessageId: "not-indexed",
    text: "missing anchor",
    nowMs: 3_000,
  }));
  repository.bindPlatformMessage({
    groupId: "g1",
    platformMessageId: "future-anchor",
    topicId: root.topicId,
    branchId: root.branchId,
    turnId: root.turnId,
    direction: "assistant",
    createdAt: 10_000,
  });
  const future = router.resolve(input({
    sourceRowId: 4,
    sourceMessageId: "future",
    replyToMessageId: "future-anchor",
    text: "future anchor",
    nowMs: 9_999,
  }));
  db.db.prepare(
    `INSERT INTO conversation_message_context
       (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
     VALUES (?, ?, ?, ?, NULL, 'assistant', ?)`,
  ).run("g1", "turn-less", root.topicId, root.branchId, 2_500);
  const turnLess = router.resolve(input({
    sourceRowId: 5,
    sourceMessageId: "turn-less-reply",
    replyToMessageId: "turn-less",
    text: "invalid anchor",
    nowMs: 3_000,
  }));

  for (const route of [stale, missing, future, turnLess]) {
    assert.equal(route.routeReason, "explicit-reply-miss");
    assert.equal(route.parentTurnId, undefined);
    assert.notEqual(route.topicId, root.topicId);
    assert.equal(repository.getCausalTurns(route.branchId).length, 1);
  }
});

test("replying to a non-head anchor forks and sibling history stays invisible", (t) => {
  const { repository, router } = fixture(t);
  const root = router.resolve(input());
  const anchorId = appendAnswer(repository, root, 2_000, "anchor");
  const later = router.resolve(input({
    sourceRowId: 2,
    sourceMessageId: "later",
    replyToMessageId: "anchor",
    text: "继续主分支",
    nowMs: 3_000,
  }));
  appendAnswer(repository, later, 4_000, "later-answer");

  const fork = router.resolve(input({
    sourceRowId: 3,
    userId: "u2",
    sourceMessageId: "fork",
    replyToMessageId: "anchor",
    text: "从旧锚点分叉",
    nowMs: 5_000,
  }));

  assert.equal(fork.routeReason, "explicit-reply-fork");
  assert.equal(fork.parentTurnId, anchorId);
  assert.notEqual(fork.branchId, root.branchId);
  assert.deepEqual(
    repository.getCausalTurns(fork.branchId).map((turn) => turn.content),
    ["武汉公司招聘前端工程师", "assistant answer", "从旧锚点分叉"],
  );
});

test("unquoted continuation is limited to the same group and user within ten minutes", (t) => {
  const { repository, router } = fixture(t);
  const root = router.resolve(input());
  appendAnswer(repository, root, 2_000);
  const atBoundary = router.resolve(input({
    sourceRowId: 2,
    sourceMessageId: "m2",
    text: "所以薪资呢",
    nowMs: 1_000 + 10 * 60 * 1_000,
  }));
  const otherUser = router.resolve(input({
    sourceRowId: 3,
    userId: "u2",
    sourceMessageId: "m3",
    text: "所以薪资呢",
    nowMs: 2_100,
  }));
  const otherGroup = router.resolve(input({
    sourceRowId: 4,
    groupId: "g2",
    sourceMessageId: "m4",
    text: "所以薪资呢",
    nowMs: 2_100,
  }));
  const stale = router.resolve(input({
    sourceRowId: 5,
    userId: "u3",
    sourceMessageId: "seed-u3",
    text: "婚姻登记数据",
    nowMs: 1_000,
  }));
  appendAnswer(repository, stale, 2_000);
  const afterBoundary = router.resolve(input({
    sourceRowId: 6,
    userId: "u3",
    sourceMessageId: "m6",
    text: "所以离婚呢",
    nowMs: 1_000 + 10 * 60 * 1_000 + 1,
  }));

  assert.equal(atBoundary.branchId, root.branchId);
  assert.equal(atBoundary.routeReason, "same-user-follow-up");
  assert.notEqual(otherUser.topicId, root.topicId);
  assert.notEqual(otherGroup.topicId, root.topicId);
  assert.notEqual(afterBoundary.branchId, stale.branchId);
  assert.equal(afterBoundary.routeReason, "new-topic");
});

test("another user's explicit activity cannot extend or take over unquoted continuation", (t) => {
  const { repository, router } = fixture(t);
  const firstUser = router.resolve(input());
  appendAnswer(repository, firstUser, 2_000, "first-answer");
  const secondUser = router.resolve(input({
    sourceRowId: 2,
    userId: "u2",
    sourceMessageId: "u2-reply",
    replyToMessageId: "first-answer",
    text: "我明确引用加入",
    nowMs: 3_000,
  }));
  appendAnswer(repository, secondUser, 4_000, "second-answer");

  const unquotedFirstUser = router.resolve(input({
    sourceRowId: 3,
    sourceMessageId: "u1-unquoted",
    text: "所以继续呢",
    nowMs: 5_000,
  }));

  assert.equal(secondUser.branchId, firstUser.branchId);
  assert.equal(secondUser.routeReason, "explicit-reply");
  assert.notEqual(unquotedFirstUser.branchId, firstUser.branchId);
  assert.equal(unquotedFirstUser.routeReason, "new-topic");
});

test("short prefixes and a lone question mark are direct follow-ups", () => {
  for (const prefix of [
    "那", "然后", "所以", "继续", "展开", "详细", "具体", "为什么",
    "怎么说", "不对", "更正", "其实", "还有", "另外", "补充",
  ]) {
    assert.equal(isDirectFollowUp(`${prefix}呢`), true, prefix);
  }
  assert.equal(isDirectFollowUp("?"), true);
  assert.equal(isDirectFollowUp("？"), true);
  assert.equal(isDirectFollowUp(`所以${"长".repeat(39)}`), false);
  assert.equal(isDirectFollowUp("普通短句"), false);
});

test("similar continuation uses >= 0.20 Jaccard and a meaningful keyword overlap", (t) => {
  const { repository, router } = fixture(t);
  assert.equal(characterJaccard("甲乙丙丁戊己", "甲乙庚辛壬癸"), 0.2);

  const thresholdRoot = router.resolve(input({ text: "甲乙丙丁戊己" }));
  appendAnswer(repository, thresholdRoot, 2_000);
  const thresholdMatch = router.resolve(input({
    sourceRowId: 2,
    sourceMessageId: "threshold-match",
    text: "甲乙庚辛壬癸",
    nowMs: 3_000,
  }));

  const belowRoot = router.resolve(input({
    sourceRowId: 3,
    userId: "u2",
    sourceMessageId: "below-root",
    text: "甲乙丙丁戊己",
    nowMs: 1_000,
  }));
  appendAnswer(repository, belowRoot, 2_000);
  const below = router.resolve(input({
    sourceRowId: 4,
    userId: "u2",
    sourceMessageId: "below",
    text: "甲乙庚辛壬癸子",
    nowMs: 3_000,
  }));

  const noKeywordRoot = router.resolve(input({
    sourceRowId: 5,
    userId: "u3",
    sourceMessageId: "no-keyword-root",
    text: "甲乙丙丁戊",
    nowMs: 1_000,
  }));
  appendAnswer(repository, noKeywordRoot, 2_000);
  const noKeyword = router.resolve(input({
    sourceRowId: 6,
    userId: "u3",
    sourceMessageId: "no-keyword",
    text: "甲丙戊己庚",
    nowMs: 3_000,
  }));

  assert.equal(thresholdMatch.branchId, thresholdRoot.branchId);
  assert.equal(thresholdMatch.routeReason, "same-user-similar");
  assert.notEqual(below.branchId, belowRoot.branchId);
  assert.equal(below.routeReason, "new-topic");
  assert.ok(characterJaccard("甲乙丙丁戊", "甲丙戊己庚") >= 0.2);
  assert.notEqual(noKeyword.branchId, noKeywordRoot.branchId);
  assert.equal(noKeyword.routeReason, "new-topic");
});

test("empty text and pure-image messages never continue an active branch", (t) => {
  const { repository, router } = fixture(t);
  const root = router.resolve(input());
  appendAnswer(repository, root, 2_000);
  const empty = router.resolve(input({
    sourceRowId: 2,
    sourceMessageId: "empty",
    text: "   ",
    nowMs: 3_000,
  }));
  const pureImage = router.resolve(input({
    sourceRowId: 3,
    sourceMessageId: "image",
    text: "",
    hasImages: true,
    nowMs: 4_000,
  }));

  assert.equal(empty.routeReason, "new-topic");
  assert.equal(pureImage.routeReason, "new-topic");
  assert.notEqual(empty.branchId, root.branchId);
  assert.notEqual(pureImage.branchId, empty.branchId);
});

test("routing exceptions fail closed into a fresh branch without a parent", () => {
  let saved: SaveMessageRouteInput | undefined;
  const fakeRepository = {
    getRouteBySourceRowId: () => undefined,
    getActiveRoute: () => {
      throw new Error("broken route index");
    },
    saveMessageRoute: (routeInput: SaveMessageRouteInput): ConversationRoute => {
      saved = routeInput;
      return {
        topicId: "isolated-topic",
        branchId: "isolated-branch",
        sourceMessageId: routeInput.sourceMessageId,
        routeReason: routeInput.routeReason,
        sourceRowId: routeInput.sourceRowId,
        turnId: 1,
      };
    },
  } as unknown as ConversationContextRepository;
  const router = new ConversationContextRouter(fakeRepository);

  const route = router.resolve(input());

  assert.equal(route.routeReason, "fail-closed");
  assert.equal(saved?.topicId, undefined);
  assert.equal(saved?.branchId, undefined);
  assert.equal(saved?.parentTurnId, undefined);
});

test("a total repository failure returns a deterministic ephemeral fail-closed route", () => {
  const fakeRepository = {
    getRouteBySourceRowId: () => {
      throw new Error("database unavailable");
    },
    saveMessageRoute: () => {
      throw new Error("database unavailable");
    },
  } as unknown as ConversationContextRepository;
  const router = new ConversationContextRouter(fakeRepository);

  const route = router.resolve(input({ replyToMessageId: "quoted-id" }));

  assert.equal(route.routeReason, "fail-closed");
  assert.equal(route.parentTurnId, undefined);
  assert.equal(route.topicId, "topic:fail-closed:g1:1");
  assert.equal(route.branchId, "branch:fail-closed:g1:1");
  assert.equal(route.replyToMessageId, "quoted-id");
});
