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
