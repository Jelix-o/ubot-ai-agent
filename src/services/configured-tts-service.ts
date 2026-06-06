import { logWarn } from "../logger.js";
import type { SkillDefinition, SystemModelConfig } from "../types.js";
import { TtsService, TtsServiceError, type TtsSynthesisResult } from "./tts-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";

export type RuntimeTtsService = {
  synthesize(text: string, skill: SkillDefinition): Promise<TtsSynthesisResult>;
};

type RuntimeTtsFactory = (model: Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey">) => RuntimeTtsService;

export class ConfiguredTtsService implements RuntimeTtsService {
  private cachedService?: {
    key: string;
    service: RuntimeTtsService;
  };

  constructor(
    private readonly fallback: RuntimeTtsService,
    private readonly systemSettingsStore: SystemSettingsStore,
    private readonly options: {
      voice: string;
      audioFormat: "wav" | "mp3" | "pcm" | "pcm16";
      cacheDir: string;
      globalStyleHint?: string;
    },
    private readonly factory: RuntimeTtsFactory = (model) =>
      new TtsService(
        model.baseUrl,
        model.apiKey ?? "",
        model.model,
        options.voice,
        options.audioFormat,
        options.cacheDir,
        options.globalStyleHint,
      ),
  ) {}

  async synthesize(text: string, skill: SkillDefinition): Promise<TtsSynthesisResult> {
    const resolved = await this.resolveService();
    try {
      return await resolved.service.synthesize(text, skill);
    } catch (error) {
      if (resolved.modelId && error instanceof TtsServiceError) {
        throw new TtsServiceError(error.message, {
          ...error.details,
          systemModelId: resolved.modelId,
        });
      }
      throw error;
    }
  }

  private async resolveService(): Promise<{ service: RuntimeTtsService; modelId?: string }> {
    const model = await this.getActiveTtsModel();
    if (!model) {
      return { service: this.fallback };
    }

    const key = [
      model.id,
      model.baseUrl,
      model.model,
      model.apiKey,
      this.options.voice,
      this.options.audioFormat,
      this.options.cacheDir,
      this.options.globalStyleHint ?? "",
    ].join("|");
    if (this.cachedService?.key === key) {
      return { service: this.cachedService.service, modelId: model.id };
    }

    try {
      const service = this.factory(model);
      this.cachedService = { key, service };
      return { service, modelId: model.id };
    } catch (error) {
      logWarn("Configured TTS model is invalid; falling back to environment model.", {
        model: model.model,
        baseUrl: model.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return { service: this.fallback };
    }
  }

  private async getActiveTtsModel(): Promise<SystemModelConfig | undefined> {
    const settings = await this.systemSettingsStore.getInternal();
    const selectedModelId = settings.selectedModelIds.tts;
    if (selectedModelId) {
      const selectedModel = settings.models.find((model) =>
        model.id === selectedModelId &&
        model.purpose === "tts" &&
        isUsableTtsModel(model)
      );
      if (selectedModel) {
        return selectedModel;
      }
    }
    return settings.models.find((model) => model.purpose === "tts" && isUsableTtsModel(model));
  }
}

function isUsableTtsModel(model: SystemModelConfig): boolean {
  return model.enabled &&
    Boolean(model.baseUrl.trim()) &&
    Boolean(model.model.trim()) &&
    Boolean(model.apiKey?.trim());
}
