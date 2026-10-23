import { randomUUID } from "node:crypto";
import { DEFAULT_REPLY_MAX_TOKENS, MIN_REPLY_MAX_TOKENS, MAX_REPLY_MAX_TOKENS } from "../shared/reply-token-budget.js";
import { readFile, stat } from "node:fs/promises";

import type {
  SystemCommandConfig,
  SystemModelConfig,
  SystemModelPurpose,
  SystemSettings,
  TokenCostControlSettings,
} from "../types.js";
import { logWarn } from "../logger.js";
import { stripUtf8Bom, writeJsonFileAtomic } from "../utils/json-file.js";
import type { SystemSettingsShadowWriter } from "./system-settings-sqlite-shadow-repository.js";
import type { V3StateRepository } from "./v3-state-repository.js";
import { assertRevision, type MutationGuard } from "./state-mutation.js";
import { isCommandPermission, minimumCommandPermission, normalizeCommandPermission, permissionAtLeast } from "./command-permissions.js";
import type { ReplyRoutingSettings } from "../types.js";
import { isRetiredModel, isRetiredModelId, removeRetiredModels } from "./retired-models.js";

type SystemSettingsUpdateInput = Partial<Omit<SystemSettings, "models">> & {
  models?: Array<Partial<SystemModelConfig> & { apiKey?: unknown }>;
};

export class SystemSettingsStore {
  private static readonly unstableFileVersion = "<unstable>";
  private cachedData?: SystemSettings;
  private cachedFileVersion?: string;

  constructor(
    private readonly filePath: string,
    private readonly defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
    private readonly shadowWriter?: SystemSettingsShadowWriter,
    private readonly v3State?: V3StateRepository,
  ) {}

  /**
   * Explicit startup/admin-maintenance sync for the Phase 1 SQLite shadow.
   * Runtime reads never call this, so GET routes remain free of shadow writes.
   */
  async syncShadowFromAuthoritative(): Promise<boolean> {
    if (this.v3State) {
      this.v3State.requireCutover();
      return true;
    }
    return this.syncShadow(await this.readData(), "explicit_sync");
  }

  async get(): Promise<SystemSettings> {
    return sanitizeSettings(await this.readData());
  }

  async update(input: SystemSettingsUpdateInput, guard?: MutationGuard): Promise<SystemSettings> {
    if (this.v3State) {
      this.v3State.requireCutover();
      return this.v3State.runAtomically(() => {
        const stored = this.v3State!.getSystemSettings<SystemSettings>();
        const current = stored ? normalizeSettings(stored, this.defaultModels) : defaultSettings(this.defaultModels);
        assertRevision(sanitizeSettings(current), guard);
        const next = this.buildUpdate(current, input);
        this.v3State!.saveSystemSettings(next);
        guard?.committed?.();
        this.cachedData = next;
        return sanitizeSettings(next);
      });
    }
    const current = await this.readData();
    assertRevision(sanitizeSettings(current), guard);
    const next = this.buildUpdate(current, input);
    await this.writeData(next);
    guard?.committed?.();
    return sanitizeSettings(next);
  }

  private buildUpdate(current: SystemSettings, input: SystemSettingsUpdateInput): SystemSettings {
    if ((Array.isArray(input.models) && input.models.some(isRetiredModel)) ||
        Object.values(input.selectedModelIds ?? {}).some(isRetiredModelId) ||
        (Array.isArray(input.replyRouting?.fallbackModelIds) && input.replyRouting.fallbackModelIds.some(isRetiredModelId))) {
      throw new Error("model_retired");
    }
    for (const command of input.commands ?? []) {
      if (!isCommandPermission(command.permission)) throw new Error("invalid_command_permission");
      if (!permissionAtLeast(command.permission, minimumCommandPermission(command.id))) throw new Error("command_permission_below_minimum");
    }
    if (input.models !== undefined) {
      if (!Array.isArray(input.models)) throw new Error("invalid_models");
      if (input.models.some((model) => (model as { purpose?: unknown }).purpose === "tts")) {
        throw new Error("voice_feature_retired");
      }
      validateModelUpdateInput(input.models);
    }
    const removedDefaultModelIds = input.models === undefined
      ? current.removedDefaultModelIds ?? []
      : reconcileRemovedDefaultModelIds(current.removedDefaultModelIds, input.models, this.defaultModels);
    const nextModels = input.models === undefined
      ? current.models
      : normalizeModels(mergeModelApiKeyState(current.models, input.models), this.defaultModels, removedDefaultModelIds);
    const next = normalizeSettings({
      ...current,
      ...input,
      removedDefaultModelIds,
      models: nextModels,
      selectedModelIds: input.selectedModelIds === undefined
        ? current.selectedModelIds
        : normalizeSelectedModelIds(input.selectedModelIds, nextModels),
      commands: input.commands === undefined ? current.commands : input.commands,
      updatedAt: new Date().toISOString(),
    }, this.defaultModels);
    if (input.replyRouting !== undefined) validateReplyRouting(input.replyRouting, nextModels);
    if (input.selectedModelIds?.reply && !nextModels.some(model => model.id === input.selectedModelIds!.reply && model.purpose === "reply" && model.enabled && model.hasApiKey)) throw new Error("reply_model_not_approved");
    return next;
  }

  async getInternal(): Promise<SystemSettings> {
    return cloneSettings(await this.readData());
  }

  invalidateCache(): void {
    this.cachedData = undefined;
    this.cachedFileVersion = undefined;
  }

  private async readData(): Promise<SystemSettings> {
    if (this.v3State) {
      this.v3State.requireCutover();
      const stored = this.v3State.getSystemSettings<SystemSettings>();
      if (stored) {
        this.cachedData = normalizeSettings(stored, this.defaultModels);
        return this.cachedData;
      }
      const initial = defaultSettings(this.defaultModels);
      this.v3State.saveSystemSettings(initial);
      this.cachedData = initial;
      return initial;
    }
    const fileVersion = await this.getFileVersion();
    if (this.cachedData && fileVersion === this.cachedFileVersion) {
      return this.cachedData;
    }
    try {
      const snapshot = await this.readStableSnapshot(fileVersion);
      const parsed = parseSettingsJson(snapshot.raw);
      this.cachedData = normalizeSettings(parsed.value, this.defaultModels);
      if (parsed.recovered) {
        await this.writeData(this.cachedData);
      } else {
        this.cachedFileVersion = snapshot.stable ? snapshot.version : SystemSettingsStore.unstableFileVersion;
      }
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = defaultSettings(this.defaultModels);
        this.cachedFileVersion = undefined;
        return this.cachedData;
      }
      throw error;
    }
  }

  private async readStableSnapshot(initialVersion: string | undefined): Promise<{
    raw: string;
    version: string | undefined;
    stable: boolean;
  }> {
    let versionBefore = initialVersion;
    let lastRaw = "";
    let versionAfter = initialVersion;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastRaw = await readFile(this.filePath, "utf8");
      versionAfter = await this.getFileVersion();
      if (versionBefore !== undefined && versionBefore === versionAfter) {
        return { raw: lastRaw, version: versionAfter, stable: true };
      }
      versionBefore = versionAfter;
    }
    return { raw: lastRaw, version: versionAfter, stable: false };
  }

  private async writeData(data: SystemSettings): Promise<void> {
    if (this.v3State) {
      this.v3State.requireCutover();
      this.v3State.saveSystemSettings(data);
      this.cachedData = data;
      return;
    }
    await writeJsonFileAtomic(this.filePath, data);
    this.cachedData = data;
    this.cachedFileVersion = await this.getFileVersion();
    this.syncShadow(data, "json_write");
  }

  private syncShadow(data: SystemSettings, reason: "explicit_sync" | "json_write"): boolean {
    if (!this.shadowWriter) {
      return false;
    }
    try {
      this.shadowWriter.syncFromAuthoritative(data);
      return true;
    } catch (error) {
      // JSON remains the only authority during the shadow phase. A SQLite
      // outage must never make model, secret, or command updates fail.
      logWarn("System settings SQLite shadow sync failed; JSON remains authoritative.", {
        reason,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  private async getFileVersion(): Promise<string | undefined> {
    try {
      const file = await stat(this.filePath);
      return `${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}

function parseSettingsJson(raw: string): { value: Partial<SystemSettings>; recovered: boolean } {
  const body = stripUtf8Bom(raw);
  try {
    return { value: JSON.parse(body) as Partial<SystemSettings>, recovered: false };
  } catch (error) {
    const recovered = recoverSettingsWithDefaultCommands(body);
    if (recovered) {
      return { value: recovered, recovered: true };
    }
    throw error;
  }
}

function recoverSettingsWithDefaultCommands(raw: string): Partial<SystemSettings> | undefined {
  const commandsMatch = /,\s*\r?\n\s*"commands"\s*:/.exec(raw);
  if (!commandsMatch) {
    return undefined;
  }
  const topLevelUpdatedAt = raw.match(/\r?\n\s*"updatedAt"\s*:\s*"([^"]+)"\s*\r?\n\s*\}\s*$/)?.[1] ?? new Date().toISOString();
  const candidate = `${raw.slice(0, commandsMatch.index)},\n  "commands": [],\n  "updatedAt": ${JSON.stringify(topLevelUpdatedAt)}\n}`;
  try {
    return JSON.parse(candidate) as Partial<SystemSettings>;
  } catch {
    return undefined;
  }
}

function defaultSettings(defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = []): SystemSettings {
  const now = new Date().toISOString();
  return {
    onlineLookupEnabled: false,
    tokenCostControl: defaultTokenCostControlSettings(),
    defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
    models: normalizeModels(defaultModels, []),
    replyRouting: defaultReplyRouting(),
    removedDefaultModelIds: [],
    selectedModelIds: normalizeSelectedModelIds({}, normalizeModels(defaultModels, [])),
    commands: defaultCommands(now),
    updatedAt: now,
  };
}

function normalizeSettings(
  value: Partial<SystemSettings>,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
): SystemSettings {
  value = removeRetiredModels({ ...value, models: value.models ?? [], selectedModelIds: value.selectedModelIds ?? {} } as SystemSettings);
  const fallback = defaultSettings(defaultModels);
  const removedDefaultModelIds = normalizeRemovedDefaultModelIds(value.removedDefaultModelIds, defaultModels);
  const models = normalizeModels(value.models, defaultModels, removedDefaultModelIds);
  return {
    onlineLookupEnabled: normalizeBoolean(value.onlineLookupEnabled, fallback.onlineLookupEnabled),
    tokenCostControl: normalizeTokenCostControl(value.tokenCostControl),
    defaultTriggerKeywords: normalizeTriggerKeywords(value.defaultTriggerKeywords),
    models,
    replyRouting: normalizeReplyRouting(value.replyRouting),
    removedDefaultModelIds,
    selectedModelIds: normalizeSelectedModelIds(value.selectedModelIds, models),
    commands: normalizeCommands(value.commands, typeof value.updatedAt === "string" ? value.updatedAt : "1970-01-01T00:00:00.000Z"),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

export function defaultTokenCostControlSettings(): TokenCostControlSettings {
  return {
    dailyReportAiQuipEnabled: false,
    chatSummaryAiEnabled: false,
    scheduledReminderAiRewriteEnabled: false,
    modelHealthAutoProbeEnabled: false,
  };
}

export function defaultReplyRouting(): ReplyRoutingSettings {
  return { fallbackEnabled: true, fallbackModelIds: [], chatAttemptTimeoutMs: 45_000, chatTotalTimeoutMs: 120_000, htmlAttemptTimeoutMs: 600_000, htmlTotalTimeoutMs: 1_200_000 };
}

function routingTimeoutMaximum(key: keyof ReplyRoutingSettings): number {
  return key === "htmlTotalTimeoutMs" ? 1_200_000 : 600_000;
}

function normalizeReplyRouting(value: Partial<ReplyRoutingSettings> | undefined): ReplyRoutingSettings {
  const defaults = defaultReplyRouting();
  const result = { ...defaults, ...value, fallbackEnabled: value?.fallbackEnabled !== false, fallbackModelIds: normalizeStringArray(value?.fallbackModelIds, 20, 80) };
  for (const key of ["chatAttemptTimeoutMs", "chatTotalTimeoutMs", "htmlAttemptTimeoutMs", "htmlTotalTimeoutMs"] as const) {
    result[key] = Number.isInteger(result[key]) && result[key] >= 1_000 && result[key] <= routingTimeoutMaximum(key) ? result[key] : defaults[key];
  }
  return result;
}

function validateReplyRouting(value: ReplyRoutingSettings, models: SystemModelConfig[]): void {
  if (typeof value.fallbackEnabled !== "boolean" || !Array.isArray(value.fallbackModelIds) || value.fallbackModelIds.length > 20 || new Set(value.fallbackModelIds).size !== value.fallbackModelIds.length) throw new Error("invalid_reply_routing");
  for (const key of ["chatAttemptTimeoutMs", "chatTotalTimeoutMs", "htmlAttemptTimeoutMs", "htmlTotalTimeoutMs"] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 1_000 || value[key] > routingTimeoutMaximum(key)) throw new Error("invalid_reply_routing_timeout");
  }
  if (value.chatAttemptTimeoutMs > value.chatTotalTimeoutMs || value.htmlAttemptTimeoutMs > value.htmlTotalTimeoutMs) throw new Error("invalid_reply_routing_timeout");
  if (value.fallbackModelIds.some(id => !models.some(model => model.id === id && model.purpose === "reply" && model.enabled && model.hasApiKey))) throw new Error("reply_model_not_approved");
}

function normalizeTokenCostControl(value: unknown): TokenCostControlSettings {
  const fallback = defaultTokenCostControlSettings();
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const record = value as Partial<Record<keyof TokenCostControlSettings, unknown>>;
  return {
    dailyReportAiQuipEnabled: normalizeBoolean(record.dailyReportAiQuipEnabled, fallback.dailyReportAiQuipEnabled),
    chatSummaryAiEnabled: normalizeBoolean(record.chatSummaryAiEnabled, fallback.chatSummaryAiEnabled),
    scheduledReminderAiRewriteEnabled: normalizeBoolean(record.scheduledReminderAiRewriteEnabled, fallback.scheduledReminderAiRewriteEnabled),
    modelHealthAutoProbeEnabled: normalizeBoolean(record.modelHealthAutoProbeEnabled, fallback.modelHealthAutoProbeEnabled),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeTriggerKeywords(value: unknown): SystemSettings["defaultTriggerKeywords"] {
  const raw = Array.isArray(value) ? value : [{ keyword: "乘风", enabled: true }];
  const map = new Map<string, { keyword: string; enabled: boolean }>();
  for (const item of raw) {
    const record = item as { keyword?: unknown; enabled?: unknown };
    const keyword = String(record?.keyword ?? "").trim().slice(0, 40);
    if (keyword && !map.has(keyword)) {
      map.set(keyword, { keyword, enabled: record.enabled !== false });
    }
  }
  return [...map.values()];
}

function normalizeModels(
  value: unknown,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
  removedDefaultModelIds: string[] = [],
): SystemModelConfig[] {
  const removedDefaultIds = new Set(removedDefaultModelIds);
  const raw = [
    ...(Array.isArray(value) ? value : []),
    ...defaultModels.filter((model) => !removedDefaultIds.has(typeof model.id === "string" ? normalizeModelId(model.id.trim()) : "")),
  ].filter(model => !isRetiredModel(model));
  const byId = new Map<string, SystemModelConfig>();
  for (const model of raw
    .map((item) => normalizeModel(item as Partial<SystemModelConfig>))
    .filter((item): item is SystemModelConfig => Boolean(item))) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

function validateModelUpdateInput(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("invalid_models");
  }
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid_model_config");
    }
    const record = item as Partial<SystemModelConfig>;
    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    const id = rawId ? normalizeModelId(rawId) : "";
    if (!id) {
      throw new Error("invalid_model_id");
    }
    if (seenIds.has(id)) {
      throw new Error("duplicate_model_id");
    }
    seenIds.add(id);
    if (!isRuntimeModelPurpose(record.purpose)) {
      throw new Error("invalid_model_purpose");
    }
    if (record.purpose === "image" && record.apiProtocol === "anthropic") {
      throw new Error("invalid_image_model_protocol");
    }
    const name = String(record.name ?? "").trim();
    const shortName = String(record.shortName ?? "").trim();
    const baseUrl = String(record.baseUrl ?? "").trim();
    const model = String(record.model ?? "").trim();
    if (!name || !shortName || !baseUrl || !model) {
      throw new Error("invalid_model_config");
    }
  }
}

function reconcileRemovedDefaultModelIds(
  currentValue: unknown,
  incoming: unknown,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
): string[] {
  const defaultIds = new Set(defaultModels
    .map((model) => typeof model.id === "string" ? normalizeModelId(model.id.trim()) : "")
    .filter(Boolean));
  if (!defaultIds.size) {
    return [];
  }
  const incomingIds = new Set(Array.isArray(incoming)
    ? incoming
        .map((item) => {
          const id = (item as Partial<SystemModelConfig> | undefined)?.id;
          return typeof id === "string" ? normalizeModelId(id.trim()) : "";
        })
        .filter(Boolean)
    : []);
  const removed = new Set(normalizeRemovedDefaultModelIds(currentValue, defaultModels));
  for (const id of defaultIds) {
    if (incomingIds.has(id)) {
      removed.delete(id);
    } else {
      removed.add(id);
    }
  }
  return [...removed];
}

function normalizeRemovedDefaultModelIds(
  value: unknown,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
): string[] {
  const defaultIds = new Set(defaultModels
    .map((model) => typeof model.id === "string" ? normalizeModelId(model.id.trim()) : "")
    .filter(Boolean));
  if (!Array.isArray(value) || !defaultIds.size) {
    return [];
  }
  return Array.from(new Set(value
    .map((item) => typeof item === "string" ? normalizeModelId(item.trim()) : "")
    .filter((id) => id && defaultIds.has(id))));
}

function normalizeModel(value: Partial<SystemModelConfig>): SystemModelConfig | undefined {
  const now = new Date().toISOString();
  const providedId = typeof value.id === "string" ? value.id.trim() : "";
  const id = providedId ? normalizeModelId(providedId) : randomUUID();
  if (!id) {
    return undefined;
  }
  const name = String(value.name ?? "").trim().slice(0, 80);
  const shortName = String(value.shortName ?? "").trim().slice(0, 32);
  const rawBaseUrl = String(value.baseUrl ?? "").trim();
  const rawModel = String(value.model ?? "").trim();
  const baseUrl = rawBaseUrl.slice(0, 240);
  const model = rawModel.slice(0, 120);
  if (!name || !shortName || !baseUrl || !model) {
    return undefined;
  }
  const purpose = normalizeModelPurpose(value.purpose);
  if (!purpose) {
    return undefined;
  }
  const apiProtocol = purpose === "image"
    ? "openai"
    : value.apiProtocol === "anthropic" ? "anthropic" : "openai";
  const isDefaultGptReply = id === "gpt" && purpose === "reply";
  const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
  const maxCompletionTokens = normalizeOptionalInt(value.maxCompletionTokens, MIN_REPLY_MAX_TOKENS, MAX_REPLY_MAX_TOKENS);
  const requestTimeoutMs = normalizeOptionalInt(value.requestTimeoutMs, 1_000, 300_000);
  return {
    id,
    name,
    shortName,
    baseUrl,
    model,
    purpose,
    ...(typeof value.apiKey === "string" && value.apiKey.trim() ? { apiKey: value.apiKey.trim() } : {}),
    hasApiKey: value.hasApiKey === true || Boolean(value.apiKey),
    enabled: value.enabled !== false,
    apiProtocol,
    ...(normalizeModelCapabilities(value.capabilities, apiProtocol) ? {
      capabilities: normalizeModelCapabilities(value.capabilities, apiProtocol),
    } : {}),
    supportsVision: value.supportsVision === true || (value.supportsVision === undefined && isDefaultGptReply),
    ...(reasoningEffort || isDefaultGptReply ? { reasoningEffort: reasoningEffort ?? "xhigh" } : {}),
    ...(maxCompletionTokens || purpose === "reply" ? { maxCompletionTokens: maxCompletionTokens ?? DEFAULT_REPLY_MAX_TOKENS } : {}),
    ...(requestTimeoutMs || isDefaultGptReply ? { requestTimeoutMs: requestTimeoutMs ?? 180_000 } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeReasoningEffort(value: unknown): SystemModelConfig["reasoningEffort"] {
  return value === "xhigh" || value === "high" ? value : undefined;
}

function normalizeOptionalInt(value: unknown, min: number, max: number): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(numberValue)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, numberValue));
}

function normalizeModelPurpose(value: unknown): SystemModelPurpose | undefined {
  return isRuntimeModelPurpose(value) ? value : undefined;
}

function isRuntimeModelPurpose(value: unknown): value is SystemModelPurpose {
  return value === "reply" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "image" ||
    value === "custom";
}

function normalizeModelCapabilities(
  value: SystemModelConfig["capabilities"],
  protocol: "openai" | "anthropic",
): SystemModelConfig["capabilities"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    ...(typeof value.vision === "boolean" ? { vision: value.vision } : {}),
    streaming: false,
    reasoningEffort: protocol === "openai" && value.reasoningEffort === true,
    requestTimeout: true,
    imageGeneration: protocol === "openai" && value.imageGeneration === true,
    ...(value.imageEditing !== undefined ? { imageEditing: protocol === "openai" && value.imageEditing === true } : {}),
  };
}

function normalizeModelId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value) ? value : "";
}

function normalizeSelectedModelIds(value: unknown, models: SystemModelConfig[]): SystemSettings["selectedModelIds"] {
  const selected: SystemSettings["selectedModelIds"] = {};
  const modelById = new Map(models.map((model) => [model.id, model]));
  if (value && typeof value === "object") {
    for (const [purposeValue, modelIdValue] of Object.entries(value as Record<string, unknown>)) {
      const purpose = normalizeModelPurpose(purposeValue);
      if (!purpose) continue;
      if (modelIdValue === "") { selected[purpose] = ""; continue; }
      const modelId = typeof modelIdValue === "string" ? normalizeModelId(modelIdValue.trim()) : "";
      const model = modelId ? modelById.get(modelId) : undefined;
      if (model && model.purpose === purpose) {
        selected[purpose] = model.id;
      }
    }
  }
  for (const model of models) {
    if (!isRuntimeModelPurpose(model.purpose)) continue;
    if (!Object.hasOwn(selected, model.purpose) && model.enabled && model.hasApiKey) {
      selected[model.purpose] = model.id;
    }
  }
  return selected;
}

function mergeModelApiKeyState(current: SystemModelConfig[], incoming: unknown): SystemSettingsUpdateInput["models"] {
  if (!Array.isArray(incoming)) {
    return [];
  }
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const record = item as Partial<SystemModelConfig> & { apiKey?: unknown };
    const currentItem = record.id ? currentById.get(record.id) : undefined;
    return {
      ...record,
      apiKey: typeof record.apiKey === "string" && record.apiKey.trim()
        ? record.apiKey.trim()
        : currentItem?.apiKey,
      hasApiKey: typeof record.apiKey === "string" && record.apiKey.trim()
        ? true
        : currentItem?.hasApiKey === true || Boolean(currentItem?.apiKey) || record.hasApiKey === true,
    };
  });
}

function normalizeCommands(value: unknown, now = "1970-01-01T00:00:00.000Z"): SystemCommandConfig[] {
  const defaults = defaultCommands(now);
  const defaultById = new Map(defaults.map((command) => [command.id, command]));
  const raw = Array.isArray(value) ? value : [];
  const byId = new Map<string, SystemCommandConfig>();
  for (const item of raw) {
    const record = item as Partial<SystemCommandConfig>;
    const id = String(record.id ?? "").trim();
    const base = defaultById.get(id);
    if (!base) {
      continue;
    }
    byId.set(id, normalizeCommand(record, base));
  }
  return defaults.map((command) => byId.get(command.id) ?? command);
}

function normalizeCommand(value: Partial<SystemCommandConfig>, base: SystemCommandConfig): SystemCommandConfig {
  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim().slice(0, 80)
    : base.title;
  const primary = typeof value.primary === "string" && value.primary.trim()
    ? value.primary.trim().slice(0, 40)
    : base.primary;
  return {
    id: base.id,
    title,
    primary,
    aliases: value.aliases === undefined ? base.aliases : normalizeStringArray(value.aliases, 12, 40),
    permission: normalizeCommandPermission(base.id, value.permission ?? base.permission),
    enabled: value.enabled !== false,
    help: typeof value.help === "string" ? value.help.trim().slice(0, 400) : base.help,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function defaultCommands(now: string): SystemCommandConfig[] {
  const commands: Array<{
    id: string;
    title: string;
    primary: string;
    aliases?: string[];
    permission: SystemCommandConfig["permission"];
    help: string;
  }> = [
    { id: "bt_search", title: "BT 资源搜索", primary: "#bt", aliases: ["/bt"], permission: "member", help: "搜索动漫、影视和成人资源，返回磁力与种子链接；支持 --fast、--full 和来源筛选" },
    { id: "conversation", title: "对话", primary: "#对话", aliases: ["#clear"], permission: "member", help: "清空或管理当前群对话上下文" },
    { id: "html_preview", title: "网页预览", primary: "#网页", aliases: ["#html"], permission: "member", help: "生成可在线预览的静态网页" },
    { id: "image_generation", title: "图片生成", primary: "#画图", aliases: ["#生图", "#改图"], permission: "member", help: "根据文字生成图片；附图、引用或 #改图 让<目标>头像去<动作> 可编辑，最多 4 张参考图" },
    { id: "help", title: "帮助", primary: "#功能", aliases: ["#帮助", "#命令"], permission: "member", help: "查看机器人可用功能和指令帮助" },
    { id: "model", title: "模型", primary: "#模型", permission: "super_admin", help: "查看模型状态；超级管理员可切换模型或恢复跟随统一默认" },
    { id: "mute", title: "静默模式", primary: "#闭嘴", aliases: ["#说话"], permission: "group_admin", help: "让机器人进入或退出静默模式" },
    { id: "live_chat", title: "实时对话", primary: "#实时对话", permission: "group_admin", help: "管理主动接话名单和倒计时" },
    { id: "daily_report", title: "日报", primary: "#日报", permission: "group_admin", help: "管理群聊日报" },
    { id: "holiday_countdown", title: "节假日", primary: "#节假日", permission: "group_admin", help: "管理节假日倒计时" },
    { id: "scheduled_reminder", title: "定时任务", primary: "#定时任务", permission: "group_admin", help: "管理群定时任务" },
    { id: "status", title: "状态", primary: "#状态", permission: "group_admin", help: "查看机器人运行状态" },
    { id: "operation_log", title: "操作日志", primary: "#操作日志", permission: "group_admin", help: "查看后台操作日志" },
    { id: "server", title: "服务器", primary: "#服务器", permission: "group_admin", help: "查看服务器资源状态" },
    { id: "ops_alert", title: "告警", primary: "#告警", permission: "group_admin", help: "管理运维告警开关" },
    { id: "memory", title: "记忆", primary: "#记忆", permission: "group_admin", help: "查看记忆状态" },
    { id: "knowledge", title: "知识库", primary: "#知识库", permission: "group_admin", help: "查看知识库状态" },
    { id: "blacklist", title: "拉黑", primary: "#拉黑", permission: "group_admin", help: "管理黑名单" },
    { id: "health", title: "健康检查", primary: "#健康检查", aliases: ["#健康"], permission: "group_admin", help: "查看服务健康状态" },
  ];

  return commands.map(({ id, title, primary, aliases = [], permission, help }) => ({
    id,
    title,
    primary,
    aliases,
    permission,
    enabled: true,
    help,
    updatedAt: now,
  }));
}

function normalizeStringArray(value: unknown, limit: number, itemLimit: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s，、]+/)
      : [];
  return Array.from(new Set(raw.map((item) => String(item).trim().slice(0, itemLimit)).filter(Boolean))).slice(0, limit);
}

function cloneSettings(settings: SystemSettings): SystemSettings {
  return JSON.parse(JSON.stringify(settings)) as SystemSettings;
}

function sanitizeSettings(settings: SystemSettings): SystemSettings {
  const cloned = cloneSettings(settings);
  cloned.models = cloned.models.map((model) => {
    const { apiKey: _apiKey, ...safeModel } = model;
    return {
      ...safeModel,
      hasApiKey: model.hasApiKey === true || Boolean(model.apiKey),
    };
  });
  return cloned;
}
