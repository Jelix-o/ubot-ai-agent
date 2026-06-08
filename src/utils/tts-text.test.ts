import assert from "node:assert/strict";
import test from "node:test";

import type { SkillDefinition } from "../types.js";
import { buildMimoTtsInput, buildTtsInputText } from "./tts-text.js";

const skill: SkillDefinition = {
  id: "leijun",
  name: "雷军",
  systemPrompt: "",
  styleRules: [],
  knowledge: [],
  ttsConfig: {
    stylePrompt: "热情 真诚",
  },
  temperature: 0.8,
  maxContextTurns: 12,
  stripAsterisks: true,
  stripTerminalPunctuation: true,
};

test("buildTtsInputText returns clean MiMo assistant text and strips markdown-like symbols", () => {
  const text = buildTtsInputText(skill, "**先说结论**\n- 这事可以做", "低沉 成熟 男声感");

  assert.equal(text, "先说结论，这事可以做");
  assert.equal(text.includes("先说结论"), true);
  assert.equal(text.includes("*"), false);
  assert.equal(text.includes("<style>"), false);
});

test("buildMimoTtsInput separates natural-language control and assistant target text", () => {
  const input = buildMimoTtsInput(
    {
      ...skill,
      ttsConfig: {
        stylePrompt: "像发布会一样坚定",
        voice: "冰糖",
        dialect: "四川话",
        personaTone: "御姐音",
      },
    },
    "太好了！我们成功了。",
    "低沉 成熟 男声感",
  );

  assert.match(input.styleInstruction ?? "", /低沉 成熟 男声感/);
  assert.match(input.styleInstruction ?? "", /像发布会一样坚定/);
  assert.match(input.styleInstruction ?? "", /音色使用 冰糖/);
  assert.match(input.styleInstruction ?? "", /带一点四川话口音/);
  assert.match(input.styleInstruction ?? "", /人设腔调偏御姐音/);
  assert.match(input.styleInstruction ?? "", /参考风格：开心、欣慰、活泼、清亮/);
  assert.match(input.styleInstruction ?? "", /本消息中的风格、语气、情绪、音色、语速和舞台控制说明只用于演绎，不要朗读/);
  assert.equal(input.assistantText, "太好了！我们成功了。");
  assert.doesNotMatch(input.assistantText, /^\([^)]*\)/);
  assert.doesNotMatch(input.assistantText, /\[[^\]]+\]/);
});

test("buildMimoTtsInput ignores legacy skill ttsStyleHint", () => {
  const input = buildMimoTtsInput(
    {
      ...skill,
      ttsStyleHint: "旧版提示不再生效",
      ttsConfig: {},
    },
    "这句正常说",
  );

  assert.doesNotMatch(input.styleInstruction ?? "", /旧版提示不再生效/);
});

test("buildMimoTtsInput adds singing tag only to assistant text", () => {
  const input = buildMimoTtsInput(skill, "今天的风，唱给你听。", undefined, { mode: "singing" });

  assert.equal(input.assistantText, "(唱歌)今天的风，唱给你听。");
  assert.match(input.styleInstruction ?? "", /使用唱歌模式自然演绎正文/);
});

test("buildMimoTtsInput keeps inferred sentence style out of assistant text", () => {
  const input = buildMimoTtsInput(skill, "太好了！我有点紧张，会不会出错？");

  assert.equal(input.assistantText, "太好了！我有点紧张，会不会出错？");
  assert.doesNotMatch(input.assistantText, /\(开心|恐惧|惊讶/);
  assert.doesNotMatch(input.assistantText, /\[语速稍快|屏息|语尾上扬/);
  assert.match(input.styleInstruction ?? "", /参考风格：开心、欣慰、活泼、清亮、恐惧、忐忑、严肃、惊讶、俏皮/);
  assert.match(input.styleInstruction ?? "", /参考语音表现：语速稍快、激动、明亮、无哭笑、屏息、紧张、声音颤抖、语尾上扬、震惊、清晰/);
});

test("buildMimoTtsInput strips common stage directions from assistant target text", () => {
  const input = buildMimoTtsInput(skill, "哈哈哈这也太牛了！别慌，我陪你。");

  assert.equal(input.assistantText, "哈哈哈这也太牛了！别慌，我陪你。");
  assert.match(input.styleInstruction ?? "", /参考语音表现：语速稍快、激动、明亮、大笑、屏息、紧张、声音颤抖、无哭笑、轻缓、温柔、柔和/);
});

test("buildMimoTtsInput removes bracketed narration but preserves natural particles", () => {
  const input = buildMimoTtsInput(skill, "（轻声）你好呀\n[温柔地]晚安呢\n`出发`");

  assert.equal(input.assistantText, "你好呀，晚安呢，出发");
  assert.doesNotMatch(input.assistantText, /轻声|温柔地|\[|\]/);
});
