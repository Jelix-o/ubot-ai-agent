import type { V3StateRepository } from "./v3-state-repository.js";
import { assertRevision, revision } from "./state-mutation.js";
import { AdminOperationLogService } from "./admin-operation-log-service.js";
import { randomUUID } from "node:crypto";

interface AudioSettings { enabled: boolean; automaticVoiceEnabled: boolean; changeToken?: string }
const DEFAULT: AudioSettings = { enabled: false, automaticVoiceEnabled: true };
export class AudioSettingsService {
  constructor(private readonly repo: V3StateRepository) {}
  get() {
    const settings = this.repo.getDocument("audio-generation-settings", "default", DEFAULT);
    return { enabled: settings.enabled, automaticVoiceEnabled: settings.automaticVoiceEnabled, model: "seed-audio-1.0", hasApiKey: Boolean(this.repo.getAudioGenerationApiKey()), dailySeconds: 1800, speechPerGroup: 20, songsPerGroup: 3, automaticProbabilityPercent: 10, revision: revision(settings) };
  }
  update(patch: { enabled?: boolean; automaticVoiceEnabled?: boolean; apiKey?: string }, expectedRevision: string, operatorUserId: string): ReturnType<AudioSettingsService["get"]> {
    this.repo.runAtomically(() => {
      const current = this.repo.getDocument("audio-generation-settings", "default", DEFAULT);
      assertRevision(current, { expectedRevision });
      if (patch.apiKey !== undefined) {
        if (typeof patch.apiKey !== "string" || patch.apiKey.length > 2048 || /[\s\x00-\x1f]/u.test(patch.apiKey)) throw new Error("invalid_audio_key");
        this.repo.saveAudioGenerationApiKey(patch.apiKey);
      }
      for (const key of ["enabled", "automaticVoiceEnabled"] as const) if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new Error("invalid_audio_settings");
      const next = { enabled: patch.enabled ?? current.enabled, automaticVoiceEnabled: patch.automaticVoiceEnabled ?? current.automaticVoiceEnabled, changeToken: randomUUID() };
      if (next.enabled && !this.repo.getAudioGenerationApiKey()) throw new Error("audio_key_required");
      const policy = this.repo.getCapabilityPolicy();
      if (!policy) throw new Error("audio_capability_policy_missing");
      this.repo.saveCapabilityPolicy({ ...policy, enabledCapabilities: [...policy.enabledCapabilities.filter(c => c !== "audio_generation"), ...(next.enabled ? ["audio_generation"] : [])], updatedAt: new Date().toISOString() });
      this.repo.saveDocument("audio-generation-settings", "default", next);
      new AdminOperationLogService("", this.repo).recordAtomic({ groupId: "system", operatorUserId, action: "audio_settings_update", detail: `enabled=${next.enabled};automatic=${next.automaticVoiceEnabled};keyChanged=${patch.apiKey !== undefined}` });
    });
    return this.get();
  }
  internal() {
    const config = this.get();
    return { ...config, enabled: config.enabled && this.repo.getCapabilityPolicy()?.enabledCapabilities.includes("audio_generation") === true, apiKey: this.repo.getAudioGenerationApiKey() };
  }
}
