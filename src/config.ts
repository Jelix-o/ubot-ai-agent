import path from "node:path";
import dotenv from "dotenv";

import type { AppConfig } from "./types.js";

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

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const napcatMode = (process.env.NAPCAT_MODE ?? "forward").trim().toLowerCase();
  const reversePort = Number(process.env.NAPCAT_REVERSE_WS_PORT ?? "6199");
  const adminHttpPort = Number(process.env.ADMIN_HTTP_PORT ?? "6200");
  const openAiBaseUrl = requireEnv("OPENAI_BASE_URL");
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = requireEnv("OPENAI_MODEL");
  const ttsAudioFormat = (process.env.TTS_AUDIO_FORMAT ?? "wav").trim().toLowerCase();
  const ttsAllowNapCatAiFallback =
    (process.env.TTS_ALLOW_NAPCAT_AI_FALLBACK ?? "false").trim().toLowerCase() === "true";
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
  if (!Number.isFinite(adminHttpPort) || adminHttpPort <= 0 || adminHttpPort > 65535) {
    throw new Error("ADMIN_HTTP_PORT must be a valid TCP port (1-65535).");
  }
  if (!["wav", "mp3", "pcm", "pcm16"].includes(ttsAudioFormat)) {
    throw new Error("TTS_AUDIO_FORMAT must be one of 'wav', 'mp3', 'pcm', or 'pcm16'.");
  }

  return {
    napcatMode,
    napcatWsUrl,
    napcatAccessToken: optionalEnv("NAPCAT_ACCESS_TOKEN"),
    napcatReverseWsHost: optionalEnv("NAPCAT_REVERSE_WS_HOST") ?? "127.0.0.1",
    napcatReverseWsPort: reversePort,
    napcatReverseWsPath: optionalEnv("NAPCAT_REVERSE_WS_PATH") ?? "/onebot/ws",
    openAiBaseUrl,
    openAiApiKey,
    openAiModel,
    profileAiBaseUrl: optionalEnv("PROFILE_AI_BASE_URL") ?? openAiBaseUrl,
    profileAiApiKey: optionalEnv("PROFILE_AI_API_KEY") ?? openAiApiKey,
    profileAiModel: optionalEnv("PROFILE_AI_MODEL") ?? openAiModel,
    ttsBaseUrl: optionalEnv("TTS_BASE_URL") ?? openAiBaseUrl,
    ttsApiKey: optionalEnv("TTS_API_KEY") ?? openAiApiKey,
    ttsModel: optionalEnv("TTS_MODEL") ?? "mimo-v2-tts",
    ttsVoice: optionalEnv("TTS_VOICE") ?? "mimo_default",
    ttsAudioFormat: ttsAudioFormat as AppConfig["ttsAudioFormat"],
    ttsStyleHint: process.env.TTS_STYLE_HINT?.trim() || undefined,
    ttsAllowNapCatAiFallback,
    ttsCacheDir: path.join(cwd, "data", "tts-cache"),
    botQq: requireEnv("BOT_QQ"),
    groupsConfigPath: path.join(cwd, "config", "groups.json"),
    skillsDir: path.join(cwd, "skills"),
    conversationsPath: path.join(cwd, "data", "conversations.json"),
    dailyReportStorePath: path.join(cwd, "data", "daily-report-store.json"),
    holidayCountdownStorePath: path.join(cwd, "data", "holiday-countdown-store.json"),
    scheduledReminderStorePath: path.join(cwd, "data", "scheduled-reminders.json"),
    adminOperationLogPath: path.join(cwd, "data", "admin-operations.jsonl"),
    groupMemoryPath: path.join(cwd, "data", "group-memory.json"),
    groupMemoryCandidatesPath: path.join(cwd, "data", "group-memory-candidates.json"),
    dailyProfileReviewPath: path.join(cwd, "data", "daily-profile-review.json"),
    knowledgeBasePath: path.join(cwd, "data", "knowledge-base.json"),
    systemSettingsPath: path.join(cwd, "data", "system-settings.json"),
    profileRecordsPath: path.join(cwd, "data", "profile-records.json"),
    adminHttpEnabled: (process.env.ADMIN_HTTP_ENABLED ?? "false").trim().toLowerCase() === "true",
    adminHttpHost: optionalEnv("ADMIN_HTTP_HOST") ?? "127.0.0.1",
    adminHttpPort,
    adminPublicBaseUrl: optionalEnv("ADMIN_PUBLIC_BASE_URL") ?? "https://bot.9958.uk",
    adminUsername: optionalEnv("ADMIN_USERNAME"),
    adminPassword: optionalEnv("ADMIN_PASSWORD"),
    adminGroupPassword: optionalEnv("ADMIN_GROUP_PASSWORD") ?? optionalEnv("ADMIN_PASSWORD"),
    adminSessionSecret: optionalEnv("ADMIN_SESSION_SECRET"),
  };
}
