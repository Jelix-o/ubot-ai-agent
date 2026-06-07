import { loadConfig } from "./config.js";
import { AdminHttpServer } from "./admin-http-server.js";
import { NapCatClient } from "./napcat-client.js";
import { NapCatReverseServer } from "./napcat-reverse-server.js";
import { BotApplication } from "./bot.js";
import { AiService } from "./services/ai-service.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { ConfiguredAiService, type RuntimeAiService } from "./services/configured-ai-service.js";
import { ConfiguredTtsService } from "./services/configured-tts-service.js";
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
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { ProfileRecordStore } from "./services/profile-record-store.js";
import { ModelHealthHistoryStore } from "./services/model-health-history-store.js";
import { MIMO_TTS_BASE_URL, MIMO_TTS_MODEL, MIMO_TTS_MODEL_ID } from "./services/mimo-tts-config.js";
import { TtsService } from "./services/tts-service.js";
import { logError, logInfo } from "./logger.js";
import type { NapcatGroupMessageEvent, SystemModelConfig } from "./types.js";
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
  const systemSettingsStore = new SystemSettingsStore(config.systemSettingsPath, buildDefaultSystemModels(config));
  const runtimeReplyAiService = new ConfiguredAiService(replyAiService, systemSettingsStore, "reply");
  const runtimeProfileAiService = new ConfiguredAiService(profileAiService, systemSettingsStore, "profile");
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
  const dailyProfileReviewService = new DailyProfileReviewService(
    config.dailyProfileReviewPath,
    groupMemoryStore,
    runtimeProfileAiService,
  );
  const groupMemoryCandidateService = new GroupMemoryCandidateService(
    new GroupMemoryCandidateStore(config.groupMemoryCandidatesPath),
    groupMemoryStore,
    runtimeProfileAiService,
  );
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath);
  const skillService = new SkillService(config.skillsDir);
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath),
    runtimeReplyAiService,
  );
  const profileRecordStore = new ProfileRecordStore(config.profileRecordsPath);
  const adminTaskStore = new AdminTaskStore(config.adminTasksPath);
  const modelHealthHistoryStore = new ModelHealthHistoryStore(config.modelHealthHistoryPath);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath);
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
    new ConversationStore(config.conversationsPath),
    runtimeReplyAiService,
    runtimeTtsService,
    new DailyReportService(
      new DailyReportStore(config.dailyReportStorePath),
      runtimeReplyAiService,
    ),
    new HolidayCountdownService(
      new HolidayCountdownStore(config.holidayCountdownStorePath),
      runtimeReplyAiService,
    ),
    scheduledReminderService,
    adminOperationLogService,
    new GroupLock(),
    new LiveChatService(),
    config.botQq,
    config.ttsAllowNapCatAiFallback,
    groupMemoryStore,
    knowledgeBaseStore,
    groupMemoryCandidateService,
    dailyProfileReviewService,
    config.adminPublicBaseUrl,
    runtimeProfileAiService,
    {
      gpt: config.openAiModel,
      mimo: config.profileAiModel,
    },
    systemSettingsStore,
    profileRecordStore,
  );

  const adminHttpServer = config.adminHttpEnabled
    ? createAdminHttpServer(
        config,
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
        app,
        napcatRuntime,
        runtimeProfileAiService,
      )
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
  dailyProfileReviewService: DailyProfileReviewService,
  knowledgeBaseStore: KnowledgeBaseStore,
  scheduledReminderService: ScheduledReminderService,
  skillService: SkillService,
  systemSettingsStore: SystemSettingsStore,
  profileRecordStore: ProfileRecordStore,
  adminTaskStore: AdminTaskStore,
  modelHealthHistoryStore: ModelHealthHistoryStore,
  adminOperationLogService: AdminOperationLogService,
  app: BotApplication,
  napcatRuntime: NapCatRuntime,
  profileAiService: RuntimeAiService,
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
    getTransportHealthStatus: () => app.getPublicTransportHealthStatus(),
    getProfileAiHealthStatus: (options) => profileAiService.checkHealth(options),
    judgeMemorySemanticRelation: (args) => profileAiService.judgeMemorySemanticRelation(args),
    listGroupMembers: (groupId) => napcatRuntime.listGroupMembers ? napcatRuntime.listGroupMembers(groupId) : Promise.resolve([]),
    listGroups: () => napcatRuntime.listGroups ? napcatRuntime.listGroups() : Promise.resolve([]),
  });
}

function buildDefaultSystemModels(config: ReturnType<typeof loadConfig>): Array<Partial<SystemModelConfig> & { apiKey?: string }> {
  const now = new Date().toISOString();
  const mimoBaseUrl = "https://token-plan-cn.xiaomimimo.com/v1";
  const mimoTextModels: Array<{ id: string; model: string; label: string }> = [
    { id: "mimo-v25-pro", model: "mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
    { id: "mimo-v25", model: "mimo-v2.5", label: "MiMo V2.5 多模态" },
  ];
  const purposeLabels: Record<Exclude<SystemModelConfig["purpose"], "reply" | "tts" | "custom">, string> = {
    profile: "画像总结",
    memory: "记忆提取",
    dedup: "去重处理",
    summary: "群聊总结",
    knowledge: "知识库处理",
  };
  const builtinMimoModels = (Object.keys(purposeLabels) as Array<keyof typeof purposeLabels>).flatMap((purpose) =>
    mimoTextModels.map((item) => ({
      id: `${purpose}-${item.id}`,
      name: `${purposeLabels[purpose]} ${item.label}`,
      shortName: item.model,
      baseUrl: mimoBaseUrl,
      model: item.model,
      purpose,
      apiKey: config.profileAiApiKey,
      hasApiKey: Boolean(config.profileAiApiKey),
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }))
  );
  return [
    {
      id: "gpt",
      name: "环境回复模型",
      shortName: config.openAiModel,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
      purpose: "reply",
      apiKey: config.openAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mimo",
      name: "环境画像模型",
      shortName: config.profileAiModel,
      baseUrl: config.profileAiBaseUrl,
      model: config.profileAiModel,
      purpose: "profile",
      apiKey: config.profileAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "memory",
      name: "环境记忆提取模型",
      shortName: config.profileAiModel,
      baseUrl: config.profileAiBaseUrl,
      model: config.profileAiModel,
      purpose: "memory",
      apiKey: config.profileAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "dedup",
      name: "环境去重处理模型",
      shortName: config.profileAiModel,
      baseUrl: config.profileAiBaseUrl,
      model: config.profileAiModel,
      purpose: "dedup",
      apiKey: config.profileAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "summary",
      name: "环境群聊总结模型",
      shortName: config.openAiModel,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
      purpose: "summary",
      apiKey: config.openAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "knowledge",
      name: "环境知识库处理模型",
      shortName: config.profileAiModel,
      baseUrl: config.profileAiBaseUrl,
      model: config.profileAiModel,
      purpose: "knowledge",
      apiKey: config.profileAiApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "tts",
      name: "环境语音模型",
      shortName: config.ttsModel,
      baseUrl: config.ttsBaseUrl,
      model: config.ttsModel,
      purpose: "tts",
      apiKey: config.ttsApiKey,
      hasApiKey: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: MIMO_TTS_MODEL_ID,
      name: "MiMo V2.5 语音合成",
      shortName: MIMO_TTS_MODEL,
      baseUrl: MIMO_TTS_BASE_URL,
      model: MIMO_TTS_MODEL,
      purpose: "tts",
      apiKey: config.ttsApiKey,
      hasApiKey: Boolean(config.ttsApiKey),
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
    ...builtinMimoModels,
  ];
}

main().catch((error) => {
  logError("Application startup failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
