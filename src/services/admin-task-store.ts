import { randomUUID } from "node:crypto";
import type { AdminTaskRecord, AdminTasksFile, AdminTaskStatus, AdminTaskType } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export interface AdminTaskListArgs {
  type?: AdminTaskType;
  status?: AdminTaskStatus;
  groupId?: string;
  visibleGroupIds?: string[];
  includeSystemTasks?: boolean;
  q?: string;
  page: number;
  pageSize: number;
}

export interface AdminTaskCreateInput {
  type: AdminTaskType;
  title: string;
  groupId?: string;
  subjectUserId?: string;
  operatorUserId: string;
  detail?: string;
}

export type AdminTaskProgressUpdater = (progress: number, detail?: string) => Promise<AdminTaskRecord | undefined>;

const MAX_TASKS = 200;
const DEFAULT_STALE_TASK_MS = 30 * 60 * 1000;
const STALE_TASK_MS_BY_TYPE: Partial<Record<AdminTaskType, number>> = {
  "memory-dedup": 12 * 60 * 1000,
  "model-check": 10 * 60 * 1000,
};
const V3_ADMIN_TASK_DOCUMENT_TYPE = "admin-task";

export class AdminTaskStore {
  private cachedData?: AdminTasksFile;
  private readonly activeTaskStartedAt = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    private readonly v3State?: V3StateRepository,
  ) {}

  async listPage(args: AdminTaskListArgs): Promise<{
    tasks: AdminTaskRecord[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    await this.failStaleTasks();
    const data = await this.readData();
    const pageSize = Math.max(1, Math.min(100, Math.floor(args.pageSize)));
    const visibleGroupIds = args.visibleGroupIds ? new Set(args.visibleGroupIds) : undefined;
    const matched = data.tasks
      .filter((task) => !args.type || task.type === args.type)
      .filter((task) => !args.status || task.status === args.status)
      .filter((task) => !args.groupId || task.groupId === args.groupId)
      .filter((task) => {
        if (!visibleGroupIds) return true;
        if (!task.groupId) return args.includeSystemTasks === true;
        return visibleGroupIds.has(task.groupId);
      })
      .filter((task) => !args.q || taskMatchesQuery(task, args.q))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.floor(args.page)), totalPages);
    const start = (page - 1) * pageSize;
    return {
      tasks: matched.slice(start, start + pageSize).map(cloneTask),
      pagination: { page, pageSize, total, totalPages },
    };
  }

  async get(id: string): Promise<AdminTaskRecord | undefined> {
    await this.failStaleTasks();
    const data = await this.readData();
    const task = data.tasks.find((item) => item.id === id);
    return task ? cloneTask(task) : undefined;
  }

  async create(input: AdminTaskCreateInput): Promise<AdminTaskRecord> {
    if (this.v3State) {
      const now = new Date().toISOString();
      const task = normalizeTask({
        id: randomUUID(),
        type: input.type,
        status: "queued",
        title: input.title,
        groupId: input.groupId,
        subjectUserId: input.subjectUserId,
        operatorUserId: input.operatorUserId,
        progress: 0,
        detail: input.detail,
        createdAt: now,
        updatedAt: now,
      });
      this.v3State.saveDocument(V3_ADMIN_TASK_DOCUMENT_TYPE, task.id, task);
      this.pruneV3Tasks();
      return cloneTask(task);
    }
    const data = await this.readData();
    const now = new Date().toISOString();
    const task = normalizeTask({
      id: randomUUID(),
      type: input.type,
      status: "queued",
      title: input.title,
      groupId: input.groupId,
      subjectUserId: input.subjectUserId,
      operatorUserId: input.operatorUserId,
      progress: 0,
      detail: input.detail,
      createdAt: now,
      updatedAt: now,
    });
    data.tasks.unshift(task);
    data.tasks = data.tasks.slice(0, MAX_TASKS);
    await this.writeData(data);
    return cloneTask(task);
  }

  async update(id: string, input: Partial<AdminTaskRecord>): Promise<AdminTaskRecord | undefined> {
    if (this.v3State) {
      const current = await this.getV3Task(id);
      if (!current) return undefined;
      const next = normalizeTask({
        ...current,
        ...input,
        id: current.id,
        type: current.type,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      this.v3State.saveDocument(V3_ADMIN_TASK_DOCUMENT_TYPE, id, next);
      return cloneTask(next);
    }
    const data = await this.readData();
    const index = data.tasks.findIndex((task) => task.id === id);
    if (index === -1) return undefined;
    const current = data.tasks[index]!;
    const now = new Date().toISOString();
    const next = normalizeTask({
      ...current,
      ...input,
      id: current.id,
      type: current.type,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    data.tasks[index] = next;
    await this.writeData(data);
    return cloneTask(next);
  }

  async run<T>(
    input: AdminTaskCreateInput,
    worker: (task: AdminTaskRecord, updateProgress: AdminTaskProgressUpdater) => Promise<T>,
  ): Promise<{ task: AdminTaskRecord; result: T }> {
    const task = await this.create(input);
    return await this.execute(task, worker);
  }

  async start<T>(
    input: AdminTaskCreateInput,
    worker: (task: AdminTaskRecord, updateProgress: AdminTaskProgressUpdater) => Promise<T>,
  ): Promise<AdminTaskRecord> {
    const task = await this.create(input);
    setTimeout(() => {
      void this.execute(task, worker).catch(() => undefined);
    }, 0);
    return task;
  }

  async sweepStaleTasks(now = new Date()): Promise<void> {
    await this.failStaleTasks(now);
  }

  private async execute<T>(
    task: AdminTaskRecord,
    worker: (task: AdminTaskRecord, updateProgress: AdminTaskProgressUpdater) => Promise<T>,
  ): Promise<{ task: AdminTaskRecord; result: T }> {
    const startedAt = new Date().toISOString();
    this.activeTaskStartedAt.set(task.id, new Date(startedAt).getTime());
    const updateProgress: AdminTaskProgressUpdater = async (progress, detail) => {
      const current = (await this.readData()).tasks.find((item) => item.id === task.id);
      if (!current || current.status !== "running") {
        return current ? cloneTask(current) : undefined;
      }
      return await this.update(task.id, {
        progress,
        ...(detail ? { detail } : {}),
      });
    };
    try {
      await this.update(task.id, { status: "running", progress: 10, startedAt });
      const result = await worker(task, updateProgress);
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
      const current = (await this.readData()).tasks.find((item) => item.id === task.id);
      if (current && current.status !== "running") {
        return { task: cloneTask(current), result };
      }
      const finished = await this.update(task.id, {
        status: "succeeded",
        progress: 100,
        result,
        finishedAt,
        durationMs,
      });
      return { task: finished ?? task, result };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
      await this.update(task.id, {
        status: "failed",
        progress: 100,
        error: error instanceof Error ? error.message : String(error),
        finishedAt,
        durationMs,
      });
      throw error;
    } finally {
      this.activeTaskStartedAt.delete(task.id);
    }
  }

  private async failStaleTasks(now = new Date()): Promise<void> {
    if (this.v3State) {
      const nowTime = now.getTime();
      for (const task of await this.listV3Tasks()) {
        if (task.status !== "queued" && task.status !== "running") continue;
        const activeStartedAt = this.activeTaskStartedAt.get(task.id);
        const baseTime = activeStartedAt ?? new Date(task.startedAt ?? task.updatedAt ?? task.createdAt).getTime();
        if (!Number.isFinite(baseTime) || nowTime - baseTime < (STALE_TASK_MS_BY_TYPE[task.type] ?? DEFAULT_STALE_TASK_MS)) continue;
        if (activeStartedAt !== undefined) this.activeTaskStartedAt.delete(task.id);
        const finishedAt = now.toISOString();
        const updated = normalizeTask({
          ...task,
          status: "failed",
          progress: 100,
          error: `任务执行超时，已自动标记失败。最后状态：${task.status}`,
          updatedAt: finishedAt,
          finishedAt,
          durationMs: Math.max(0, nowTime - new Date(task.startedAt ?? task.createdAt).getTime()),
        });
        this.v3State.saveDocument(V3_ADMIN_TASK_DOCUMENT_TYPE, updated.id, updated);
      }
      return;
    }
    const data = await this.readData();
    let changed = false;
    const nowTime = now.getTime();
    data.tasks = data.tasks.map((task) => {
      if (task.status !== "queued" && task.status !== "running") {
        return task;
      }
      const activeStartedAt = this.activeTaskStartedAt.get(task.id);
      const baseTime = activeStartedAt ?? new Date(task.startedAt ?? task.updatedAt ?? task.createdAt).getTime();
      if (!Number.isFinite(baseTime)) {
        return task;
      }
      const staleMs = STALE_TASK_MS_BY_TYPE[task.type] ?? DEFAULT_STALE_TASK_MS;
      if (nowTime - baseTime < staleMs) {
        return task;
      }
      if (activeStartedAt !== undefined) {
        this.activeTaskStartedAt.delete(task.id);
      }
      changed = true;
      const finishedAt = now.toISOString();
      const startedAt = task.startedAt ?? task.createdAt;
      return normalizeTask({
        ...task,
        status: "failed",
        progress: 100,
        error: `任务执行超时，已自动标记失败。最后状态：${task.status}`,
        updatedAt: finishedAt,
        finishedAt,
        durationMs: Math.max(0, nowTime - new Date(startedAt).getTime()),
      });
    });
    if (changed) {
      await this.writeData(data);
    }
  }

  private async readData(): Promise<AdminTasksFile> {
    if (this.v3State) {
      return { tasks: await this.listV3Tasks() };
    }
    if (this.cachedData) return this.cachedData;
    try {
      this.cachedData = normalizeFile(await readJsonFile<Partial<AdminTasksFile>>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = { tasks: [] };
        return this.cachedData;
      }
      throw error;
    }
  }

  private async writeData(data: AdminTasksFile): Promise<void> {
    if (this.v3State) {
      throw new Error("v3_state_repository_requires_operation_level_writes");
    }
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }

  private async getV3Task(id: string): Promise<AdminTaskRecord | undefined> {
    const value = this.v3State!.getDocument<Partial<AdminTaskRecord>>(V3_ADMIN_TASK_DOCUMENT_TYPE, id, {});
    return parsePersistedTask(value, id);
  }

  private async listV3Tasks(): Promise<AdminTaskRecord[]> {
    return this.v3State!.listDocuments<Partial<AdminTaskRecord>>(V3_ADMIN_TASK_DOCUMENT_TYPE)
      .flatMap((document) => {
        const task = parsePersistedTask(document.value, document.key);
        return task ? [task] : [];
      });
  }

  private pruneV3Tasks(): void {
    const documents = this.v3State!.listDocuments<Partial<AdminTaskRecord>>(V3_ADMIN_TASK_DOCUMENT_TYPE)
      .flatMap((document) => {
        const task = parsePersistedTask(document.value, document.key);
        return task ? [{ document, task }] : [];
      })
      .sort((left, right) => right.task.createdAt.localeCompare(left.task.createdAt));
    for (const { document } of documents.slice(MAX_TASKS)) {
      this.v3State!.deleteDocument(V3_ADMIN_TASK_DOCUMENT_TYPE, document.key);
    }
  }
}

function normalizeFile(value: Partial<AdminTasksFile>): AdminTasksFile {
  return {
    tasks: Array.isArray(value.tasks)
      ? value.tasks.map(normalizeTask).filter((task): task is AdminTaskRecord => Boolean(task)).slice(0, MAX_TASKS)
      : [],
  };
}

/**
 * V3 document rows are untrusted persisted input.  Never run malformed rows
 * through normalizeTask here: it synthesizes a new UUID for create paths,
 * which would make a corrupt document appear as a real task on every read.
 */
function parsePersistedTask(value: Partial<AdminTaskRecord>, documentKey: string): AdminTaskRecord | undefined {
  if (
    typeof value.id !== "string" ||
    value.id !== documentKey ||
    !value.id.trim() ||
    !isAdminTaskType(value.type) ||
    !isAdminTaskStatus(value.status) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.operatorUserId !== "string" ||
    !value.operatorUserId.trim() ||
    !normalizeIso(value.createdAt) ||
    !normalizeIso(value.updatedAt)
  ) {
    return undefined;
  }
  return normalizeTask(value);
}

function normalizeTask(value: Partial<AdminTaskRecord>): AdminTaskRecord {
  const now = new Date().toISOString();
  const status = normalizeStatus(value.status);
  const startedAt = normalizeIso(value.startedAt);
  const finishedAt = normalizeIso(value.finishedAt);
  return {
    id: String(value.id || randomUUID()),
    type: normalizeType(value.type),
    status,
    title: String(value.title || "后台任务").trim().slice(0, 120),
    ...(optionalString(value.groupId) ? { groupId: optionalString(value.groupId) } : {}),
    ...(optionalString(value.subjectUserId) ? { subjectUserId: optionalString(value.subjectUserId) } : {}),
    operatorUserId: String(value.operatorUserId || "system").trim().slice(0, 80),
    progress: normalizeProgress(value.progress),
    ...(optionalString(value.detail) ? { detail: optionalString(value.detail)?.slice(0, 500) } : {}),
    ...(optionalString(value.error) ? { error: optionalString(value.error)?.slice(0, 500) } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    createdAt: normalizeIso(value.createdAt) ?? now,
    updatedAt: normalizeIso(value.updatedAt) ?? now,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? { durationMs: Math.max(0, Math.floor(value.durationMs)) } : {}),
  };
}

function normalizeType(value: unknown): AdminTaskType {
  return isAdminTaskType(value) ? value : "memory-dedup";
}

function normalizeStatus(value: unknown): AdminTaskStatus {
  return isAdminTaskStatus(value) ? value : "succeeded";
}

function isAdminTaskType(value: unknown): value is AdminTaskType {
  return value === "memory-dedup" || value === "model-check" || value === "bulk-review";
}

function isAdminTaskStatus(value: unknown): value is AdminTaskStatus {
  return value === "queued" || value === "running" || value === "failed" || value === "cancelled" || value === "succeeded";
}

function normalizeProgress(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.min(100, Math.floor(numberValue))) : 0;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cloneTask(task: AdminTaskRecord): AdminTaskRecord {
  return { ...task, ...(task.result !== undefined ? { result: structuredClone(task.result) } : {}) };
}

function taskMatchesQuery(task: AdminTaskRecord, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const resultText = task.result === undefined ? "" : safeStringify(task.result);
  return [
    task.id,
    task.type,
    task.status,
    task.title,
    task.groupId,
    task.subjectUserId,
    task.operatorUserId,
    task.detail,
    task.error,
    resultText,
  ].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
