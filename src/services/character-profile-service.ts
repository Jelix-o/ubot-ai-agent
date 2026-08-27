import type { CharacterProfile, SkillDefinition } from "../types.js";
import {
  HUIXIAN_CHARACTER_PROFILE_ID,
  cloneHuixianCharacterProfile,
  normalizeHuixianCharacterProfile,
} from "./skill-service.js";

/**
 * The persistence contract is intentionally narrow so V3's active identity
 * can be supplied by SQLite without coupling this service to a database
 * implementation or to the legacy JSON archive adapter.
 */
export interface CharacterProfileRepository {
  getHuixianProfile(): Promise<CharacterProfile | undefined>;
  saveHuixianProfile(profile: CharacterProfile, changedBy?: string): Promise<CharacterProfile>;
}

export interface CharacterProfileServiceOptions {
  /** Used only to initialize an empty V3 store during the controlled migration. */
  bootstrapProfile?: CharacterProfile;
}

/**
 * V3's sole runtime persona service.  It never reads `skills/` and every save
 * passes through the same Huixian-only normalization used for legacy import.
 */
export class CharacterProfileService {
  constructor(
    private readonly repository: CharacterProfileRepository,
    private readonly options: CharacterProfileServiceOptions = {},
  ) {}

  async getHuixianProfile(_options: { refresh?: boolean } = {}): Promise<CharacterProfile | undefined> {
    const profile = await this.repository.getHuixianProfile();
    return profile ? cloneHuixianCharacterProfile(profile) : undefined;
  }

  /** Compatibility reader for callers that still use the historical skill id. */
  async getSkill(skillId: string, _options: { refresh?: boolean } = {}): Promise<SkillDefinition | undefined> {
    return normalizeProfileId(skillId) === HUIXIAN_CHARACTER_PROFILE_ID
      ? this.getHuixianProfile()
      : undefined;
  }

  /** Compatibility registry: V3 always exposes exactly one possible persona. */
  async getAllSkills(_options: { refresh?: boolean } = {}): Promise<SkillDefinition[]> {
    const profile = await this.getHuixianProfile();
    return profile ? [profile] : [];
  }

  /**
   * Initializes the unique profile only when no profile has yet been migrated.
   * Existing SQLite state always wins over the packaged source asset.
   */
  async ensureHuixianProfile(changedBy = "migration"): Promise<CharacterProfile> {
    const existing = await this.getHuixianProfile();
    if (existing) return existing;
    if (!this.options.bootstrapProfile) {
      throw new Error("huixian_profile_not_initialized");
    }
    const bootstrap = normalizeHuixianCharacterProfile(this.options.bootstrapProfile);
    return cloneHuixianCharacterProfile(await this.repository.saveHuixianProfile(bootstrap, changedBy));
  }

  async updateHuixianProfile(
    input: Partial<CharacterProfile>,
    changedBy = "admin",
  ): Promise<CharacterProfile> {
    const current = await this.ensureHuixianProfile(changedBy);
    const next = normalizeHuixianCharacterProfile({
      ...current,
      ...input,
      id: HUIXIAN_CHARACTER_PROFILE_ID,
    });
    return cloneHuixianCharacterProfile(await this.repository.saveHuixianProfile(next, changedBy));
  }
}

function normalizeProfileId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
