import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { GroupMemory, GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryType } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";
import { type GroupMemoryInput, GroupMemoryStore } from "./group-memory-store.js";

interface GroupMemoryCandidateFile {
  candidates: GroupMemoryCandidate[];
}

export type GroupMemoryCandidateInput = {
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence?: number;
  source?: string;
};

export class GroupMemoryCandidateStore {
  private cachedData?: GroupMemoryCandidateFile;

  constructor(private readonly filePath: string) {}

  async list(args: { groupId?: string; status?: GroupMemoryCandidateStatus } = {}): Promise<GroupMemoryCandidate[]> {
    const data = await this.readData();
    return data.candidates
      .filter((candidate) => !args.groupId || candidate.groupId === args.groupId)
      .filter((candidate) => !args.status || candidate.status === args.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneCandidate);
  }

  async addCandidate(input: GroupMemoryCandidateInput): Promise<GroupMemoryCandidate> {
    const data = await this.readData();
    const normalizedKey = buildCandidateKey(input);
    const existing = data.candidates.find((candidate) => buildCandidateKey(candidate) === normalizedKey);
    const now = new Date().toISOString();

    if (existing) {
      existing.title = input.title.trim().slice(0, 80) || existing.title;
      existing.content = input.content.trim().slice(0, 600) || existing.content;
      existing.confidence = normalizeConfidence(input.confidence ?? existing.confidence);
      existing.source = input.source?.trim().slice(0, 80) || existing.source;
      existing.updatedAt = now;
      if (existing.status !== "pending") {
        existing.status = "pending";
      }
      await this.writeData(data);
      return cloneCandidate(existing);
    }

    const candidate = normalizeCandidate({
      id: randomUUID(),
      groupId: input.groupId,
      type: input.type,
      ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
      title: input.title,
      content: input.content,
      confidence: input.confidence ?? 0.65,
      source: input.source ?? "auto",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    data.candidates.push(candidate);
    await this.writeData(data);
    return cloneCandidate(candidate);
  }

  async update(
    id: string,
    patch: Partial<GroupMemoryCandidateInput> & { status?: GroupMemoryCandidateStatus },
  ): Promise<GroupMemoryCandidate | undefined> {
    const data = await this.readData();
    const index = data.candidates.findIndex((candidate) => candidate.id === id);
    if (index === -1) {
      return undefined;
    }

    const current = data.candidates[index]!;
    const hasSubjectUserId = Object.prototype.hasOwnProperty.call(patch, "subjectUserId");
    const updated = normalizeCandidate({
      ...current,
      ...patch,
      subjectUserId: hasSubjectUserId ? patch.subjectUserId : current.subjectUserId,
      updatedAt: new Date().toISOString(),
    });
    data.candidates[index] = updated;
    await this.writeData(data);
    return cloneCandidate(updated);
  }

  async approve(
    id: string,
    memoryStore: GroupMemoryStore,
    patch: Partial<GroupMemoryInput> = {},
  ): Promise<{ candidate: GroupMemoryCandidate; memory: GroupMemory } | undefined> {
    const data = await this.readData();
    const candidate = data.candidates.find((item) => item.id === id);
    if (!candidate) {
      return undefined;
    }

    const hasSubjectUserId = Object.prototype.hasOwnProperty.call(patch, "subjectUserId");
    const updatedCandidate = normalizeCandidate({
      ...candidate,
      ...patch,
      subjectUserId: hasSubjectUserId ? patch.subjectUserId : candidate.subjectUserId,
      status: "approved",
      updatedAt: new Date().toISOString(),
    });
    Object.assign(candidate, updatedCandidate);

    const memory = await memoryStore.create({
      groupId: updatedCandidate.groupId,
      type: updatedCandidate.type,
      subjectUserId: updatedCandidate.subjectUserId,
      title: updatedCandidate.title,
      content: updatedCandidate.content,
      confidence: updatedCandidate.confidence,
      source: updatedCandidate.source,
      enabled: true,
    });
    await this.writeData(data);
    return {
      candidate: cloneCandidate(updatedCandidate),
      memory,
    };
  }

  async reject(id: string): Promise<GroupMemoryCandidate | undefined> {
    return this.update(id, { status: "rejected" });
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.readData();
    const next = data.candidates.filter((candidate) => candidate.id !== id);
    if (next.length === data.candidates.length) {
      return false;
    }
    data.candidates = next;
    await this.writeData(data);
    return true;
  }

  private async readData(): Promise<GroupMemoryCandidateFile> {
    if (this.cachedData) {
      return this.cachedData;
    }

    try {
      this.cachedData = normalizeCandidateFile(await readJsonFile<GroupMemoryCandidateFile>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const knownError = error as NodeJS.ErrnoException;
      if (knownError.code === "ENOENT") {
        this.cachedData = { candidates: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: GroupMemoryCandidateFile): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeCandidateFile(data: Partial<GroupMemoryCandidateFile>): GroupMemoryCandidateFile {
  return {
    candidates: Array.isArray(data.candidates)
      ? data.candidates.map(normalizeCandidate).filter((candidate): candidate is GroupMemoryCandidate => Boolean(candidate))
      : [],
  };
}

function normalizeCandidate(value: Partial<GroupMemoryCandidate>): GroupMemoryCandidate {
  const now = new Date().toISOString();
  const status = value.status === "approved" || value.status === "rejected" ? value.status : "pending";
  return {
    id: String(value.id || randomUUID()),
    groupId: String(value.groupId || "").trim(),
    type: value.type === "member_profile" ? "member_profile" : "group_fact",
    ...(value.subjectUserId && /^\d+$/.test(String(value.subjectUserId).trim())
      ? { subjectUserId: String(value.subjectUserId).trim() }
      : {}),
    title: String(value.title || "").trim().slice(0, 80),
    content: String(value.content || "").trim().slice(0, 600),
    confidence: normalizeConfidence(value.confidence),
    source: String(value.source || "auto").trim().slice(0, 80),
    status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeConfidence(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.65;
}

function buildCandidateKey(input: {
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
}): string {
  return [
    input.groupId.trim(),
    input.type,
    input.subjectUserId?.trim() ?? "",
    normalizeKeyText(input.title),
    normalizeKeyText(input.content),
  ].join("|");
}

function normalizeKeyText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").slice(0, 120);
}

function cloneCandidate(candidate: GroupMemoryCandidate): GroupMemoryCandidate {
  return { ...candidate };
}
