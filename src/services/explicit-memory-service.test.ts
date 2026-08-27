import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExplicitMemoryService } from "./explicit-memory-service.js";
import { GroupMemoryStore } from "./group-memory-store.js";

async function createFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "explicit-memory-"));
  const store = new GroupMemoryStore(path.join(dir, "memory.json"));
  return {
    store,
    service: new ExplicitMemoryService(store),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const input = {
  groupId: "67890",
  userId: "20001",
  userName: "Tester",
  content: "我以后喜欢简洁直接的回答。",
  source: "explicit_command" as const,
  createdAt: "2026-08-26T10:00:00.000Z",
};

test("explicit memory service stores only the sender's explicit request", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.service.capture(input);

    assert.equal(result.status, "created");
    assert.equal(result.memory?.type, "member_profile");
    assert.equal(result.memory?.subjectUserId, "20001");
    assert.equal(result.memory?.content, input.content);
    assert.equal(result.memory?.source, "explicit_command");
    assert.equal(result.memory?.confidence, 1);
    assert.equal(result.memory?.evidence?.messageCount, 1);
    assert.equal(result.memory?.evidence?.speakers[0]?.userId, "20001");
    assert.equal((await fixture.store.list("67890")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit memory service is idempotent for same sender and content", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.capture(input);
    const second = await fixture.service.capture({ ...input, content: "我以后 喜欢简洁直接的回答！" });

    assert.equal(first.status, "created");
    assert.equal(second.status, "duplicate");
    assert.equal(second.memory?.id, first.memory?.id);
    assert.equal((await fixture.store.list("67890")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit memory service refuses opted-out and secret-like content", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await fixture.service.capture(input, { memoryDisabled: true }), { status: "disabled" });
    assert.deepEqual(await fixture.service.capture({ ...input, content: "我的 API_KEY=sk-this-must-not-be-stored" }), { status: "unsafe" });
    assert.deepEqual(await fixture.service.capture({ ...input, content: "  " }), { status: "empty" });
    assert.equal((await fixture.store.list("67890")).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit memory service distinguishes natural-language explicit requests", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.service.capture({
      ...input,
      content: "我不吃香菜。",
      source: "explicit_request",
    });

    assert.equal(result.status, "created");
    assert.equal(result.memory?.source, "explicit_request");
    assert.match(result.memory?.evidence?.summary ?? "", /请记住/);
  } finally {
    await fixture.cleanup();
  }
});
