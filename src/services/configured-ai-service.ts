import { logWarn } from "../logger.js";
import type { SystemModelConfig, SystemModelPurpose } from "../types.js";
import type { AiService } from "./ai-service.js";
import { AiService as OpenAiService } from "./ai-service.js";
import { resolveProviderCapabilities } from "./ai-provider.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";
import type { ProviderCapabilityPolicy, ProviderProtocol } from "./capability-policy-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";

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
>;

type RuntimeAiFactory = (model: Pick<
  SystemModelConfig,
  "baseUrl" | "model" | "purpose" | "apiKey" | "apiProtocol" | "capabilities" | "supportsVision" | "reasoningEffort" | "maxCompletionTokens" | "requestTimeoutMs"
>, policyCapabilities?: Parameters<typeof resolveProviderCapabilities>[1]) => RuntimeAiService;

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

export class ConfiguredAiService implements RuntimeAiService {
  private cachedService?: {
    key: string;
    service: RuntimeAiService;
  };

  constructor(
    private readonly fallback: RuntimeAiService,
    private readonly systemSettingsStore: SystemSettingsStore,
    private readonly purpose: SystemModelPurpose,
    private readonly factory: RuntimeAiFactory = (model, policyCapabilities) => {
      const providerCapabilities = resolveProviderCapabilities(model, policyCapabilities);
      if (model.apiProtocol === "anthropic") {
        const client = new AnthropicChatCompletions(model.baseUrl, model.apiKey ?? "", {
          timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
        });
        return new OpenAiService(model.baseUrl, model.apiKey ?? "", model.model, client as any, {
          reasoningEffort: model.reasoningEffort,
          maxCompletionTokens: model.maxCompletionTokens,
          timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
          providerCapabilities,
        });
      }
      return new OpenAiService(model.baseUrl, model.apiKey ?? "", model.model, undefined, {
        reasoningEffort: model.reasoningEffort,
        maxCompletionTokens: model.maxCompletionTokens,
        timeoutMs: providerCapabilities.requestTimeout ? model.requestTimeoutMs : undefined,
        providerCapabilities,
      });
    },
    private readonly selectedModelId?: string,
    private readonly capabilityPolicy?: ProviderCapabilityPolicy,
    private readonly requireSelectedModel = false,
  ) {}

  async checkHealth(options?: Parameters<AiService["checkHealth"]>[0]): ReturnType<AiService["checkHealth"]> {
    return (await this.resolveService()).checkHealth(options);
  }

  async generateReply(args: Parameters<AiService["generateReply"]>[0]): ReturnType<AiService["generateReply"]> {
    return (await this.resolveService()).generateReply(args);
  }

  async generateStaticHtml(
    args: Parameters<AiService["generateStaticHtml"]>[0],
  ): ReturnType<AiService["generateStaticHtml"]> {
    // Static previews intentionally use the same selected reply model as the
    // group conversation. They are not a summary or custom-model workload.
    return (await this.resolveService("reply")).generateStaticHtml(args);
  }

  async evaluateReplyDesire(
    skill: Parameters<AiService["evaluateReplyDesire"]>[0],
    history: Parameters<AiService["evaluateReplyDesire"]>[1],
    bufferedMessages: Parameters<AiService["evaluateReplyDesire"]>[2],
    signal?: AbortSignal,
  ): ReturnType<AiService["evaluateReplyDesire"]> {
    return (await this.resolveService()).evaluateReplyDesire(skill, history, bufferedMessages, signal);
  }

  async evaluateControlledMention(
    args: Parameters<AiService["evaluateControlledMention"]>[0],
  ): ReturnType<AiService["evaluateControlledMention"]> {
    return (await this.resolveService()).evaluateControlledMention(args);
  }

  async generateDailyReportInsights(
    args: Parameters<AiService["generateDailyReportInsights"]>[0],
  ): ReturnType<AiService["generateDailyReportInsights"]> {
    return (await this.resolveService("summary")).generateDailyReportInsights(args);
  }

  async generateBroadcastQuip(
    context: Parameters<AiService["generateBroadcastQuip"]>[0],
  ): ReturnType<AiService["generateBroadcastQuip"]> {
    return (await this.resolveService("summary")).generateBroadcastQuip(context);
  }

  async generateScheduledReminderText(
    args: Parameters<AiService["generateScheduledReminderText"]>[0],
  ): ReturnType<AiService["generateScheduledReminderText"]> {
    return (await this.resolveService("summary")).generateScheduledReminderText(args);
  }

  async generateChatPeriodSummary(
    input: Parameters<AiService["generateChatPeriodSummary"]>[0],
  ): ReturnType<AiService["generateChatPeriodSummary"]> {
    return (await this.resolveService("summary")).generateChatPeriodSummary(input);
  }

  private async resolveService(preferredPurpose?: SystemModelPurpose): Promise<RuntimeAiService> {
    const model = await this.getActiveModel(preferredPurpose);
    if (!model) {
      if (this.requireSelectedModel && this.selectedModelId) {
        throw new ConfiguredModelUnavailableError(this.selectedModelId);
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
      this.cachedService = { key, service };
      return service;
    } catch (error) {
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

  private requireProviderChat(protocol: ProviderProtocol): void {
    if (this.capabilityPolicy?.isProviderFeatureEnabled(protocol, "chat") === false) {
      throw new ProviderCapabilityDisabledError(protocol, "chat");
    }
  }

  private async getActiveModel(preferredPurpose?: SystemModelPurpose): Promise<SystemModelConfig | undefined> {
    const settings = await this.systemSettingsStore.getInternal();
    if (this.selectedModelId) {
      return settings.models.find((model) => model.id === this.selectedModelId && isUsableModel(model));
    }
    for (const purpose of this.resolvePurposeOrder(preferredPurpose)) {
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

function isSelectableModelPurpose(purpose: SystemModelPurpose): boolean {
  return purpose === "reply" || purpose === "summary" || purpose === "knowledge" || purpose === "tts" || purpose === "custom";
}
