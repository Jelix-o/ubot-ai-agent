import { logWarn } from "../logger.js";
import type { SystemModelConfig } from "../types.js";
import type { AiService } from "./ai-service.js";
import { AiService as OpenAiService } from "./ai-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";

export type RuntimeAiService = Pick<
  AiService,
  | "checkHealth"
  | "generateReply"
  | "evaluateReplyDesire"
  | "evaluateControlledMention"
  | "extractGroupMemoryCandidates"
  | "normalizeMemoryCandidateLanguage"
  | "judgeMemorySemanticRelation"
  | "summarizeDailyMemberProfile"
  | "summarizeOverallMemberProfile"
  | "generateDailyReportInsights"
  | "generateBroadcastQuip"
  | "generateScheduledReminderText"
  | "generateChatPeriodSummary"
>;

type RuntimeAiFactory = (model: Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey">) => RuntimeAiService;

export class ConfiguredAiService implements RuntimeAiService {
  private cachedService?: {
    key: string;
    service: RuntimeAiService;
  };

  constructor(
    private readonly fallback: RuntimeAiService,
    private readonly systemSettingsStore: SystemSettingsStore,
    private readonly purpose: SystemModelConfig["purpose"],
    private readonly factory: RuntimeAiFactory = (model) => new OpenAiService(model.baseUrl, model.apiKey ?? "", model.model),
    private readonly selectedModelId?: string,
  ) {}

  async checkHealth(options?: Parameters<AiService["checkHealth"]>[0]): ReturnType<AiService["checkHealth"]> {
    return (await this.resolveService()).checkHealth(options);
  }

  async generateReply(args: Parameters<AiService["generateReply"]>[0]): ReturnType<AiService["generateReply"]> {
    return (await this.resolveService()).generateReply(args);
  }

  async evaluateReplyDesire(
    skill: Parameters<AiService["evaluateReplyDesire"]>[0],
    history: Parameters<AiService["evaluateReplyDesire"]>[1],
    bufferedMessages: Parameters<AiService["evaluateReplyDesire"]>[2],
  ): ReturnType<AiService["evaluateReplyDesire"]> {
    return (await this.resolveService()).evaluateReplyDesire(skill, history, bufferedMessages);
  }

  async evaluateControlledMention(
    args: Parameters<AiService["evaluateControlledMention"]>[0],
  ): ReturnType<AiService["evaluateControlledMention"]> {
    return (await this.resolveService()).evaluateControlledMention(args);
  }

  async extractGroupMemoryCandidates(
    args: Parameters<AiService["extractGroupMemoryCandidates"]>[0],
  ): ReturnType<AiService["extractGroupMemoryCandidates"]> {
    return (await this.resolveService("memory")).extractGroupMemoryCandidates(args);
  }

  async normalizeMemoryCandidateLanguage(
    args: Parameters<AiService["normalizeMemoryCandidateLanguage"]>[0],
  ): ReturnType<AiService["normalizeMemoryCandidateLanguage"]> {
    return (await this.resolveService("memory")).normalizeMemoryCandidateLanguage(args);
  }

  async judgeMemorySemanticRelation(
    args: Parameters<AiService["judgeMemorySemanticRelation"]>[0],
  ): ReturnType<AiService["judgeMemorySemanticRelation"]> {
    return (await this.resolveService("dedup")).judgeMemorySemanticRelation(args);
  }

  async summarizeDailyMemberProfile(
    args: Parameters<AiService["summarizeDailyMemberProfile"]>[0],
  ): ReturnType<AiService["summarizeDailyMemberProfile"]> {
    return (await this.resolveService()).summarizeDailyMemberProfile(args);
  }

  async summarizeOverallMemberProfile(
    args: Parameters<AiService["summarizeOverallMemberProfile"]>[0],
  ): ReturnType<AiService["summarizeOverallMemberProfile"]> {
    return (await this.resolveService()).summarizeOverallMemberProfile(args);
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

  private async resolveService(preferredPurpose?: SystemModelConfig["purpose"]): Promise<RuntimeAiService> {
    const model = await this.getActiveModel(preferredPurpose);
    if (!model) {
      return this.fallback;
    }

    const key = `${model.id}|${model.baseUrl}|${model.model}|${model.apiKey}`;
    if (this.cachedService?.key === key) {
      return this.cachedService.service;
    }

    try {
      const service = this.factory(model);
      this.cachedService = { key, service };
      return service;
    } catch (error) {
      logWarn("Configured AI model is invalid; falling back to environment model.", {
        purpose: this.purpose,
        model: model.model,
        baseUrl: model.baseUrl,
        error: (error as Error).message,
      });
      return this.fallback;
    }
  }

  private async getActiveModel(preferredPurpose?: SystemModelConfig["purpose"]): Promise<SystemModelConfig | undefined> {
    const settings = await this.systemSettingsStore.getInternal();
    if (this.selectedModelId) {
      return settings.models.find((model) => model.id === this.selectedModelId && isUsableModel(model));
    }
    for (const purpose of this.resolvePurposeOrder(preferredPurpose)) {
      const selectedModelId = settings.selectedModelIds[purpose];
      if (selectedModelId) {
        const selectedModel = settings.models.find((item) =>
          item.id === selectedModelId &&
          item.purpose === purpose &&
          isUsableModel(item)
        );
        if (selectedModel) {
          return selectedModel;
        }
      }
      const fallbackModel = settings.models.find((item) => item.purpose === purpose && isUsableModel(item));
      if (fallbackModel) {
        return fallbackModel;
      }
    }
    return undefined;
  }

  private resolvePurposeOrder(preferredPurpose?: SystemModelConfig["purpose"]): SystemModelConfig["purpose"][] {
    const order: SystemModelConfig["purpose"][] = [];
    const push = (purpose: SystemModelConfig["purpose"] | undefined): void => {
      if (purpose && !order.includes(purpose)) {
        order.push(purpose);
      }
    };

    push(preferredPurpose);
    push(this.purpose);
    if (this.purpose === "profile" || preferredPurpose === "memory" || preferredPurpose === "dedup" || preferredPurpose === "summary") {
      push("profile");
    }
    return order;
  }
}

function isUsableModel(model: SystemModelConfig): boolean {
  return model.enabled &&
    Boolean(model.baseUrl.trim()) &&
    Boolean(model.model.trim()) &&
    Boolean(model.apiKey?.trim());
}
