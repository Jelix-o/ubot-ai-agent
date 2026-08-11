import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConversationTurn, ConversationsFile } from "../types.js";
import { ConversationStore } from "./conversation-store.js";

function makeTurn(groupId: string, userId: string, content: string): ConversationTurn {
  return {
    groupId,
    userId,
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  };
}

async function withTempStore<T>(run: (store: ConversationStore, filePath: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conversation-store-test-"));
  const filePath = path.join(tempDir, "conversations.json");

  try {
    return await run(new ConversationStore(filePath), filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("stores conversation turns by group and user", async () => {
  await withTempStore(async (store) => {
    await store.appendDialogue("group-1", "user-a", [makeTurn("group-1", "user-a", "A1")], 10);

    assert.equal((await store.getTurns("group-1", "user-a")).length, 1);
    assert.deepEqual(await store.getTurns("group-1", "user-b"), []);
    assert.deepEqual(await store.getTurns("group-2", "user-a"), []);
  });
});

test("clearUser removes only that user's context in a group", async () => {
  await withTempStore(async (store) => {
    await store.appendDialogue("group-1", "user-a", [makeTurn("group-1", "user-a", "A1")], 10);
    await store.appendDialogue("group-1", "user-b", [makeTurn("group-1", "user-b", "B1")], 10);

    await store.clearUser("group-1", "user-a");

    assert.deepEqual(await store.getTurns("group-1", "user-a"), []);
    assert.equal((await store.getTurns("group-1", "user-b")).length, 1);
  });
});

test("clearGroup removes all personal contexts in the group plus legacy group key", async () => {
  await withTempStore(async (store, filePath) => {
    const existing: ConversationsFile = {
      conversations: {
        "group-1": [makeTurn("group-1", "legacy-user", "legacy")],
        "group-1:user-a": [makeTurn("group-1", "user-a", "A1")],
        "group-1:user-b": [makeTurn("group-1", "user-b", "B1")],
        "group-2:user-a": [makeTurn("group-2", "user-a", "other group")],
      },
    };
    await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

    await store.clearGroup("group-1");
    await store.flush();

    const raw = JSON.parse(await readFile(filePath, "utf8")) as ConversationsFile;
    assert.deepEqual(Object.keys(raw.conversations), ["group-2:user-a"]);
    assert.equal((await store.getTurns("group-2", "user-a")).length, 1);
  });
});

test("requires a reply anchor, retains reply anchors for thirty minutes, and clears group topics", async () => {
  await withTempStore(async (store) => {
    const startedAt = new Date("2026-07-27T00:00:00.000Z");
    const topic = await store.appendSharedDialogue({
      groupId: "group-1",
      userId: "user-a",
      userContent: "first topic message",
      assistantContent: "first topic reply",
      sourceMessageId: "100",
      botMessageIds: ["101"],
      now: startedAt,
    });

    assert.equal(await store.getSharedTopic("group-1", undefined, new Date(startedAt.getTime() + 9 * 60 * 1000)), undefined);
    assert.equal((await store.getSharedTopic("group-1", "101", new Date(startedAt.getTime() + 29 * 60 * 1000)))?.id, topic.id);

    await store.appendSharedDialogue({
      groupId: "group-1",
      topicId: topic.id,
      userId: "user-b",
      userContent: "quoted continuation",
      assistantContent: "continued reply",
      sourceMessageId: "102",
      now: new Date(startedAt.getTime() + 29 * 60 * 1000),
    });

    assert.equal(await store.getSharedTopic("group-1", "101", new Date(startedAt.getTime() + 60 * 60 * 1000)), undefined);

    await store.clearGroup("group-1");
    assert.equal(await store.getSharedTopic("group-1", "102", new Date(startedAt.getTime() + 29 * 60 * 1000)), undefined);
  });
});

test("stores sender snapshots while accepting legacy shared-topic turns", async () => {
  await withTempStore(async (store, filePath) => {
    const topic = await store.appendSharedDialogue({
      groupId: "group-1",
      userId: "1569671790",
      userContent: "first topic message",
      senderCard: "  空白名备用卡  ",
      senderNickname: "季博神",
      assistantContent: "first topic reply",
      now: new Date("2026-07-27T00:00:00.000Z"),
    });

    assert.deepEqual(topic.turns[0], {
      role: "user",
      content: "first topic message",
      userId: "1569671790",
      senderCard: "空白名备用卡",
      senderNickname: "季博神",
      timestamp: "2026-07-27T00:00:00.000Z",
    });

    const legacy: ConversationsFile = {
      conversations: {},
      sharedTopics: {
        "legacy-topic": {
          id: "legacy-topic",
          groupId: "group-2",
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:00:00.000Z",
          turns: [
            {
              role: "user",
              content: "legacy message",
              userId: "289513186",
              timestamp: "2026-07-27T00:00:00.000Z",
            },
          ],
        },
      },
      sharedTopicMessageIndex: { "group-2:legacy-anchor": "legacy-topic" },
    };
    await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const legacyStore = new ConversationStore(filePath);
    const loaded = await legacyStore.getSharedTopic("group-2", "legacy-anchor", new Date("2026-07-27T00:01:00.000Z"));
    assert.equal(loaded?.turns[0]?.senderCard, undefined);
    assert.equal(loaded?.turns[0]?.senderNickname, undefined);
  });
});

test("bounds shared topics to thirty-two turns and twenty-four thousand characters", async () => {
  await withTempStore(async (store) => {
    const now = new Date("2026-07-27T00:00:00.000Z");
    let topicId: string | undefined;
    for (let index = 0; index < 20; index += 1) {
      const topic = await store.appendSharedDialogue({
        groupId: "group-1",
        topicId,
        userId: "user-a",
        userContent: `user-${index}:${"u".repeat(1_000)}`,
        assistantContent: `assistant-${index}:${"a".repeat(1_000)}`,
        sourceMessageId: String(index),
        now: new Date(now.getTime() + index * 1000),
      });
      topicId = topic.id;
    }

    const topic = await store.getSharedTopic("group-1", "19", new Date(now.getTime() + 20_000));
    assert.ok(topic);
    assert.equal(topic.turns.length <= 32, true);
    assert.equal(topic.turns.reduce((total, turn) => total + turn.content.length, 0) <= 24_000, true);
    assert.match(topic.turns.at(-1)?.content ?? "", /assistant-19/);
  });
});

test("missing file, empty shape, and old empty conversations shape normalize safely", async () => {
  await withTempStore(async (store, filePath) => {
    assert.deepEqual(await store.getTurns("group-1", "user-a"), []);

    await writeFile(filePath, "{}", "utf8");
    assert.deepEqual(await store.getTurns("group-1", "user-a"), []);

    await writeFile(filePath, "{\"conversations\":{}}", "utf8");
    assert.deepEqual(await store.getTurns("group-1", "user-a"), []);
  });
});
