import { createHash } from "node:crypto";

import type { GroupsConfigFile } from "../types.js";
import { SharedDb, type GroupConfigShadowSnapshotRow } from "../shared/sqlite.js";

/**
 * Contract used by GroupConfigService while JSON remains the authority.
 * Implementations must never be consulted to answer a runtime configuration
 * read; they only receive an already-persisted JSON snapshot.
 */
export interface GroupConfigShadowWriter {
  syncFromAuthoritative(config: GroupsConfigFile): GroupConfigShadowSyncResult;
}

export type GroupConfigShadowSyncStatus = "created" | "updated" | "unchanged";

export interface GroupConfigShadowSyncResult {
  status: GroupConfigShadowSyncStatus;
  snapshotHash: string;
  groupCount: number;
}

export type GroupConfigShadowComparison =
  | {
      status: "missing";
      authoritativeHash: string;
      groupCount: number;
    }
  | {
      status: "in_sync";
      authoritativeHash: string;
      groupCount: number;
      syncedAt: number;
    }
  | {
      status: "out_of_sync";
      authoritativeHash: string;
      shadowHash: string;
      groupCount: number;
      syncedAt: number;
    };

const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * First persistence-migration vertical slice for group configuration.
 *
 * The repository intentionally stores one canonical document snapshot. It is
 * enough to validate dual-write, detect divergence and support a safe import
 * later, while avoiding a premature JSON→SQLite source-of-truth cutover.
 */
export class GroupConfigSqliteShadowRepository implements GroupConfigShadowWriter {
  constructor(private readonly sharedDb: SharedDb) {}

  syncFromAuthoritative(config: GroupsConfigFile): GroupConfigShadowSyncResult {
    const next = serializeAuthoritativeConfig(config);
    const current = this.sharedDb.getGroupConfigShadowSnapshot();
    if (
      current
      && current.snapshot_hash === next.hash
      && current.schema_version === SNAPSHOT_SCHEMA_VERSION
      && current.group_count === next.groupCount
    ) {
      return {
        status: "unchanged",
        snapshotHash: next.hash,
        groupCount: next.groupCount,
      };
    }

    this.sharedDb.saveGroupConfigShadowSnapshot({
      snapshotJson: next.json,
      snapshotHash: next.hash,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      groupCount: next.groupCount,
    });
    return {
      status: current ? "updated" : "created",
      snapshotHash: next.hash,
      groupCount: next.groupCount,
    };
  }

  compareAuthoritative(config: GroupsConfigFile): GroupConfigShadowComparison {
    const next = serializeAuthoritativeConfig(config);
    const current = this.sharedDb.getGroupConfigShadowSnapshot();
    if (!current) {
      return {
        status: "missing",
        authoritativeHash: next.hash,
        groupCount: next.groupCount,
      };
    }
    if (
      current.snapshot_hash === next.hash
      && current.schema_version === SNAPSHOT_SCHEMA_VERSION
      && current.group_count === next.groupCount
    ) {
      return {
        status: "in_sync",
        authoritativeHash: next.hash,
        groupCount: next.groupCount,
        syncedAt: current.synced_at,
      };
    }
    return {
      status: "out_of_sync",
      authoritativeHash: next.hash,
      shadowHash: current.snapshot_hash,
      groupCount: next.groupCount,
      syncedAt: current.synced_at,
    };
  }

  getSnapshot(): GroupConfigShadowSnapshotRow | undefined {
    return this.sharedDb.getGroupConfigShadowSnapshot();
  }
}

function serializeAuthoritativeConfig(config: GroupsConfigFile): {
  json: string;
  hash: string;
  groupCount: number;
} {
  const json = JSON.stringify(canonicalize(config));
  return {
    json,
    hash: createHash("sha256").update(json).digest("hex"),
    groupCount: config.groups.length,
  };
}

/** Sort object keys recursively while preserving arrays and their meaning. */
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
