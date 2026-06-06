import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AdminOperationLogEntry {
  timestamp: string;
  groupId: string;
  operatorUserId: string;
  action: string;
  target?: string;
  detail?: string;
}

export class AdminOperationLogService {
  constructor(private readonly filePath: string) {}

  async record(entry: Omit<AdminOperationLogEntry, "timestamp"> & { timestamp?: string }): Promise<void> {
    const normalized: AdminOperationLogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      groupId: entry.groupId,
      operatorUserId: entry.operatorUserId,
      action: entry.action,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8");
  }

  async listRecent(groupId: string, limit = 10): Promise<AdminOperationLogEntry[]> {
    return this.list({ groupId, limit });
  }

  async list(args: { groupId?: string; action?: string; q?: string; limit?: number } = {}): Promise<AdminOperationLogEntry[]> {
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
        const parsed = JSON.parse(trimmed) as Partial<AdminOperationLogEntry>;
        if (
          (!args.groupId || parsed.groupId === args.groupId) &&
          typeof parsed.timestamp === "string" &&
          typeof parsed.groupId === "string" &&
          typeof parsed.operatorUserId === "string" &&
          typeof parsed.action === "string"
        ) {
          const entry = {
            timestamp: parsed.timestamp,
            groupId: parsed.groupId,
            operatorUserId: parsed.operatorUserId,
            action: parsed.action,
            ...(typeof parsed.target === "string" && parsed.target ? { target: parsed.target } : {}),
            ...(typeof parsed.detail === "string" && parsed.detail ? { detail: parsed.detail } : {}),
          };
          if (action && !entry.action.toLowerCase().includes(action)) {
            continue;
          }
          if (query && ![
            entry.groupId,
            entry.operatorUserId,
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
}
