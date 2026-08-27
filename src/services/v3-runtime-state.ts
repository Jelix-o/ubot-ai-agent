import type { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository, type V3CapabilityPolicy } from "./v3-state-repository.js";

export const REQUIRED_V3_RUNTIME_CAPABILITIES = [
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

export type V3RuntimeCapability = typeof REQUIRED_V3_RUNTIME_CAPABILITIES[number];

/**
 * Resolves the sole runtime state authority after the one-shot V3 cutover.
 * Development and migration tooling may use the RC JSON compatibility path
 * before cutover. Production never may: the migrator runs before units start,
 * so a missing marker is a deployment failure rather than a JSON fallback.
 */
export function resolveV3RuntimeState(
  sharedDb: SharedDb,
  stateEncryptionKey: string | undefined,
  options: { production?: boolean } = {},
): V3StateRepository | undefined {
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (production && !stateEncryptionKey?.trim()) {
    throw new Error("UBOT_STATE_ENCRYPTION_KEY is required for production startup.");
  }

  const repository = new V3StateRepository(sharedDb, { stateEncryptionKey });
  if (!repository.isCutover()) {
    if (production) {
      throw new Error("v3_state_cutover_required");
    }
    return undefined;
  }

  repository.requireCutover();
  assertV3RuntimeCapabilities(repository);
  return repository;
}

/** Validates the persisted V3 policy before any runtime composition begins. */
export function assertV3RuntimeCapabilities(repository: V3StateRepository): V3CapabilityPolicy {
  repository.requireCutover();
  const policy = repository.getCapabilityPolicy();
  if (!policy || !Array.isArray(policy.enabledCapabilities)) {
    throw new Error("v3_capability_policy_missing");
  }

  const enabled = new Set(policy.enabledCapabilities);
  const missing = REQUIRED_V3_RUNTIME_CAPABILITIES.filter((capability) => !enabled.has(capability));
  if (missing.length > 0) {
    throw new Error(`v3_capability_policy_missing_required:${missing.join(",")}`);
  }
  return policy;
}
