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
