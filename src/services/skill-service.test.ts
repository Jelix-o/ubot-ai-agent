import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HUIXIAN_SKILL_ID, isRetiredLegacySkillId, SkillService } from "./skill-service.js";

function huixian(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: HUIXIAN_SKILL_ID,
    name: "会仙",
    systemPrompt: "会仙是原创成年女性虚拟聊天伙伴。",
    styleRules: ["自然、诚实、有边界。"],
    knowledge: ["没有真实私人照片或线下行程。"],
    temperature: 0.8,
    maxContextTurns: 24,
    ...overrides,
  };
}

test("SkillService exposes only the Huixian persona", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huixian-only-"));
  try {
    await writeFile(path.join(dir, "huixian.json"), JSON.stringify(huixian()), "utf8");
    await writeFile(path.join(dir, "legacy.json"), JSON.stringify({ ...huixian(), id: "legacy", name: "Legacy" }), "utf8");
    const service = new SkillService(dir);

    assert.deepEqual((await service.getAllSkills()).map((item) => item.id), ["huixian"]);
    assert.equal((await service.getSkill("huixian"))?.name, "会仙");
    assert.equal(await service.getSkill("legacy"), undefined);
    assert.equal(isRetiredLegacySkillId("huixian"), false);
    assert.equal(isRetiredLegacySkillId("zxp"), true);
    assert.equal(isRetiredLegacySkillId("anything-else"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Huixian profile updates in place and strips legacy source material", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huixian-update-"));
  try {
    await writeFile(path.join(dir, "huixian.json"), JSON.stringify({
      ...huixian(),
      sourceSkillLines: ["private source material"],
      sourceSkillLineLimit: 500,
      ttsStyleHint: "自然亲切",
      ttsConfig: { voice: "Chloe", baseEmotion: "开心" },
    }), "utf8");
    const service = new SkillService(dir);

    const updated = await service.updateHuixianProfile({
      name: "会仙·虚拟聊天伙伴",
      knowledge: ["不伪造真人照片。"],
    });
    assert.equal(updated?.id, "huixian");
    assert.equal(updated?.name, "会仙·虚拟聊天伙伴");
    assert.deepEqual(updated?.ttsConfig, { stylePrompt: "自然亲切", voice: "Chloe" });

    const saved = JSON.parse(await readFile(path.join(dir, "huixian.json"), "utf8"));
    assert.equal(Object.hasOwn(saved, "sourceSkillLines"), false);
    assert.equal(Object.hasOwn(saved, "sourceSkillLineLimit"), false);
    assert.equal(saved.id, "huixian");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Huixian profile refreshes after an external update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huixian-refresh-"));
  const filePath = path.join(dir, "huixian.json");
  try {
    await writeFile(filePath, JSON.stringify(huixian({ systemPrompt: "第一版" })), "utf8");
    const service = new SkillService(dir);
    assert.equal((await service.getHuixianProfile())?.systemPrompt, "第一版");

    await writeFile(filePath, JSON.stringify(huixian({ systemPrompt: "第二版" })), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1000));
    assert.equal((await service.getHuixianProfile())?.systemPrompt, "第二版");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generic skill creation, import, removal and non-Huixian update are rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huixian-locked-"));
  try {
    await writeFile(path.join(dir, "huixian.json"), JSON.stringify(huixian()), "utf8");
    const service = new SkillService(dir);

    await assert.rejects(service.createSkill(huixian({ id: "other" }) as never), /huixian_only/);
    await assert.rejects(service.importSkill(JSON.stringify(huixian({ id: "other" }))), /huixian_only/);
    await assert.rejects(service.updateSkill("other", { name: "Other" }), /huixian_only/);
    assert.equal(await service.removeSkill("huixian"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Huixian backups only read and restore huixian.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huixian-backup-"));
  try {
    await writeFile(path.join(dir, "huixian.json"), JSON.stringify(huixian({ name: "会仙初版" })), "utf8");
    await writeFile(path.join(dir, "legacy.json"), JSON.stringify({ id: "legacy" }), "utf8");
    const service = new SkillService(dir);
    const backup = await service.backupSkills(new Date("2026-08-26T01:02:03Z"));
    assert.deepEqual(backup.files, ["huixian.json"]);

    await service.updateHuixianProfile({ name: "会仙新版" });
    const restored = await service.restoreBackup(path.basename(backup.backupDir));
    assert.deepEqual(restored.files, ["huixian.json"]);
    assert.equal((await service.getHuixianProfile())?.name, "会仙初版");
    assert.equal(JSON.parse(await readFile(path.join(dir, "legacy.json"), "utf8")).id, "legacy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
