import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CharacterProfile, SkillDefinition, SkillTtsConfig } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import {
  MIMO_TTS_DIALECTS,
  MIMO_TTS_PERSONA_TONES,
  MIMO_TTS_PRESET_VOICES,
} from "./mimo-tts-config.js";

export const HUIXIAN_SKILL_ID = "huixian";
/** V3 name for the only supported persona identifier. */
export const HUIXIAN_CHARACTER_PROFILE_ID = HUIXIAN_SKILL_ID;

export interface HuixianProfileReader {
  getHuixianProfile(options?: { refresh?: boolean }): Promise<CharacterProfile | undefined>;
}

/**
 * The product no longer exposes a skill marketplace or switchable personas.
 * This predicate remains for compatibility with old group configuration and
 * callers that need to distinguish the sole supported persona.
 */
export function isRetiredLegacySkillId(skillId: unknown): boolean {
  return normalizeSkillId(skillId).toLowerCase() !== HUIXIAN_SKILL_ID;
}

/**
 * Legacy JSON archive adapter. V3 runtime composition must use
 * CharacterProfileService with V3StateRepository instead. This remains to
 * import/export the old `skills/huixian.json` during a controlled migration.
 */
export class SkillService implements HuixianProfileReader {
  private cachedHuixian?: SkillDefinition;
  private cachedVersion?: string;

  constructor(private readonly skillsDir: string) {}

  async getHuixianProfile(options: { refresh?: boolean } = {}): Promise<SkillDefinition | undefined> {
    if (options.refresh) {
      this.invalidateCache();
    }
    const filePath = this.skillFilePath();
    const version = await fileVersion(filePath);
    if (this.cachedHuixian && this.cachedVersion === version) {
      return cloneSkill(this.cachedHuixian);
    }
    try {
      const profile = normalizeHuixianCharacterProfile(await readJsonFile<SkillDefinition>(filePath));
      if (profile.id !== HUIXIAN_SKILL_ID) {
        throw new Error("invalid_huixian_profile");
      }
      this.cachedHuixian = profile;
      this.cachedVersion = version;
      return cloneSkill(profile);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedHuixian = undefined;
        this.cachedVersion = "missing";
        return undefined;
      }
      throw error;
    }
  }

  async updateHuixianProfile(input: Partial<SkillDefinition>): Promise<SkillDefinition | undefined> {
    const current = await this.getHuixianProfile();
    if (!current) {
      return undefined;
    }
    const next = normalizeHuixianCharacterProfile({
      ...current,
      ...input,
      id: HUIXIAN_SKILL_ID,
    });
    await mkdir(this.skillsDir, { recursive: true });
    await writeJsonFileAtomic(this.skillFilePath(), next);
    this.cachedHuixian = next;
    this.cachedVersion = await fileVersion(this.skillFilePath());
    return cloneSkill(next);
  }

  /** Compatibility boundary for existing model/runtime callers. */
  async getSkill(skillId: string, options: { refresh?: boolean } = {}): Promise<SkillDefinition | undefined> {
    return normalizeSkillId(skillId) === HUIXIAN_SKILL_ID
      ? this.getHuixianProfile(options)
      : undefined;
  }

  /** Compatibility boundary: the registry always contains exactly one persona. */
  async getAllSkills(options: { refresh?: boolean } = {}): Promise<SkillDefinition[]> {
    const profile = await this.getHuixianProfile(options);
    return profile ? [profile] : [];
  }

  async createSkill(_input: SkillDefinition): Promise<SkillDefinition> {
    throw new Error("huixian_only");
  }

  async updateSkill(skillId: string, input: Partial<SkillDefinition>): Promise<SkillDefinition | undefined> {
    if (normalizeSkillId(skillId) !== HUIXIAN_SKILL_ID) {
      throw new Error("huixian_only");
    }
    return this.updateHuixianProfile(input);
  }

  async removeSkill(_skillId: string): Promise<boolean> {
    return false;
  }

  async exportSkill(skillId: string): Promise<string | undefined> {
    const profile = await this.getSkill(skillId);
    return profile ? `${JSON.stringify(profile, null, 2)}\n` : undefined;
  }

  async importSkill(_raw: string): Promise<SkillDefinition> {
    throw new Error("huixian_only");
  }

  /** Creates a non-destructive backup of the sole editable persona. */
  async backupSkills(now = new Date()): Promise<{ backupDir: string; files: string[] }> {
    const profile = await this.getHuixianProfile();
    const backupDir = path.join(this.skillsDir, ".backups", toCompactTimestamp(now));
    await mkdir(backupDir, { recursive: true });
    if (!profile) {
      return { backupDir, files: [] };
    }
    await writeJsonFileAtomic(path.join(backupDir, "huixian.json"), profile);
    return { backupDir, files: ["huixian.json"] };
  }

  async listBackups(): Promise<Array<{ id: string; createdAt: string; files: string[] }>> {
    const backupRoot = path.join(this.skillsDir, ".backups");
    try {
      const entries = await readdir(backupRoot, { withFileTypes: true });
      const backups = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^\d{14}$/.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(backupRoot, entry.name, "huixian.json");
          const profile = await readOptionalProfile(filePath);
          return profile
            ? { id: entry.name, createdAt: compactTimestampToIso(entry.name), files: ["huixian.json"] }
            : undefined;
        }));
      return backups
        .filter((backup): backup is { id: string; createdAt: string; files: string[] } => Boolean(backup))
        .sort((left, right) => right.id.localeCompare(left.id));
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") return [];
      throw error;
    }
  }

  /** Restoring a persona never touches any unrelated legacy file. */
  async restoreBackup(backupId: string): Promise<{ restoredCount: number; files: string[] }> {
    if (!/^\d{14}$/.test(backupId)) {
      throw new Error("invalid_backup_id");
    }
    const profile = await readOptionalProfile(path.join(this.skillsDir, ".backups", backupId, "huixian.json"));
    if (!profile) {
      throw new Error("backup_empty");
    }
    await mkdir(this.skillsDir, { recursive: true });
    await writeJsonFileAtomic(this.skillFilePath(), profile);
    this.cachedHuixian = profile;
    this.cachedVersion = await fileVersion(this.skillFilePath());
    return { restoredCount: 1, files: ["huixian.json"] };
  }

  private invalidateCache(): void {
    this.cachedHuixian = undefined;
    this.cachedVersion = undefined;
  }

  private skillFilePath(): string {
    return path.join(this.skillsDir, "huixian.json");
  }
}

async function readOptionalProfile(filePath: string): Promise<SkillDefinition | undefined> {
  try {
    const profile = normalizeHuixianCharacterProfile(await readJsonFile<SkillDefinition>(filePath));
    return profile.id === HUIXIAN_SKILL_ID ? profile : undefined;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileVersion(filePath: string): Promise<string> {
  try {
    const metadata = await stat(filePath);
    return `${metadata.mtimeMs}:${metadata.size}`;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") return "missing";
    throw error;
  }
}

export function normalizeHuixianCharacterProfile(value: SkillDefinition): CharacterProfile {
  const id = normalizeSkillId(value.id);
  if (id !== HUIXIAN_SKILL_ID) {
    throw new Error("huixian_only");
  }
  const name = String(value.name ?? "").trim();
  const systemPrompt = String(value.systemPrompt ?? "").trim();
  if (!name || !systemPrompt) {
    throw new Error("invalid_skill");
  }
  const legacyTtsStyleHint = typeof value.ttsStyleHint === "string" ? value.ttsStyleHint.trim().slice(0, 400) : "";
  const ttsConfig = normalizeSkillTtsConfig(value.ttsConfig, legacyTtsStyleHint);
  return {
    id: HUIXIAN_SKILL_ID,
    name: name.slice(0, 80),
    systemPrompt,
    styleRules: normalizeStringArray(value.styleRules),
    knowledge: normalizeStringArray(value.knowledge),
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

export function cloneHuixianCharacterProfile(profile: CharacterProfile): CharacterProfile {
  return normalizeHuixianCharacterProfile(JSON.parse(JSON.stringify(profile)) as CharacterProfile);
}

/** @deprecated Internal compatibility helper for the legacy JSON archive adapter. */
function cloneSkill(profile: SkillDefinition): SkillDefinition {
  return cloneHuixianCharacterProfile(profile);
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
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id.toLowerCase() : "";
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
