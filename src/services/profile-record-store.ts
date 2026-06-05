import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import type { ProfileRecord, ProfileRecordsFile, ProfileRecordType } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

export interface ProfileRecordListArgs {
  groupId?: string;
  userId?: string;
  type?: ProfileRecordType;
  query?: string;
  page: number;
  pageSize: number;
}

export interface ProfileRecordListResult {
  items: ProfileRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ProfileRecordInput {
  groupId: string;
  userId: string;
  type: ProfileRecordType;
  summary: string;
  sourceMemoryCount?: number;
  generatedAt?: string;
  createdBy?: string;
}

export class ProfileRecordStore {
  private cachedData?: ProfileRecordsFile;

  constructor(private readonly filePath: string) {}

  async listPage(args: ProfileRecordListArgs): Promise<ProfileRecordListResult> {
    const data = await this.readData();
    const query = String(args.query ?? "").trim().toLowerCase();
    const pageSize = Math.max(1, args.pageSize);
    const matched = data.records
      .filter((record) => !args.groupId || record.groupId === args.groupId)
      .filter((record) => !args.userId || record.userId === args.userId)
      .filter((record) => !args.type || record.type === args.type)
      .filter((record) => !query || recordMatchesQuery(record, query))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || right.createdAt.localeCompare(left.createdAt));
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, args.page), totalPages);
    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map(cloneRecord),
      pagination: { page, pageSize, total, totalPages },
    };
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    const data = await this.readData();
    const record = data.records.find((item) => item.id === id);
    return record ? cloneRecord(record) : undefined;
  }

  async getLatest(args: { groupId: string; userId: string; type: ProfileRecordType }): Promise<ProfileRecord | undefined> {
    const data = await this.readData();
    const record = data.records
      .filter((item) => item.groupId === args.groupId && item.userId === args.userId && item.type === args.type)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || right.createdAt.localeCompare(left.createdAt))[0];
    return record ? cloneRecord(record) : undefined;
  }

  async getByShareToken(shareToken: string): Promise<ProfileRecord | undefined> {
    const token = normalizeShareToken(shareToken);
    if (!token) return undefined;
    const data = await this.readData();
    const record = data.records.find((item) => item.shareToken === token);
    return record ? cloneRecord(record) : undefined;
  }

  async create(input: ProfileRecordInput): Promise<ProfileRecord> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const record = normalizeRecord({
      id: randomUUID(),
      groupId: input.groupId,
      userId: input.userId,
      type: input.type,
      summary: input.summary,
      shareToken: createShareToken(),
      sourceMemoryCount: input.sourceMemoryCount ?? 0,
      generatedAt: input.generatedAt ?? now,
      createdAt: now,
      createdBy: input.createdBy ?? "system",
    });
    data.records.push(record);
    await this.writeData(data);
    return cloneRecord(record);
  }

  async update(id: string, input: Partial<ProfileRecordInput>): Promise<ProfileRecord | undefined> {
    const data = await this.readData();
    const index = data.records.findIndex((record) => record.id === id);
    if (index === -1) {
      return undefined;
    }
    const current = data.records[index]!;
    const record = normalizeRecord({
      ...current,
      ...input,
      groupId: input.groupId ?? current.groupId,
      userId: input.userId ?? current.userId,
      type: input.type ?? current.type,
      summary: input.summary ?? current.summary,
      shareToken: current.shareToken || createShareToken(),
      sourceMemoryCount: input.sourceMemoryCount ?? current.sourceMemoryCount,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      createdAt: current.createdAt,
      createdBy: input.createdBy ?? current.createdBy,
    });
    data.records[index] = record;
    await this.writeData(data);
    return cloneRecord(record);
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.readData();
    const next = data.records.filter((record) => record.id !== id);
    if (next.length === data.records.length) {
      return false;
    }
    data.records = next;
    await this.writeData(data);
    return true;
  }

  private async readData(): Promise<ProfileRecordsFile> {
    if (this.cachedData) {
      return this.cachedData;
    }
    try {
      this.cachedData = normalizeFile(await readJsonFile<Partial<ProfileRecordsFile>>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = { records: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: ProfileRecordsFile): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeFile(value: Partial<ProfileRecordsFile>): ProfileRecordsFile {
  return {
    records: Array.isArray(value.records)
      ? value.records.map(normalizeRecord).filter((record): record is ProfileRecord => Boolean(record))
      : [],
  };
}

function normalizeRecord(value: Partial<ProfileRecord>): ProfileRecord {
  const now = new Date().toISOString();
  const type = value.type === "yesterday" ? "yesterday" : "overall";
  const shareToken = normalizeShareToken(value.shareToken);
  return {
    id: String(value.id || randomUUID()),
    groupId: String(value.groupId || "").trim(),
    userId: String(value.userId || "").trim(),
    type,
    summary: String(value.summary || "").trim().slice(0, 6000),
    ...(shareToken ? { shareToken } : {}),
    sourceMemoryCount: normalizeCount(value.sourceMemoryCount),
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : now,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    createdBy: String(value.createdBy || "system").trim().slice(0, 80),
  };
}

function createShareToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeShareToken(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{32,}$/.test(text) ? text : undefined;
}

function normalizeCount(value: unknown): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}

function recordMatchesQuery(record: ProfileRecord, query: string): boolean {
  return [
    record.id,
    record.groupId,
    record.userId,
    record.type,
    record.summary,
    record.createdBy,
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function cloneRecord(record: ProfileRecord): ProfileRecord {
  return { ...record };
}
