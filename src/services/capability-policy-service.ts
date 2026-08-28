import type { AiProviderCapabilities } from "./ai-provider.js";
import type { V3CapabilityPolicy, V3StateRepository } from "./v3-state-repository.js";

export type ProviderProtocol = "openai" | "anthropic";

export const V3_RUNTIME_CAPABILITIES = [
  "conversation",
  "explicit_memory",
  "knowledge",
  "scheduled_reminders",
  "daily_reports",
  "holiday_countdown",
  "realtime_lookup",
  "voice",
  "singing",
] as const;

export type V3RuntimeCapability = typeof V3_RUNTIME_CAPABILITIES[number];

export const PROVIDER_CAPABILITY_FEATURES = [
  "chat",
  "vision",
  "streaming",
  "reasoningEffort",
  "requestTimeout",
] as const;

export type ProviderCapabilityFeature = typeof PROVIDER_CAPABILITY_FEATURES[number];

/**
 * Small runtime-facing contract so orchestration can be tested without a
 * SQLite dependency. The V3 implementation intentionally reads the policy
 * from SQLite for each decision: a policy update must take effect without a
 * process restart, and a removed/malformed policy fails closed.
 */
export interface RuntimeCapabilityPolicy {
  isEnabled(capability: V3RuntimeCapability): boolean;
  isProviderFeatureEnabled(protocol: ProviderProtocol, feature: ProviderCapabilityFeature): boolean;
  getProviderCapabilityOverrides(protocol: ProviderProtocol): Partial<AiProviderCapabilities> | undefined;
}

/** The provider-only view used by model composition. */
export type ProviderCapabilityPolicy = Pick<
  RuntimeCapabilityPolicy,
  "isProviderFeatureEnabled" | "getProviderCapabilityOverrides"
>;

/**
 * Startup validation prevents malformed policy documents from accidentally
 * becoming an allow-all path. An enabled list is intentionally allowed to be
 * partial: the policy is an authorization source, so an absent capability is
 * an explicit deny rather than a deployment failure.
 */
export function validateV3CapabilityPolicy(policy: unknown): asserts policy is V3CapabilityPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("v3_capability_policy_missing");
  }
  const candidate = policy as Partial<V3CapabilityPolicy>;
  if (!Number.isInteger(candidate.version) || !candidate.version || !Array.isArray(candidate.enabledCapabilities)) {
    throw new Error("v3_capability_policy_invalid");
  }
  if (typeof candidate.updatedAt !== "string" || !candidate.updatedAt.trim()) {
    throw new Error("v3_capability_policy_invalid");
  }

  const enabled = normalizeStringArray(candidate.enabledCapabilities);
  if (enabled.length !== candidate.enabledCapabilities.length || new Set(enabled).size !== enabled.length) {
    throw new Error("v3_capability_policy_invalid");
  }
  const unknownCapability = enabled.find((capability) =>
    !(V3_RUNTIME_CAPABILITIES as readonly string[]).includes(capability),
  );
  if (unknownCapability) {
    throw new Error(`v3_capability_policy_unknown_capability:${unknownCapability}`);
  }

  if (candidate.providerCapabilities === undefined) {
    return;
  }
  if (!candidate.providerCapabilities || typeof candidate.providerCapabilities !== "object" || Array.isArray(candidate.providerCapabilities)) {
    throw new Error("v3_capability_policy_invalid_provider_capabilities");
  }
  for (const [protocol, features] of Object.entries(candidate.providerCapabilities)) {
    if (protocol !== "openai" && protocol !== "anthropic") {
      throw new Error(`v3_capability_policy_unknown_provider:${protocol}`);
    }
    if (!Array.isArray(features)) {
      throw new Error(`v3_capability_policy_invalid_provider:${protocol}`);
    }
    const normalized = normalizeStringArray(features);
    if (normalized.length !== features.length || new Set(normalized).size !== normalized.length) {
      throw new Error(`v3_capability_policy_invalid_provider:${protocol}`);
    }
    const unknownFeature = normalized.find((feature) =>
      !(PROVIDER_CAPABILITY_FEATURES as readonly string[]).includes(feature),
    );
    if (unknownFeature) {
      throw new Error(`v3_capability_policy_unknown_provider_feature:${protocol}:${unknownFeature}`);
    }
  }
}

/**
 * The persistent V3 capability-policy authority. Product capabilities and
 * provider request capabilities are deliberately separate: disabling a
 * provider's `vision` feature can only narrow a model configuration, never
 * make an unsupported provider appear to support images.
 */
export class V3CapabilityPolicyService implements RuntimeCapabilityPolicy {
  constructor(private readonly repository: V3StateRepository) {}

  isEnabled(capability: V3RuntimeCapability): boolean {
    const policy = this.readPolicy();
    return policy ? new Set(policy.enabledCapabilities).has(capability) : false;
  }

  isProviderFeatureEnabled(protocol: ProviderProtocol, feature: ProviderCapabilityFeature): boolean {
    const features = this.getConfiguredProviderFeatures(protocol);
    // Older V3 policy records did not include provider details. Preserve the
    // protocol-safe provider defaults in that case rather than disabling a
    // working deployment during an additive upgrade.
    return features === undefined ? this.hasReadablePolicyWithoutProviderOverride() : features.has(feature);
  }

  getProviderCapabilityOverrides(protocol: ProviderProtocol): Partial<AiProviderCapabilities> | undefined {
    const features = this.getConfiguredProviderFeatures(protocol);
    if (features === undefined) {
      return this.hasReadablePolicyWithoutProviderOverride() ? undefined : {
        vision: false,
        streaming: false,
        reasoningEffort: false,
        requestTimeout: false,
      };
    }
    return {
      vision: features.has("vision"),
      streaming: features.has("streaming"),
      reasoningEffort: features.has("reasoningEffort"),
      requestTimeout: features.has("requestTimeout"),
    };
  }

  private readPolicy(): V3CapabilityPolicy | undefined {
    try {
      const policy = this.repository.getCapabilityPolicy();
      validateV3CapabilityPolicy(policy);
      return policy;
    } catch {
      // A transient SQLite failure or corrupted row must never broaden
      // privileges. Returning undefined makes all runtime checks deny.
      return undefined;
    }
  }

  private hasReadablePolicyWithoutProviderOverride(): boolean {
    return this.readPolicy() !== undefined;
  }

  private getConfiguredProviderFeatures(protocol: ProviderProtocol): Set<ProviderCapabilityFeature> | undefined {
    const policy = this.readPolicy();
    const configured = policy?.providerCapabilities;
    if (configured === undefined) {
      return undefined;
    }
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      return new Set();
    }

    const values = configured[protocol];
    if (!Array.isArray(values)) {
      return new Set();
    }
    const allowed = new Set<ProviderCapabilityFeature>();
    for (const value of normalizeStringArray(values)) {
      if ((PROVIDER_CAPABILITY_FEATURES as readonly string[]).includes(value)) {
        allowed.add(value as ProviderCapabilityFeature);
      }
    }
    return allowed;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
