import type { ImageIntentRoutingSettings } from "../types.js";

export function normalizeImageIntentRouting(value?: Partial<ImageIntentRoutingSettings>): ImageIntentRoutingSettings {
  return {
    enabled: value?.enabled !== false,
    requestProfile: value?.requestProfile === "openai" ? "openai" : "deepseek",
    timeoutMs: bounded(value?.timeoutMs, 4_000, 1_000, 30_000),
    maxCompletionTokens: bounded(value?.maxCompletionTokens, 512, 64, 512),
    fallbackModelIds: Array.isArray(value?.fallbackModelIds) ? [...new Set(value.fallbackModelIds.filter(id => typeof id === "string" && /^[\w.-]{1,100}$/u.test(id)))].slice(0, 4) : ["gpt"],
    totalTimeoutMs: bounded(value?.totalTimeoutMs, 8_000, 1_000, 30_000),
  };
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function validateImageIntentRouting(value: unknown): void {
  const input = value as ImageIntentRoutingSettings;
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.enabled !== "boolean" || !["openai", "deepseek"].includes(input.requestProfile) ||
      !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 30_000 ||
      !Number.isInteger(input.maxCompletionTokens) || input.maxCompletionTokens < 64 || input.maxCompletionTokens > 512) {
    throw new Error("invalid_image_intent_routing");
  }
  if (input.fallbackModelIds !== undefined && (!Array.isArray(input.fallbackModelIds) || input.fallbackModelIds.length > 4 || input.fallbackModelIds.some(id => typeof id !== "string" || !/^[\w.-]{1,100}$/u.test(id)))) throw new Error("invalid_image_intent_routing");
  if (input.totalTimeoutMs !== undefined && (!Number.isInteger(input.totalTimeoutMs) || input.totalTimeoutMs < 1000 || input.totalTimeoutMs > 30000)) throw new Error("invalid_image_intent_routing");
}
