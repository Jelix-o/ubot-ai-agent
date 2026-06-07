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
  ttsStyleHint: "热情 真诚",
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
        baseEmotion: "兴奋",
        compoundEmotion: "忐忑",
        overallTone: "活泼",
        voiceTexture: "清亮",
        paceRhythm: "深呼吸",
        emotionState: "激动",
        voiceFeature: "气声",
        laughCry: "轻笑",
      },
    },
    "太好了！我们成功了。",
    "低沉 成熟 男声感",
  );

  assert.match(input.styleInstruction ?? "", /低沉 成熟 男声感/);
  assert.match(input.styleInstruction ?? "", /像发布会一样坚定/);
  assert.match(input.styleInstruction ?? "", /热情 真诚/);
  assert.match(input.styleInstruction ?? "", /音色使用 冰糖/);
  assert.match(input.styleInstruction ?? "", /根据每句话的语义自动匹配基础情绪/);
  assert.match(input.assistantText, /^\(兴奋 忐忑 活泼 清亮 深呼吸 激动 气声 轻笑\)/);
  assert.match(input.assistantText, /太好了/);
});

test("buildMimoTtsInput adds singing tag only to assistant text", () => {
  const input = buildMimoTtsInput(skill, "今天的风，唱给你听。", undefined, { mode: "singing" });

  assert.match(input.assistantText, /^\(唱歌/);
  assert.doesNotMatch(input.styleInstruction ?? "", /唱歌/);
});
