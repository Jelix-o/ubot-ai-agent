import assert from "node:assert/strict";
import test from "node:test";

import type { SkillDefinition } from "../types.js";
import { formatReplyMessages } from "./reply-format.js";

const skill: SkillDefinition = {
  id: "leijun",
  name: "leijun",
  systemPrompt: "",
  styleRules: [],
  knowledge: [],
  temperature: 0.7,
  maxContextTurns: 12,
  maxReplyCharsPerMessage: 20,
  maxReplyMessages: 3,
  preferredMaxReplyMessages: 2,
  stripAsterisks: true,
  singleSentencePerMessage: false,
  stripTerminalPunctuation: true,
};

test("formatReplyMessages strips asterisks and trailing punctuation", () => {
  const messages = formatReplyMessages(skill, "*你好*\n*这事我觉得可以。*");

  assert.deepEqual(messages, ["你好", "这事我觉得可以"]);
});

test("formatReplyMessages preserves explicit line breaks as natural split points", () => {
  const messages = formatReplyMessages(skill, "先说结论\n这事能做\n你别急");

  assert.deepEqual(messages, ["先说结论", "这事能做"]);
});

test("formatReplyMessages merges short sentences when they fit", () => {
  const messages = formatReplyMessages(skill, "先说结论。可以做。先看预算。");

  assert.deepEqual(messages, ["先说结论 可以做 先看预算"]);
});

test("formatReplyMessages splits into multiple messages by length", () => {
  const messages = formatReplyMessages(
    skill,
    "这事我先说结论。可以做，但是别着急。先看你的预算。再看你更在意性能还是手感。",
  );

  assert.equal(messages.length >= 2, true);
  assert.equal(messages.every((message) => message.length <= 20), true);
  assert.equal(messages.every((message) => !/[。?!！？；，、]$/.test(message)), true);
});

test("formatReplyMessages chunks long single sentence", () => {
  const messages = formatReplyMessages(
    skill,
    "这件事本质上不是不能做而是你得先想清楚你最在乎的到底是什么然后我才好给你建议",
  );

  assert.equal(messages.length >= 2, true);
  assert.equal(messages.every((message) => message.length <= 20), true);
});

test("formatReplyMessages uses shared persona defaults when skill does not override them", () => {
  const messages = formatReplyMessages(
    {
      id: "jackma",
      name: "jackma",
      systemPrompt: "",
      styleRules: [],
      knowledge: [],
      temperature: 0.7,
      maxContextTurns: 12,
    },
    "*你好*\n这事我觉得能做。",
  );

  assert.deepEqual(messages, ["你好", "这事我觉得能做"]);
});

test("formatReplyMessages can merge explicit line breaks when skill disables line break splitting", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 50,
      respectLineBreaks: false,
    },
    "第一句\n第二句\n第三句",
  );

  assert.deepEqual(messages, ["第一句 第二句 第三句"]);
});

test("formatReplyMessages prefers one or two messages when burst mode is not triggered", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 18,
      maxReplyMessages: 3,
      preferredMaxReplyMessages: 2,
      respectLineBreaks: false,
      allowBurstOnHighEmotion: true,
      highEmotionKeywords: ["妈的"],
    },
    "怎么说 这事不亏 你先别急 先看看预算再说",
  );

  assert.equal(messages.length <= 2, true);
});

test("formatReplyMessages allows three messages when burst mode is triggered by high emotion", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 10,
      maxReplyMessages: 3,
      preferredMaxReplyMessages: 2,
      respectLineBreaks: false,
      allowBurstOnHighEmotion: true,
      highEmotionKeywords: ["妈的"],
    },
    "妈的 真烦 你有病吧 还在这狗叫 真是把我气死了",
  );

  assert.equal(messages.length, 3);
});

test("formatReplyMessages clamps configured replies to at most 8 messages and 3000 chars total", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 900,
      maxTotalReplyChars: 900,
      maxReplyMessages: 9,
      preferredMaxReplyMessages: 9,
      respectLineBreaks: false,
    },
    [
      "agent就是让模型自己拆任务自己调工具自己执行，不需要你一步一步盯着",
      "mcp是模型接外部能力的协议层，相当于给模型插上搜索、天气、数据库这些能力接口",
      "skills就是提前写好的行为包、规则包、知识包，让模型进入某种稳定的人设和工作方式",
      "这三个东西合起来，才像一个真正能干活的AI系统",
    ].join("。"),
  );

  assert.equal(messages.length <= 8, true);
  assert.equal(messages.every((message) => message.length <= 600), true);
  assert.equal(messages.join(" ").length <= 900, true);
});

test("formatReplyMessages honors a per-reply short or detailed budget", () => {
  const text = "x".repeat(1_500);
  const short = formatReplyMessages(skill, text, {
    maxChars: 160,
    maxTotalChars: 160,
    maxMessages: 1,
    preferredMaxMessages: 1,
  });
  const detailed = formatReplyMessages(skill, text, {
    maxChars: 420,
    maxTotalChars: 1_200,
    maxMessages: 4,
    preferredMaxMessages: 4,
  });

  assert.equal(short.length, 1);
  assert.equal(short[0]?.length, 160);
  assert.equal(detailed.length <= 4, true);
  assert.equal(detailed.every((message) => message.length <= 420), true);
  assert.equal(detailed.join(" ").length <= 1_200, true);
  assert.equal(detailed.join(" ").length > short.join(" ").length, true);
});

test("formatReplyMessages honors a skill's 600-character reply budget", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 600,
      maxTotalReplyChars: 600,
      maxReplyMessages: 4,
      preferredMaxReplyMessages: 4,
      respectLineBreaks: false,
    },
    "x".repeat(500),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.length, 500);
});

test("formatReplyMessages stops at complete thoughts instead of leaving a half sentence tail", () => {
  const messages = formatReplyMessages(
    {
      ...skill,
      maxReplyCharsPerMessage: 70,
      maxTotalReplyChars: 90,
      maxReplyMessages: 3,
      preferredMaxReplyMessages: 3,
      respectLineBreaks: false,
    },
    [
      "agent就是接任务后自己拆步骤自己执行",
      "mcp就是把搜索和接口这些能力接进来",
      "skills就是提前写好规则语气和知识边界",
      "这三样配合起来才像真能干活的系统",
      "后面这句只是额外补充预算不够就整句丢掉",
    ].join("。"),
  );

  assert.deepEqual(messages, [
    "agent就是接任务后自己拆步骤自己执行 mcp就是把搜索和接口这些能力接进来 skills就是提前写好规则语气和知识边界",
    "这三样配合起来才像真能干活的系统",
  ]);
});
