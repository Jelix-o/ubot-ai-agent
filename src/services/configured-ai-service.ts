import { withModelOperation } from "./model-telemetry.js";
import { ReplyModelRouter } from "./reply-model-router.js";
import { logWarn } from "../logger.js";
import type { ImageIntentRoutingSettings, SystemModelConfig, SystemModelPurpose } from "../types.js";
import { normalizeImageIntentRouting } from "./image-intent-settings.js";
import {
  AiService as OpenAiService,
  ImageIntentClassificationError,
  type AiService,
  type ReplyDesireContext,
} from "./ai-service.js";
import { resolveProviderCapabilities } from "./ai-provider.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";
import type { ProviderCapabilityPolicy, ProviderProtocol } from "./capability-policy-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";
import {
  ImageIntentRouterError,
  type ImageIntentClassifier,
  type ImageIntentRoute,
  type ImageIntentRouterInput,
} from "./image-intent-router-plugin.js";

export type RuntimeAiService = Pick<
  AiService,
  | "checkHealth"
  | "generateReply"
  | "generateStaticHtml"
  | "evaluateReplyDesire"
  | "evaluateControlledMention"
  | "generateDailyReportInsights"
  | "generateBroadcastQuip"
  | "generateScheduledReminderText"
  | "generateChatPeriodSummary"
> & Partial<Pick<AiService, "resolveConversationContext" | "classifyImageIntent">>;

type RuntimeAiFactory = (model: Pick<
  SystemModelConfig,
  "id" | "baseUrl" | "model" | "purpose" | "apiKey" | "apiProtocol" | "capabilities" | "supportsVision" | "reasoningEffort" | "maxCompletionTokens" | "requestTimeoutMs"
>, policyCapabilities?: Parameters<typeof resolveProviderCapabilities>[1], imageIntentRouting?: ImageIntentRoutingSettings) => RuntimeAiService;

/** Raised instead of silently falling back when the persistent policy denies provider chat. */
export class ProviderCapabilityDisabledError extends Error {
  constructor(protocol: ProviderProtocol, feature: string) {
    super(`v3_provider_capability_disabled:${protocol}:${feature}`);
    this.name = "ProviderCapabilityDisabledError";
  }
}

export class ConfiguredModelUnavailableError extends Error {
  readonly status = 503;

  constructor(modelId: string) {
    super(`configured_model_unavailable:${modelId}`);
    this.name = "ConfiguredModelUnavailableError";
  }
}

export class ConfiguredAiService implements RuntimeAiService, ImageIntentClassifier {
  private auxiliaryRouter?: ReplyModelRouter;
  private readonly modelIds = new WeakMap<object, string>();
  private cachedService?: {
    key: string;
    service: RuntimeAiService;
  };

  constructor(
    private readonly fallback: RuntimeAiService,
    private readonly systemSettingsStore: SystemSettingsStore,
    private readonly purpose: SystemModelPurpose,
    private readonly factory: RuntimeAiFactory = (model, policyCapabilities, imageIntentRouting) => {
      const providerCapabilities = resolveProviderCapabilities(model, policyCapabilities);
      if (model.apiProtocol === "anthropic") {
        const client = new AnthropicChatCompletions(model.baseUrl, model.apiKey ?? "", {
          timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
        });
        return new OpenAiService(model.baseUrl, model.apiKey ?? "", model.model, client as any, {
          reasoningEffort: model.reasoningEffort,
          maxCompletionTokens: model.maxCompletionTokens,
          timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
          providerCapabilities: {
            ...providerCapabilities,
            toolCalling: model.capabilities?.toolCalling === true,
          },
        });
      }
      return new OpenAiService(model.baseUrl, model.apiKey ?? "", model.model, undefined, {
        imageIntentRouting,
        reasoningEffort: model.reasoningEffort,
        maxCompletionTokens: model.maxCompletionTokens,
        timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
        providerCapabilities: {
          ...providerCapabilities,
          toolCalling: model.capabilities?.toolCalling === true,
        },
      });
    },
    private readonly selectedModelId?: string,
    private readonly capabilityPolicy?: ProviderCapabilityPolicy,
    private readonly requireSelectedModel = false,
  ) {}

  async checkHealth(options?: Parameters<AiService["checkHealth"]>[0]): ReturnType<AiService["checkHealth"]> {
    const service = await this.resolveService();
    return withModelOperation("probe", undefined, () => service.checkHealth(options), this.modelIds.get(service));
  }

  async generateReply(args: Parameters<AiService["generateReply"]>[0]): ReturnType<AiService["generateReply"]> {
    const service = await this.resolveService();
    return withModelOperation("reply", undefined, () => service.generateReply(args), this.modelIds.get(service));
  }

  /**
   * Image routing is intentionally bound to the explicitly selected dedicated
   * model. It never borrows the reply model or the environment fallback.
   */
  async isImageIntentConfigured(): Promise<boolean> {
    try {
      await this.resolveSelectedImageIntentService();
      return true;
    } catch {
      return false;
    }
  }

  async classifyImageIntent(input: ImageIntentRouterInput): Promise<ImageIntentRoute> {
    let selectedModel: SystemModelConfig | undefined;
    try {
      const { service, model } = await this.resolveSelectedImageIntentService();
      selectedModel = model;
      if (!service.classifyImageIntent) {
        throw new ConfiguredModelUnavailableError(model.id);
      }
      const classify = service.classifyImageIntent.bind(service);
      const result = await withModelOperation(
        "image_intent",
        undefined,
        () => classify(input),
        model.id,
      );
      return {
        ...result,
        modelId: model.id,
        model: result.model,
      };
    } catch (error) {
      if (error instanceof ImageIntentRouterError) {
        throw error;
      }
      const modelMetadata = selectedModel
        ? { modelId: selectedModel.id, model: selectedModel.model }
        : {};
      if (error instanceof ImageIntentClassificationError && error.code === "invalid_response") {
        throw new ImageIntentRouterError("invalid_response", { cause: error, ...modelMetadata });
      }
      throw new ImageIntentRouterError("unavailable", { cause: error, ...modelMetadata });
    }
  }

  async resolveConversationContext(args: Parameters<AiService["resolveConversationContext"]>[0]): Promise<string> {
    const service = await this.resolveService("reply");
    return service.resolveConversationContext ? service.resolveConversationContext(args) : "";
  }

  async generateStaticHtml(
    args: Parameters<AiService["generateStaticHtml"]>[0],
  ): ReturnType<AiService["generateStaticHtml"]> {
    // Static previews intentionally use the same selected reply model as the
    // group conversation. They are not a summary or custom-model workload.
    const service = await this.resolveService("reply");
    return withModelOperation("html", undefined, () => service.generateStaticHtml(args), this.modelIds.get(service));
  }

  async evaluateReplyDesire(
    skill: Parameters<AiService["evaluateReplyDesire"]>[0],
    history: Parameters<AiService["evaluateReplyDesire"]>[1],
    bufferedMessages: Parameters<AiService["evaluateReplyDesire"]>[2],
    signal?: AbortSignal,
    throwOnFailure = false,
    group?: ReplyDesireContext,
  ): ReturnType<AiService["evaluateReplyDesire"]> {
    if (this.purpose === "reply" && !this.selectedModelId) {
      try {
        this.auxiliaryRouter ??= new ReplyModelRouter(this.systemSettingsStore, this.capabilityPolicy,
          model => this.factory(model, this.capabilityPolicy?.getProviderCapabilityOverrides(normalizeProtocol(model.apiProtocol))));
        const session = await this.auxiliaryRouter.begin({ ...group, groupId: group?.groupId ?? "" }, "auxiliary", { signal });
        return (await session.run((service, attemptSignal) => service.evaluateReplyDesire(skill, history, bufferedMessages, attemptSignal, true, group))).value;
      } catch (error) { if (throwOnFailure) throw error; return "SKIP"; }
    }
    const service = await this.resolveService();
    return withModelOperation("background", undefined, () => service.evaluateReplyDesire(skill, history, bufferedMessages, signal, throwOnFailure, group), this.modelIds.get(service));
  }

  async evaluateControlledMention(
    args: Parameters<AiService["evaluateControlledMention"]>[0],
  ): ReturnType<AiService["evaluateControlledMention"]> {
    const service = await this.resolveService();
    return withModelOperation("background", undefined, () => service.evaluateControlledMention(args), this.modelIds.get(service));
  }

  async generateDailyReportInsights(
    args: Parameters<AiService["generateDailyReportInsights"]>[0],
  ): ReturnType<AiService["generateDailyReportInsights"]> {
    const service = await this.resolveService("summary");
    return withModelOperation("background", undefined, () => service.generateDailyReportInsights(args), this.modelIds.get(service));
  }

  async generateBroadcastQuip(
    context: Parameters<AiService["generateBroadcastQuip"]>[0],
  ): ReturnType<AiService["generateBroadcastQuip"]> {
    const service = await this.resolveService("summary");
    return withModelOperation("background", undefined, () => service.generateBroadcastQuip(context), this.modelIds.get(service));
  }

  async generateScheduledReminderText(
    args: Parameters<AiService["generateScheduledReminderText"]>[0],
  ): ReturnType<AiService["generateScheduledReminderText"]> {
    const service = await this.resolveService("summary");
    return withModelOperation("background", undefined, () => service.generateScheduledReminderText(args), this.modelIds.get(service));
  }

  async generateChatPeriodSummary(
    input: Parameters<AiService["generateChatPeriodSummary"]>[0],
  ): ReturnType<AiService["generateChatPeriodSummary"]> {
    const service = await this.resolveService("summary");
    return withModelOperation("background", undefined, () => service.generateChatPeriodSummary(input), this.modelIds.get(service));
  }

  private async resolveService(preferredPurpose?: SystemModelPurpose): Promise<RuntimeAiService> {
    const model = await this.getActiveModel(preferredPurpose);
    if (!model) {
      if (this.requireSelectedModel) {
        throw new ConfiguredModelUnavailableError(this.selectedModelId ?? "reply");
      }
      this.requireProviderChat("openai");
      return this.fallback;
    }

    const protocol = normalizeProtocol(model.apiProtocol);
    this.requireProviderChat(protocol);
    const policyCapabilities = this.capabilityPolicy?.getProviderCapabilityOverrides(protocol);

    const key = [
      model.id,
      model.baseUrl,
      model.model,
      model.apiKey,
      model.apiProtocol,
      JSON.stringify(model.capabilities ?? {}),
      model.supportsVision,
      model.reasoningEffort,
      model.maxCompletionTokens,
      model.requestTimeoutMs,
      JSON.stringify(policyCapabilities ?? {}),
    ].join("|");
    if (this.cachedService?.key === key) {
      return this.cachedService.service;
    }

    try {
      const service = this.factory(model, policyCapabilities);
      this.modelIds.set(service, model.id);
      this.cachedService = { key, service };
      return service;
    } catch (error) {
      if (this.requireSelectedModel) throw error;
      logWarn("Configured AI model is invalid; falling back to environment model.", {
        purpose: this.purpose,
        model: model.model,
        baseUrl: model.baseUrl,
        error: (error as Error).message,
      });
      this.requireProviderChat("openai");
      return this.fallback;
    }
  }

  private async resolveSelectedImageIntentService(): Promise<{
    service: RuntimeAiService;
    model: SystemModelConfig;
  }> {
    const settings = await this.systemSettingsStore.getInternal();
    const selectedModelId = settings.selectedModelIds.image_intent;
    const routing = normalizeImageIntentRouting(settings.imageIntentRouting);
    if (!routing.enabled) throw new ConfiguredModelUnavailableError("image_intent_disabled");
    const model = selectedModelId
      ? settings.models.find((item) => item.id === selectedModelId && isUsableImageIntentModel(item))
      : undefined;
    if (!model) {
      throw new ConfiguredModelUnavailableError(selectedModelId || "image_intent");
    }

    const protocol = normalizeProtocol(model.apiProtocol);
    this.requireProviderChat(protocol);
    const policyCapabilities = this.capabilityPolicy?.getProviderCapabilityOverrides(protocol);
    const key = [
      model.id,
      model.baseUrl,
      model.model,
      model.apiKey,
      model.apiProtocol,
      JSON.stringify(model.capabilities ?? {}),
      model.supportsVision,
      model.reasoningEffort,
      model.maxCompletionTokens,
      model.requestTimeoutMs,
      JSON.stringify(policyCapabilities ?? {}),
      JSON.stringify(routing),
    ].join("|");
    if (this.cachedService?.key === key) {
      if (!this.cachedService.service.classifyImageIntent) {
        throw new ConfiguredModelUnavailableError(model.id);
      }
      return { service: this.cachedService.service, model };
    }

    // Unlike ordinary reply composition, the classifier has no fallback
    // model. A malformed or unavailable configured router is a closed gate.
    const service = this.factory(model, policyCapabilities, routing);
    if (!service.classifyImageIntent) {
      throw new ConfiguredModelUnavailableError(model.id);
    }
    this.modelIds.set(service, model.id);
    this.cachedService = { key, service };
    return { service, model };
  }

  private requireProviderChat(protocol: ProviderProtocol): void {
    if (this.capabilityPolicy?.isProviderFeatureEnabled(protocol, "chat") === false) {
      throw new ProviderCapabilityDisabledError(protocol, "chat");
    }
  }

  private async getActiveModel(preferredPurpose?: SystemModelPurpose): Promise<SystemModelConfig | undefined> {
    const settings = await this.systemSettingsStore.getInternal();
    if (this.selectedModelId) {
      return settings.models.find((model) => model.id === this.selectedModelId && model.purpose === this.purpose && isUsableModel(model));
    }
    for (const purpose of this.resolvePurposeOrder(preferredPurpose)) {
      if (settings.selectedModelIds[purpose] === "") throw new Error("model_not_configured");
      const selectedModelId = isSelectableModelPurpose(purpose)
        ? settings.selectedModelIds[purpose]
        : undefined;
      if (selectedModelId) {
        const selectedModel = settings.models.find((item) =>
          item.id === selectedModelId &&
          item.purpose === purpose &&
          isUsableModel(item)
        );
        if (selectedModel) {
          return selectedModel;
        }
        if (this.requireSelectedModel) {
          return undefined;
        }
      }
      const fallbackModel = settings.models.find((item) => item.purpose === purpose && isUsableModel(item));
      if (fallbackModel) {
        return fallbackModel;
      }
    }
    return undefined;
  }

  private resolvePurposeOrder(preferredPurpose?: SystemModelPurpose): SystemModelPurpose[] {
    const order: SystemModelPurpose[] = [];
    const push = (purpose: SystemModelPurpose | undefined): void => {
      if (purpose && !order.includes(purpose)) {
        order.push(purpose);
      }
    };

    push(preferredPurpose);
    push(this.purpose);
    return order;
  }
}

function normalizeProtocol(value: SystemModelConfig["apiProtocol"]): ProviderProtocol {
  return value === "anthropic" ? "anthropic" : "openai";
}

function isUsableModel(model: SystemModelConfig): boolean {
  return model.enabled &&
    Boolean(model.baseUrl.trim()) &&
    Boolean(model.model.trim()) &&
    Boolean(model.apiKey?.trim());
}

function isUsableImageIntentModel(model: SystemModelConfig): boolean {
  return (model.purpose === "image_intent" || model.purpose === "reply") &&
    model.apiProtocol !== "anthropic" &&
    model.capabilities?.toolCalling === true &&
    isUsableModel(model);
}

function isSelectableModelPurpose(purpose: SystemModelPurpose): boolean {
  return purpose === "reply" || purpose === "summary" || purpose === "knowledge" || purpose === "custom";
}
