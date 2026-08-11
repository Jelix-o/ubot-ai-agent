import { loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { openSharedDb, type SharedDb } from "./shared/sqlite.js";
import { Metrics } from "./shared/metrics.js";
import { ConsumerRunner } from "./shared/consumer-runner.js";
import { WorkerTransport } from "./worker-transport.js";
import { IngressReadApiClient } from "./ingress-read-api.js";
import { InflightManager } from "./services/inflight-manager.js";
import { LlmSemaphore } from "./services/llm-semaphore.js";
import { CircuitOpenError, degradedMessage, GatewayProxy } from "./services/gateway-proxy.js";
import { TopicRouter } from "./services/topic-router.js";
import { AtmosphereSummarizer } from "./services/atmosphere-summarizer.js";
import { BotApplication, type MessageTransport } from "./bot.js";
import { GroupLock } from "./services/group-lock.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { SkillService } from "./services/skill-service.js";
import { ConversationStore } from "./services/conversation-store.js";
import { AiService } from "./services/ai-service.js";
import { ConfiguredAiService } from "./services/configured-ai-service.js";
import { TtsService } from "./services/tts-service.js";
import { ConfiguredTtsService } from "./services/configured-tts-service.js";
import { DailyReportService } from "./services/daily-report-service.js";
import { DailyReportStore } from "./services/daily-report-store.js";
import { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import { HolidayCountdownStore } from "./services/holiday-countdown-store.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./services/group-memory-candidate-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { DailyProfileReviewService } from "./services/daily-profile-review-service.js";
import { ProfileRecordStore } from "./services/profile-record-store.js";
import { GroupTranscriptService } from "./services/group-transcript-service.js";
import { RealtimeLookupService } from "./services/realtime-lookup-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { ImagePipeline } from "./services/image-pipeline.js";
import { buildDefaultSystemModels } from "./system-model-defaults.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import type { AiReply, NapcatGroupMessageEvent } from "./types.js";

/**
 * Worker process (plan section 1):
 *   - Polls the shared `messages` table per key.
 *   - Assigns (group, user, topic) triples and runs the BotApplication logic
 *     with true cancellation + in-flight merge semantics.
 *   - Enqueues replies into the outbox; the ingress process delivers them.
 */
export class WorkerApp {
  private readonly sharedDb: SharedDb;
  private readonly metrics: Metrics;
  private readonly inflight: InflightManager;
  private readonly semaphore = new LlmSemaphore(8, 2_000);
  private readonly topicRouter: TopicRouter;
  private readonly atmosphere: AtmosphereSummarizer;
  private readonly runner: ConsumerRunner;
  private readonly gateway: GatewayProxy;
  private maxQueueDepthSeen = 0;
  readonly llmGate: (task: () => Promise<AiReply>, signal?: AbortSignal) => Promise<AiReply>;

  constructor(
    private readonly options: {
      dataDir: string;
      botApp: BotApplication;
      consumerKey: string;
    },
    private readonly transport: MessageTransport,
  ) {
    this.sharedDb = openSharedDb(this.options.dataDir);
    this.metrics = new Metrics(`${this.options.dataDir}/shared/metrics`, {
      processName: "worker",
      flushIntervalMs: 30_000,
    });
    this.inflight = new InflightManager(this.sharedDb);
    this.topicRouter = new TopicRouter(this.options.dataDir);
    this.atmosphere = new AtmosphereSummarizer(this.options.dataDir);
    this.gateway = new GatewayProxy(undefined, this.metrics, {
      tripAfterFailures: 5,
      slowThresholdMs: 40_000,
      openMs: 30_000,
    });
    this.llmGate = async (task) => {
      let release: (() => void) | undefined;
      try {
        release = await this.semaphore.acquire();
        this.metrics.inc("llm_semaphore_acquired");
      } catch {
        this.metrics.inc("llm_semaphore_timeout");
        return degradedReply("llm_semaphore_timeout", this.options.botApp.getBotQq());
      }
      try {
        return await this.gateway.call<AiReply>(async () => task());
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          return degradedReply("circuit_open", this.options.botApp.getBotQq());
        }
        throw error;
      } finally {
        release();
      }
    };

    this.runner = new ConsumerRunner(this.sharedDb, this.options.consumerKey, {
      keyOf: (message) => {
        // 指令消息（# 开头）不需要 @ 也要路由处理（生产事故：群里 #对话/#clear
        // 等指令全部被当成自由发言跳过，指令不生效）。
        const isCommand = message.text.trim().startsWith("#");
        if (!message.has_at_bot && !isCommand) {
          // Free chat never produces a topic (plan 5.1.3); skip for now.
          return "";
        }
        // Topic assignment must be stable for the same conversation; compute it
        // here so both the key and the handler agree on one topic.
        const replyTopicId = message.reply_to ? this.replyTopicIndex.get(message.reply_to) : undefined;
        const assignment = this.topicRouter.assignTopic({
          groupId: message.group_id,
          userId: message.user_id,
          text: message.text,
          replyToMessageId: message.reply_to ?? undefined,
          replyToTopicId: replyTopicId,
        });
        if (message.reply_to) {
          this.replyTopicIndex.set(message.reply_to, assignment.topicId);
        }
        return `${message.group_id}:${message.user_id}:${assignment.topicId}`;
      },
      handler: async (message, done) => {
        await this.handleMessage(message, done);
      },
      pollIntervalMs: 300,
      batchSize: 50,
      maxConcurrentKeys: 8,
    });
  }

  /** msg_id → topic_id for reply-chain inheritance (plan 5.1.1). */
  private readonly replyTopicIndex = new Map<string, string>();

  private async handleMessage(
    message: {
      id: number;
      group_id: string;
      user_id: string;
      msg_id: string;
      msg_time: number;
      text: string;
      images_json?: string;
      reply_to?: string | null;
      has_at_bot?: number;
    },
    done: () => Promise<void>,
  ): Promise<void> {
    const replyTopicId = message.reply_to ? this.replyTopicIndex.get(message.reply_to) : undefined;
    const assignment = this.topicRouter.assignTopic({
      groupId: message.group_id,
      userId: message.user_id,
      text: message.text,
      replyToMessageId: message.reply_to ?? undefined,
      replyToTopicId: replyTopicId,
    });
    if (message.reply_to) {
      this.replyTopicIndex.set(message.reply_to, assignment.topicId);
    }
    const key = `${message.group_id}:${message.user_id}:${assignment.topicId}`;

    // Withdraw if the message was retracted (plan 8.1).
    if (this.sharedDb.isRetracted(message.group_id, message.msg_id)) {
      logInfo("Skipped retracted message.", { groupId: message.group_id, msgId: message.msg_id });
      await done();
      return;
    }

    // In-flight merge semantics (plan 2.3): only applies when a task for this
    // key is ALREADY running; the first message always proceeds.
    const existingInflight = this.sharedDb.getInflight(key);
    if (existingInflight) {
      const decision = this.inflight.decideNewMessage(key, message.text, Date.now());
      if (decision.action === "drop") {
        this.metrics.inc("duplicate_trigger_dropped");
        logInfo("Dropped duplicate-triggering message.", { key, msgId: message.msg_id });
        await done();
        return;
      }
      if (decision.reason === "cancel_and_rerun") {
        // 旧任务被取消（>20s 无响应），新消息续跑；旧任务的失败话术被
        // cancelledReplyHook 抑制，不会与新回复一起冒出来。
        this.metrics.inc("cancelled_task");
        logInfo("Rerunning key with merged follow-up message.", { key, msgId: message.msg_id });
      }
    }

    const taskStartedAt = Date.now();
    const task = this.inflight.begin(key);
    this.metrics.inc("tasks_started");
    try {
      const event = this.buildEvent(message);
      // 只有 @bot 或指令（#开头）消息才处理；自由发言跳过（计划 §5.1.3）。
      const parsed = parseGroupMessage(event.message, this.options.botApp.getBotQq());
      const isCommand = parsed.text.trim().startsWith("#");
      if (!parsed.hasAtBot && !isCommand) {
        await done();
        return;
      }

      const controller = new AbortController();
      const cancelPoll = setInterval(() => {
        const row = this.sharedDb.getInflight(key);
        if (row?.cancel_requested) {
          controller.abort();
        }
      }, 100);
      cancelPoll.unref();

      try {
        await this.options.botApp.handleGroupMessage(event, controller.signal);
        this.metrics.inc("tasks_completed");
        // 指标 #4：端到端回复延迟 p95（计划 §6）。
        this.metrics.observeLatency("end_to_end_reply", Date.now() - taskStartedAt);
      } finally {
        clearInterval(cancelPoll);
      }
    } catch (error) {
      logError("Worker message handling failed.", {
        key,
        msgId: message.msg_id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.metrics.inc("tasks_failed");
    } finally {
      this.inflight.end(key);
      // 指标 #5：per-key 队列深度峰值（计划 §6）。
      const queueDepth = this.runner.queueDepth;
      this.maxQueueDepthSeen = Math.max(this.maxQueueDepthSeen, queueDepth);
      this.metrics.setGauge("per_key_queue_depth_max", this.maxQueueDepthSeen);
      await done();
    }
  }

  private buildEvent(message: {
    group_id: string;
    user_id: string;
    msg_id: string;
    msg_time: number;
    text: string;
    images_json?: string;
    reply_to?: string | null;
    has_at_bot?: number;
  }): NapcatGroupMessageEvent {
    const images = JSON.parse(message.images_json ?? "[]") as Array<{ url?: string; file?: string; summary?: string }>;
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    if (message.reply_to) {
      segments.push({ type: "reply", data: { id: message.reply_to } });
    }
    if (message.has_at_bot) {
      segments.push({ type: "at", data: { qq: this.options.botApp.getBotQq() } });
    }
    if (message.text) {
      segments.push({ type: "text", data: { text: message.text } });
    }
    for (const image of images) {
      const data: Record<string, string> = {};
      if (image.url) {
        data.url = image.url;
      }
      if (image.file) {
        data.file = image.file;
      }
      if (image.summary) {
        data.summary = image.summary;
      }
      segments.push({ type: "image", data });
    }
    return {
      post_type: "message",
      message_type: "group",
      self_id: Number(this.options.botApp.getBotQq()),
      group_id: Number(message.group_id),
      user_id: Number(message.user_id),
      message_id: Number(message.msg_id),
      time: Math.floor(message.msg_time / 1000),
      raw_message: message.text,
      message: segments,
    };
  }

  start(): void {
    // 清表兜底：水位超过 messages 最大 id 时重置（生产事故根因之一）。
    this.sharedDb.resetWatermarkIfStale(this.options.consumerKey);
    logInfo("Worker started.", {
      consumerKey: this.options.consumerKey,
      dataDir: this.options.dataDir,
    });
  }

  get botApp(): BotApplication {
    return this.options.botApp;
  }

  async stop(): Promise<void> {
    this.runner.stop();
    this.metrics.stop();
    this.sharedDb.close();
  }
}

function buildBotApp(
  config: ReturnType<typeof loadConfig>,
  transport: MessageTransport,
  imagePipeline?: ImagePipeline,
): BotApplication {
  const dataDir = config.dataDir;
  const sharedDb = openSharedDb(dataDir);
  const replyAiService = new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel);
  const profileAiService = new AiService(config.profileAiBaseUrl, config.profileAiApiKey, config.profileAiModel);
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
    8,
    systemSettingsStore,
  );
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath);
  const skillService = new SkillService(config.skillsDir);
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath),
    runtimeReplyAiService,
  );
  const profileRecordStore = new ProfileRecordStore(config.profileRecordsPath);
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath);
  const atmosphere = new AtmosphereSummarizer(dataDir);

  return new BotApplication(
    transport,
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
    new RealtimeLookupService({ searchUrl: config.realtimeSearchUrl }),
    new GroupTranscriptService(),
    atmosphere,
    undefined,
    imagePipeline,
    () => {
      // The worker counts cancelled tasks via its own metrics instance; this
      // hook is invoked by the bot when a cancelled task suppresses its reply.
    },
    false, // worker 不发送启动运维告警（多进程下由 ingress 感知连接状态）
  );
}

/** Stage-1 image localization pipeline; NapCat get_image is the localize callback (plan §4). */
function buildImagePipeline(transport: MessageTransport): ImagePipeline {
  return new ImagePipeline({
    localizeDataUrl: (image) => {
      if (!transport.resolveImageInputs) {
        return Promise.resolve(undefined);
      }
      return transport.resolveImageInputs([image]).then((resolved) => {
        const first = resolved[0];
        return first && typeof first.url === "string" && first.url.startsWith("data:")
          ? first.url
          : undefined;
      });
    },
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const readClient = new IngressReadApiClient(`http://127.0.0.1:${config.ingressReadApiPort}`);
  const sharedDb = openSharedDb(config.dataDir);
  const transport = new WorkerTransport(sharedDb, {
    resolveImageInputs: (images) => readClient.resolveImages(images),
    listGroupMembers: (groupId) => readClient.listGroupMembers(groupId),
    listGroups: () => readClient.listGroups(),
    resolveMentionTargets: (groupId, candidates) => readClient.resolveMentionTargets(groupId, candidates),
    resolveMemberIdentities: (groupId, candidates) => readClient.resolveMemberIdentities(groupId, candidates),
    getMessage: (messageId) => readClient.getMessage(messageId),
  });
  const app = new WorkerApp(
    {
      dataDir: config.dataDir,
      botApp: buildBotApp(config, transport, buildImagePipeline(transport)),
      consumerKey: "worker:main",
    },
    transport,
  );
  // Wire the semaphore+breaker gate into the bot's LLM call path.
  const botApp = app.botApp;
  botApp.setLlmGate(app.llmGate);

  botApp.start();
  app.start();

  const shutdown = async () => {
    logInfo("Worker shutting down...");
    await botApp.stop();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("index-worker")) {
  void main().catch((error) => {
    logError("Worker startup failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

/** Builds a degraded AiReply from a fixed tier wording (plan §2.5). */
function degradedReply(tier: string, botQq: string): AiReply {
  return {
    text: degradedMessage(tier),
    model: "degraded",
    skillId: "degraded",
    promptChars: 0,
  };
}
