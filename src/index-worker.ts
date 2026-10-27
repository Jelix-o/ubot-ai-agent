import { GroupInteractionService } from "./services/group-interaction-service.js";
import { ModelTelemetryStore, setModelTelemetryStore } from "./services/model-telemetry.js";
import { BtSearchService } from "./services/bt-search-service.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { logError, logInfo, logWarn } from "./logger.js";
import { openSharedDb, type SharedDb } from "./shared/sqlite.js";
import { Metrics } from "./shared/metrics.js";
import { observeReplyArtifacts } from "./services/reply-artifacts.js";
import { ConsumerRunner } from "./shared/consumer-runner.js";
import { WorkerTransport } from "./worker-transport.js";
import { IngressReadApiClient } from "./ingress-read-api.js";
import { InflightManager } from "./services/inflight-manager.js";
import { LlmSemaphore } from "./services/llm-semaphore.js";
import { CircuitOpenError, degradedMessage } from "./services/gateway-proxy.js";
import { AtmosphereSummarizer } from "./services/atmosphere-summarizer.js";
import { ConversationContextRepository, type ConversationRoute } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import type { ParticipationDecision } from "./services/participation-policy.js";
import { BotApplication, type BackgroundLlmGate, type MessageTransport } from "./bot.js";
import { GroupLock } from "./services/group-lock.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupConfigSqliteShadowRepository } from "./services/group-config-sqlite-shadow-repository.js";
import { ConversationStore } from "./services/conversation-store.js";
import { SqliteConversationStore } from "./services/conversation-store-v3.js";
import { AiService } from "./services/ai-service.js";
import { ConfiguredAiService } from "./services/configured-ai-service.js";
import { DailyReportService } from "./services/daily-report-service.js";
import { DailyReportStore } from "./services/daily-report-store.js";
import { HolidayCountdownService } from "./services/holiday-countdown-service.js";
import { HolidayCountdownStore } from "./services/holiday-countdown-store.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { KnowledgeSourceBindingStore } from "./services/knowledge-source-binding-store.js";
import { loadPrivateEnterpriseRanking } from "./services/private-enterprise-ranking.js";
import { GroupTranscriptService } from "./services/group-transcript-service.js";
import { RealtimeLookupService } from "./services/realtime-lookup-service.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { SystemSettingsSqliteShadowRepository } from "./services/system-settings-sqlite-shadow-repository.js";
import { ImagePipeline } from "./services/image-pipeline.js";
import { CharacterProfileService } from "./services/character-profile-service.js";
import { V3CapabilityPolicyService } from "./services/capability-policy-service.js";
import { resolveV3RuntimeState } from "./services/v3-runtime-state.js";
import { SkillService } from "./services/skill-service.js";
import { HtmlPreviewService } from "./services/html-preview-service.js";
import { QqAdminAuthorizationService } from "./services/qq-admin-authorization-service.js";
import { RecentGroupEvidenceService } from "./services/recent-group-evidence-service.js";
import { MemeLibraryService } from "./services/meme-library-service.js";
import { ConfiguredImageGenerationService } from "./services/image-generation-service.js";
import { ImagePreviewArchiveService } from "./services/image-preview-archive-service.js";
import { ImageRequestRepository, type ImageRequestStatus } from "./services/image-request-repository.js";
import { QqAvatarReferenceService } from "./services/qq-avatar-reference-service.js";
import {
  ImageIntentRouteRepository,
  type ImageIntentRouteRecord,
} from "./services/image-intent-route-repository.js";
import {
  ImageIntentRouterError,
  ImageIntentRouterPlugin,
  type ImageIntentRouter,
} from "./services/image-intent-router-plugin.js";
import type { NaturalImageRequest } from "./services/natural-image-request.js";
import { ImageGenerationConfirmationRepository } from "./services/image-generation-confirmation-repository.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import { buildDefaultSystemModels } from "./system-model-defaults.js";
import {
  rebuildLegacyGroupMessageSegments,
  restoreCanonicalMessageSegments,
} from "./utils/persisted-message-segments.js";
import type { AiReply, NapcatGroupMessageEvent } from "./types.js";

interface NaturalImageRouteBase {
  event: NapcatGroupMessageEvent;
  hasTrustedBotMention: boolean;
  hasTrustedReply: boolean;
  replyIsGeneratedImage: boolean;
}

type NaturalImageRoute = NaturalImageRouteBase & (
  | { kind: "image"; request: Exclude<NaturalImageRequest, { kind: "clarification" }> }
  | { kind: "clarification"; request: Extract<NaturalImageRequest, { kind: "clarification" }> }
  | { kind: "chat" }
  | { kind: "pending" }
);

class ImageIntentRoutePendingError extends Error {
  constructor() {
    super("image_intent_route_pending");
    this.name = "ImageIntentRoutePendingError";
  }
}

/**
 * A classifier lease can expire while the background LLM semaphore is busy.
 * It is crucial that an expired owner never dispatches a late tool call: a
 * replay may already have terminalized the route as result_unknown.
 */
class ImageIntentRouteLeaseLostError extends Error {
  constructor() {
    super("image_intent_route_lease_lost");
    this.name = "ImageIntentRouteLeaseLostError";
  }
}

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
  private readonly stopArtifactObservation: () => void;
  private readonly inflight: InflightManager;
  private readonly semaphore = new LlmSemaphore(8, 2_000);
  private readonly contextRepository: ConversationContextRepository;
  private readonly contextRouter: ConversationContextRouter;
  private readonly atmosphere: AtmosphereSummarizer;
  private readonly imageRequests: ImageRequestRepository;
  private readonly imageIntentRoutes: ImageIntentRouteRepository;
  private readonly runner: ConsumerRunner;
  private maxQueueDepthSeen = 0;
  readonly llmGate: (task: () => Promise<AiReply>, signal?: AbortSignal) => Promise<AiReply>;
  readonly backgroundLlmGate: BackgroundLlmGate;

  constructor(
    private readonly options: {
      dataDir: string;
      sharedDb: SharedDb;
      botApp: BotApplication;
      consumerKey: string;
      isBlacklistedUser: (groupId: string, userId: string) => Promise<boolean>;
      stateEncryptionKey?: string;
      imageIntentRouter?: ImageIntentRouter;
      /** Internal test/operations override; production uses the repository default. */
      imageIntentRouteLeaseMs?: number;
    },
  ) {
    this.sharedDb = this.options.sharedDb;
    this.metrics = new Metrics(`${this.options.dataDir}/shared/metrics`, {
      processName: "worker",
      flushIntervalMs: 30_000,
    });
    this.stopArtifactObservation = observeReplyArtifacts(metric => this.metrics.inc(metric));
    this.inflight = new InflightManager(this.sharedDb);
    this.contextRepository = new ConversationContextRepository(this.sharedDb);
    this.contextRouter = new ConversationContextRouter(this.contextRepository);
    this.imageRequests = new ImageRequestRepository(this.sharedDb);
    this.imageIntentRoutes = new ImageIntentRouteRepository(this.sharedDb);
    const v3State = resolveV3RuntimeState(this.sharedDb, this.options.stateEncryptionKey);
    v3State?.retireRoastModeForExistingGroupsOnce();
    this.atmosphere = new AtmosphereSummarizer(
      this.options.dataDir,
      {},
      v3State,
    );
    this.backgroundLlmGate = async <T>(task: () => Promise<T>, signal?: AbortSignal) => {
      let release: (() => void) | undefined;
      try {
        release = await this.semaphore.acquire(signal);
        this.metrics.inc("llm_semaphore_acquired");
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        this.metrics.inc("llm_semaphore_timeout");
        throw new Error("llm_semaphore_timeout");
      }
      try {
        signal?.throwIfAborted();
        return await task();
      } finally {
        release();
      }
    };
    this.llmGate = async (task, signal) => {
      try {
        return await this.backgroundLlmGate(task, signal);
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          return degradedReply("circuit_open");
        }
        if (error instanceof Error && error.message === "llm_semaphore_timeout") {
          return degradedReply("llm_semaphore_timeout");
        }
        throw error;
      }
    };

    this.runner = new ConsumerRunner(this.sharedDb, this.options.consumerKey, {
      keyOf: async (message) => {
        if (message.processable === 0) {
          return `${message.group_id}:passive`;
        }
        // A recall can arrive after ingress persisted the message but before
        // queue selection. Do not send recalled content to the intent model
        // (or any other routing decision) just because the handler's later
        // terminal check has not run yet.
        if (this.sharedDb.isRetracted(message.group_id, message.msg_id)) {
          return `${message.group_id}:retracted`;
        }
        // Blacklisted messages must not create a participation audit or a
        // conversation route. BotApplication still owns command precedence,
        // daily-report recording, and the fixed image response.
        if (await this.isBlacklistedMessage(message)) {
          return `${message.group_id}:blacklisted`;
        }
        if (await this.options.botApp.getBtCommand(message.text)) {
          await this.getOrRecordParticipationDecision(message);
          // Each request reaches the bounded global search queue immediately.
          return `${message.group_id}:bt-search:${message.id}`;
        }
        this.updateAtmosphere(message.group_id, message.msg_time);
        const previewRequest = await this.options.botApp.getHtmlPreviewRequest(
          message.text,
          Boolean(message.has_at_bot),
        );
        if (previewRequest) {
          return `${message.group_id}:html-preview`;
        }
        // Queue selection must stay local and bounded. A candidate gets an
        // intent lane first; its remote classifier call happens only once the
        // lane is dispatched, then handoffs to the final execution key.
        const naturalImageRoute = await this.getNaturalImageRoute(message, { classify: false });
        if (naturalImageRoute?.kind === "image") {
          // Natural image requests use a separate group/member queue. This
          // preserves a member's one-at-a-time image work without holding up
          // unrelated group conversation or another member's request.
          return `${message.group_id}:image:${message.user_id}`;
        }
        if (naturalImageRoute?.kind === "pending") {
          return `${message.group_id}:image-intent:${message.user_id}`;
        }
        if (naturalImageRoute?.kind === "clarification") {
          return `${message.group_id}:image-intent-clarification:${message.id}`;
        }
        // A bare real @bot has no request to process. Do not create a
        // participation decision, a chat turn, or an image usage hint.
        if (!message.text.trim() && parseImages(message.images_json).length === 0) {
          return `${message.group_id}:passive`;
        }
        if (await this.isImageGenerationCommand(message.text)) {
          // Explicit #生图/#改图 requests share the same per-member image
          // queue as natural requests. This also makes their durable request
          // ledger source row available before an upstream call.
          return `${message.group_id}:image:${message.user_id}`;
        }
        // 指令消息（# 开头）不需要 @ 也要路由处理（生产事故：群里 #对话/#clear
        // 等指令全部被当成自由发言跳过，指令不生效）。
        const isCommand = await this.options.botApp.isSystemCommand(message.text);
        if (isCommand) {
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
        const route = await this.resolveRoute(message);
        return `${message.group_id}:${route.branchId}`;
      },
      handler: async (message, done, handoff, currentKey) => {
        await this.handleMessage(message, done, handoff, currentKey);
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
      canonical_segments_json?: string | null;
      has_at_bot?: number;
      processable?: number;
      drop_reason?: string | null;
    },
    done: () => Promise<void>,
    handoff: (targetKey: string) => Promise<void>,
    currentKey: string,
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

    // A retracted message is terminal before any per-message side effect,
    // including the blacklist fast path.
    if (this.sharedDb.isRetracted(message.group_id, message.msg_id)) {
      logInfo("Skipped retracted message.", { groupId: message.group_id, msgId: message.msg_id });
      await done();
      return;
    }

    if (await this.isBlacklistedMessage(message)) {
      const taskStartedAt = Date.now();
      try {
        await this.options.botApp.handleGroupMessage(this.buildEvent(message));
        this.metrics.inc("tasks_completed");
        this.metrics.observeLatency("end_to_end_reply", Date.now() - taskStartedAt);
        await done();
      } catch (error) {
        logError("Worker blacklisted message handling failed.", {
          groupId: message.group_id,
          msgId: message.msg_id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.metrics.inc("tasks_failed");
        throw error;
      } finally {
        const queueDepth = this.runner.queueDepth;
        this.maxQueueDepthSeen = Math.max(this.maxQueueDepthSeen, queueDepth);
        this.metrics.setGauge("per_key_queue_depth_max", this.maxQueueDepthSeen);
      }
      return;
    }

    // Preflight only chooses a bounded staging lane. This handler claims the
    // route once; later attempts read the durable source-row result instead of
    // rerouting or submitting a second classifier call.
    const previewRequest = await this.options.botApp.getHtmlPreviewRequest(
      message.text,
      Boolean(message.has_at_bot),
    );
    const isPreview = Boolean(previewRequest);
    const naturalImageRoute = await this.getNaturalImageRoute(message);
    if (naturalImageRoute?.kind === "pending") {
      this.metrics.inc("image_intent_router_pending");
      throw new ImageIntentRoutePendingError();
    }
    const isNaturalImage = naturalImageRoute?.kind === "image";
    const isNaturalClarification = naturalImageRoute?.kind === "clarification";
    const isNaturalRequest = isNaturalImage || isNaturalClarification;
    if (!isNaturalRequest && !message.text.trim() && parseImages(message.images_json).length === 0) {
      await done();
      return;
    }
    const isImageCommand = await this.isImageGenerationCommand(message.text);
    const isImageRequest = isNaturalImage || isImageCommand;
    // This is a status-only lookup. It lets metrics distinguish a replay from
    // a first submission without recording a prompt or any member metadata.
    const hadExistingImageRequest = isImageRequest && this.hasImageRequest(
      message.group_id,
      message.msg_id,
    );
    const isBt = Boolean(await this.options.botApp.getBtCommand(message.text));
    const isCommand = await this.options.botApp.isSystemCommand(message.text);
    const participation = isCommand || isPreview || isNaturalRequest || isImageCommand
      ? undefined
      : await this.getOrRecordParticipationDecision(message);
    const isRoutedConversation = participation?.action === "reply";
    // Commands deliberately have no conversation route.
    const route = !isRoutedConversation
      ? undefined
      : this.contextRepository.getRouteBySourceRowId(message.id) ?? await this.resolveRoute(message);
    const key = isBt
      ? `${message.group_id}:bt-search:${message.id}`
      : isPreview
      ? `${message.group_id}:html-preview`
      : isNaturalImage
        ? `${message.group_id}:image:${message.user_id}`
      : isNaturalClarification
        ? `${message.group_id}:image-intent-clarification:${message.id}`
      : isImageCommand
        ? `${message.group_id}:image:${message.user_id}`
      : isCommand
        ? `${message.group_id}:command`
      : route
        ? `${message.group_id}:${route.branchId}`
        : `${message.group_id}:passive`;

    // A natural candidate began in the dedicated intent lane so key selection
    // never waits for the routing model. Once its durable action is known,
    // move the same uncompleted source row to the real execution lane.
    if (currentKey !== key) {
      await handoff(key);
      return;
    }

    if (isNaturalRequest) this.metrics.inc("natural_image_request_matched");
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

    if (isPreview || isImageRequest || isNaturalClarification) {
      // ConsumerRunner owns strict serial execution for this key. Do not put
      // image or preview work in InflightManager: its conversation-oriented
      // cancel and merge rules would violate image publication semantics.
      const taskStartedAt = Date.now();
      try {
        await this.options.botApp.handleGroupMessage(
          naturalImageRoute?.kind === "image" || naturalImageRoute?.kind === "clarification"
            ? naturalImageRoute.event
            : this.buildEvent(message),
          undefined,
          undefined,
          naturalImageRoute?.kind === "image" || naturalImageRoute?.kind === "clarification"
            ? {
                ...(naturalImageRoute.kind === "image" ? { imageRequestSourceRowId: message.id } : {}),
                hasTrustedBotMention: naturalImageRoute.hasTrustedBotMention,
                hasTrustedReply: naturalImageRoute.hasTrustedReply,
                replyIsGeneratedImage: naturalImageRoute.replyIsGeneratedImage,
                naturalImageRequest: naturalImageRoute.request,
                naturalImageRoutingDecided: true,
              }
            : isImageCommand
              ? { imageRequestSourceRowId: message.id }
            : undefined,
        );
        if (isNaturalRequest) this.metrics.inc("natural_image_request_handled");
        this.metrics.inc("tasks_completed");
        this.metrics.observeLatency("end_to_end_reply", Date.now() - taskStartedAt);
        await done();
      } catch (error) {
        logError(
          isNaturalRequest
            ? "Worker natural image handling failed."
            : isImageCommand
              ? "Worker image command handling failed."
              : "Worker HTML preview handling failed.",
          {
            key,
            msgId: message.msg_id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        this.metrics.inc("tasks_failed");
        throw error;
      } finally {
        if (isImageRequest) {
          this.recordImageRequestMetrics({
            isNaturalImage,
            hadExistingImageRequest,
            groupId: message.group_id,
            sourceMessageId: message.msg_id,
          });
        }
        const queueDepth = this.runner.queueDepth;
        this.maxQueueDepthSeen = Math.max(this.maxQueueDepthSeen, queueDepth);
        this.metrics.setGauge("per_key_queue_depth_max", this.maxQueueDepthSeen);
      }
      return;
    }

    if (route && !this.contextRepository.orchestration.isTaskCurrent(message.id)) {
      this.metrics.inc("superseded_task_skipped");
      await done();
      return;
    }

    const taskStartedAt = Date.now();
    const task = this.inflight.begin(key);
    if (route) this.contextRepository.orchestration.setTaskStatus(message.id, "running");
    this.metrics.inc("tasks_started");
    let completed = false;
    try {
      const event = this.buildEvent(message);
      const controller = new AbortController();
      const cancelPoll = setInterval(() => {
        const row = this.sharedDb.getInflight(key);
        if (row?.cancel_requested || (route && !this.contextRepository.orchestration.isTaskCurrent(message.id))) {
          controller.abort();
        }
      }, 100);
      cancelPoll.unref();

      try {
        await this.options.botApp.handleGroupMessage(event, controller.signal, route, {
          // The route alone is not authorization: the policy reason proves
          // this was a same-group reply to an acknowledged bot message.
          allowReplyWithoutMention: participation?.reason === "explicit_reply" ||
            participation?.reason === "explicit_memory_request" || participation?.reason === "directed_follow_up",
          // A configured intent router has already chosen ordinary chat for
          // this message. Do not let BotApplication's legacy regex parser
          // reinterpret it as an image request on the way to the chat path.
          ...(naturalImageRoute?.kind === "chat" ? { naturalImageRoutingDecided: true } : {}),
        });
        if (naturalImageRoute?.kind === "chat" && this.imageIntentRoutes.getBySourceRow(message.id)?.action === "clarification") {
          this.metrics.inc("image_intent_router_clarification_to_chat");
        }
        this.metrics.inc("tasks_completed");
        completed = true;
        if (route) this.contextRepository.orchestration.setTaskStatus(message.id, "awaiting_delivery");
        // 指标 #4：端到端回复延迟 p95（计划 §6）。
        this.metrics.observeLatency("end_to_end_reply", Date.now() - taskStartedAt);
      } finally {
        clearInterval(cancelPoll);
      }
    } catch (error) {
      if (route) this.contextRepository.orchestration.setTaskStatus(message.id, "failed");
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

  /**
   * Natural image text is never authorized by the normalized text column or
   * legacy `has_at_bot` flag. A real bot mention must survive as a canonical
   * platform segment. Continuous edits are separately authorized by a live
   * generated-image receipt in the same group.
   */
  private async getNaturalImageRoute(message: {
    id: number;
    group_id: string;
    user_id: string;
    msg_id: string;
    msg_time: number;
    text: string;
    images_json?: string;
    sender_card?: string | null;
    sender_nickname?: string | null;
    sender_role?: string | null;
    reply_to?: string | null;
    verified_mention_user_ids_json?: string;
    canonical_segments_json?: string | null;
    has_at_bot?: number;
  }, options: { classify?: boolean } = {}): Promise<NaturalImageRoute | undefined> {
    if (!message.text.trim() && parseImages(message.images_json).length === 0) return undefined;
    // Explicit #生图 / #改图 retain their established command path. They
    // must never spend an intent-classification request or inherit a model
    // choice from this optional natural-language plugin.
    if (await this.isImageGenerationCommand(message.text) || await this.options.botApp.isSystemCommand(message.text)) {
      return undefined;
    }

    const event = this.buildEvent(message);
    const canonicalSegments = restoreCanonicalMessageSegments(message.canonical_segments_json);
    const hasTrustedBotMention = Boolean(canonicalSegments?.some((segment) =>
      typeof segment !== "string" &&
      segment.type === "at" &&
      String(segment.data?.qq ?? "").trim() === this.options.botApp.getBotQq(),
    ));
    // A legacy `reply_to` has no ordered segment provenance. Do not let it
    // authorize a continuous natural edit; current ingress rows always carry
    // this matching structured reply segment.
    const hasTrustedReply = Boolean(
      message.reply_to && canonicalSegments?.some((segment) =>
        typeof segment !== "string" &&
        segment.type === "reply" &&
        String(segment.data?.id ?? "").trim() === message.reply_to,
      ),
    );
    const replyIsGeneratedImage = hasTrustedReply && this.isAvailableGeneratedImageReply(
      message.group_id,
      message.reply_to,
    );
    if (!hasTrustedBotMention && !replyIsGeneratedImage) return undefined;

    const routingEnabled = this.options.botApp.isNaturalImageRoutingEnabled
      ? await this.options.botApp.isNaturalImageRoutingEnabled(message.group_id)
      : true;
    if (!routingEnabled) return undefined;

    const base: NaturalImageRouteBase = {
      event,
      hasTrustedBotMention,
      hasTrustedReply,
      replyIsGeneratedImage,
    };

    if (this.options.botApp.canRouteNaturalImageRequest && !await this.options.botApp.canRouteNaturalImageRequest(event)) {
      return { ...base, kind: "chat" };
    }
    if (hasTrustedBotMention && /^确认生成[。！!]?$/u.test(parseGroupMessage(event.message, this.options.botApp.getBotQq()).text.trim())) {
      if (this.options.imageIntentRouter && !await this.options.imageIntentRouter.isConfigured()) return { ...base, kind: "chat" };
      const originalId = new ImageGenerationConfirmationRepository(this.sharedDb).confirm(message.id);
      const original = originalId === undefined ? undefined : this.sharedDb.db.prepare("SELECT * FROM messages WHERE id = ?")
        .get(originalId) as typeof message | undefined;
      if (original && !this.sharedDb.isRetracted(original.group_id, original.msg_id)) {
        const request = await this.options.botApp.getNaturalImageRequestForIntent(this.buildEvent(original),
          { hasTrustedBotMention: true, hasTrustedReply: false, replyIsGeneratedImage: false }, "generate");
        if (request?.kind === "generate") {
          return { ...base, kind: "image", request: { ...request, requiresConfirmation: false } };
        }
      }
      return { ...base, kind: "clarification", request: { kind: "clarification", reason: "confirmation_expired" } };
    }

    const router = this.options.imageIntentRouter;
    if (!router) {
      // Compatibility for focused tests and older embedders that do not wire
      // the plugin. Production always provides the dedicated router.
      const request = await this.options.botApp.getNaturalImageRequest(event, {
        hasTrustedBotMention,
        hasTrustedReply,
        replyIsGeneratedImage,
      });
      if (!request) return undefined;
      if (request.kind === "clarification" && request.reason === "unrecognized_intent") return { ...base, kind: "chat" };
      return request.kind === "clarification"
        ? { ...base, kind: "clarification", request }
        : { ...base, kind: "image", request };
    }

    const persisted = this.imageIntentRoutes.getBySourceRow(message.id);
    if (persisted && persisted.status !== "classifying") {
      this.metrics.inc("image_intent_router_duplicate_reused");
      return this.routeFromPersistedImageIntent(persisted, base);
    }

    // A missing or disabled router is a terminal, per-message ordinary-chat
    // decision. Persisting it stops key selection and retries from repeatedly
    // probing settings or falling back to the legacy keyword parser.
    if (!persisted && !await router.isConfigured()) {
      const unavailable = this.imageIntentRoutes.recordUnavailable({
        sourceRowId: message.id,
        errorCode: "model_not_configured",
      });
      if (unavailable.created) this.metrics.inc("image_intent_router_unavailable");
      return this.routeFromPersistedImageIntent(unavailable.route, base);
    }

    // `keyOf` calls this preflight mode. It establishes only that the inbound
    // event is eligible for the plugin; starting a lease or awaiting a remote
    // tool call here would serially stall the entire ConsumerRunner poll batch.
    if (options.classify === false) {
      return { ...base, kind: "pending" };
    }

    const claim = this.imageIntentRoutes.claim({
      sourceRowId: message.id,
      ...(this.options.imageIntentRouteLeaseMs === undefined
        ? {}
        : { leaseMs: this.options.imageIntentRouteLeaseMs }),
    });
    if (claim.state === "resolved") {
      if (claim.route.errorCode === "result_unknown") {
        this.metrics.inc("image_intent_router_result_unknown");
      }
      this.metrics.inc("image_intent_router_duplicate_reused");
      return this.routeFromPersistedImageIntent(claim.route, base);
    }
    if (claim.state === "busy") {
      return { ...base, kind: "pending" };
    }

    try {
      const classified = await this.backgroundLlmGate(async () => {
        // Claim ownership once more after the semaphore wait.  This closes the
        // crash/replay window where another worker can terminalize an expired
        // route before this worker actually reaches the upstream model.
        const ownsLease = this.imageIntentRoutes.renewLease({
          sourceRowId: message.id,
          leaseToken: claim.leaseToken,
          ...(this.options.imageIntentRouteLeaseMs === undefined
            ? {}
            : { leaseMs: this.options.imageIntentRouteLeaseMs }),
        });
        if (!ownsLease) throw new ImageIntentRouteLeaseLostError();
        return router.classify({
          sanitizedText: sanitizeImageIntentText(canonicalSegments, this.options.botApp.getBotQq()),
          facts: {
            hasTrustedBotMention,
            hasTrustedReply,
            replyIsGeneratedImage,
            attachmentCount: parseImages(message.images_json).length,
          },
        });
      });
      const saved = this.imageIntentRoutes.complete({
        sourceRowId: message.id,
        leaseToken: claim.leaseToken,
        action: classified.action,
        modelId: classified.modelId,
        model: classified.model,
      });
      if (!saved) {
        // A reclaimed lease completed first. Its durable answer, if any, is
        // the only result allowed to guide this inbound message.
        return this.routeFromPersistedImageIntent(
          this.imageIntentRoutes.getBySourceRow(message.id) ?? claim.route,
          base,
        );
      }
      this.metrics.inc(`image_intent_router_classified_${classified.action}`);
      return this.routeFromPersistedImageIntent(saved, base);
    } catch (error) {
      if (error instanceof ImageIntentRouteLeaseLostError) {
        // Claim performs the expiry transition atomically.  It cannot issue a
        // new router call, so a delayed owner remains fail-closed to chat.
        const recovered = this.imageIntentRoutes.claim({
          sourceRowId: message.id,
          ...(this.options.imageIntentRouteLeaseMs === undefined
            ? {}
            : { leaseMs: this.options.imageIntentRouteLeaseMs }),
        });
        if (recovered.state === "resolved") {
          if (recovered.route.errorCode === "result_unknown") {
            this.metrics.inc("image_intent_router_result_unknown");
          }
          return this.routeFromPersistedImageIntent(recovered.route, base);
        }
        return { ...base, kind: "pending" };
      }
      const routerError = error instanceof ImageIntentRouterError ? error : undefined;
      const errorCode = routerError?.code ?? "unavailable";
      const saved = this.imageIntentRoutes.markUnavailable({
        sourceRowId: message.id,
        leaseToken: claim.leaseToken,
        errorCode,
        ...(routerError?.modelId && routerError.model
          ? { modelId: routerError.modelId, model: routerError.model }
          : {}),
      });
      if (!saved) {
        return this.routeFromPersistedImageIntent(
          this.imageIntentRoutes.getBySourceRow(message.id) ?? claim.route,
          base,
        );
      }
      this.metrics.inc("image_intent_router_unavailable");
      logWarn("Image intent router failed closed to ordinary conversation.", {
        sourceRowId: message.id,
        errorCode,
      });
      return this.routeFromPersistedImageIntent(saved, base);
    }
  }

  private async routeFromPersistedImageIntent(
    record: ImageIntentRouteRecord,
    base: NaturalImageRouteBase,
  ): Promise<NaturalImageRoute> {
    if (record.status === "classifying") return { ...base, kind: "pending" };
    if (record.status !== "classified" || !record.action) return { ...base, kind: "chat" };

    // Preserve the model's original action in the ledger, including old
    // records, but uncertainty must not interrupt the conversation with a
    // generic image hint. Replays reuse this same local interpretation.
    if (record.action === "chat" || record.action === "clarification") return { ...base, kind: "chat" };
    const request = await this.options.botApp.getNaturalImageRequestForIntent(
      base.event,
      {
        hasTrustedBotMention: base.hasTrustedBotMention,
        hasTrustedReply: base.hasTrustedReply,
        replyIsGeneratedImage: base.replyIsGeneratedImage,
      },
      record.action,
    );
    if (!request) {
      // The model has no authority to override local trust, group settings, or
      // syntax validation. Treat an unmaterializable action as normal chat.
      this.metrics.inc("image_intent_router_host_rejected");
      return { ...base, kind: "chat" };
    }
    if (request.kind === "clarification") {
      return { ...base, kind: "clarification", request };
    }
    if (request.kind === "generate" && request.requiresConfirmation) {
      new ImageGenerationConfirmationRepository(this.sharedDb).request(record.sourceRowId);
      return { ...base, kind: "clarification", request: { kind: "clarification", reason: "generation_confirmation" } };
    }
    return { ...base, kind: "image", request };
  }

  /**
   * Older focused Worker fakes do not implement this newer BotApplication
   * method. Production always does, while the optional call keeps those
   * structural test doubles faithful to the legacy interface.
   */
  private async isImageGenerationCommand(text: string): Promise<boolean> {
    return (await this.options.botApp.isImageGenerationCommand?.(text)) ?? false;
  }

  private hasImageRequest(groupId: string, sourceMessageId: string): boolean {
    try {
      return Boolean(this.imageRequests.getSafeBySource(groupId, sourceMessageId));
    } catch {
      // Metrics must never make a message fail if the observability lookup is
      // unavailable. The durable ledger remains the request authority.
      return false;
    }
  }

  /**
   * Status-only accounting for image requests. Counter names are deliberately
   * fixed and the lookup does not emit source ids, prompts, or display names.
   */
  private recordImageRequestMetrics(input: {
    isNaturalImage: boolean;
    hadExistingImageRequest: boolean;
    groupId: string;
    sourceMessageId: string;
  }): void {
    let status: ImageRequestStatus | undefined;
    try {
      status = this.imageRequests.getSafeBySource(input.groupId, input.sourceMessageId)?.status;
    } catch {
      // See hasImageRequest: observability is intentionally best effort.
      status = undefined;
    }

    if (input.hadExistingImageRequest) {
      this.metrics.inc("image_request_duplicate_reused");
    }
    if (input.isNaturalImage && (status === undefined || status === "failed")) {
      this.metrics.inc("natural_image_request_rejected");
    }
    if (status === "outcome_unknown") {
      this.metrics.inc("image_request_outcome_unknown");
    }
    if (status === "delivery_unknown") {
      this.metrics.inc("image_request_delivery_unknown");
    }
  }

  private isAvailableGeneratedImageReply(groupId: string, replyTo: string | null | undefined): boolean {
    const messageId = replyTo?.trim();
    if (!messageId || this.sharedDb.isRetracted(groupId, messageId)) return false;
    return Boolean(this.sharedDb.db.prepare(
      `SELECT 1
         FROM image_previews
        WHERE group_id = ?
          AND output_message_id = ?
          AND status = 'available'
          AND publication_state = 'published'
          AND expires_at > ?
        LIMIT 1`,
    ).get(groupId, messageId, Date.now()));
  }

  private async resolveRoute(message: {
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
  }): Promise<ConversationRoute> {
    const images = parseImages(message.images_json);
    const input = {
      sourceRowId: message.id,
      groupId: message.group_id,
      userId: message.user_id,
      sourceMessageId: message.msg_id,
      replyToMessageId: message.reply_to ?? undefined,
      text: message.text,
      hasImages: images.length > 0,
      nowMs: message.msg_time,
    };
    const route = await this.options.botApp.prepareConversationRoute?.(input) ?? this.contextRouter.resolve(input);
    this.contextRepository.orchestration.registerTask(route, message.group_id, message.user_id,
      this.contextRepository.orchestration.getResolution(message.id)?.relation ?? "new");
    return route;
  }

  private isBlacklistedMessage(message: { group_id: string; user_id: string }): Promise<boolean> {
    return this.options.isBlacklistedUser(message.group_id, message.user_id);
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
        userId: message.user_id,
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
    sender_role?: string | null;
    reply_to?: string | null;
    verified_mention_user_ids_json?: string;
    canonical_segments_json?: string | null;
    has_at_bot?: number;
  }): NapcatGroupMessageEvent {
    const images = parseImages(message.images_json);
    const verifiedMentionUserIds = parseVerifiedMentionUserIds(message.verified_mention_user_ids_json);
    const segments = restoreCanonicalMessageSegments(message.canonical_segments_json)
      ?? rebuildLegacyGroupMessageSegments({
        text: message.text,
        images,
        replyTo: message.reply_to,
        hasAtBot: Boolean(message.has_at_bot),
        botQq: this.options.botApp.getBotQq(),
        verifiedMentionUserIds,
      });
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
        ...(message.sender_role ? { role: message.sender_role } : {}),
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
    try {
      await this.runner.stop();
    } finally {
      this.stopArtifactObservation();
      this.metrics.stop();
    }
  }
}

async function buildBotApp(
  config: ReturnType<typeof loadConfig>,
  sharedDb: SharedDb,
  transport: MessageTransport,
  imagePipeline?: ImagePipeline,
): Promise<{
  botApp: BotApplication;
  groupConfigService: GroupConfigService;
  imageIntentRouter: ImageIntentRouter;
}> {
  const dataDir = config.dataDir;
  setModelTelemetryStore(new ModelTelemetryStore(sharedDb));
  const v3State = resolveV3RuntimeState(sharedDb, config.stateEncryptionKey);
  v3State?.retireRoastModeForExistingGroupsOnce();
  const capabilityPolicy = v3State ? new V3CapabilityPolicyService(v3State) : undefined;
  const contextRepository = new ConversationContextRepository(sharedDb);
  const replyAiService = new AiService(config.openAiBaseUrl, config.openAiApiKey, config.openAiModel);
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
  const runtimeReplyAiService = new ConfiguredAiService(
    replyAiService,
    systemSettingsStore,
    "reply",
    undefined,
    undefined,
    capabilityPolicy,
  );
  // The image router is deliberately a separate, selected-only runtime. It
  // cannot borrow the ordinary reply model when no low-cost tool-capable
  // classifier is configured.
  const imageIntentAiService = new ConfiguredAiService(
    replyAiService,
    systemSettingsStore,
    "image_intent",
    undefined,
    undefined,
    capabilityPolicy,
    true,
  );
  const imageIntentRouter = new ImageIntentRouterPlugin(imageIntentAiService);
  const htmlPreviewFallbackAiService = new ConfiguredAiService(
    replyAiService,
    systemSettingsStore,
    "reply",
    undefined,
    "ds",
    capabilityPolicy,
    true,
  );
  const knowledgeBaseStore = new KnowledgeBaseStore(config.knowledgeBasePath, v3State);
  const skillService = v3State
    ? new CharacterProfileService(v3State)
    : new SkillService(config.skillsDir);
  if (v3State && !await skillService.getHuixianProfile()) {
    throw new Error("v3_huixian_profile_missing");
  }
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(config.scheduledReminderStorePath, v3State),
    runtimeReplyAiService,
  );
  const adminOperationLogService = new AdminOperationLogService(config.adminOperationLogPath, v3State);
  const atmosphere = new AtmosphereSummarizer(dataDir, {}, v3State);
  const htmlPreviewService = new HtmlPreviewService({
    sharedDb,
    rootDir: config.htmlPreviewRoot,
    publicBaseUrl: config.htmlPreviewPublicBaseUrl,
  });
  const imageGenerationService = new ConfiguredImageGenerationService(
    systemSettingsStore,
    path.join(dataDir, "generated-images"),
    v3State,
    capabilityPolicy,
    fetch,
    Date.now,
    () => (sharedDb.db.prepare(
      "SELECT text FROM outbox WHERE kind = 'generated_image' AND status IN ('pending', 'sending')",
    ).all() as Array<{ text: string }>).map((row) => row.text),
  );
  const imagePreviewArchiveService = new ImagePreviewArchiveService({
    sharedDb,
    rootDir: path.join(dataDir, "generated-image-previews"),
    stagedRoot: path.join(dataDir, "generated-images"),
  });
  // ConsumerRunner begins polling from its constructor. Reclaim a pending
  // pre-crash archive before the WorkerApp exists so an active request can
  // never be mistaken for an abandoned preview.
  try {
    const recovered = await imagePreviewArchiveService.recoverUnpublished();
    if (recovered) {
      logWarn("Discarded unpublished generated-image previews during worker startup.", { recovered });
    }
  } catch (error) {
    logWarn("Failed to recover unpublished generated-image previews during worker startup.", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  // Keep the existing fixed blacklist response active until V3 cutover. The
  // library itself deliberately has no legacy persistence fallback.
  const memeLibraryService = v3State ? new MemeLibraryService(dataDir, v3State) : undefined;
  await memeLibraryService?.initialize();

  const botApp = new BotApplication(
    transport,
    groupConfigService,
    skillService,
    v3State ? new SqliteConversationStore(contextRepository) : new ConversationStore(config.conversationsPath),
    runtimeReplyAiService,
    undefined,
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
    new GroupLock(),
    new LiveChatService(),
    config.botQq,
    false,
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
    imagePipeline,
    () => {
      // The worker counts cancelled tasks via its own metrics instance; this
      // hook is invoked by the bot when a cancelled task suppresses its reply.
    },
    false, // worker 不发送启动运维告警（多进程下由 ingress 感知连接状态）
    contextRepository,
    new ConversationContextRouter(contextRepository),
    capabilityPolicy,
    htmlPreviewService,
    {
      mode: "ds",
      label: "ds",
      service: htmlPreviewFallbackAiService,
    },
    v3State ? new QqAdminAuthorizationService(sharedDb) : undefined,
    new RecentGroupEvidenceService(sharedDb),
    memeLibraryService,
    imageGenerationService,
    loadPrivateEnterpriseRanking(),
    new KnowledgeSourceBindingStore(v3State),
    new BtSearchService({ dataDir: path.join(dataDir, "bt") }),
    imagePreviewArchiveService,
    new QqAvatarReferenceService(),
    new ImageRequestRepository(sharedDb),
    new GroupInteractionService(sharedDb, config.botQq),
  );
  return { botApp, groupConfigService, imageIntentRouter };
}

function parseVerifiedMentionUserIds(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => /^\d{5,12}$/.test(item)),
    )];
  } catch {
    return [];
  }
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
  const readClient = new IngressReadApiClient(
    `http://127.0.0.1:${config.ingressReadApiPort}`,
    config.ingressReadApiToken,
  );
  const sharedDb = openSharedDb(config.dataDir);
  try {
    const transport = new WorkerTransport(sharedDb, {
      resolveImageInputs: (images) => readClient.resolveImages(images),
      listGroupMembers: (groupId, options) => readClient.listGroupMembers(groupId, options),
      listGroups: () => readClient.listGroups(),
      resolveMentionTargets: (groupId, candidates) => readClient.resolveMentionTargets(groupId, candidates),
      resolveMemberIdentities: (groupId, candidates) => readClient.resolveMemberIdentities(groupId, candidates),
      getMessage: (messageId) => readClient.getMessage(messageId),
    });
    const builtBot = await buildBotApp(config, sharedDb, transport, buildImagePipeline(transport));
    const app = new WorkerApp(
      {
        dataDir: config.dataDir,
        sharedDb,
        botApp: builtBot.botApp,
        consumerKey: "worker:main",
        isBlacklistedUser: async (groupId, userId) => {
          const group = await builtBot.groupConfigService.getGroup(groupId);
          return (group?.blacklistedUserIds ?? []).includes(userId);
        },
        stateEncryptionKey: config.stateEncryptionKey,
        imageIntentRouter: builtBot.imageIntentRouter,
      },
    );
    // Wire the semaphore+breaker gate into the bot's LLM call path.
    const botApp = app.botApp;
    botApp.setLlmGate(app.llmGate);
    botApp.setBackgroundLlmGate(app.backgroundLlmGate);

    botApp.start();
    app.start();

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      logInfo("Worker shutting down...");
      let shutdownError: unknown;
      try {
        await app.stop();
      } catch (error) {
        shutdownError = error;
        logError("Worker application shutdown failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await botApp.stop();
      } catch (error) {
        shutdownError ??= error;
        logError("Worker bot shutdown failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sharedDb.close();
      }
      if (shutdownError) {
        process.exit(1);
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    sharedDb.close();
    throw error;
  }
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
function degradedReply(tier: string): AiReply {
  return {
    text: degradedMessage(tier),
    model: "degraded",
    skillId: "degraded",
    promptChars: 0,
  };
}

function parseImages(imagesJson?: string): Array<{ url?: string; file?: string; summary?: string }> {
  try {
    const value = JSON.parse(imagesJson ?? "[]") as unknown;
    return Array.isArray(value) ? value as Array<{ url?: string; file?: string; summary?: string }> : [];
  } catch {
    return [];
  }
}

/**
 * Reduces the platform message to routing text without leaking member IDs,
 * image locations, reply identifiers, or a real @ target to the classifier.
 * The position of each real mention remains visible through an opaque marker,
 * which is enough for the model to distinguish the avatar grammar.
 */
function sanitizeImageIntentText(
  segments: NapcatGroupMessageEvent["message"] | undefined,
  botQq: string,
): string {
  if (!Array.isArray(segments)) return "";
  let memberMentionIndex = 0;
  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      parts.push(sanitizeImageIntentTextFragment(segment));
      continue;
    }
    if (segment.type === "text") {
      parts.push(sanitizeImageIntentTextFragment(String(segment.data?.text ?? "")));
      continue;
    }
    if (segment.type === "at") {
      const mentionedQq = String(segment.data?.qq ?? "").trim();
      parts.push(mentionedQq === botQq ? "[BOT_MENTION]" : `[MEMBER_MENTION_${++memberMentionIndex}]`);
    }
    // Reply and image segments are represented only by the trusted facts.
    // Their IDs, URLs, and file names are not useful to action selection.
  }
  return parts.join("").replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

function sanitizeImageIntentTextFragment(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // URLs can embed QQ or hosted-media identifiers and do not influence
    // whether the request should be treated as a picture action.
    .replace(/(?:https?:\/\/|www\.)\S+/giu, "[URL]")
    .replace(/(?<!\d)\d{5,12}(?!\d)/gu, "[NUMBER]");
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
