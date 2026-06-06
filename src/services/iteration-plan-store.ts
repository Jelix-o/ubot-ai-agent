import { randomUUID } from "node:crypto";

import type {
  IterationPlanEvidenceItem,
  IterationPlanRecommendation,
  IterationPlanRecord,
  IterationPlansFile,
  IterationPlanRiskLevel,
  IterationPlanScope,
  IterationPlanStatus,
} from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

const MAX_PLANS = 100;

export interface IterationPlanListArgs {
  status?: IterationPlanStatus;
  scope?: IterationPlanScope;
  q?: string;
  page: number;
  pageSize: number;
}

export interface IterationPlanCreateInput {
  title: string;
  summary: string;
  generatedBy: "ai" | "manual";
  scope: IterationPlanScope;
  goalPrompt: string;
  evidence?: IterationPlanEvidenceItem[];
  recommendations?: IterationPlanRecommendation[];
  riskLevel?: IterationPlanRiskLevel;
}

export class IterationPlanStore {
  private cachedData?: IterationPlansFile;

  constructor(private readonly filePath: string) {}

  async listPage(args: IterationPlanListArgs): Promise<{
    plans: IterationPlanRecord[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const data = await this.readData();
    const query = args.q?.trim().toLowerCase() ?? "";
    const pageSize = Math.max(1, Math.min(100, Math.floor(args.pageSize)));
    const matched = data.plans
      .filter((plan) => !args.status || plan.status === args.status)
      .filter((plan) => !args.scope || plan.scope === args.scope)
      .filter((plan) => !query || planMatchesQuery(plan, query))
      .sort(compareNewestFirst);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.floor(args.page)), totalPages);
    const start = (page - 1) * pageSize;
    return {
      plans: matched.slice(start, start + pageSize).map(clonePlan),
      pagination: { page, pageSize, total, totalPages },
    };
  }

  async list(args: { status?: IterationPlanStatus; limit?: number } = {}): Promise<IterationPlanRecord[]> {
    const data = await this.readData();
    return data.plans
      .filter((plan) => !args.status || plan.status === args.status)
      .sort(compareNewestFirst)
      .slice(0, Math.max(1, Math.min(args.limit ?? 30, MAX_PLANS)))
      .map(clonePlan);
  }

  async get(id: string): Promise<IterationPlanRecord | undefined> {
    const data = await this.readData();
    const plan = data.plans.find((item) => item.id === id);
    return plan ? clonePlan(plan) : undefined;
  }

  async create(input: IterationPlanCreateInput): Promise<IterationPlanRecord> {
    const data = await this.readData();
    const now = new Date().toISOString();
    const plan = normalizePlan({
      id: randomUUID(),
      title: input.title,
      summary: input.summary,
      status: "draft",
      generatedBy: input.generatedBy,
      scope: input.scope,
      goalPrompt: input.goalPrompt,
      evidence: input.evidence ?? [],
      recommendations: input.recommendations ?? [],
      riskLevel: input.riskLevel ?? "medium",
      createdAt: now,
      updatedAt: now,
    });
    data.plans.unshift(plan);
    data.plans = data.plans.slice(0, MAX_PLANS);
    await this.writeData(data);
    return clonePlan(plan);
  }

  async updateStatus(id: string, status: IterationPlanStatus, options: { reason?: string; operatorUserId?: string } = {}): Promise<IterationPlanRecord | undefined> {
    const data = await this.readData();
    const index = data.plans.findIndex((plan) => plan.id === id);
    if (index === -1) return undefined;
    const current = data.plans[index]!;
    const now = new Date().toISOString();
    const next = normalizePlan({
      ...current,
      status,
      ...(status === "applied" ? { appliedAt: now, appliedBy: options.operatorUserId ?? current.appliedBy } : {}),
      ...(status === "rejected" && options.reason ? { rejectionReason: options.reason } : {}),
      updatedAt: now,
    });
    data.plans[index] = next;
    await this.writeData(data);
    return clonePlan(next);
  }

  async recordApplied(id: string, operatorUserId: string): Promise<IterationPlanRecord | undefined> {
    return this.updateStatus(id, "applied", { operatorUserId });
  }

  private async readData(): Promise<IterationPlansFile> {
    if (this.cachedData) return this.cachedData;
    try {
      this.cachedData = normalizeFile(await readJsonFile<Partial<IterationPlansFile>>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = { plans: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: IterationPlansFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }
}

function normalizeFile(value: Partial<IterationPlansFile>): IterationPlansFile {
  return {
    plans: Array.isArray(value.plans)
      ? value.plans.map(normalizePlan).filter((plan): plan is IterationPlanRecord => Boolean(plan)).slice(0, MAX_PLANS)
      : [],
  };
}

function normalizePlan(value: Partial<IterationPlanRecord>): IterationPlanRecord {
  const now = new Date().toISOString();
  return {
    id: String(value.id || randomUUID()),
    title: normalizeText(value.title || "自我迭代开发计划", 120),
    summary: normalizeText(value.summary, 2400),
    status: normalizeStatus(value.status),
    generatedBy: value.generatedBy === "manual" ? "manual" : "ai",
    scope: normalizeScope(value.scope),
    goalPrompt: normalizeText(value.goalPrompt, 20000),
    evidence: normalizeEvidence(value.evidence),
    recommendations: normalizeRecommendations(value.recommendations),
    riskLevel: normalizeRisk(value.riskLevel),
    createdAt: normalizeIso(value.createdAt) ?? now,
    updatedAt: normalizeIso(value.updatedAt) ?? now,
    ...(normalizeIso(value.appliedAt) ? { appliedAt: normalizeIso(value.appliedAt) } : {}),
    ...(normalizeText(value.appliedBy, 80) ? { appliedBy: normalizeText(value.appliedBy, 80) } : {}),
    ...(normalizeText(value.rejectionReason, 500) ? { rejectionReason: normalizeText(value.rejectionReason, 500) } : {}),
  };
}

function normalizeStatus(value: unknown): IterationPlanStatus {
  return value === "approved" || value === "applied" || value === "rejected" ? value : "draft";
}

function normalizeScope(value: unknown): IterationPlanScope {
  return value === "code" || value === "config" || value === "data" ? value : "mixed";
}

function normalizeRisk(value: unknown): IterationPlanRiskLevel {
  return value === "low" || value === "high" ? value : "medium";
}

function normalizeEvidence(value: unknown): IterationPlanEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<IterationPlanEvidenceItem>;
      const title = normalizeText(record.title, 160);
      const detail = normalizeText(record.detail, 1200);
      if (!title || !detail) return undefined;
      return {
        type: normalizeText(record.type || "evidence", 60),
        title,
        detail,
        ...(normalizeText(record.groupId, 80) ? { groupId: normalizeText(record.groupId, 80) } : {}),
        ...(normalizeText(record.entityId, 120) ? { entityId: normalizeText(record.entityId, 120) } : {}),
      };
    })
    .filter((item): item is IterationPlanEvidenceItem => Boolean(item))
    .slice(0, 80);
}

function normalizeRecommendations(value: unknown): IterationPlanRecommendation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<IterationPlanRecommendation>;
      const title = normalizeText(record.title, 160);
      const detail = normalizeText(record.detail, 1600);
      if (!title || !detail) return undefined;
      return {
        type: normalizeRecommendationType(record.type),
        title,
        detail,
        ...(normalizeAction(record.action) ? { action: normalizeAction(record.action) } : {}),
        ...(normalizeText(record.targetId, 120) ? { targetId: normalizeText(record.targetId, 120) } : {}),
        ...(record.patch !== undefined ? { patch: record.patch } : {}),
      };
    })
    .filter((item): item is IterationPlanRecommendation => Boolean(item))
    .slice(0, 40);
}

function normalizeRecommendationType(value: unknown): IterationPlanRecommendation["type"] {
  return value === "skill" || value === "config" || value === "data" ? value : "code";
}

function normalizeAction(value: unknown): IterationPlanRecommendation["action"] | undefined {
  return value === "approve_candidates" ||
    value === "reject_candidates" ||
    value === "disable_knowledge" ||
    value === "enable_knowledge" ||
    value === "skill_patch" ||
    value === "group_config_patch"
    ? value
    : undefined;
}

function normalizeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function planMatchesQuery(plan: IterationPlanRecord, query: string): boolean {
  return [
    plan.id,
    plan.title,
    plan.summary,
    plan.status,
    plan.generatedBy,
    plan.scope,
    plan.riskLevel,
    plan.goalPrompt,
    plan.rejectionReason,
    ...plan.evidence.flatMap((item) => [item.type, item.title, item.detail, item.groupId, item.entityId]),
    ...plan.recommendations.flatMap((item) => [item.type, item.title, item.detail, item.action, item.targetId]),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function compareNewestFirst(left: IterationPlanRecord, right: IterationPlanRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function clonePlan(plan: IterationPlanRecord): IterationPlanRecord {
  return {
    ...plan,
    evidence: plan.evidence.map((item) => ({ ...item })),
    recommendations: plan.recommendations.map((item) => ({ ...item })),
  };
}
