import assert from "node:assert/strict";
import test from "node:test";

import { ParticipationPolicy } from "./participation-policy.js";

const policy = new ParticipationPolicy();

function decide(overrides: Partial<Parameters<ParticipationPolicy["decide"]>[0]> = {}) {
  return policy.decide({
    text: "群里今天讨论什么？",
    hasAtBot: false,
    hasReply: false,
    hasImages: false,
    groupConfigured: true,
    groupEnabled: true,
    groupMuted: false,
    isCommand: false,
    isExplicitMemoryRequest: false,
    isConversationCommand: false,
    keywordTriggered: false,
    ...overrides,
  });
}

test("participation policy observes ambient messages without soliciting a reply", () => {
  const decision = decide();

  assert.deepEqual(decision, {
    action: "observe",
    reason: "ambient_observation",
    score: 0,
    policyVersion: "v1-conservative",
    signals: {
      hasAtBot: false,
      hasReply: false,
      hasImages: false,
      isCommand: false,
      isConversationCommand: false,
      groupMuted: false,
      keywordTriggered: false,
    },
  });
});

test("participation policy keeps explicit mentions above the muted ambient rule", () => {
  const decision = decide({ hasAtBot: true, groupMuted: true });

  assert.equal(decision.action, "reply");
  assert.equal(decision.reason, "direct_mention");
  assert.equal(decision.score, 1);
});

test("participation policy routes explicit memory requests as auditable tasks", () => {
  const decision = decide({
    text: "请记住我喜欢简洁回答",
    hasAtBot: true,
    isExplicitMemoryRequest: true,
  });

  assert.equal(decision.action, "task");
  assert.equal(decision.reason, "explicit_memory_request");
  assert.equal(decision.score, 1);
});

test("participation policy treats an already-verified bot reply as an explicit conversation", () => {
  const decision = decide({ hasReply: true, groupMuted: true });

  assert.equal(decision.action, "reply");
  assert.equal(decision.reason, "explicit_reply");
  assert.equal(decision.score, 0.98);
});

test("participation policy routes only conversation commands into the reply path", () => {
  const conversation = decide({
    text: "#语音 说一句晚安",
    isCommand: true,
    isConversationCommand: true,
  });
  const administrative = decide({
    text: "#状态",
    isCommand: true,
    isConversationCommand: false,
  });

  assert.equal(conversation.action, "reply");
  assert.equal(conversation.reason, "conversation_command");
  assert.equal(administrative.action, "admin_command");
  assert.equal(administrative.reason, "administrative_command");
});

test("participation policy preserves keyword replies but rejects unavailable groups", () => {
  const keyword = decide({ keywordTriggered: true });
  const unavailable = decide({ groupEnabled: false, keywordTriggered: true });

  assert.equal(keyword.action, "reply");
  assert.equal(keyword.reason, "keyword_trigger");
  assert.equal(keyword.score, 0.82);
  assert.equal(unavailable.action, "ignore");
  assert.equal(unavailable.reason, "group_unavailable");
});

test("participation policy ignores content-free events", () => {
  const empty = decide({ text: "  " });
  const image = decide({ text: "  ", hasImages: true });

  assert.equal(empty.action, "ignore");
  assert.equal(empty.reason, "empty_message");
  assert.equal(image.action, "observe");
});
