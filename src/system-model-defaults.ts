import type { AppConfig, SystemModelConfig } from "./types.js";

/** Builds the default system model list from environment config (shared by all processes). */
export function buildDefaultSystemModels(config: AppConfig): Array<Partial<SystemModelConfig> & { apiKey?: string }> {
  const now = new Date().toISOString();
  return [
    {
      id: "gpt",
      name: "Environment Reply Model",
      shortName: config.openAiModel,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
      purpose: "reply",
      apiKey: config.openAiApiKey,
      hasApiKey: true,
      enabled: true,
      supportsVision: true,
      reasoningEffort: "xhigh",
      maxCompletionTokens: 8_192,
      requestTimeoutMs: 180_000,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
