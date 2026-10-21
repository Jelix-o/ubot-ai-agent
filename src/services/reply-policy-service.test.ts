import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ReplyPolicyService } from "./reply-policy-service.js";
import { emptyConversationState, type ContextResolution } from "./conversation-state.js";
import { buildSystemPrompt } from "./ai-service.js";
import { HUIXIAN_CONVERSATION_RULES, upgradeHuixianConversationProfile } from "../persona/huixian-conversation-policy.js";
import type { SkillDefinition } from "../types.js";

const service = new ReplyPolicyService();
const resolution: ContextResolution = { intent: "confirm", relation: "follow_up", resolvedInput: "是因为太认真了吗", selectedMessageIds: ["game"], mediaSourceMessageIds: [], needsMoreContext: false, source: "model" };

test("reply planning keeps the recipient, delivered coverage, answered questions and image source together", () => {
  const state = { ...emptyConversationState(), coveredPoints: ["喝水成了习惯"], questions: [
    { key: "only-game", userId: "a", text: "平时也会吗", status: "answered" as const },
    { key: "other-person", userId: "b", text: "平时也会吗", status: "answered" as const },
  ] };
  const plan = service.plan({ resolution, state, userId: "a", sourceMessageId: "follow", mediaSourceMessageIds: ["image", "image"] });
  assert.equal(plan.recipientUserId, "a");
  assert.equal(plan.sourceMessageId, "follow");
  assert.deepEqual(plan.alreadyCovered, ["喝水成了习惯"]);
  assert.deepEqual(plan.answeredQuestionKeys, ["only-game"]);
  assert.deepEqual(plan.mediaSourceMessageIds, ["image"]);
  assert.equal(plan.explanation, "on_request");
  assert.equal(service.plan({ resolution: { ...resolution, intent: "explain" }, state }).explanation, "requested");
  assert.deepEqual(service.plan({ resolution: { ...resolution, intent: "image" }, state }).toolNeeds, ["image"]);
});

test("clarification does not ask the same recipient an already answered question", () => {
  const state = { ...emptyConversationState(), questions: [{ key: "only-game", userId: "a", text: "平时也会吗？", status: "answered" as const }] };
  const input = { resolution: { ...resolution, clarification: "平时也会吗" }, state };
  assert.equal(service.plan({ ...input, userId: "a" }).action, "reply");
  assert.equal(service.plan({ ...input, userId: "b" }).action, "clarify");
});

test("Huixian defaults to a short direct answer, then expands only for explanations or explicit detail", () => {
  const state = emptyConversationState();
  const direct = service.plan({
    resolution,
    state,
    userId: "a",
    userInput: "湖南社保档位一万元，交三十年能领多少",
  });
  const directBudget = service.replyFormatBudget({ id: "huixian" }, "湖南社保档位一万元，交三十年能领多少", direct)!;
  assert.equal(direct.detailLevel, "direct");
  assert.deepEqual(directBudget, { maxChars: 180, maxTotalChars: 180, maxMessages: 1, preferredMaxMessages: 1 });
  assert.match(service.instruction(direct, state, { formatBudget: directBudget }), /1 到 3 句、180 个可见字符内/);
  assert.match(service.review({ text: "长".repeat(181) }, direct, [], { formatBudget: directBudget })!, /默认短答超过 180/);
  assert.equal(service.review({ text: "大概四五千，具体还得看当地计发基数和缴费指数" }, direct, [], { formatBudget: directBudget }), undefined);

  const explanation = service.plan({
    resolution: { ...resolution, intent: "explain" },
    state,
    userId: "a",
    userInput: "为什么会这样",
  });
  const explanationBudget = service.replyFormatBudget({ id: "huixian" }, "为什么会这样", explanation)!;
  assert.equal(explanation.detailLevel, "brief_explanation");
  assert.deepEqual(explanationBudget, { maxChars: 240, maxTotalChars: 240, maxMessages: 1, preferredMaxMessages: 1 });
  assert.match(service.instruction(explanation, state, { formatBudget: explanationBudget }), /只解释当前被问的那一点/);

  const detailed = service.plan({
    resolution: { ...resolution, intent: "explain" },
    state,
    userId: "a",
    userInput: "详细解释一下",
  });
  const detailedBudget = service.replyFormatBudget({ id: "huixian" }, "详细解释一下", detailed)!;
  assert.equal(detailed.detailLevel, "detailed");
  assert.equal(detailedBudget.maxTotalChars, 1_200);
  assert.match(service.instruction(detailed, state, { formatBudget: detailedBudget }), /明确要求详细内容/);
  assert.match(service.instruction(direct, state, { formatBudget: directBudget, explicitReplyLength: true }), /默认短答限制不适用/);
});

test("review preserves brief confirmations, catches repeats and targeted faults, and leaves verified tool messages intact", () => {
  const plan = service.plan({ resolution, state: emptyConversationState() });
  const prior = "先改掉打游戏时顺手不停喝水的习惯，真渴了照常小口喝，不用强忍";
  assert.equal(service.review({ text: "对，就是这个原因" }, plan, [prior]), undefined);
  assert.match(service.review({ text: prior }, { ...plan, intent: "chat" }, [prior])!, /复述/);
  for (const flag of ["repeatsAnswered", "reasksKnown", "unsupportedReversal"] as const) {
    const replyCheck = { repeatsAnswered: false, reasksKnown: false, unsupportedReversal: false, [flag]: true };
    assert.ok(service.review({ text: "待修正草稿", replyCheck }, plan, []));
    assert.equal(service.review({ text: "工具结果", messages: ["核验结果"], replyCheck }, plan, []), undefined);
  }
  assert.doesNotMatch(service.rewriteInstruction(undefined, "重复提问", prior), /undefined/);
});

test("effective persona compiles each managed rule once while preserving custom instructions and explicit long-form requirements", async () => {
  const packaged = JSON.parse(await readFile("assets/huixian-profile.json", "utf8")) as SkillDefinition;
  const profile = upgradeHuixianConversationProfile({ ...packaged, systemPrompt: `${packaged.systemPrompt}\n管理员自定义：喜欢游戏梗`, styleRules: [...packaged.styleRules, "管理员自定义语气"], temperature: 0.37 });
  const before = structuredClone(profile);
  const prompt = buildSystemPrompt(profile, undefined, "本轮明确要求详细分析，完整回答");
  for (const rule of HUIXIAN_CONVERSATION_RULES) assert.equal(prompt.split(rule).length - 1, 1);
  assert.match(prompt, /管理员自定义：喜欢游戏梗/);
  assert.match(prompt, /管理员自定义语气/);
  assert.match(prompt, /本轮明确要求详细分析，完整回答/);
  assert.deepEqual(profile, before);
});
