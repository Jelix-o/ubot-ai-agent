import assert from "node:assert/strict";
import test from "node:test";

import { GroupTranscriptService } from "./group-transcript-service.js";

test("retains a short per-group transcript, expires it, and excludes the current message", () => {
  const service = new GroupTranscriptService();
  service.addMessage({
    groupId: "67890",
    userId: "20001",
    messageId: "1",
    text: "  前端也能写后端  ",
    senderCard: "  前端同学  ",
    now: 1_000,
  });
  service.addMessage({
    groupId: "67890",
    userId: "20002",
    messageId: "2",
    text: "规则说清楚 AI 就能做。",
    senderNickname: "后端同学",
    now: 2_000,
  });

  const recent = service.getRecentMessages("67890", { excludeMessageId: "2", now: 2_000 });
  assert.deepEqual(recent, [{
    messageId: "1",
    userId: "20001",
    text: "前端也能写后端",
    timestamp: "1970-01-01T00:00:01.000Z",
    senderCard: "前端同学",
  }]);

  assert.deepEqual(service.getRecentMessages("67890", { now: 3_602_001 }), []);
});

test("keeps at most one hundred and twenty recent messages per group", () => {
  const service = new GroupTranscriptService();
  for (let index = 0; index < 121; index += 1) {
    service.addMessage({
      groupId: "67890",
      userId: "20001",
      messageId: String(index),
      text: `消息 ${index}`,
      now: 1_000 + index,
    });
  }

  const recent = service.getRecentMessages("67890", { now: 2_000 });
  assert.equal(recent.length, 120);
  assert.equal(recent[0]?.messageId, "1");
  assert.equal(recent.at(-1)?.messageId, "120");
});
