import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { charJaccard, extractKeywords, hasKeywordOverlap, TopicRouter } from "./topic-router.js";

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "topics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("reply chain inherits the referenced topic", (t) => {
  const router = new TopicRouter(tempDir(t));
  const first = router.assignTopic({ groupId: "10001", userId: "20001", text: "你们公司是不是在裁员", nowMs: 1_000 });
  const second = router.assignTopic({
    groupId: "10001",
    userId: "20001",
    text: "听说前端组要优化",
    replyToTopicId: first.topicId,
    nowMs: 2_000,
  });
  assert.equal(second.action, "inherit");
  assert.equal(second.topicId, first.topicId);
});

test("unrelated @bot message opens a new topic (no topic bleed)", (t) => {
  const router = new TopicRouter(tempDir(t));
  const layoff = router.assignTopic({ groupId: "10001", userId: "20001", text: "公司裁员是真的吗", nowMs: 1_000 });
  const weather = router.assignTopic({ groupId: "10001", userId: "20002", text: "今天杭州天气怎么样", nowMs: 2_000 });
  assert.equal(weather.action, "new");
  assert.notEqual(weather.topicId, layoff.topicId, "weather must not join the layoff topic");
});

test("related follow-up joins the active topic", (t) => {
  const router = new TopicRouter(tempDir(t));
  const first = router.assignTopic({ groupId: "10001", userId: "20001", text: "现在前端行情怎么样", nowMs: 1_000 });
  const second = router.assignTopic({ groupId: "10001", userId: "20003", text: "前端现在就业形势如何", nowMs: 30_000 });
  assert.equal(second.action, "join", "similar topic must join within the active window");
  assert.equal(second.topicId, first.topicId);
});

test("inactive topics expire after the window and do not join", (t) => {
  const router = new TopicRouter(tempDir(t));
  router.assignTopic({ groupId: "10001", userId: "20001", text: "前端行情怎么样", nowMs: 1_000 });
  const later = router.assignTopic({
    groupId: "10001",
    userId: "20001",
    text: "前端行情怎么样",
    nowMs: 1_000 + 40 * 60 * 1000,
  });
  assert.equal(later.action, "new", "topic is stale after 30min window");
});

test("topics persist across router instances", (t) => {
  const dir = tempDir(t);
  const first = new TopicRouter(dir);
  const created = first.assignTopic({ groupId: "10001", userId: "20001", text: "后端做 Agent 方向怎么样", nowMs: 1_000 });

  const second = new TopicRouter(dir);
  const joined = second.assignTopic({ groupId: "10001", userId: "20002", text: "后端转 Agent 方向靠谱吗", nowMs: 5_000 });
  assert.equal(joined.action, "join");
  assert.equal(joined.topicId, created.topicId);
});

test("keyword extraction and char Jaccard behave sanely", () => {
  const a = extractKeywords("今天天气怎么样明天会不会下雨");
  const b = extractKeywords("明天下雨概率大吗");
  assert.ok(a.length >= 2);
  assert.ok(b.length >= 2);

  const related = charJaccard("前端就业形势严峻", "前端行情不好找");
  const unrelated = charJaccard("前端就业形势严峻", "这家餐厅的菜很好吃");
  assert.ok(related > unrelated, "related topics must score higher than unrelated ones");

  assert.equal(hasKeywordOverlap(extractKeywords("前端行情"), extractKeywords("前端就业")), true);
  assert.equal(
    hasKeywordOverlap(extractKeywords("前端行情怎么样"), extractKeywords("后端行情怎么样")),
    false,
    "a bare stopword overlap (行情) must not satisfy the gate",
  );
});
