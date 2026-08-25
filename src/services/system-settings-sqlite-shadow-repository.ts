import { createHash } from "node:crypto";

import { SharedDb, type SystemSettingsShadowSnapshotRow } from "../shared/sqlite.js";
import type { SystemSettings } from "../types.js";

/**
 * System-settings shadow contract. The passed value is treated as sensitive
 * regardless of the caller; this repository redacts it again before SQLite.
 */
export interface SystemSettingsShadowWriter {
  syncFromAuthoritative(settings: SystemSettings): SystemSettingsShadowSyncResult;
}

export type SystemSettingsShadowSyncStatus = "created" | "updated" | "unchanged";

export interface SystemSettingsShadowSyncResult {
  status: SystemSettingsShadowSyncStatus;
  snapshotHash: string;
}

export type SystemSettingsShadowComparison =
  | { status: "missing"; authoritativeHash: string }
  | { status: "in_sync"; authoritativeHash: string; syncedAt: number }
  | { status: "out_of_sync"; authoritativeHash: string; shadowHash: string; syncedAt: number };

const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Non-authoritative system settings snapshot for the migration shadow phase.
 * API keys and authentication-secret hashes are intentionally never copied to
 * the shared SQLite database; credential migration needs its own SecretRef
 * design and must not piggyback on configuration dual-write.
 */
export class SystemSettingsSqliteShadowRepository implements SystemSettingsShadowWriter {
  constructor(private readonly sharedDb: SharedDb) {}

  syncFromAuthoritative(settings: SystemSettings): SystemSettingsShadowSyncResult {
    const next = serializeSafeSettings(settings);
    const current = this.sharedDb.getSystemSettingsShadowSnapshot();
    if (current && current.snapshot_hash === next.hash && current.schema_version === SNAPSHOT_SCHEMA_VERSION) {
      return { status: "unchanged", snapshotHash: next.hash };
    }

    this.sharedDb.saveSystemSettingsShadowSnapshot({
      snapshotJson: next.json,
      snapshotHash: next.hash,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    });
    return { status: current ? "updated" : "created", snapshotHash: next.hash };
  }

  compareAuthoritative(settings: SystemSettings): SystemSettingsShadowComparison {
    const next = serializeSafeSettings(settings);
    const current = this.sharedDb.getSystemSettingsShadowSnapshot();
    if (!current) {
      return { status: "missing", authoritativeHash: next.hash };
    }
    if (current.snapshot_hash === next.hash && current.schema_version === SNAPSHOT_SCHEMA_VERSION) {
      return { status: "in_sync", authoritativeHash: next.hash, syncedAt: current.synced_at };
    }
    return {
      status: "out_of_sync",
      authoritativeHash: next.hash,
      shadowHash: current.snapshot_hash,
      syncedAt: current.synced_at,
    };
  }

  getSnapshot(): SystemSettingsShadowSnapshotRow | undefined {
    return this.sharedDb.getSystemSettingsShadowSnapshot();
  }
}

function serializeSafeSettings(settings: SystemSettings): { json: string; hash: string } {
  const json = JSON.stringify(canonicalize(redactSecrets(settings)));
  return {
    json,
    hash: createHash("sha256").update(json).digest("hex"),
  };
}

function redactSecrets(settings: SystemSettings): SystemSettings {
  const safe = JSON.parse(JSON.stringify(settings)) as SystemSettings;
  safe.adminSecretConfigured ??= Boolean(safe.adminSecretHash);
  safe.groupAdminSecretConfigured ??= Boolean(safe.groupAdminSecretHash);
  delete safe.adminSecretHash;
  delete safe.groupAdminSecretHash;
  safe.models = safe.models.map((model) => {
    const { apiKey: _apiKey, ...withoutApiKey } = model;
    return {
      ...withoutApiKey,
      hasApiKey: model.hasApiKey === true || Boolean(model.apiKey),
    };
  });
  return safe;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
