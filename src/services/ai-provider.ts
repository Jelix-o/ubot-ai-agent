import type { SystemModelConfig } from "../types.js";

/**
 * Provider-level behavior that must be known before constructing a request.
 * This is deliberately independent of a model's display metadata so the
 * runtime does not assume that every OpenAI-compatible gateway behaves alike.
 */
export interface AiProviderCapabilities {
  vision: boolean;
  streaming: boolean;
  reasoningEffort: boolean;
  requestTimeout: boolean;
}

/** Capability metadata carried by a provider-specific client adapter. */
export interface ProviderCapabilitiesCarrier {
  readonly providerCapabilities?: Partial<AiProviderCapabilities>;
}

export const OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES: Readonly<AiProviderCapabilities> = Object.freeze({
  vision: true,
  streaming: true,
  reasoningEffort: true,
  requestTimeout: true,
});

export const ANTHROPIC_PROVIDER_CAPABILITIES: Readonly<AiProviderCapabilities> = Object.freeze({
  vision: true,
  // V3's Chat Completions compatibility boundary is non-streaming for Claude.
  streaming: false,
  // OpenAI's reasoning_effort field is not part of the Anthropic Messages API.
  reasoningEffort: false,
  requestTimeout: true,
});

export function resolveProviderCapabilities(
  model: Pick<SystemModelConfig, "apiProtocol" | "capabilities" | "supportsVision">,
  policyOverride?: Partial<AiProviderCapabilities>,
): AiProviderCapabilities {
  const defaults = model.apiProtocol === "anthropic"
    ? ANTHROPIC_PROVIDER_CAPABILITIES
    : OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES;
  const configured = model.capabilities ?? {};

  if (model.apiProtocol === "anthropic") {
    return applyPolicyCapabilityBounds({
      vision: configured.vision ?? model.supportsVision ?? defaults.vision,
      streaming: false,
      reasoningEffort: false,
      requestTimeout: true,
    }, policyOverride);
  }

  return applyPolicyCapabilityBounds({
    vision: configured.vision ?? model.supportsVision ?? defaults.vision,
    streaming: configured.streaming ?? defaults.streaming,
    reasoningEffort: configured.reasoningEffort ?? defaults.reasoningEffort,
    requestTimeout: true,
  }, policyOverride);
}

/** A persisted policy can only reduce provider capabilities, never expand them. */
function applyPolicyCapabilityBounds(
  capabilities: AiProviderCapabilities,
  policyOverride: Partial<AiProviderCapabilities> | undefined,
): AiProviderCapabilities {
  if (!policyOverride) {
    return capabilities;
  }
  return {
    vision: capabilities.vision && policyOverride.vision !== false,
    streaming: capabilities.streaming && policyOverride.streaming !== false,
    reasoningEffort: capabilities.reasoningEffort && policyOverride.reasoningEffort !== false,
    requestTimeout: capabilities.requestTimeout && policyOverride.requestTimeout !== false,
  };
}

export function mergeProviderCapabilities(
  defaults: Readonly<AiProviderCapabilities>,
  override?: Partial<AiProviderCapabilities>,
): AiProviderCapabilities {
  return {
    vision: override?.vision ?? defaults.vision,
    streaming: override?.streaming ?? defaults.streaming,
    reasoningEffort: override?.reasoningEffort ?? defaults.reasoningEffort,
    requestTimeout: override?.requestTimeout ?? defaults.requestTimeout,
  };
}
