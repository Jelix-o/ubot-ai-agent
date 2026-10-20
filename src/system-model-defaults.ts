import type { AppConfig, SystemModelConfig } from "./types.js";
import { DEFAULT_REPLY_MAX_TOKENS } from "./shared/reply-token-budget.js";

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
      maxCompletionTokens: DEFAULT_REPLY_MAX_TOKENS,
      requestTimeoutMs: 180_000,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
