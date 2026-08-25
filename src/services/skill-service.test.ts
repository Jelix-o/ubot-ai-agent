import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isRetiredLegacySkillId, SkillService } from "./skill-service.js";

function assertNoLegacySourceMaterial(value: object): void {
  assert.equal(Object.hasOwn(value, "sourceSkillLines"), false);
  assert.equal(Object.hasOwn(value, "sourceSkillLineLimit"), false);
}

test("SkillService reloads externally modified profiles without a process restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-external-refresh-"));
  const filePath = path.join(dir, "assistant.json");
  const service = new SkillService(dir);
  const base = {
    id: "assistant",
    name: "机器人",
    systemPrompt: "保持第一版人格",
    styleRules: [],
    knowledge: [],
    temperature: 0.7,
    maxContextTurns: 12,
  };

  try {
    await writeFile(filePath, JSON.stringify(base));
    assert.equal((await service.getSkill("assistant"))?.systemPrompt, "保持第一版人格");

    await writeFile(filePath, JSON.stringify({ ...base, systemPrompt: "保持第二版人格" }));
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal((await service.getSkill("assistant"))?.systemPrompt, "保持第二版人格");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    assertNoLegacySourceMaterial(skill);

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

test("SkillService reads legacy source material without mutating the source file and strips it from explicit outputs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-source-material-"));
  const service = new SkillService(dir);
  const legacySkill = {
    id: "legacy",
    name: "Legacy Skill",
    systemPrompt: "Use the configured profile only.",
    styleRules: ["Keep responses direct."],
    knowledge: ["Use verified facts."],
    sourceSkillLines: ["private source material"],
    sourceSkillLineLimit: 500,
    temperature: 0.7,
    maxContextTurns: 12,
  };

  try {
    const legacySourceJson = JSON.stringify(legacySkill);
    await writeFile(path.join(dir, "legacy.json"), legacySourceJson);

    const readSkill = await service.getSkill("legacy");
    assert.ok(readSkill);
    assertNoLegacySourceMaterial(readSkill);
    assert.equal(await readFile(path.join(dir, "legacy.json"), "utf8"), legacySourceJson);
    const sourceAfterRead = JSON.parse(await readFile(path.join(dir, "legacy.json"), "utf8"));
    assert.deepEqual(sourceAfterRead.sourceSkillLines, ["private source material"]);
    assert.equal(sourceAfterRead.sourceSkillLineLimit, 500);

    const updatedLegacy = await service.updateSkill("legacy", { knowledge: ["Persist only configured knowledge."] });
    assert.ok(updatedLegacy);
    assertNoLegacySourceMaterial(updatedLegacy);
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(dir, "legacy.json"), "utf8")));

    const created = await service.createSkill({ ...legacySkill, id: "created" });
    assertNoLegacySourceMaterial(created);
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(dir, "created.json"), "utf8")));

    const updated = await service.updateSkill("created", { knowledge: ["Updated configured knowledge."] });
    assert.ok(updated);
    assertNoLegacySourceMaterial(updated);
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(dir, "created.json"), "utf8")));

    const imported = await service.importSkill(JSON.stringify({ ...legacySkill, id: "imported" }));
    assertNoLegacySourceMaterial(imported);
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(dir, "imported.json"), "utf8")));

    const exported = await service.exportSkill("imported");
    assert.ok(exported);
    assertNoLegacySourceMaterial(JSON.parse(exported));
    assert.equal(exported.includes("private source material"), false);

    await writeFile(path.join(dir, "backup-source.json"), JSON.stringify({ ...legacySkill, id: "backup-source" }));
    const backup = await service.backupSkills(new Date("2026-08-25T01:02:03Z"));
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(backup.backupDir, "backup-source.json"), "utf8")));
    const backupSourceAfterBackup = JSON.parse(await readFile(path.join(dir, "backup-source.json"), "utf8"));
    assert.deepEqual(backupSourceAfterBackup.sourceSkillLines, ["private source material"]);
    assert.equal(backupSourceAfterBackup.sourceSkillLineLimit, 500);

    const restoreSource = { ...legacySkill, id: "restore-source", sourceSkillLines: ["restored private source material"] };
    await writeFile(path.join(backup.backupDir, "restore-source.json"), JSON.stringify(restoreSource));
    await service.restoreBackup(path.basename(backup.backupDir));
    const restoreBackupSource = JSON.parse(await readFile(path.join(backup.backupDir, "restore-source.json"), "utf8"));
    assert.deepEqual(restoreBackupSource.sourceSkillLines, ["restored private source material"]);
    assert.equal(restoreBackupSource.sourceSkillLineLimit, 500);
    assertNoLegacySourceMaterial(JSON.parse(await readFile(path.join(dir, "restore-source.json"), "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillService retires raw legacy personas without modifying their source files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-retired-personas-"));
  const service = new SkillService(dir);
  const activeSkill = {
    id: "huixian",
    name: "会仙",
    systemPrompt: "Use the maintained profile.",
    styleRules: [],
    knowledge: [],
    temperature: 0.7,
    maxContextTurns: 12,
  };
  const legacySkill = {
    ...activeSkill,
    id: "zxp",
    name: "Retired source persona",
    systemPrompt: "Do not load this raw source persona.",
  };
  const legacyFile = path.join(dir, "zxp.json");
  const renamedLegacyFile = path.join(dir, "owner-archive.json");
  const legacyJson = JSON.stringify(legacySkill);

  try {
    await writeFile(path.join(dir, "huixian.json"), JSON.stringify(activeSkill));
    await writeFile(legacyFile, legacyJson);
    await writeFile(renamedLegacyFile, legacyJson);

    for (const retiredId of ["ZXP", "youmi", "leijun", "jackma"]) {
      assert.equal(isRetiredLegacySkillId(retiredId), true);
    }
    assert.equal(isRetiredLegacySkillId("huixian"), false);
    assert.deepEqual((await service.getAllSkills()).map((skill) => skill.id), ["huixian"]);
    assert.equal(await service.getSkill("zxp"), undefined);
    assert.equal(await service.exportSkill("zxp"), undefined);
    assert.equal(await service.removeSkill("zxp"), false);
    assert.equal(await service.removeSkill("owner-archive"), false);
    await assert.rejects(service.createSkill(legacySkill), /invalid_skill_id/);
    await assert.rejects(service.importSkill(JSON.stringify(legacySkill)), /invalid_skill_id/);
    await assert.rejects(service.updateSkill("zxp", { name: "Should not write" }), /invalid_skill_id/);

    const backup = await service.backupSkills(new Date("2026-08-25T01:02:03Z"));
    assert.deepEqual(backup.files, ["huixian.json"]);
    await assert.rejects(readFile(path.join(backup.backupDir, "zxp.json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(backup.backupDir, "owner-archive.json"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(legacyFile, "utf8"), legacyJson);
    assert.equal(await readFile(renamedLegacyFile, "utf8"), legacyJson);

    await writeFile(path.join(dir, "huixian.json"), JSON.stringify({ ...activeSkill, name: "Changed" }));
    await writeFile(path.join(backup.backupDir, "zxp.json"), legacyJson);
    await writeFile(path.join(backup.backupDir, "owner-archive.json"), legacyJson);
    const restored = await service.restoreBackup(path.basename(backup.backupDir));
    assert.deepEqual(restored.files, ["huixian.json"]);
    assert.equal((await service.getSkill("huixian"))?.name, "会仙");
    assert.equal(await readFile(legacyFile, "utf8"), legacyJson);
    assert.equal(await readFile(renamedLegacyFile, "utf8"), legacyJson);
    assert.deepEqual((await service.listBackups())[0]?.files, ["huixian.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
