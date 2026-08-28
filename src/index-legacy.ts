import { loadConfig } from "./config.js";
import { AdminHttpServer } from "./admin-http-server.js";
import { NapCatClient } from "./napcat-client.js";
import { NapCatReverseServer } from "./napcat-reverse-server.js";
import { BotApplication } from "./bot.js";
import { AiService } from "./services/ai-service.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { ConfiguredAiService } from "./services/configured-ai-service.js";
import { ConfiguredTtsService } from "./services/configured-tts-service.js";
import { ConversationStore } from "./services/conversation-store.js";
import { SqliteConversationStore } from "./services/conversation-store-v3.js";
import { ConversationContextRepository } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import { AtmosphereSummarizer } from "./services/atmosphere-summarizer.js";
import { DailyReportService } from "./services/daily-report-service.js";
import { DailyReportStore } from "./services/daily-report-store.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupConfigSqliteShadowRepository } from "./services/group-config-sqlite-shadow-repository.js";
import { GroupLock } from "./services/group-lock.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { GroupTranscriptService } from "./services/group-transcript-service.js";
import { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import { HolidayCountdownStore } from "./services/holiday-countdown-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { CharacterProfileService } from "./services/character-profile-service.js";
import { SkillService } from "./services/skill-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { SystemSettingsSqliteShadowRepository } from "./services/system-settings-sqlite-shadow-repository.js";
import { RealtimeLookupService } from "./services/realtime-lookup-service.js";
import { ModelHealthHistoryStore } from "./services/model-health-history-store.js";
import { TtsService } from "./services/tts-service.js";
import { logError, logInfo } from "./logger.js";
import type { NapcatGroupMessageEvent } from "./types.js";
import type { MessageTransport } from "./bot.js";
import { buildDefaultSystemModels } from "./system-model-defaults.js";
import { openSharedDb } from "./shared/sqlite.js";
import { resolveV3RuntimeState } from "./services/v3-runtime-state.js";
import { V3CapabilityPolicyService } from "./services/capability-policy-service.js";
import { extractImagesFromMessage, parseGroupMessage } from "./utils/message-parser.js";

type NapCatRuntime = MessageTransport & {
  start(): void;
  on(event: "groupMessage", listener: (event: NapcatGroupMessageEvent) => void): unknown;
};

let activeLegacyBot: BotApplication | undefined;
let legacyStartup: Promise<BotApplication> | undefined;
let shuttingDown = false;

/**
 * Legacy single-process entry (rollback path for the service-split rollout).
 * `BOT_ROLE` unset → this module runs the whole bot + admin in one process,
 * exactly like UBot V1.x.
 */
async function startLegacyBot(): Promise<BotApplication> {
  const config = loadConfig();
  const replyAiService = new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel);
  logInfo("AI services configured.", {
    replyBaseUrl: config.openAiBaseUrl,
    replyModel: config.openAiModel,
  });
  const sharedDb = openSharedDb(config.dataDir);
  const v3State = resolveV3RuntimeState(sharedDb, config.stateEncryptionKey);
  const capabilityPolicy = v3State ? new V3CapabilityPolicyService(v3State) : undefined;
  const groupMemoryStore = new GroupMemoryStore(config.groupMemoryPath, v3State);
  const systemSettingsStore = new SystemSettingsStore(
    config.systemSettingsPath,
    buildDefaultSystemModels(config),
    v3State ? undefined : new SystemSettingsSqliteShadowRepository(sharedDb),
    v3State,
  );
  await systemSettingsStore.syncShadowFromAuthoritative();
  const runtimeReplyAiService = new ConfiguredAiService(
    replyAiService,
    systemSettingsStore,
    "reply",
    undefined,
    undefined,
    capabilityPolicy,
  );
  const defaultTtsService = new TtsService(
    config.ttsBaseUrl,
    config.ttsApiKey,
    config.ttsModel,
    config.ttsVoice,
    config.ttsAudioFormat,
    config.ttsCacheDir,
    config.ttsStyleHint,
  );
  const runtimeTtsService = new ConfiguredTtsService(defaultTtsService, systemSettingsStore, {
    voice: config.ttsVoice,
    audioFormat: config.ttsAudioFormat,
    cacheDir: config.ttsCacheDir,
    globalStyleHint: config.ttsStyleHint,
  });
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath, v3State);
  const characterProfileService = v3State ? new CharacterProfileService(v3State) : undefined;
  const skillService = characterProfileService ?? new SkillService(config.skillsDir);
  if (characterProfileService && !await characterProfileService.getHuixianProfile()) {
    throw new Error("v3_huixian_profile_missing");
  }
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath, v3State),
    runtimeReplyAiService,
  );
  const adminTaskStore = new AdminTaskStore(config.adminTasksPath, v3State);
  await sweepAdminTasksOnStartup(adminTaskStore);
  const modelHealthHistoryStore = new ModelHealthHistoryStore(config.modelHealthHistoryPath, v3State);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath, v3State);
  const groupConfigService = new GroupConfigService(
    config.groupsConfigPath,
    v3State ? undefined : new GroupConfigSqliteShadowRepository(sharedDb),
    v3State,
  );
  await groupConfigService.syncShadowFromAuthoritative();
  const contextRepository = new ConversationContextRepository(sharedDb);
  const contextRouter = new ConversationContextRouter(contextRepository);
  const atmosphere = new AtmosphereSummarizer(config.dataDir, {}, v3State);
  const napcatRuntime: NapCatRuntime =
    config.napcatMode === "reverse"
      ? new NapCatReverseServer({
          host: config.napcatReverseWsHost,
          port: config.napcatReverseWsPort,
          path: config.napcatReverseWsPath,
          accessToken: config.napcatAccessToken,
        })
      : new NapCatClient({
          wsUrl: config.napcatWsUrl,
          accessToken: config.napcatAccessToken,
        });

  const app = new BotApplication(
    napcatRuntime,
    groupConfigService,
    skillService,
    v3State ? new SqliteConversationStore(contextRepository) : new ConversationStore(config.conversationsPath),
    runtimeReplyAiService,
    runtimeTtsService,
    new DailyReportService(
      new DailyReportStore(config.dailyReportStorePath, v3State),
      runtimeReplyAiService,
    ),
    new HolidayCountdownService(
      new HolidayCountdownStore(config.holidayCountdownStorePath, v3State),
      runtimeReplyAiService,
    ),
    scheduledReminderService,
    adminOperationLogService,
    // Legacy has no ConsumerRunner, so serialize the group while the route is
    // resolved and executed. This prevents same-branch LLM overlap.
    new GroupLock(1),
    new LiveChatService(),
    config.botQq,
    config.ttsAllowNapCatAiFallback,
    groupMemoryStore,
    knowledgeBaseStore,
    undefined,
    undefined,
    config.adminPublicBaseUrl,
    undefined,
    {
      gpt: config.openAiModel,
    },
    systemSettingsStore,
    undefined,
    new RealtimeLookupService({ searchUrl: config.realtimeSearchUrl }),
    new GroupTranscriptService(),
    atmosphere,
    undefined,
    undefined,
    undefined,
    true,
    contextRepository,
    contextRouter,
    capabilityPolicy,
  );

  const adminHttpServer = config.adminHttpEnabled
    ? createAdminHttpServer(
        config,
        groupConfigService,
        groupMemoryStore,
        knowledgeBaseStore,
        scheduledReminderService,
        characterProfileService,
        systemSettingsStore,
        adminTaskStore,
        modelHealthHistoryStore,
        adminOperationLogService,
        app,
        napcatRuntime,
        sharedDb,
      )
    : undefined;

  napcatRuntime.on("groupMessage", async (event) => {
    try {
      const parsed = parseGroupMessage(event.message, config.botQq);
      const images = extractImagesFromMessage(event.message);
      const groupId = String(event.group_id);
      const userId = String(event.user_id);
      const selfId = event.self_id === undefined ? config.botQq : String(event.self_id);
      if (userId === config.botQq || userId === selfId) {
        return;
      }
      const messageId = String(event.message_id);
      const messageTime = event.time ? event.time * 1_000 : Date.now();
      const rowId = sharedDb.insertMessage({
        groupId,
        userId,
        selfId,
        msgId: messageId,
        msgTime: messageTime,
        text: parsed.text,
        imagesJson: JSON.stringify(images),
        senderCard: event.sender?.card,
        senderNickname: event.sender?.nickname,
        replyTo: parsed.replyMessageId,
        hasAtBot: parsed.hasAtBot,
        isBotMsg: false,
        createdAt: Date.now(),
      });
      if (rowId === 0) {
        return;
      }
      const recent = sharedDb.listRecentGroupMessages(groupId, messageTime - 60 * 60 * 1_000);
      atmosphere.update(groupId, recent.map((row) => ({
        groupId: row.group_id,
        userId: row.user_id,
        messageId: row.msg_id,
        text: row.text || (safeImageCount(row.images_json) > 0 ? "[图片消息]" : ""),
        timestamp: new Date(row.msg_time).toISOString(),
      })).filter((message) => Boolean(message.text)), messageTime);
      const isAdministrativeCommand = parsed.text.trim().startsWith("#") &&
        !/^(?:#语音(?:\s|$)|#唱歌(?:\s|$))/u.test(parsed.text.trim());
      // A OneBot reply segment alone is not an authorization to speak. Match
      // the worker path: only a same-group, acknowledged bot message may
      // continue without an explicit @.
      const replyToBot = sharedDb.isKnownBotMessage(groupId, parsed.replyMessageId);
      const shouldRoute = !isAdministrativeCommand && await app.shouldRouteConversation(
        groupId,
        parsed.text,
        parsed.hasAtBot,
        {
          hasImages: images.length > 0,
          replyToBot,
        },
      );
      const route = !shouldRoute
        ? undefined
        : contextRouter.resolve({
            sourceRowId: rowId,
            groupId,
            userId,
            sourceMessageId: messageId,
            replyToMessageId: parsed.replyMessageId,
            text: parsed.text,
            hasImages: images.length > 0,
            nowMs: messageTime,
          });
      await app.handleGroupMessage(event, undefined, route, {
        allowReplyWithoutMention: replyToBot,
      });
    } catch (error) {
      logError("Unhandled group message error.", {
        error: (error as Error).message,
        groupId: event.group_id,
        userId: event.user_id,
      });
    }
  });

  app.start();
  napcatRuntime.start();
  adminHttpServer?.start();
  logInfo("NapCat QQ skill bot started.", {
    mode: config.napcatMode,
  });

  return app;
}

/** Starts the legacy process once so shutdown never creates a second runtime. */
export async function main(): Promise<BotApplication> {
  if (activeLegacyBot) {
    return activeLegacyBot;
  }
  legacyStartup ??= startLegacyBot().then((bot) => {
    activeLegacyBot = bot;
    return bot;
  });
  return legacyStartup;
}

function safeImageCount(imagesJson: string): number {
  try {
    const value = JSON.parse(imagesJson) as unknown;
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

async function sweepAdminTasksOnStartup(adminTaskStore: AdminTaskStore): Promise<void> {
  try {
    await adminTaskStore.sweepStaleTasks();
  } catch (error) {
    logError("Failed to sweep stale admin tasks on startup.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createAdminHttpServer(
  config: ReturnType<typeof loadConfig>,
  groupConfigService: GroupConfigService,
  groupMemoryStore: GroupMemoryStore,
  knowledgeBaseStore: KnowledgeBaseStore,
  scheduledReminderService: ScheduledReminderService,
  characterProfileService: CharacterProfileService | undefined,
  systemSettingsStore: SystemSettingsStore,
  adminTaskStore: AdminTaskStore,
  modelHealthHistoryStore: ModelHealthHistoryStore,
  adminOperationLogService: AdminOperationLogService,
  app: BotApplication,
  napcatRuntime: NapCatRuntime,
  sharedDb: ReturnType<typeof openSharedDb>,
): AdminHttpServer {
  if (!config.stateEncryptionKey) {
    throw new Error("UBOT_STATE_ENCRYPTION_KEY is required when ADMIN_HTTP_ENABLED=true.");
  }

  return new AdminHttpServer({
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
    adminOperationLogService,
    getTransportHealthStatus: () => app.getPublicTransportHealthStatus(),
    listGroupMembers: (groupId) => napcatRuntime.listGroupMembers ? napcatRuntime.listGroupMembers(groupId) : Promise.resolve([]),
    listGroups: () => napcatRuntime.listGroups ? napcatRuntime.listGroups() : Promise.resolve([]),
    sharedDb,
  });
}

// Direct-run entry guard (rollback path: `node dist/index-legacy.js` or
// BOT_ROLE=legacy → dist/index.js imports this module and calls main()).
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("index-legacy") || process.argv[1].endsWith("index-legacy.js"));

if (isDirectRun) {
  void main().catch((error) => {
    logError("Legacy startup failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

// Graceful shutdown: stop the already-running legacy app. Do not call main()
// here: constructing another app during SIGTERM can rebind ports and corrupt
// the rollback path exactly when it must remain dependable.
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logInfo("Shutting down legacy runtime...");
  try {
    const bot = activeLegacyBot ?? await legacyStartup;
    await bot?.stop();
    logInfo("Legacy shutdown complete.");
    process.exit(0);
  } catch (error) {
    logError("Legacy shutdown failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
