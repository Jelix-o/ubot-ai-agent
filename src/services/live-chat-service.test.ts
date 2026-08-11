import assert from "node:assert/strict";
import test from "node:test";

import { LiveChatService } from "./live-chat-service.js";

test("live chat runtime state reports pending users without exposing message text", () => {
  const service = new LiveChatService();
  service.recordBotActivity("67890", 1_000);
  service.addMessage("67890", "20001", "private buffered text", 2_000);

  const waiting = service.getRuntimeState("67890", ["20001", "20001"], 30, 20_000);
  assert.deepEqual(waiting, {
    enabled: true,
    trackedUserCount: 1,
    delaySeconds: 30,
    pendingUsers: [{ userId: "20001", messageCount: 1, state: "waiting" }],
  });

  const ready = service.getRuntimeState("67890", ["20001"], 30, 32_000);
  assert.equal(ready.pendingUsers[0]?.state, "ready");
  assert.equal(JSON.stringify(ready).includes("private buffered text"), false);
});
