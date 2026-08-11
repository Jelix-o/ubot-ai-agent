import { loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { AdminHttpServer } from "./admin-http-server.js";
import { IngressReadApiClient } from "./ingress-read-api.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./services/group-memory-candidate-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { SkillService } from "./services/skill-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { ProfileRecordStore } from "./services/profile-record-store.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { ModelHealthHistoryStore } from "./services/model-health-history-store.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AiService } from "./services/ai-service.js";
import { ConfiguredAiService } from "./services/configured-ai-service.js";
import { DailyProfileReviewService } from "./services/daily-profile-review-service.js";
import { buildDefaultSystemModels } from "./system-model-defaults.js";

/**
 * Admin process:
 *   - Runs the admin HTTP backend on its own, reading shared state from the
 *     SQLite DB and metrics dir (no direct dependency on the worker's
 *     BotApplication instance).
 *   - NapCat read APIs (members, groups) are proxied through the ingress
 *     read API instead of owning a WS connection.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.adminHttpEnabled) {
    logInfo("Admin HTTP disabled; admin process exiting.");
    return;
  }
  if (!config.adminUsername || !config.adminPassword || !config.adminSessionSecret) {
    throw new Error("ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SESSION_SECRET are required when ADMIN_HTTP_ENABLED=true.");
  }

  const readClient = new IngressReadApiClient(`http://127.0.0.1:${config.ingressReadApiPort}`);
  const groupConfigService = new GroupConfigService(config.groupsConfigPath);
  const groupMemoryStore = new GroupMemoryStore(config.groupMemoryPath);
  const systemSettingsStore = new SystemSettingsStore(config.systemSettingsPath, buildDefaultSystemModels(config));
  const profileAiService = new ConfiguredAiService(
    new AiService(config.profileAiBaseUrl, config.profileAiApiKey, config.profileAiModel),
    systemSettingsStore,
    "profile",
  );
  const groupMemoryCandidateService = new GroupMemoryCandidateService(
    new GroupMemoryCandidateStore(config.groupMemoryCandidatesPath),
    groupMemoryStore,
    profileAiService,
    8,
    systemSettingsStore,
  );
  const dailyProfileReviewService = new DailyProfileReviewService(
    config.dailyProfileReviewPath,
    groupMemoryStore,
    profileAiService,
  );
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath);
  const skillService = new SkillService(config.skillsDir);
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath),
    new ConfiguredAiService(
      new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel),
      systemSettingsStore,
      "reply",
    ),
  );
  const profileRecordStore = new ProfileRecordStore(config.profileRecordsPath);
  const adminTaskStore = new AdminTaskStore(config.adminTasksPath);
  const modelHealthHistoryStore = new ModelHealthHistoryStore(config.modelHealthHistoryPath);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath);

  const server = new AdminHttpServer({
    host: config.adminHttpHost,
    port: config.adminHttpPort,
    publicBaseUrl: config.adminPublicBaseUrl,
    username: config.adminUsername,
    password: config.adminPassword,
    groupPassword: config.adminGroupPassword ?? config.adminPassword,
    sessionSecret: config.adminSessionSecret,
    groupConfigService,
    groupMemoryStore,
    groupMemoryCandidateService,
    dailyProfileReviewService,
    knowledgeBaseStore,
    scheduledReminderService,
    skillService,
    systemSettingsStore,
    profileRecordStore,
    adminTaskStore,
    modelHealthHistoryStore,
    adminOperationLogService,
    getTransportHealthStatus: () => readClient.getHealth(),
    getProfileAiHealthStatus: (options) => profileAiService.checkHealth(options),
    judgeMemorySemanticRelation: (args) => profileAiService.judgeMemorySemanticRelation(args),
    summarizeOverallMemberProfile: (args) => profileAiService.summarizeOverallMemberProfile(args),
    listGroupMembers: (groupId) => readClient.listGroupMembers(groupId),
    listGroups: () => readClient.listGroups(),
  });

  server.start();
  logInfo("Admin HTTP server started.", {
    host: config.adminHttpHost,
    port: config.adminHttpPort,
  });

  const shutdown = () => {
    logInfo("Admin shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("index-admin")) {
  void main().catch((error) => {
    logError("Admin startup failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
