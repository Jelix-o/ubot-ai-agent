import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeBaseStore } from "./knowledge-base-store.js";

test("knowledge base store persists entries and ranks keyword hits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knowledge-base-"));
  try {
    const store = new KnowledgeBaseStore(path.join(dir, "knowledge.json"));
    const faq = await store.create({
      groupId: "67890",
      title: "报销规则",
      question: "怎么报销发票",
      answer: "先贴发票，再找管理员登记。",
      keywords: ["报销", "发票"],
    });
    await store.create({
      groupId: "67890",
      title: "无关规则",
      question: "午饭吃什么",
      answer: "随便。",
      keywords: ["午饭"],
    });

    const hits = await store.search("67890", "我要报销发票");
    assert.equal(hits[0]?.entry.id, faq.id);

    await store.update(faq.id, { enabled: false });
    assert.equal((await store.search("67890", "我要报销发票")).length, 0);

    assert.equal(await store.remove(faq.id), true);
    assert.equal(await store.remove(faq.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledge base store pages filtered entries newest first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knowledge-base-page-"));
  try {
    const store = new KnowledgeBaseStore(path.join(dir, "knowledge.json"));
    await store.create({
      groupId: "67890",
      title: "Older FAQ",
      question: "How to claim travel expenses?",
      answer: "Use the travel form.",
      keywords: ["travel", "expense"],
    });
    const disabled = await store.create({
      groupId: "67890",
      title: "Disabled FAQ",
      question: "How to book a room?",
      answer: "Ask operations.",
      keywords: ["room"],
    });
    await store.update(disabled.id, { enabled: false });
    await store.create({
      groupId: "67890",
      title: "Newest FAQ",
      question: "How to submit invoices?",
      answer: "Upload invoice files before Friday.",
      keywords: ["invoice"],
    });
    await store.create({
      groupId: "99999",
      title: "Other group FAQ",
      question: "Should not match this group.",
      answer: "No.",
      keywords: ["invoice"],
    });

    const firstPage = await store.listPage({
      groupId: "67890",
      page: 1,
      pageSize: 2,
    });
    assert.equal(firstPage.pagination.total, 3);
    assert.equal(firstPage.pagination.totalPages, 2);
    assert.equal(firstPage.items.length, 2);
    assert.deepEqual(firstPage.items.map((entry) => entry.title), ["Newest FAQ", "Disabled FAQ"]);

    const searchPage = await store.listPage({
      groupId: "67890",
      query: "invoice",
      page: 1,
      pageSize: 10,
    });
    assert.equal(searchPage.pagination.total, 1);
    assert.equal(searchPage.items[0]?.title, "Newest FAQ");

    const disabledPage = await store.listPage({
      groupId: "67890",
      query: "disabled",
      page: 1,
      pageSize: 10,
    });
    assert.equal(disabledPage.pagination.total, 1);
    assert.equal(disabledPage.items[0]?.title, "Disabled FAQ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
