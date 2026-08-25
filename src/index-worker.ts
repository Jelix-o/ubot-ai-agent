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
import { AtmosphereSummarizer } from "./services/atmosphere-summarizer.js";
import { ConversationContextRepository, type ConversationRoute } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import type { ParticipationDecision } from "./services/participation-policy.js";
import { BotApplication, type MessageTransport } from "./bot.js";
import { GroupLock } from "./services/group-lock.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupConfigSqliteShadowRepository } from "./services/group-config-sqlite-shadow-repository.js";
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
import { SystemSettingsSqliteShadowRepository } from "./services/system-settings-sqlite-shadow-repository.js";
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
  private readonly contextRepository: ConversationContextRepository;
  private readonly contextRouter: ConversationContextRouter;
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
    this.contextRepository = new ConversationContextRepository(this.sharedDb);
    this.contextRouter = new ConversationContextRouter(this.contextRepository);
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
      keyOf: async (message) => {
        if (message.processable === 0) {
          return `${message.group_id}:passive`;
        }
        this.updateAtmosphere(message.group_id, message.msg_time);
        // 指令消息（# 开头）不需要 @ 也要路由处理（生产事故：群里 #对话/#clear
        // 等指令全部被当成自由发言跳过，指令不生效）。
        const isCommand = message.text.trim().startsWith("#");
        if (isCommand && !isAiConversationCommand(message.text)) {
          const decision = await this.getOrRecordParticipationDecision(message);
          this.metrics.inc(`participation_decision_${decision.action}`);
          // Commands mutate pointers/configuration and must not create a
          // conversation branch merely by being observed by the worker.
          return `${message.group_id}:command`;
        }
        const decision = await this.getOrRecordParticipationDecision(message);
        this.metrics.inc(`participation_decision_${decision.action}`);
        if (decision.action !== "reply") {
          return `${message.group_id}:passive`;
        }
        logInfo("Routed group participation decision.", {
          groupId: message.group_id,
          sourceRowId: message.id,
          action: decision.action,
          reason: decision.reason,
          score: decision.score,
          policyVersion: decision.policyVersion,
        });
        const route = this.resolveRoute(message);
        return `${message.group_id}:${route.branchId}`;
      },
      handler: async (message, done) => {
        await this.handleMessage(message, done);
      },
      pollIntervalMs: 300,
      batchSize: 50,
      maxConcurrentKeys: 8,
    });
  }

  private async handleMessage(
    message: {
      id: number;
      group_id: string;
      user_id: string;
      msg_id: string;
      msg_time: number;
      text: string;
      images_json?: string;
      sender_card?: string | null;
      sender_nickname?: string | null;
      reply_to?: string | null;
      has_at_bot?: number;
      processable?: number;
      drop_reason?: string | null;
    },
    done: () => Promise<void>,
  ): Promise<void> {
    if (message.processable === 0) {
      this.metrics.inc("dropped_message_skipped");
      logInfo("Skipped non-processable ingress message.", {
        groupId: message.group_id,
        sourceRowId: message.id,
        msgId: message.msg_id,
        reason: message.drop_reason ?? "unspecified",
      });
      await done();
      return;
    }

    // keyOf already persisted this route. Reading by source row makes retries
    // and duplicate delivery reuse the exact same result without rerouting.
    const isCommand = message.text.trim().startsWith("#") && !isAiConversationCommand(message.text);
    const participation = isCommand
      ? undefined
      : await this.getOrRecordParticipationDecision(message);
    const isRoutedConversation = participation?.action === "reply";
    if (participation) {
      this.metrics.inc(`participation_handled_${participation.action}`);
      logInfo("Handled group participation decision.", {
        groupId: message.group_id,
        sourceRowId: message.id,
        action: participation.action,
        reason: participation.reason,
        score: participation.score,
        policyVersion: participation.policyVersion,
      });
    }
    // Commands deliberately have no conversation route.
    const route = !isRoutedConversation
      ? undefined
      : this.contextRepository.getRouteBySourceRowId(message.id) ?? this.resolveRoute(message);
    const key = isCommand
      ? `${message.group_id}:command`
      : route
        ? `${message.group_id}:${route.branchId}`
        : `${message.group_id}:passive`;

    // Withdraw if the message was retracted (plan 8.1).
    if (this.sharedDb.isRetracted(message.group_id, message.msg_id)) {
      logInfo("Skipped retracted message.", { groupId: message.group_id, msgId: message.msg_id });
      await done();
      return;
    }

    if (route) {
      const discardedDrafts = this.sharedDb.discardPreparingOutboxForSource(
        route.topicId,
        route.branchId,
        route.turnId,
      );
      if (discardedDrafts > 0) {
        logInfo("Discarded unpublished outbox drafts before retry.", {
          groupId: message.group_id,
          sourceRowId: message.id,
          branchId: route.branchId,
          discardedDrafts,
        });
      }
    }

    if (route && this.contextRepository.hasAssistantReplyForTurn(route.branchId, route.turnId)) {
      logInfo("Skipped already-persisted conversation reply after worker recovery.", {
        groupId: message.group_id,
        sourceRowId: message.id,
        branchId: route.branchId,
      });
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
    let completed = false;
    try {
      const event = this.buildEvent(message);
      const controller = new AbortController();
      const cancelPoll = setInterval(() => {
        const row = this.sharedDb.getInflight(key);
        if (row?.cancel_requested) {
          controller.abort();
        }
      }, 100);
      cancelPoll.unref();

      try {
        await this.options.botApp.handleGroupMessage(event, controller.signal, route, {
          // The route alone is not authorization: the policy reason proves
          // this was a same-group reply to an acknowledged bot message.
          allowReplyWithoutMention: participation?.reason === "explicit_reply",
        });
        this.metrics.inc("tasks_completed");
        completed = true;
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
      throw error;
    } finally {
      this.inflight.end(key, task.taskId);
      // 指标 #5：per-key 队列深度峰值（计划 §6）。
      const queueDepth = this.runner.queueDepth;
      this.maxQueueDepthSeen = Math.max(this.maxQueueDepthSeen, queueDepth);
      this.metrics.setGauge("per_key_queue_depth_max", this.maxQueueDepthSeen);
      if (completed) {
        await done();
      }
    }
  }

  private resolveRoute(message: {
    id: number;
    group_id: string;
    user_id: string;
    msg_id: string;
    msg_time: number;
    text: string;
    images_json?: string;
    sender_card?: string | null;
    sender_nickname?: string | null;
    reply_to?: string | null;
  }): ConversationRoute {
    const images = parseImages(message.images_json);
    return this.contextRouter.resolve({
      sourceRowId: message.id,
      groupId: message.group_id,
      userId: message.user_id,
      sourceMessageId: message.msg_id,
      replyToMessageId: message.reply_to ?? undefined,
      text: message.text,
      hasImages: images.length > 0,
      nowMs: message.msg_time,
    });
  }

  /**
   * The decision is persisted before a message enters a per-key queue. Reusing
   * it here keeps worker retries deterministic even when group settings change
   * while a message is waiting, and makes the audit row match actual handling.
   */
  private async getOrRecordParticipationDecision(message: {
    id: number;
    group_id: string;
    user_id: string;
    text: string;
    images_json?: string;
    reply_to?: string | null;
    has_at_bot?: number;
  }): Promise<ParticipationDecision> {
    const persisted = this.sharedDb.getParticipationDecision(message.id);
    if (persisted) {
      return participationDecisionFromRow(persisted);
    }

    const replyToBot = this.sharedDb.isKnownBotMessage(message.group_id, message.reply_to);
    const decision = await this.options.botApp.getParticipationDecision(
      message.group_id,
      message.text,
      Boolean(message.has_at_bot),
      {
        hasImages: parseImages(message.images_json).length > 0,
        replyToBot,
      },
    );
    this.sharedDb.recordParticipationDecision({
      sourceRowId: message.id,
      groupId: message.group_id,
      userId: message.user_id,
      action: decision.action,
      reason: decision.reason,
      score: decision.score,
      policyVersion: decision.policyVersion,
      signals: decision.signals,
      createdAt: Date.now(),
    });
    return decision;
  }

  private updateAtmosphere(groupId: string, nowMs: number): void {
    try {
      const rows = this.sharedDb.listRecentGroupMessages(groupId, nowMs - 60 * 60 * 1_000);
      this.atmosphere.update(
        groupId,
        rows.map((row) => ({
          groupId: row.group_id,
          userId: row.user_id,
          messageId: row.msg_id,
          text: row.text || (parseImages(row.images_json).length > 0 ? "[图片消息]" : ""),
          timestamp: new Date(row.msg_time).toISOString(),
        })).filter((message) => Boolean(message.text)),
        nowMs,
      );
    } catch (error) {
      logError("Failed to update sanitized group atmosphere.", {
        groupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildEvent(message: {
    group_id: string;
    user_id: string;
    msg_id: string;
    msg_time: number;
    text: string;
    images_json?: string;
    sender_card?: string | null;
    sender_nickname?: string | null;
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
      sender: {
        user_id: Number(message.user_id),
        ...(message.sender_card ? { card: message.sender_card } : {}),
        ...(message.sender_nickname ? { nickname: message.sender_nickname } : {}),
      },
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

async function buildBotApp(
  config: ReturnType<typeof loadConfig>,
  transport: MessageTransport,
  imagePipeline?: ImagePipeline,
): Promise<BotApplication> {
  const dataDir = config.dataDir;
  const sharedDb = openSharedDb(dataDir);
  const contextRepository = new ConversationContextRepository(sharedDb);
  const replyAiService = new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel);
  const profileAiService = new AiService(config.profileAiBaseUrl, config.profileAiApiKey, config.profileAiModel);
  const groupConfigService = new GroupConfigService(
    config.groupsConfigPath,
    new GroupConfigSqliteShadowRepository(sharedDb),
  );
  await groupConfigService.syncShadowFromAuthoritative();
  const groupMemoryStore = new GroupMemoryStore(config.groupMemoryPath);
  const systemSettingsStore = new SystemSettingsStore(
    config.systemSettingsPath,
    buildDefaultSystemModels(config),
    new SystemSettingsSqliteShadowRepository(sharedDb),
  );
  await systemSettingsStore.syncShadowFromAuthoritative();
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
    contextRepository,
    new ConversationContextRouter(contextRepository),
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
      botApp: await buildBotApp(config, transport, buildImagePipeline(transport)),
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

function isAiConversationCommand(text: string): boolean {
  return /^(?:#语音(?:\s|$)|#唱歌(?:\s|$))/u.test(text.trim());
}

function parseImages(imagesJson?: string): Array<{ url?: string; file?: string; summary?: string }> {
  try {
    const value = JSON.parse(imagesJson ?? "[]") as unknown;
    return Array.isArray(value) ? value as Array<{ url?: string; file?: string; summary?: string }> : [];
  } catch {
    return [];
  }
}

function participationDecisionFromRow(row: {
  action: string;
  reason: string;
  score: number;
  policy_version: string;
  signals_json: string;
}): ParticipationDecision {
  return {
    action: row.action as ParticipationDecision["action"],
    reason: row.reason as ParticipationDecision["reason"],
    score: row.score,
    policyVersion: row.policy_version,
    signals: parseParticipationSignals(row.signals_json),
  };
}

function parseParticipationSignals(value: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}
