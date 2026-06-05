import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SkillDefinition } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

export class SkillService {
  private cachedSkills?: SkillDefinition[];

  constructor(private readonly skillsDir: string) {}

  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    const skills = await this.getAllSkills();
    return skills.find((skill) => skill.id === skillId);
  }

  async getAllSkills(): Promise<SkillDefinition[]> {
    if (this.cachedSkills) {
      return this.cachedSkills;
    }

    const files = await readdir(this.skillsDir, { withFileTypes: true });
    const jsonFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    const skills = await Promise.all(
      jsonFiles.map(async (entry) => {
        const filePath = path.join(this.skillsDir, entry.name);
        return readJsonFile<SkillDefinition>(filePath);
      }),
    );

    this.cachedSkills = skills.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    return this.cachedSkills;
  }

  async createSkill(input: SkillDefinition): Promise<SkillDefinition> {
    const skill = normalizeSkillDefinition(input);
    const existing = await this.getSkill(skill.id);
    if (existing) {
      throw new Error("skill_exists");
    }
    await this.writeSkillFile(skill.id, skill);
    this.cachedSkills = undefined;
    return skill;
  }

  async updateSkill(skillId: string, input: Partial<SkillDefinition>): Promise<SkillDefinition | undefined> {
    const current = await this.getSkill(skillId);
    if (!current) {
      return undefined;
    }
    const next = normalizeSkillDefinition({
      ...current,
      ...input,
      id: skillId,
    });
    await this.writeSkillFile(skillId, next);
    this.cachedSkills = undefined;
    return next;
  }

  async removeSkill(skillId: string): Promise<boolean> {
    const filePath = this.skillFilePath(skillId);
    try {
      await import("node:fs/promises").then(({ rm }) => rm(filePath));
      this.cachedSkills = undefined;
      return true;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async exportSkill(skillId: string): Promise<string | undefined> {
    const skill = await this.getSkill(skillId);
    return skill ? `${JSON.stringify(skill, null, 2)}\n` : undefined;
  }

  async importSkill(raw: string): Promise<SkillDefinition> {
    const parsed = JSON.parse(raw) as SkillDefinition;
    const skill = normalizeSkillDefinition(parsed);
    await this.writeSkillFile(skill.id, skill);
    this.cachedSkills = undefined;
    return skill;
  }

  async backupSkills(now = new Date()): Promise<{ backupDir: string; files: string[] }> {
    const backupDir = path.join(this.skillsDir, ".backups", toCompactTimestamp(now));
    await mkdir(backupDir, { recursive: true });
    const files = await readdir(this.skillsDir, { withFileTypes: true });
    const copied: string[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const source = path.join(this.skillsDir, entry.name);
      const target = path.join(backupDir, entry.name);
      await writeFile(target, await readFile(source));
      copied.push(entry.name);
    }
    return { backupDir, files: copied };
  }

  async listBackups(): Promise<Array<{ id: string; createdAt: string; files: string[] }>> {
    const backupRoot = path.join(this.skillsDir, ".backups");
    let entries;
    try {
      entries = await readdir(backupRoot, { withFileTypes: true });
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") return [];
      throw error;
    }
    const backups = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d{14}$/.test(entry.name))
      .map(async (entry) => {
        const backupDir = path.join(backupRoot, entry.name);
        const files = (await readdir(backupDir, { withFileTypes: true }))
          .filter((file) => file.isFile() && file.name.endsWith(".json"))
          .map((file) => file.name)
          .sort();
        return {
          id: entry.name,
          createdAt: compactTimestampToIso(entry.name),
          files,
        };
      }));
    return backups.sort((left, right) => right.id.localeCompare(left.id));
  }

  async restoreBackup(backupId: string): Promise<{ restoredCount: number; files: string[] }> {
    if (!/^\d{14}$/.test(backupId)) {
      throw new Error("invalid_backup_id");
    }
    const backupDir = path.join(this.skillsDir, ".backups", backupId);
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backupFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (backupFiles.length === 0) {
      throw new Error("backup_empty");
    }
    const currentFiles = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of currentFiles) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        await rm(path.join(this.skillsDir, entry.name));
      }
    }
    const restored: string[] = [];
    for (const entry of backupFiles) {
      await writeFile(path.join(this.skillsDir, entry.name), await readFile(path.join(backupDir, entry.name)));
      restored.push(entry.name);
    }
    this.cachedSkills = undefined;
    return { restoredCount: restored.length, files: restored.sort() };
  }

  private async writeSkillFile(skillId: string, skill: SkillDefinition): Promise<void> {
    await mkdir(this.skillsDir, { recursive: true });
    await writeFile(this.skillFilePath(skillId), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
  }

  private skillFilePath(skillId: string): string {
    const safeId = normalizeSkillId(skillId);
    if (!safeId) {
      throw new Error("invalid_skill_id");
    }
    return path.join(this.skillsDir, `${safeId}.json`);
  }
}

function normalizeSkillDefinition(value: SkillDefinition): SkillDefinition {
  const id = normalizeSkillId(value.id);
  if (!id) {
    throw new Error("invalid_skill_id");
  }
  const name = String(value.name ?? "").trim();
  const systemPrompt = String(value.systemPrompt ?? "").trim();
  if (!name || !systemPrompt) {
    throw new Error("invalid_skill");
  }
  return {
    id,
    name: name.slice(0, 80),
    systemPrompt,
    styleRules: normalizeStringArray(value.styleRules),
    knowledge: normalizeStringArray(value.knowledge),
    ...(Array.isArray(value.sourceSkillLines) ? { sourceSkillLines: normalizeStringArray(value.sourceSkillLines, 2000, 1000) } : {}),
    ...(typeof value.ttsStyleHint === "string" && value.ttsStyleHint.trim() ? { ttsStyleHint: value.ttsStyleHint.trim().slice(0, 400) } : {}),
    ...(Array.isArray(value.exampleExchanges) ? { exampleExchanges: value.exampleExchanges.map((item) => ({
      user: String(item?.user ?? "").trim().slice(0, 1000),
      assistant: String(item?.assistant ?? "").trim().slice(0, 1000),
    })).filter((item) => item.user && item.assistant).slice(0, 20) } : {}),
    temperature: normalizeNumber(value.temperature, 0.7, 0, 2),
    maxContextTurns: Math.max(1, Math.min(50, Math.floor(normalizeNumber(value.maxContextTurns, 12, 1, 50)))),
    ...(value.maxReplyCharsPerMessage !== undefined ? { maxReplyCharsPerMessage: normalizeOptionalInt(value.maxReplyCharsPerMessage, 20, 4000) } : {}),
    ...(value.maxTotalReplyChars !== undefined ? { maxTotalReplyChars: normalizeOptionalInt(value.maxTotalReplyChars, 20, 8000) } : {}),
    ...(value.maxReplyMessages !== undefined ? { maxReplyMessages: normalizeOptionalInt(value.maxReplyMessages, 1, 20) } : {}),
    ...(value.preferredMaxReplyMessages !== undefined ? { preferredMaxReplyMessages: normalizeOptionalInt(value.preferredMaxReplyMessages, 1, 20) } : {}),
    ...(value.stripAsterisks !== undefined ? { stripAsterisks: value.stripAsterisks === true } : {}),
    ...(value.singleSentencePerMessage !== undefined ? { singleSentencePerMessage: value.singleSentencePerMessage === true } : {}),
    ...(value.stripTerminalPunctuation !== undefined ? { stripTerminalPunctuation: value.stripTerminalPunctuation === true } : {}),
    ...(value.respectLineBreaks !== undefined ? { respectLineBreaks: value.respectLineBreaks === true } : {}),
    ...(value.allowBurstOnHighEmotion !== undefined ? { allowBurstOnHighEmotion: value.allowBurstOnHighEmotion === true } : {}),
    ...(Array.isArray(value.highEmotionKeywords) ? { highEmotionKeywords: normalizeStringArray(value.highEmotionKeywords, 50, 40) } : {}),
  };
}

function normalizeSkillId(value: unknown): string {
  const id = String(value ?? "").trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : "";
}

function normalizeStringArray(value: unknown, limit = 200, itemLimit = 2000): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim().slice(0, itemLimit)).filter(Boolean).slice(0, limit);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? Math.max(min, Math.min(max, numberValue)) : fallback;
}

function normalizeOptionalInt(value: unknown, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(normalizeNumber(value, min, min, max))));
}

function toCompactTimestamp(now: Date): string {
  return [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
    `${now.getHours()}`.padStart(2, "0"),
    `${now.getMinutes()}`.padStart(2, "0"),
    `${now.getSeconds()}`.padStart(2, "0"),
  ].join("");
}

function compactTimestampToIso(value: string): string {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(8, 10);
  const minute = value.slice(10, 12);
  const second = value.slice(12, 14);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).toISOString();
}
