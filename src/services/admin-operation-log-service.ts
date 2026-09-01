import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { V3StateRepository } from "./v3-state-repository.js";
import type { AdminRole } from "../types.js";

const V3_OPERATION_DOCUMENT_TYPE = "admin-operation";
const MAX_V3_OPERATION_LOG_ENTRIES = 2_000;

export interface AdminOperationLogEntry {
  timestamp: string;
  groupId: string;
  operatorUserId: string;
  operatorAccountId?: string;
  operatorUsername?: string;
  operatorRole?: AdminRole;
  action: string;
  target?: string;
  detail?: string;
}

export class AdminOperationLogService {
  constructor(
    private readonly filePath: string,
    private readonly v3State?: V3StateRepository,
  ) {}

  async record(entry: Omit<AdminOperationLogEntry, "timestamp"> & { timestamp?: string }): Promise<void> {
    const normalized: AdminOperationLogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      groupId: entry.groupId,
      operatorUserId: entry.operatorUserId,
      ...(entry.operatorAccountId ? { operatorAccountId: entry.operatorAccountId } : {}),
      ...(entry.operatorUsername ? { operatorUsername: entry.operatorUsername } : {}),
      ...(entry.operatorRole ? { operatorRole: entry.operatorRole } : {}),
      action: entry.action,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    };

    if (this.v3State) {
      this.v3State.saveDocument(V3_OPERATION_DOCUMENT_TYPE, randomUUID(), normalized);
      this.pruneV3Entries();
      return;
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8");
  }

  async listRecent(groupId: string, limit = 10): Promise<AdminOperationLogEntry[]> {
    return this.list({ groupId, limit });
  }

  async list(args: { groupId?: string; action?: string; q?: string; limit?: number } = {}): Promise<AdminOperationLogEntry[]> {
    if (this.v3State) {
      const query = args.q?.trim().toLowerCase() ?? "";
      const action = args.action?.trim().toLowerCase() ?? "";
      return this.v3State.listDocuments<AdminOperationLogEntry>(V3_OPERATION_DOCUMENT_TYPE)
        .map((document) => normalizeEntry(document.value))
        .filter((entry): entry is AdminOperationLogEntry => Boolean(entry))
        .filter((entry) => !args.groupId || entry.groupId === args.groupId)
        .filter((entry) => !action || entry.action.toLowerCase().includes(action))
        .filter((entry) => !query || [
          entry.groupId,
          entry.operatorUserId,
          entry.operatorAccountId,
          entry.operatorUsername,
          entry.action,
          entry.target,
          entry.detail,
        ].some((value) => String(value ?? "").toLowerCase().includes(query)))
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, args.limit ?? 10);
    }
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: AdminOperationLogEntry[] = [];
    const query = args.q?.trim().toLowerCase() ?? "";
    const action = args.action?.trim().toLowerCase() ?? "";
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const entry = normalizeEntry(JSON.parse(trimmed));
        if (entry && (!args.groupId || entry.groupId === args.groupId)) {
          if (action && !entry.action.toLowerCase().includes(action)) {
            continue;
          }
          if (query && ![
            entry.groupId,
            entry.operatorUserId,
            entry.operatorAccountId,
            entry.operatorUsername,
            entry.action,
            entry.target,
            entry.detail,
          ].some((value) => String(value ?? "").toLowerCase().includes(query))) {
            continue;
          }
          entries.push(entry);
        }
      } catch {
        continue;
      }
    }

    return entries.slice(-(args.limit ?? 10)).reverse();
  }

  private pruneV3Entries(): void {
    if (!this.v3State) return;
    const documents = this.v3State.listDocuments<AdminOperationLogEntry>(V3_OPERATION_DOCUMENT_TYPE)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const document of documents.slice(MAX_V3_OPERATION_LOG_ENTRIES)) {
      this.v3State.deleteDocument(V3_OPERATION_DOCUMENT_TYPE, document.key);
    }
  }
}

function normalizeEntry(value: unknown): AdminOperationLogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<AdminOperationLogEntry>;
  if (
    typeof parsed.timestamp !== "string" ||
    typeof parsed.groupId !== "string" ||
    typeof parsed.operatorUserId !== "string" ||
    typeof parsed.action !== "string"
  ) {
    return undefined;
  }
  return {
    timestamp: parsed.timestamp,
    groupId: parsed.groupId,
    operatorUserId: parsed.operatorUserId,
    ...(typeof parsed.operatorAccountId === "string" && parsed.operatorAccountId ? { operatorAccountId: parsed.operatorAccountId } : {}),
    ...(typeof parsed.operatorUsername === "string" && parsed.operatorUsername ? { operatorUsername: parsed.operatorUsername } : {}),
    ...(parsed.operatorRole === "super_admin" || parsed.operatorRole === "group_admin" ? { operatorRole: parsed.operatorRole } : {}),
    action: parsed.action,
    ...(typeof parsed.target === "string" && parsed.target ? { target: parsed.target } : {}),
    ...(typeof parsed.detail === "string" && parsed.detail ? { detail: parsed.detail } : {}),
  };
}
