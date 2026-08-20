import assert from "node:assert/strict";
import test from "node:test";

import type { SkillDefinition } from "../types.js";
import {
  buildExplicitReplyLengthInstruction,
  buildExplicitReplyLengthPlan,
  parseReplyLengthIntent,
  resolveReplyLengthIntent,
} from "./reply-length.js";

const skill: SkillDefinition = {
  id: "huixian",
  name: "会仙",
  systemPrompt: "test",
  styleRules: [],
  knowledge: [],
  temperature: 0.7,
  maxContextTurns: 12,
  maxReplyCharsPerMessage: 500,
  maxTotalReplyChars: 3_000,
  maxReplyMessages: 8,
  preferredMaxReplyMessages: 4,
};

test("parses Arabic and Chinese requested reply lengths", () => {
  assert.deepEqual(parseReplyLengthIntent("来个3000字的")?.requestedChars, 3_000);
  assert.deepEqual(parseReplyLengthIntent("写一篇三千字长文")?.requestedChars, 3_000);
  assert.deepEqual(parseReplyLengthIntent("约 ２５００ 字")?.requestedChars, 2_500);
});

test("distinguishes minimum, target, maximum and generic long-form intent", () => {
  assert.equal(parseReplyLengthIntent("至少写3000字")?.kind, "minimum");
  assert.equal(parseReplyLengthIntent("来个3000字的")?.kind, "target");
  assert.equal(parseReplyLengthIntent("控制在3000字以内")?.kind, "maximum");
  assert.equal(parseReplyLengthIntent("直接写完发出来")?.kind, "long-form");
});

test("continuation inherits only the current user's latest uninterrupted length request", () => {
  const inherited = resolveReplyLengthIntent("直接写完发出来", [
    { role: "user", userId: "u1", content: "来个3000字的" },
    { role: "assistant", content: "能写，你回复发我再写" },
    { role: "user", userId: "u2", content: "来个5000字的" },
    { role: "assistant", content: "这是其他用户的回复，不应计入" },
  ], "u1");
  assert.equal(inherited?.requestedChars, 3_000);
  assert.equal(inherited?.inherited, true);
  assert.equal(inherited?.priorAssistantChars, "能写，你回复发我再写".length);

  assert.equal(resolveReplyLengthIntent("继续", [
    { role: "user", userId: "u1", content: "来个3000字的" },
    { role: "user", userId: "u1", content: "顺便问一下天气" },
  ], "u1"), undefined);
});

test("explicit budget honors skill hard limits and ignores preferred message count", () => {
  const plan = buildExplicitReplyLengthPlan(skill, parseReplyLengthIntent("来个5000字的")!);
  assert.deepEqual(plan?.budget, {
    maxChars: 500,
    maxTotalChars: 3_000,
    maxMessages: 8,
    preferredMaxMessages: 8,
  });
  assert.equal(plan?.targetChars, 3_000);
});

test("maximum intent caps output without requiring the model to fill it", () => {
  const plan = buildExplicitReplyLengthPlan(skill, parseReplyLengthIntent("最多3000字")!);
  assert.equal(plan?.targetChars, undefined);
  assert.match(buildExplicitReplyLengthInstruction(plan!), /不要求写满/);
});

test("unconfigured text skills use explicit long-form defaults", () => {
  const plan = buildExplicitReplyLengthPlan({
    ...skill,
    id: "other",
    maxReplyCharsPerMessage: undefined,
    maxTotalReplyChars: undefined,
    maxReplyMessages: undefined,
    preferredMaxReplyMessages: undefined,
  }, parseReplyLengthIntent("写一篇长文")!);
  assert.deepEqual(plan?.budget, {
    maxChars: 500,
    maxTotalChars: 3_000,
    maxMessages: 8,
    preferredMaxMessages: 8,
  });
});
