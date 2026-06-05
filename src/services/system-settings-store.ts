import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import type { SystemCommandConfig, SystemModelConfig, SystemSettings } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

type SystemSettingsUpdateInput = Partial<Omit<SystemSettings, "models">> & {
  models?: Array<Partial<SystemModelConfig> & { apiKey?: unknown }>;
};

export class SystemSettingsStore {
  private cachedData?: SystemSettings;

  constructor(
    private readonly filePath: string,
    private readonly defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
  ) {}

  async get(): Promise<SystemSettings> {
    return sanitizeSettings(await this.readData());
  }

  async update(input: SystemSettingsUpdateInput): Promise<SystemSettings> {
    const current = await this.readData();
    const nextModels = input.models === undefined
      ? current.models
      : normalizeModels(mergeModelApiKeyState(current.models, input.models), this.defaultModels);
    const next = normalizeSettings({
      ...current,
      ...input,
      adminSecretHash: current.adminSecretHash,
      groupAdminSecretHash: current.groupAdminSecretHash,
      models: nextModels,
      selectedModelIds: input.selectedModelIds === undefined
        ? current.selectedModelIds
        : normalizeSelectedModelIds(input.selectedModelIds, nextModels),
      commands: input.commands === undefined ? current.commands : input.commands,
      updatedAt: new Date().toISOString(),
    });
    await this.writeData(next);
    return sanitizeSettings(next);
  }

  async getInternal(): Promise<SystemSettings> {
    return cloneSettings(await this.readData());
  }

  async resetAdminSecret(secret: string): Promise<SystemSettings> {
    const current = await this.readData();
    const next = normalizeSettings({
      ...current,
      adminSecretHash: hashSecret(secret),
      updatedAt: new Date().toISOString(),
    }, this.defaultModels);
    await this.writeData(next);
    return sanitizeSettings(next);
  }

  async resetGroupAdminSecret(secret: string): Promise<SystemSettings> {
    const current = await this.readData();
    const next = normalizeSettings({
      ...current,
      groupAdminSecretHash: hashSecret(secret),
      updatedAt: new Date().toISOString(),
    }, this.defaultModels);
    await this.writeData(next);
    return sanitizeSettings(next);
  }

  async verifyAdminSecret(secret: string, fallback?: string): Promise<boolean> {
    const settings = await this.readData();
    return verifyConfiguredOrFallback(settings.adminSecretHash, secret, fallback);
  }

  async verifyGroupAdminSecret(secret: string, fallback?: string): Promise<boolean> {
    const settings = await this.readData();
    return verifyConfiguredOrFallback(settings.groupAdminSecretHash, secret, fallback);
  }

  private async readData(): Promise<SystemSettings> {
    if (this.cachedData) {
      return this.cachedData;
    }
    try {
      this.cachedData = normalizeSettings(await readJsonFile<Partial<SystemSettings>>(this.filePath), this.defaultModels);
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = defaultSettings(this.defaultModels);
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: SystemSettings): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function defaultSettings(defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = []): SystemSettings {
  const now = new Date().toISOString();
  return {
    profileSummaryMaxChars: 1800,
    profileShortSummaryMaxChars: 140,
    dailyProfileReviewEnabled: true,
    dailyProfileReviewTime: "00:00",
    memoryDedupEnabled: true,
    memoryDedupTime: "23:00",
    defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
    models: normalizeModels(defaultModels, []),
    selectedModelIds: normalizeSelectedModelIds({}, normalizeModels(defaultModels, [])),
    commands: defaultCommands(now),
    updatedAt: now,
  };
}

function normalizeSettings(
  value: Partial<SystemSettings>,
  defaultModels: Array<Partial<SystemModelConfig> & { apiKey?: string }> = [],
): SystemSettings {
  const fallback = defaultSettings(defaultModels);
  return {
    profileSummaryMaxChars: normalizePositiveInt(value.profileSummaryMaxChars, fallback.profileSummaryMaxChars, 100, 6000),
    profileShortSummaryMaxChars: normalizePositiveInt(value.profileShortSummaryMaxChars, fallback.profileShortSummaryMaxChars, 40, 600),
    dailyProfileReviewEnabled: value.dailyProfileReviewEnabled !== false,
    dailyProfileReviewTime: normalizeTime(value.dailyProfileReviewTime, fallback.dailyProfileReviewTime),
    memoryDedupEnabled: value.memoryDedupEnabled !== false,
    memoryDedupTime: normalizeTime(value.memoryDedupTime, fallback.memoryDedupTime),
    ...(normalizeSecretHash(value.adminSecretHash) ? { adminSecretHash: normalizeSecretHash(value.adminSecretHash) } : {}),
    ...(normalizeSecretHash(value.groupAdminSecretHash) ? { groupAdminSecretHash: normalizeSecretHash(value.groupAdminSecretHash) } : {}),
    defaultTriggerKeywords: normalizeTriggerKeywords(value.defaultTriggerKeywords),
    models: normalizeModels(value.models, defaultModels),
    selectedModelIds: normalizeSelectedModelIds(value.selectedModelIds, normalizeModels(value.models, defaultModels)),
    commands: normalizeCommands(value.commands),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

function normalizeTime(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    throw new Error("invalid_time");
  }
  return value.trim();
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numberValue));
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
): SystemModelConfig[] {
  const raw = [
    ...(Array.isArray(value) ? value : []),
    ...defaultModels,
  ];
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

function normalizeModel(value: Partial<SystemModelConfig>): SystemModelConfig | undefined {
  const now = new Date().toISOString();
  const providedId = typeof value.id === "string" ? value.id.trim() : "";
  const id = providedId ? normalizeModelId(providedId) : randomUUID();
  if (!id) {
    return undefined;
  }
  const name = String(value.name ?? "").trim().slice(0, 80);
  const shortName = String(value.shortName ?? "").trim().slice(0, 32);
  const baseUrl = String(value.baseUrl ?? "").trim().slice(0, 240);
  const model = String(value.model ?? "").trim().slice(0, 120);
  if (!name || !shortName || !baseUrl || !model) {
    return undefined;
  }
  const purpose = normalizeModelPurpose(value.purpose);
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
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeModelPurpose(value: unknown): SystemModelConfig["purpose"] {
  return value === "reply" ||
    value === "profile" ||
    value === "memory" ||
    value === "dedup" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "tts" ||
    value === "custom"
    ? value
    : "custom";
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
      const modelId = typeof modelIdValue === "string" ? normalizeModelId(modelIdValue.trim()) : "";
      const model = modelId ? modelById.get(modelId) : undefined;
      if (model && model.purpose === purpose) {
        selected[purpose] = model.id;
      }
    }
  }
  for (const model of models) {
    if (!selected[model.purpose] && model.enabled && model.hasApiKey) {
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

function normalizeCommands(value: unknown): SystemCommandConfig[] {
  const defaults = defaultCommands(new Date().toISOString());
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
    permission: base.permission,
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
    { id: "conversation", title: "对话", primary: "#对话", aliases: ["#clear"], permission: "member", help: "清空或管理当前群对话上下文" },
    { id: "voice", title: "语音", primary: "#语音", permission: "member", help: "生成语音回复" },
    { id: "help", title: "帮助", primary: "#功能", aliases: ["#帮助", "#命令"], permission: "member", help: "查看机器人可用功能和指令帮助" },
    { id: "skill", title: "技能", primary: "#技能", permission: "group_admin", help: "查看或切换当前群技能" },
    { id: "model", title: "模型", primary: "#模型", permission: "group_admin", help: "查看或切换当前群回复模型" },
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
    { id: "profile_yesterday", title: "昨日画像", primary: "#昨日画像", permission: "member", help: "生成成员昨日画像摘要" },
    { id: "profile_overall", title: "群聊画像", primary: "#群聊画像", permission: "member", help: "生成成员群聊画像摘要" },
    { id: "admin", title: "管理员", primary: "#管理员", permission: "super_admin", help: "管理群管理员" },
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
  cloned.adminSecretConfigured = Boolean(cloned.adminSecretHash);
  cloned.groupAdminSecretConfigured = Boolean(cloned.groupAdminSecretHash);
  delete cloned.adminSecretHash;
  delete cloned.groupAdminSecretHash;
  cloned.models = cloned.models.map((model) => {
    const { apiKey: _apiKey, ...safeModel } = model;
    return {
      ...safeModel,
      hasApiKey: model.hasApiKey === true || Boolean(model.apiKey),
    };
  });
  return cloned;
}

function hashSecret(secret: string): string {
  const text = String(secret ?? "").trim();
  if (text.length < 6) {
    throw new Error("secret_too_short");
  }
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(text, salt, 32).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyConfiguredOrFallback(hash: string | undefined, secret: string, fallback?: string): boolean {
  const text = String(secret ?? "");
  if (hash) {
    return verifySecretHash(hash, text);
  }
  return Boolean(fallback) && safeTextEqual(text, fallback ?? "");
}

function verifySecretHash(hash: string, secret: string): boolean {
  const [, salt, expected] = hash.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(secret, salt, 32);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function safeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function normalizeSecretHash(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return /^scrypt:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{32,}$/.test(text) ? text : undefined;
}
