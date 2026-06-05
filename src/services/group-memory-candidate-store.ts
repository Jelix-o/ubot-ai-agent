import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  GroupMemory,
  GroupMemoryCandidate,
  GroupMemoryCandidateStatus,
  GroupMemoryEvidence,
  GroupMemoryType,
} from "../types.js";
import { readJsonFile } from "../utils/json-file.js";
import { type GroupMemoryInput, GroupMemoryStore } from "./group-memory-store.js";

const EVIDENCE_SUMMARY_LIMIT = 2400;

interface GroupMemoryCandidateFile {
  candidates: GroupMemoryCandidate[];
}

export interface GroupMemoryCandidateListPageArgs {
  groupId?: string;
  status?: GroupMemoryCandidateStatus;
  subjectUserId?: string;
  type?: GroupMemoryType;
  query?: string;
  page: number;
  pageSize: number;
}

export interface GroupMemoryCandidateListPageResult {
  items: GroupMemoryCandidate[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export type GroupMemoryCandidateInput = {
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence?: number;
  source?: string;
  evidence?: GroupMemoryEvidence;
};

export interface GroupMemoryCandidateAddResult {
  candidate: GroupMemoryCandidate;
  created: boolean;
}

export interface SubjectCount {
  userId: string;
  count: number;
}

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

  async get(id: string): Promise<GroupMemoryCandidate | undefined> {
    const data = await this.readData();
    const candidate = data.candidates.find((item) => item.id === id);
    return candidate ? cloneCandidate(candidate) : undefined;
  }

  async listPage(args: GroupMemoryCandidateListPageArgs): Promise<GroupMemoryCandidateListPageResult> {
    const data = await this.readData();
    const query = normalizeSearchQuery(args.query);
    const pageSize = Math.max(1, args.pageSize);
    const matched = data.candidates
      .filter((candidate) => !args.groupId || candidate.groupId === args.groupId)
      .filter((candidate) => !args.status || candidate.status === args.status)
      .filter((candidate) => !args.subjectUserId || candidate.subjectUserId === args.subjectUserId)
      .filter((candidate) => !args.type || candidate.type === args.type)
      .filter((candidate) => !query || candidateMatchesQuery(candidate, query))
      .sort(compareCandidatesNewestFirst);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, args.page), totalPages);
    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map(cloneCandidate),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  async countPendingBySubject(groupId: string): Promise<SubjectCount[]> {
    const data = await this.readData();
    const counts = new Map<string, number>();
    for (const candidate of data.candidates) {
      if (candidate.groupId !== groupId || candidate.status !== "pending" || !candidate.subjectUserId) {
        continue;
      }
      counts.set(candidate.subjectUserId, (counts.get(candidate.subjectUserId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([userId, count]) => ({ userId, count }));
  }

  async addCandidate(input: GroupMemoryCandidateInput): Promise<GroupMemoryCandidate> {
    const result = await this.addCandidateWithResult(input);
    return result.candidate;
  }

  async addCandidateWithResult(input: GroupMemoryCandidateInput): Promise<GroupMemoryCandidateAddResult> {
    const data = await this.readData();
    const normalizedKey = buildCandidateKey(input);
    const existing = data.candidates.find((candidate) => buildCandidateKey(candidate) === normalizedKey);
    const now = new Date().toISOString();

    if (existing) {
      existing.title = input.title.trim().slice(0, 80) || existing.title;
      existing.content = input.content.trim().slice(0, 600) || existing.content;
      existing.confidence = normalizeConfidence(input.confidence ?? existing.confidence);
      existing.source = input.source?.trim().slice(0, 80) || existing.source;
      existing.evidence = normalizeEvidence(input.evidence) ?? existing.evidence;
      existing.updatedAt = now;
      if (existing.status === "rejected") {
        existing.status = "pending";
      }
      await this.writeData(data);
      return { candidate: cloneCandidate(existing), created: false };
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
      ...(input.evidence ? { evidence: input.evidence } : {}),
    });
    data.candidates.push(candidate);
    await this.writeData(data);
    return { candidate: cloneCandidate(candidate), created: true };
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
    if (candidate.status !== "pending") {
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
      evidence: updatedCandidate.evidence,
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
  const type = value.type === "member_profile" ? "member_profile" : "group_fact";
  return {
    id: String(value.id || randomUUID()),
    groupId: String(value.groupId || "").trim(),
    type,
    ...(type === "member_profile" && value.subjectUserId && /^\d+$/.test(String(value.subjectUserId).trim())
      ? { subjectUserId: String(value.subjectUserId).trim() }
      : {}),
    title: String(value.title || "").trim().slice(0, 80),
    content: String(value.content || "").trim().slice(0, 600),
    confidence: normalizeConfidence(value.confidence),
    source: String(value.source || "auto").trim().slice(0, 80),
    status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    ...(normalizeEvidence(value.evidence) ? { evidence: normalizeEvidence(value.evidence) } : {}),
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

function compareCandidatesNewestFirst(left: GroupMemoryCandidate, right: GroupMemoryCandidate): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function cloneCandidate(candidate: GroupMemoryCandidate): GroupMemoryCandidate {
  return {
    ...candidate,
    ...(candidate.evidence
      ? {
          evidence: {
            ...candidate.evidence,
            speakers: candidate.evidence.speakers.map((speaker) => ({ ...speaker })),
          },
        }
      : {}),
  };
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function candidateMatchesQuery(candidate: GroupMemoryCandidate, query: string): boolean {
  return [
    candidate.id,
    candidate.groupId,
    candidate.type,
    candidate.status,
    candidate.subjectUserId,
    candidate.title,
    candidate.content,
    candidate.source,
    candidate.evidence?.summary,
    ...(candidate.evidence?.speakers.map((speaker) => `${speaker.userId} ${speaker.userName}`) ?? []),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function normalizeEvidence(value: GroupMemoryCandidate["evidence"] | undefined): GroupMemoryEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const startAt = typeof value.startAt === "string" ? value.startAt.trim() : "";
  const endAt = typeof value.endAt === "string" ? value.endAt.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, EVIDENCE_SUMMARY_LIMIT) : "";
  const messageCount =
    typeof value.messageCount === "number" && Number.isFinite(value.messageCount)
      ? Math.max(0, Math.floor(value.messageCount))
      : 0;
  const speakers = Array.isArray(value.speakers)
    ? value.speakers
        .map((speaker) => ({
          userId: String(speaker?.userId ?? "").trim(),
          userName: String(speaker?.userName ?? "").trim().slice(0, 80),
        }))
        .filter((speaker) => /^\d+$/.test(speaker.userId))
        .slice(0, 20)
    : [];

  if (!startAt || !endAt || !summary) {
    return undefined;
  }

  return {
    startAt,
    endAt,
    messageCount,
    speakers,
    summary,
  };
}
