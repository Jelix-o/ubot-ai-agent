import { loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { AdminHttpServer } from "./admin-http-server.js";
import { IngressReadApiClient } from "./ingress-read-api.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupConfigSqliteShadowRepository } from "./services/group-config-sqlite-shadow-repository.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { CharacterProfileService } from "./services/character-profile-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { SystemSettingsSqliteShadowRepository } from "./services/system-settings-sqlite-shadow-repository.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { ModelHealthHistoryStore } from "./services/model-health-history-store.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AiService } from "./services/ai-service.js";
import { ConfiguredAiService } from "./services/configured-ai-service.js";
import { buildDefaultSystemModels } from "./system-model-defaults.js";
import { openSharedDb } from "./shared/sqlite.js";
import { resolveV3RuntimeState } from "./services/v3-runtime-state.js";
import { V3CapabilityPolicyService } from "./services/capability-policy-service.js";
import { HtmlPreviewService } from "./services/html-preview-service.js";

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
  if (!config.stateEncryptionKey) {
    throw new Error("UBOT_STATE_ENCRYPTION_KEY is required when ADMIN_HTTP_ENABLED=true.");
  }

  const readClient = new IngressReadApiClient(`http://127.0.0.1:${config.ingressReadApiPort}`);
  const sharedDb = openSharedDb(config.dataDir);
  const v3State = resolveV3RuntimeState(sharedDb, config.stateEncryptionKey);
  const capabilityPolicy = v3State ? new V3CapabilityPolicyService(v3State) : undefined;
  const groupConfigService = new GroupConfigService(
    config.groupsConfigPath,
    v3State ? undefined : new GroupConfigSqliteShadowRepository(sharedDb),
    v3State,
  );
  await groupConfigService.syncShadowFromAuthoritative();
  const groupMemoryStore = new GroupMemoryStore(config.groupMemoryPath, v3State);
  const systemSettingsStore = new SystemSettingsStore(
    config.systemSettingsPath,
    buildDefaultSystemModels(config),
    v3State ? undefined : new SystemSettingsSqliteShadowRepository(sharedDb),
    v3State,
  );
  await systemSettingsStore.syncShadowFromAuthoritative();
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath, v3State);
  const characterProfileService = v3State ? new CharacterProfileService(v3State) : undefined;
  if (characterProfileService && !await characterProfileService.getHuixianProfile()) {
    throw new Error("v3_huixian_profile_missing");
  }
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath, v3State),
    new ConfiguredAiService(
      new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel),
      systemSettingsStore,
      "reply",
      undefined,
      undefined,
      capabilityPolicy,
    ),
  );
  const adminTaskStore = new AdminTaskStore(config.adminTasksPath, v3State);
  const modelHealthHistoryStore = new ModelHealthHistoryStore(config.modelHealthHistoryPath, v3State);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath, v3State);
  const htmlPreviewService = new HtmlPreviewService({
    sharedDb,
    rootDir: config.htmlPreviewRoot,
    publicBaseUrl: config.htmlPreviewPublicBaseUrl,
  });

  const server = new AdminHttpServer({
    host: config.adminHttpHost,
    port: config.adminHttpPort,
    publicBaseUrl: config.adminPublicBaseUrl,
    username: config.adminUsername,
    password: config.adminPassword,
    stateEncryptionKey: config.stateEncryptionKey,
    groupConfigService,
    groupMemoryStore,
    knowledgeBaseStore,
    scheduledReminderService,
    characterProfileService,
    systemSettingsStore,
    adminTaskStore,
    modelHealthHistoryStore,
    htmlPreviewService,
    adminOperationLogService,
    getTransportHealthStatus: () => readClient.getHealth(),
    listGroupMembers: (groupId) => readClient.listGroupMembersStrict(groupId),
    listGroups: () => readClient.listGroups(),
    sharedDb,
    mfaRequired: config.adminMfaRequired,
  });

  server.start();
  logInfo("Admin HTTP server started.", {
    host: config.adminHttpHost,
    port: config.adminHttpPort,
  });

  const shutdown = () => {
    logInfo("Admin shutting down...");
    server.close();
    sharedDb.close();
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
