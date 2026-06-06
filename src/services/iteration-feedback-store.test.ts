import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IterationFeedbackStore } from "./iteration-feedback-store.js";

async function withStore<T>(run: (store: IterationFeedbackStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iteration-feedback-store-"));
  try {
    return await run(new IterationFeedbackStore(path.join(dir, "feedback.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("IterationFeedbackStore creates, filters, and updates feedback records", async () => {
  await withStore(async (store) => {
    const bug = await store.create({
      groupId: "10001",
      operatorUserId: "admin",
      source: "admin",
      category: "bug",
      title: "Reply crash",
      content: "reply failed with timeout",
    });
    const feature = await store.create({
      groupId: "10002",
      operatorUserId: "20001",
      source: "qq_command",
      content: "希望新增每日计划汇总",
    });

    assert.equal(bug.status, "open");
    assert.equal(feature.category, "feature");

    const groupPage = await store.listPage({
      groupId: "10001",
      page: 1,
      pageSize: 20,
    });
    assert.equal(groupPage.pagination.total, 1);
    assert.equal(groupPage.feedback[0]?.id, bug.id);

    const queryPage = await store.listPage({
      q: "每日计划",
      page: 1,
      pageSize: 20,
    });
    assert.equal(queryPage.pagination.total, 1);
    assert.equal(queryPage.feedback[0]?.id, feature.id);

    const planned = await store.updateStatus(bug.id, "planned");
    assert.equal(planned?.status, "planned");
    assert.equal((await store.list({ status: "planned" }))[0]?.id, bug.id);
  });
});

test("IterationFeedbackStore enforces visible group filtering for non-super admins", async () => {
  await withStore(async (store) => {
    await store.create({
      groupId: "10001",
      operatorUserId: "admin",
      source: "admin",
      content: "first group feedback",
    });
    await store.create({
      groupId: "10002",
      operatorUserId: "admin",
      source: "admin",
      content: "second group feedback",
    });

    const visible = await store.listPage({
      visibleGroupIds: ["10001"],
      page: 1,
      pageSize: 20,
    });
    assert.equal(visible.pagination.total, 1);
    assert.equal(visible.feedback[0]?.groupId, "10001");

    const all = await store.listPage({
      includeAllGroups: true,
      visibleGroupIds: ["10001"],
      page: 1,
      pageSize: 20,
    });
    assert.equal(all.pagination.total, 2);
  });
});
