import type { GroupBotConfig, SystemModelConfig, SystemSettings } from "../types.js";

export const RETIRED_GEMINI_MODEL_IDS = ["gemini", "gemini-38-flash"] as const;

export function isRetiredModelId(value: unknown): boolean {
  return typeof value === "string" && /(?:^|[/:])gemini(?:$|[-_.:])/i.test(value.trim());
}

export function isRetiredModel(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<SystemModelConfig>;
  return isRetiredModelId(model.id) || isRetiredModelId(model.model);
}

export function removeRetiredModels<T extends SystemSettings>(settings: T): T {
  const safe = structuredClone(settings);
  const retiredIds = new Set<string>(RETIRED_GEMINI_MODEL_IDS);
  safe.models = Array.isArray(safe.models) ? safe.models : [];
  safe.selectedModelIds = safe.selectedModelIds && typeof safe.selectedModelIds === "object" ? safe.selectedModelIds : {};
  for (const model of safe.models) if (isRetiredModel(model)) retiredIds.add(model.id);
  const retired = (id: unknown): boolean => typeof id === "string" && (retiredIds.has(id) || isRetiredModelId(id));
  safe.models = safe.models.filter(model => !isRetiredModel(model));
  for (const [purpose, id] of Object.entries(safe.selectedModelIds)) {
    if (!retired(id)) continue;
    // Empty means explicitly unconfigured, never an environment fallback.
    safe.selectedModelIds[purpose as keyof SystemSettings["selectedModelIds"]] = purpose === "reply" &&
      safe.models.some(model => model.id === "sol" && model.purpose === "reply" && model.enabled && (model.hasApiKey || model.apiKey))
      ? "sol" : "";
  }
  if (safe.replyRouting && Array.isArray(safe.replyRouting.fallbackModelIds)) {
    safe.replyRouting.fallbackModelIds = safe.replyRouting.fallbackModelIds.filter(id => !retired(id));
  }
  return safe;
}

export function removeRetiredGroupModel(group: GroupBotConfig, retiredIds: ReadonlySet<string> = new Set()): GroupBotConfig {
  if (!isRetiredModelId(group.replyModelMode) && !retiredIds.has(group.replyModelMode ?? "")) return group;
  return { ...group, replyModelMode: "sol", replyModelSource: "global" };
}
