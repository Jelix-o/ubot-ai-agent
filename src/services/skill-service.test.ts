import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillService } from "./skill-service.js";

test("SkillService normalizes reply defaults and simplifies legacy TTS config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-"));
  const service = new SkillService(dir);

  await writeFile(path.join(dir, "legacy.json"), JSON.stringify({
    id: "legacy",
    name: "旧 Skill",
    systemPrompt: "按角色说话",
    styleRules: [],
    knowledge: [],
    ttsStyleHint: "旧版提示迁移",
    ttsConfig: {
      voice: "Chloe",
      dialect: "粤语",
      personaTone: "御姐音",
      baseEmotion: "开心",
      compoundEmotion: "怅然",
      overallTone: "温柔",
      voiceTexture: "清亮",
      paceRhythm: "深呼吸",
      emotionState: "激动",
      voiceFeature: "气声",
      laughCry: "轻笑",
    },
    temperature: 0.7,
    maxContextTurns: 12,
  }));

  try {
    const skill = await service.getSkill("legacy");
    assert.ok(skill);
    assert.equal(skill.ttsStyleHint, undefined);
    assert.deepEqual(skill.ttsConfig, {
      stylePrompt: "旧版提示迁移",
      voice: "Chloe",
      dialect: "粤语",
      personaTone: "御姐音",
    });
    assert.equal(skill.stripAsterisks, true);
    assert.equal(skill.singleSentencePerMessage, false);
    assert.equal(skill.stripTerminalPunctuation, true);
    assert.equal(skill.respectLineBreaks, true);

    await service.updateSkill("legacy", skill);
    const saved = JSON.parse(await readFile(path.join(dir, "legacy.json"), "utf8"));
    assert.equal("ttsStyleHint" in saved, false);
    assert.equal("baseEmotion" in saved.ttsConfig, false);
    assert.equal(saved.stripAsterisks, true);
    assert.equal(saved.singleSentencePerMessage, false);
    assert.equal(saved.stripTerminalPunctuation, true);
    assert.equal(saved.respectLineBreaks, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
