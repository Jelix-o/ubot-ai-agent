import { createHash } from "node:crypto";
import { logInfo, logWarn } from "../logger.js";
import type { GroupBotConfig, SystemModelConfig } from "../types.js";
import { AiService, getAiProviderFailureDetails, ReplyOutputTruncatedError, StaticHtmlOutputTruncatedError } from "./ai-service.js";
import { resolveProviderCapabilities } from "./ai-provider.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";
import type { ProviderCapabilityPolicy } from "./capability-policy-service.js";
import { ConfiguredModelUnavailableError, type RuntimeAiService } from "./configured-ai-service.js";
import { CircuitOpenError, GatewayProxy } from "./gateway-proxy.js";
import { LlmSemaphore, LlmSemaphoreTimeoutError } from "./llm-semaphore.js";
import { defaultReplyRouting, type SystemSettingsStore } from "./system-settings-store.js";
import { withModelOperation } from "./model-telemetry.js";

export type ReplyOperation = "chat" | "html" | "auxiliary";
type Gate = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
export function retryableModelFailure(error: unknown): boolean {
  if (error instanceof CircuitOpenError || error instanceof StaticHtmlOutputTruncatedError || error instanceof ReplyOutputTruncatedError) return true;
  if (error instanceof LlmSemaphoreTimeoutError) return false;
  const { kind, statusCode } = getAiProviderFailureDetails(error);
  if (statusCode !== undefined && statusCode < 500 && ![408, 409, 429].includes(statusCode)) return false;
  if (error instanceof Error && /refusal|content.?filter|safety|v3_provider|knowledge_tool|llm_semaphore/i.test(error.message)) return false;
  return ["network", "timeout", "rate_limit", "unavailable", "format_error"].includes(kind) ||
    (error instanceof Error && /response.*empty|empty.*response|invalid.*json|html_preview_(?:invalid|output|empty)/i.test(error.message));
}

export function effectiveReplyModelId(group: Pick<GroupBotConfig, "replyModelSource" | "replyModelMode">, defaultId?: string): string {
  return group.replyModelSource === "global" ? defaultId ?? "gpt" : group.replyModelMode ?? "gpt";
}

export class ReplyModelRouter {
  private readonly clients = new Map<string, { fingerprint: string; service: RuntimeAiService; breaker: GatewayProxy }>();
  private readonly semaphore = new LlmSemaphore(8, 2_000);
  constructor(
    private readonly settingsStore: SystemSettingsStore,
    private readonly policy?: ProviderCapabilityPolicy,
    private readonly factory: (model: SystemModelConfig) => RuntimeAiService = model => {
      const capabilities = resolveProviderCapabilities(model, this.policy?.getProviderCapabilityOverrides(model.apiProtocol === "anthropic" ? "anthropic" : "openai"));
      const client = model.apiProtocol === "anthropic" ? new AnthropicChatCompletions(model.baseUrl, model.apiKey ?? "", { timeoutMs: model.requestTimeoutMs }) : undefined;
      return new AiService(model.baseUrl, model.apiKey ?? "", model.model, client as any, {
        timeoutMs: model.requestTimeoutMs, maxCompletionTokens: model.maxCompletionTokens,
        reasoningEffort: model.reasoningEffort, providerCapabilities: capabilities,
      });
    },
  ) {}

  async begin(group: Pick<GroupBotConfig, "groupId" | "replyModelMode" | "replyModelSource">, kind: ReplyOperation, options: { signal?: AbortSignal; vision?: boolean; gate?: Gate } = {}) {
    options.signal?.throwIfAborted();
    const settings = await this.settingsStore.getInternal();
    const routing = settings.replyRouting ?? defaultReplyRouting();
    const primary = effectiveReplyModelId(group, settings.selectedModelIds.reply);
    const ids = [...new Set([primary, ...(routing.fallbackEnabled ? routing.fallbackModelIds : [])])];
    const candidates = ids.flatMap(id => {
      const model = settings.models.find(model => model.id === id && model.purpose === "reply" && model.enabled && model.apiKey?.trim());
      if (!model) return [];
      const protocol = model.apiProtocol === "anthropic" ? "anthropic" : "openai";
      if (this.policy?.isProviderFeatureEnabled(protocol, "chat") === false) return [];
      if (options.vision && !resolveProviderCapabilities(model, this.policy?.getProviderCapabilityOverrides(protocol)).vision) return [];
      return [model];
    });
    const totalMs = kind === "auxiliary" ? 10_000 : kind === "html" ? routing.htmlTotalTimeoutMs : routing.chatTotalTimeoutMs;
    const attemptMs = kind === "auxiliary" ? 4_000 : kind === "html" ? routing.htmlAttemptTimeoutMs : routing.chatAttemptTimeoutMs;
    const deadline = Date.now() + totalMs;
    let cursor = 0;
    let lastError: unknown = new ConfiguredModelUnavailableError(primary);
    return {
      run: async <T>(action: (service: RuntimeAiService, signal: AbortSignal) => Promise<T>): Promise<{ value: T; modelId: string; fallbackUsed: boolean }> => {
        while (cursor < candidates.length) {
          options.signal?.throwIfAborted();
          if (Date.now() >= deadline) throw Object.assign(new Error("model_total_timeout"), { status: 408 });
          const model = candidates[cursor++]!;
          const fingerprint = createHash("sha256").update(JSON.stringify([model, this.policy?.getProviderCapabilityOverrides(model.apiProtocol === "anthropic" ? "anthropic" : "openai")])).digest("hex");
          let entry = this.clients.get(model.id);
          if (!entry || entry.fingerprint !== fingerprint) {
            entry = { fingerprint, service: this.factory(model), breaker: new GatewayProxy() };
            this.clients.set(model.id, entry);
          }
          const startedAt = Date.now();
          try {
            const execute = async () => {
              options.signal?.throwIfAborted();
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw Object.assign(new Error("model_total_timeout"), { status: 408 });
              return entry!.breaker.call(signal => withModelOperation(kind === "chat" ? "reply" : kind === "html" ? "html" : "participation", group.groupId, () => action(entry!.service, signal), model.id), {
                signal: options.signal, timeoutMs: Math.min(attemptMs, remaining, model.requestTimeoutMs ?? attemptMs), countFailure: retryableModelFailure,
              });
            };
            let value: T;
            if (options.gate) value = await options.gate(execute, options.signal);
            else { const release = await this.semaphore.acquire(options.signal); try { value = await execute(); } finally { release(); } }
            options.signal?.throwIfAborted();
            logInfo("Reply model route succeeded.", { groupId: group.groupId, kind, modelId: model.id, attempt: cursor, durationMs: Date.now() - startedAt });
            return { value, modelId: model.id, fallbackUsed: model.id !== primary };
          } catch (error) {
            options.signal?.throwIfAborted();
            lastError = error;
            const failure = getAiProviderFailureDetails(error);
            logWarn("Reply model route failed.", { groupId: group.groupId, kind, modelId: model.id, attempt: cursor, durationMs: Date.now() - startedAt, failureKind: failure.kind, statusCode: failure.statusCode });
            if (!retryableModelFailure(error)) throw error;
          }
        }
        throw lastError;
      },
    };
  }
}
