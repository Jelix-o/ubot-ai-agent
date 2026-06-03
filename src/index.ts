import { loadConfig } from "./config.js";
import { AdminHttpServer } from "./admin-http-server.js";
import { NapCatClient } from "./napcat-client.js";
import { NapCatReverseServer } from "./napcat-reverse-server.js";
import { BotApplication } from "./bot.js";
import { AiService } from "./services/ai-service.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { ConversationStore } from "./services/conversation-store.js";
import { DailyProfileReviewService } from "./services/daily-profile-review-service.js";
import { DailyReportService } from "./services/daily-report-service.js";
import { DailyReportStore } from "./services/daily-report-store.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupLock } from "./services/group-lock.js";
import { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./services/group-memory-candidate-store.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import { HolidayCountdownStore } from "./services/holiday-countdown-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { SkillService } from "./services/skill-service.js";
import { TtsService } from "./services/tts-service.js";
import { logError, logInfo } from "./logger.js";
import type { NapcatGroupMessageEvent } from "./types.js";
import type { MessageTransport } from "./bot.js";

type NapCatRuntime = MessageTransport & {
  start(): void;
  on(event: "groupMessage", listener: (event: NapcatGroupMessageEvent) => void): unknown;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const replyAiService = new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel);
  const profileAiService = new AiService(config.profileAiBaseUrl, config.profileAiApiKey, config.profileAiModel);
  logInfo("AI services configured.", {
    replyBaseUrl: config.openAiBaseUrl,
    replyModel: config.openAiModel,
    profileBaseUrl: config.profileAiBaseUrl,
    profileModel: config.profileAiModel,
    profileAiConfigured: config.profileAiBaseUrl !== config.openAiBaseUrl || config.profileAiModel !== config.openAiModel,
  });
  const groupConfigService = new GroupConfigService(config.groupsConfigPath);
  const groupMemoryStore = new GroupMemoryStore(config.groupMemoryPath);
  const dailyProfileReviewService = new DailyProfileReviewService(
    config.dailyProfileReviewPath,
    groupMemoryStore,
    profileAiService,
  );
  const groupMemoryCandidateService = new GroupMemoryCandidateService(
    new GroupMemoryCandidateStore(config.groupMemoryCandidatesPath),
    groupMemoryStore,
    profileAiService,
  );
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath);
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
    new SkillService(config.skillsDir),
    new ConversationStore(config.conversationsPath),
    replyAiService,
    new TtsService(
      config.ttsBaseUrl,
      config.ttsApiKey,
      config.ttsModel,
      config.ttsVoice,
      config.ttsAudioFormat,
      config.ttsCacheDir,
      config.ttsStyleHint,
    ),
    new DailyReportService(
      new DailyReportStore(config.dailyReportStorePath),
      replyAiService,
    ),
    new HolidayCountdownService(
      new HolidayCountdownStore(config.holidayCountdownStorePath),
      replyAiService,
    ),
    new ScheduledReminderService(
      new ScheduledReminderStore(config.scheduledReminderStorePath),
      replyAiService,
    ),
    new AdminOperationLogService(config.adminOperationLogPath),
    new GroupLock(),
    new LiveChatService(),
    config.botQq,
    config.ttsAllowNapCatAiFallback,
    groupMemoryStore,
    knowledgeBaseStore,
    groupMemoryCandidateService,
    dailyProfileReviewService,
    config.adminPublicBaseUrl,
    profileAiService,
    {
      gpt: config.openAiModel,
      mimo: config.profileAiModel,
    },
  );

  const adminHttpServer = config.adminHttpEnabled
    ? createAdminHttpServer(config, groupConfigService, groupMemoryStore, groupMemoryCandidateService, knowledgeBaseStore, app, napcatRuntime, profileAiService)
    : undefined;

  napcatRuntime.on("groupMessage", async (event) => {
    try {
      await app.handleGroupMessage(event);
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
}

function createAdminHttpServer(
  config: ReturnType<typeof loadConfig>,
  groupConfigService: GroupConfigService,
  groupMemoryStore: GroupMemoryStore,
  groupMemoryCandidateService: GroupMemoryCandidateService,
  knowledgeBaseStore: KnowledgeBaseStore,
  app: BotApplication,
  napcatRuntime: NapCatRuntime,
  profileAiService: AiService,
): AdminHttpServer {
  if (!config.adminUsername || !config.adminPassword || !config.adminSessionSecret) {
    throw new Error("ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SESSION_SECRET are required when ADMIN_HTTP_ENABLED=true.");
  }

  return new AdminHttpServer({
    host: config.adminHttpHost,
    port: config.adminHttpPort,
    publicBaseUrl: config.adminPublicBaseUrl,
    username: config.adminUsername,
    password: config.adminPassword,
    sessionSecret: config.adminSessionSecret,
    groupConfigService,
    groupMemoryStore,
    groupMemoryCandidateService,
    knowledgeBaseStore,
    adminOperationLogService: new AdminOperationLogService(config.adminOperationLogPath),
    getTransportHealthStatus: () => app.getPublicTransportHealthStatus(),
    getProfileAiHealthStatus: (options) => profileAiService.checkHealth(options),
    listGroupMembers: (groupId) => napcatRuntime.listGroupMembers ? napcatRuntime.listGroupMembers(groupId) : Promise.resolve([]),
  });
}

main().catch((error) => {
  logError("Application startup failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
