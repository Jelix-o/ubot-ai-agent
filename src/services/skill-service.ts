import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { SkillDefinition, SkillTtsConfig } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import {
  MIMO_TTS_DIALECTS,
  MIMO_TTS_PERSONA_TONES,
  MIMO_TTS_PRESET_VOICES,
} from "./mimo-tts-config.js";

const RETIRED_LEGACY_SKILL_IDS = new Set(["zxp", "youmi", "leijun", "jackma"]);

/**
 * These files are retained as owner-managed source material, but are never
 * exposed through the runtime skill registry or administrative skill flows.
 */
export function isRetiredLegacySkillId(skillId: unknown): boolean {
  return RETIRED_LEGACY_SKILL_IDS.has(normalizeSkillId(skillId).toLowerCase());
}

export class SkillService {
  private cachedSkills?: SkillDefinition[];
  private cachedVersion?: string;

  constructor(private readonly skillsDir: string) {}

  async getSkill(skillId: string, options: { refresh?: boolean } = {}): Promise<SkillDefinition | undefined> {
    if (isRetiredLegacySkillId(skillId)) {
      return undefined;
    }
    const skills = await this.getAllSkills(options);
    return skills.find((skill) => skill.id === skillId);
  }

  async getAllSkills(options: { refresh?: boolean } = {}): Promise<SkillDefinition[]> {
    if (options.refresh) {
      this.invalidateCache();
    }
    const jsonFiles = await this.listSkillFiles();
    const version = await skillFilesVersion(this.skillsDir, jsonFiles.map((entry) => entry.name));
    if (this.cachedSkills && this.cachedVersion === version) {
      return this.cloneSkills(this.cachedSkills);
    }

    const skills = (await Promise.all(
      jsonFiles.map(async (entry) => {
        const filePath = path.join(this.skillsDir, entry.name);
        return this.readSkillFile(filePath);
      }),
    )).filter((skill) => !isRetiredLegacySkillId(skill.id));

    this.cachedSkills = skills.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    this.cachedVersion = await skillFilesVersion(this.skillsDir, jsonFiles.map((entry) => entry.name));
    return this.cloneSkills(this.cachedSkills);
  }

  async createSkill(input: SkillDefinition): Promise<SkillDefinition> {
    const skill = normalizeSkillDefinition(input);
    assertWritableSkillId(skill.id);
    const existing = await this.getSkill(skill.id);
    if (existing) {
      throw new Error("skill_exists");
    }
    await this.writeSkillFile(skill.id, skill);
    this.invalidateCache();
    return skill;
  }

  async updateSkill(skillId: string, input: Partial<SkillDefinition>): Promise<SkillDefinition | undefined> {
    assertWritableSkillId(skillId);
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
    this.invalidateCache();
    return next;
  }

  async removeSkill(skillId: string): Promise<boolean> {
    if (isRetiredLegacySkillId(skillId)) {
      return false;
    }
    const filePath = this.skillFilePath(skillId);
    try {
      if (await this.isRetiredSkillFile(filePath)) {
        return false;
      }
      await import("node:fs/promises").then(({ rm }) => rm(filePath));
      this.invalidateCache();
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
    if (isRetiredLegacySkillId(skillId)) {
      return undefined;
    }
    const skill = await this.getSkill(skillId);
    return skill ? `${JSON.stringify(normalizeSkillDefinition(skill), null, 2)}\n` : undefined;
  }

  async importSkill(raw: string): Promise<SkillDefinition> {
    const parsed = JSON.parse(raw) as SkillDefinition;
    const skill = normalizeSkillDefinition(parsed);
    assertWritableSkillId(skill.id);
    await this.writeSkillFile(skill.id, skill);
    this.invalidateCache();
    return skill;
  }

  async backupSkills(now = new Date()): Promise<{ backupDir: string; files: string[] }> {
    const backupDir = path.join(this.skillsDir, ".backups", toCompactTimestamp(now));
    await mkdir(backupDir, { recursive: true });
    const files = await readdir(this.skillsDir, { withFileTypes: true });
    const copied: string[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || isRetiredLegacySkillId(path.parse(entry.name).name)) {
        continue;
      }
      const source = path.join(this.skillsDir, entry.name);
      const skill = await this.readSkillFile(source);
      if (isRetiredLegacySkillId(skill.id)) {
        continue;
      }
      const target = path.join(backupDir, entry.name);
      await writeJsonFileAtomic(target, skill);
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
        const files = (await Promise.all(
          (await readdir(backupDir, { withFileTypes: true }))
            .filter((file) => file.isFile() && file.name.endsWith(".json") && !isRetiredLegacySkillId(path.parse(file.name).name))
            .map(async (file) =>
              await this.isRetiredSkillFile(path.join(backupDir, file.name)) ? undefined : file.name,
            ),
        )).filter((file): file is string => Boolean(file)).sort();
        return {
          id: entry.name,
          createdAt: compactTimestampToIso(entry.name),
          files,
        };
      }));
    return backups
      .filter((backup) => backup.files.length > 0)
      .sort((left, right) => right.id.localeCompare(left.id));
  }

  async restoreBackup(backupId: string): Promise<{ restoredCount: number; files: string[] }> {
    if (!/^\d{14}$/.test(backupId)) {
      throw new Error("invalid_backup_id");
    }
    const backupDir = path.join(this.skillsDir, ".backups", backupId);
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backupFiles = entries.filter((entry) =>
      entry.isFile() && entry.name.endsWith(".json") && !isRetiredLegacySkillId(path.parse(entry.name).name),
    );
    if (backupFiles.length === 0) {
      throw new Error("backup_empty");
    }
    const restoredSkills = (await Promise.all(backupFiles.map(async (entry) => ({
      name: entry.name,
      skill: await this.readSkillFile(path.join(backupDir, entry.name)),
    })))).filter((entry) => !isRetiredLegacySkillId(entry.skill.id));
    if (restoredSkills.length === 0) {
      throw new Error("backup_empty");
    }
    const currentFiles = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of currentFiles) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !isRetiredLegacySkillId(path.parse(entry.name).name) &&
        !(await this.isRetiredSkillFile(path.join(this.skillsDir, entry.name)))
      ) {
        await rm(path.join(this.skillsDir, entry.name));
      }
    }
    const restored: string[] = [];
    for (const entry of restoredSkills) {
      await writeJsonFileAtomic(path.join(this.skillsDir, entry.name), entry.skill);
      restored.push(entry.name);
    }
    this.invalidateCache();
    return { restoredCount: restored.length, files: restored.sort() };
  }

  private invalidateCache(): void {
    this.cachedSkills = undefined;
    this.cachedVersion = undefined;
  }

  private async listSkillFiles(): Promise<Array<{ name: string }>> {
    try {
      const files = await readdir(this.skillsDir, { withFileTypes: true });
      return files
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !isRetiredLegacySkillId(path.parse(entry.name).name))
        .map((entry) => ({ name: entry.name }));
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readSkillFile(filePath: string): Promise<SkillDefinition> {
    const raw = await readJsonFile<SkillDefinition>(filePath);
    return normalizeSkillDefinition(raw);
  }

  private cloneSkills(skills: SkillDefinition[]): SkillDefinition[] {
    return skills.map((skill) => normalizeSkillDefinition(skill));
  }

  private async writeSkillFile(skillId: string, skill: SkillDefinition): Promise<void> {
    assertWritableSkillId(skillId);
    assertWritableSkillId(skill.id);
    await mkdir(this.skillsDir, { recursive: true });
    await writeJsonFileAtomic(this.skillFilePath(skillId), skill);
  }

  private async isRetiredSkillFile(filePath: string): Promise<boolean> {
    try {
      const raw = await readJsonFile<Partial<SkillDefinition>>(filePath);
      return isRetiredLegacySkillId(raw.id);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private skillFilePath(skillId: string): string {
    const safeId = normalizeSkillId(skillId);
    if (!safeId) {
      throw new Error("invalid_skill_id");
    }
    return path.join(this.skillsDir, `${safeId}.json`);
  }
}

async function skillFilesVersion(skillsDir: string, fileNames: string[]): Promise<string> {
  const parts = await Promise.all(fileNames.map(async (name) => {
    const metadata = await stat(path.join(skillsDir, name));
    return `${name}:${metadata.mtimeMs}:${metadata.size}`;
  }));
  return parts.sort().join("|");
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
  const legacyTtsStyleHint = typeof value.ttsStyleHint === "string" ? value.ttsStyleHint.trim().slice(0, 400) : "";
  const ttsConfig = normalizeSkillTtsConfig(value.ttsConfig, legacyTtsStyleHint);
  return {
    id,
    name: name.slice(0, 80),
    systemPrompt,
    styleRules: normalizeStringArray(value.styleRules),
    knowledge: normalizeStringArray(value.knowledge),
    // Legacy source material may be accepted from old files or imports, but it
    // must never enter the runtime cache, API output, exports, or backups.
    ...(Object.keys(ttsConfig).length > 0 ? { ttsConfig } : {}),
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
    stripAsterisks: value.stripAsterisks !== undefined ? value.stripAsterisks === true : true,
    singleSentencePerMessage: value.singleSentencePerMessage === true,
    stripTerminalPunctuation: value.stripTerminalPunctuation !== undefined ? value.stripTerminalPunctuation === true : true,
    respectLineBreaks: value.respectLineBreaks !== undefined ? value.respectLineBreaks === true : true,
    ...(value.allowBurstOnHighEmotion !== undefined ? { allowBurstOnHighEmotion: value.allowBurstOnHighEmotion === true } : {}),
    ...(Array.isArray(value.highEmotionKeywords) ? { highEmotionKeywords: normalizeStringArray(value.highEmotionKeywords, 50, 40) } : {}),
  };
}

function normalizeSkillTtsConfig(value: unknown, legacyStylePrompt = ""): SkillTtsConfig {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof SkillTtsConfig, unknown>>
    : {};
  const next: SkillTtsConfig = {};

  const stylePrompt = normalizeOptionalString(record.stylePrompt, 800) || legacyStylePrompt;
  if (stylePrompt) next.stylePrompt = stylePrompt;
  addEnum(next, "voice", record.voice, MIMO_TTS_PRESET_VOICES);
  addEnum(next, "dialect", record.dialect, MIMO_TTS_DIALECTS);
  addEnum(next, "personaTone", record.personaTone, MIMO_TTS_PERSONA_TONES);
  return next;
}

function addEnum<K extends keyof SkillTtsConfig>(
  target: SkillTtsConfig,
  key: K,
  value: unknown,
  allowed: readonly string[],
): void {
  const text = normalizeOptionalString(value, 80);
  if (!text) return;
  if (!allowed.includes(text)) {
    throw new Error("invalid_skill_tts_config");
  }
  (target as Record<keyof SkillTtsConfig, string | undefined>)[key] = text;
}

function normalizeOptionalString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function normalizeSkillId(value: unknown): string {
  const id = String(value ?? "").trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : "";
}

function assertWritableSkillId(skillId: unknown): void {
  if (isRetiredLegacySkillId(skillId)) {
    // Keep the established admin API error contract while denying writes to
    // retired IDs. The predicate remains available to callers that need the
    // more specific retirement reason.
    throw new Error("invalid_skill_id");
  }
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
