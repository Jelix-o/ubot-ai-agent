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

test("buildTtsInputText returns MiMo assistant text with tags and strips markdown-like symbols", () => {
  const text = buildTtsInputText(skill, "**先说结论**\n- 这事可以做", "低沉 成熟 男声感");

  assert.match(text, /^\([^)]*\)/);
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
  assert.match(input.styleInstruction ?? "", /目标文本中的每句话已按 MiMo 标签自动标注基础情绪/);
  assert.match(input.assistantText, /^\(四川话 御姐音 开心 欣慰 活泼 清亮\)\[激动\]/);
  assert.match(input.assistantText, /太好了/);
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

  assert.match(input.assistantText, /^\(唱歌\)\(平静 干练 清亮\)/);
  assert.doesNotMatch(input.styleInstruction ?? "", /唱歌/);
});

test("buildMimoTtsInput applies sentence-level style and audio tags", () => {
  const input = buildMimoTtsInput(skill, "太好了！我有点紧张，会不会出错？");

  assert.match(input.assistantText, /^\(开心 欣慰 活泼 清亮\)\[激动\]太好了！/);
  assert.match(input.assistantText, /\(恐惧 忐忑 严肃 清亮\)\[屏息 紧张 声音颤抖\]我有点紧张，/);
  assert.match(input.assistantText, /\(惊讶 忐忑 俏皮 清亮\)\[震惊\]会不会出错？/);
});
