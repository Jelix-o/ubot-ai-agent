import assert from "node:assert/strict";
import test from "node:test";

import { parseExplicitMemoryRequest, stripExplicitMemoryLead } from "./explicit-memory-service.js";
import { GroupParticipationService } from "./group-participation-service.js";
import type { GroupBotConfig } from "../types.js";

function group(overrides: Partial<GroupBotConfig> = {}): GroupBotConfig {
  return {
    groupId: "67890",
    currentSkillId: "huixian",
    allowedSkillIds: ["huixian"],
    switcherUserIds: [],
    liveChatUserIds: [],
    participationMode: "mentions_and_keywords",
    ...overrides,
  };
}

function createService(
  configuredGroup: GroupBotConfig | undefined = group(),
  defaultTriggerKeywords: Array<{ keyword: string; enabled: boolean }> = [],
): GroupParticipationService {
  return new GroupParticipationService(
    { getGroup: async () => configuredGroup },
    { get: async () => ({ defaultTriggerKeywords }) },
  );
}

test("group participation service routes configured keyword matches through the shared policy", async () => {
  const service = createService(group({
    triggerKeywords: [{ keyword: "会仙", enabled: true }],
  }));

  const decision = await service.decide("67890", "会仙，看看这个", false);

  assert.equal(decision.action, "reply");
  assert.equal(decision.reason, "keyword_trigger");
  assert.equal(decision.signals.keywordTriggered, true);
  assert.equal(await service.shouldTriggerKeyword(group(), "#会仙", false), false);
  assert.equal(await service.shouldTriggerKeyword(group(), "会仙", true), false);
  assert.equal(await service.shouldTriggerKeyword(group({
    participationMode: "mentions_only",
    triggerKeywords: [{ keyword: "会仙", enabled: true }],
  }), "会仙", false), false);
});

test("group participation service uses persisted system defaults only when the group has none", async () => {
  const service = createService(group(), [{ keyword: "帮手", enabled: true }]);

  const decision = await service.decide("67890", "帮手，来一下", false);

  assert.equal(decision.action, "reply");
  assert.equal(decision.reason, "keyword_trigger");
});

test("group participation service preserves muted and verified-reply precedence", async () => {
  const service = createService(group({
    botMuted: true,
    triggerKeywords: [{ keyword: "会仙", enabled: true }],
  }));

  const mutedKeyword = await service.decide("67890", "会仙", false);
  const directMention = await service.decide("67890", "会仙", true);
  const verifiedReply = await service.decide("67890", "继续", false, { replyToBot: true });

  assert.equal(mutedKeyword.action, "observe");
  assert.equal(mutedKeyword.reason, "muted_observation");
  assert.equal(directMention.reason, "direct_mention");
  assert.equal(verifiedReply.reason, "explicit_reply");
});

test("explicit memory request parsing remains explicit and reusable by participation routing", () => {
  assert.equal(parseExplicitMemoryRequest("请记住：我喜欢简洁回答"), "我喜欢简洁回答");
  assert.equal(parseExplicitMemoryRequest("我喜欢简洁回答"), undefined);
  assert.equal(stripExplicitMemoryLead("记忆一下 我不吃香菜"), "我不吃香菜");
});
