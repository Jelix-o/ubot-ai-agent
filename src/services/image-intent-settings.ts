import type { ImageIntentRoutingSettings } from "../types.js";

export function normalizeImageIntentRouting(value?: Partial<ImageIntentRoutingSettings>): ImageIntentRoutingSettings {
  return {
    enabled: value?.enabled !== false,
    requestProfile: value?.requestProfile === "openai" ? "openai" : "deepseek",
    timeoutMs: bounded(value?.timeoutMs, 5_000, 1_000, 30_000),
    maxCompletionTokens: bounded(value?.maxCompletionTokens, 128, 64, 512),
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
}
