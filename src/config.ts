import { realpathSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

import type { AppConfig } from "./types.js";
import { isRetiredModelId } from "./services/retired-models.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function resolveDataDir(cwd: string): string {
  const dataDir = path.join(cwd, "data");
  try {
    return realpathSync(dataDir);
  } catch (error) {
    // A fresh installation creates data later; deployed release symlinks must
    // instead resolve to the same persistent directory in every process.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return dataDir;
    throw error;
  }
}

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const dataDir = resolveDataDir(cwd);
  const napcatMode = (process.env.NAPCAT_MODE ?? "forward").trim().toLowerCase();
  const reversePort = Number(process.env.NAPCAT_REVERSE_WS_PORT ?? "6199");
  const adminHttpPort = Number(process.env.ADMIN_HTTP_PORT ?? "6200");
  const ingressReadApiPort = Number(process.env.INGRESS_READ_API_PORT ?? "6198");
  const ingressReadApiToken = requireEnv("INGRESS_READ_API_TOKEN");
  const openAiBaseUrl = requireEnv("OPENAI_BASE_URL");
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = requireEnv("OPENAI_MODEL");
  if (isRetiredModelId(openAiModel)) throw new Error("model_retired");
  const napcatWsUrl =
    napcatMode === "forward"
      ? requireEnv("NAPCAT_WS_URL")
      : process.env.NAPCAT_WS_URL ?? "ws://127.0.0.1:3001";
  if (napcatMode !== "forward" && napcatMode !== "reverse") {
    throw new Error("NAPCAT_MODE must be either 'forward' or 'reverse'.");
  }
  if (!Number.isFinite(reversePort) || reversePort <= 0 || reversePort > 65535) {
    throw new Error("NAPCAT_REVERSE_WS_PORT must be a valid TCP port (1-65535).");
  }
  if (!Number.isFinite(ingressReadApiPort) || ingressReadApiPort <= 0 || ingressReadApiPort > 65535) {
    throw new Error("INGRESS_READ_API_PORT must be a valid TCP port (1-65535).");
  }
  if (!Number.isFinite(adminHttpPort) || adminHttpPort <= 0 || adminHttpPort > 65535) {
    throw new Error("ADMIN_HTTP_PORT must be a valid TCP port (1-65535).");
  }
  const napcatAccessToken = optionalEnv("NAPCAT_ACCESS_TOKEN");
  const reverseHost = optionalEnv("NAPCAT_REVERSE_WS_HOST") ?? "127.0.0.1";
  if (napcatMode === "reverse" && reverseHost !== "127.0.0.1" && reverseHost !== "localhost" && !napcatAccessToken) {
    throw new Error("NAPCAT_ACCESS_TOKEN is required when reverse WebSocket listens on a non-localhost host.");
  }

  return {
    napcatMode,
    napcatWsUrl,
    napcatAccessToken,
    napcatReverseWsHost: reverseHost,
    napcatReverseWsPort: reversePort,
    napcatReverseWsPath: optionalEnv("NAPCAT_REVERSE_WS_PATH") ?? "/onebot/ws",
    ingressReadApiPort,
    ingressReadApiToken,
    openAiBaseUrl,
    openAiApiKey,
    openAiModel,
    realtimeSearchUrl: optionalEnv("REALTIME_SEARCH_URL") ?? "http://127.0.0.1:8088",
    dataDir,
    htmlPreviewPublicBaseUrl: optionalEnv("HTML_PREVIEW_PUBLIC_BASE_URL") ?? "https://preview.9958.uk",
    htmlPreviewRoot: optionalEnv("HTML_PREVIEW_ROOT") ?? path.join(dataDir, "generated-pages"),
    botQq: requireEnv("BOT_QQ"),
    groupsConfigPath: path.join(cwd, "config", "groups.json"),
    skillsDir: path.join(cwd, "skills"),
    conversationsPath: path.join(dataDir, "conversations.json"),
    dailyReportStorePath: path.join(dataDir, "daily-report-store.json"),
    holidayCountdownStorePath: path.join(dataDir, "holiday-countdown-store.json"),
    scheduledReminderStorePath: path.join(dataDir, "scheduled-reminders.json"),
    adminOperationLogPath: path.join(dataDir, "admin-operations.jsonl"),
    groupMemoryPath: path.join(dataDir, "group-memory.json"),
    knowledgeBasePath: path.join(dataDir, "knowledge-base.json"),
    systemSettingsPath: path.join(dataDir, "system-settings.json"),
    adminTasksPath: path.join(dataDir, "admin-tasks.json"),
    modelHealthHistoryPath: path.join(dataDir, "model-health-history.json"),
    adminHttpEnabled: (process.env.ADMIN_HTTP_ENABLED ?? "false").trim().toLowerCase() === "true",
    adminHttpHost: optionalEnv("ADMIN_HTTP_HOST") ?? "127.0.0.1",
    adminHttpPort,
    adminPublicBaseUrl: optionalEnv("ADMIN_PUBLIC_BASE_URL") ?? "https://bot.9958.uk",
    adminUsername: optionalEnv("ADMIN_USERNAME"),
    adminPassword: optionalEnv("ADMIN_PASSWORD"),
    stateEncryptionKey: optionalEnv("UBOT_STATE_ENCRYPTION_KEY"),
  };
}
