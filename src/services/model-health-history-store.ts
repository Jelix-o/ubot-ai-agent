import type { AiHealthStatus, SystemModelPurpose } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export interface ModelHealthHistoryEntry extends AiHealthStatus {
  id: string;
  purpose: SystemModelPurpose;
  name: string;
  shortName: string;
  selected: boolean;
  source: "manual" | "overview" | "health" | "runtime";
}

interface ModelHealthHistoryFile {
  models: Record<string, ModelHealthHistoryEntry>;
}

const MAX_MODEL_HEALTH_HISTORY = 200;
const V3_MODEL_HEALTH_DOCUMENT_TYPE = "model-health";

export class ModelHealthHistoryStore {
  private cachedData?: ModelHealthHistoryFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly v3State?: V3StateRepository,
  ) {}

  async list(): Promise<ModelHealthHistoryEntry[]> {
    if (this.v3State) {
      return this.listV3();
    }
    const data = await this.readData();
    return Object.values(data.models).map(cloneEntry).sort((left, right) => left.purpose.localeCompare(right.purpose) || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ModelHealthHistoryEntry | undefined> {
    if (this.v3State) {
      const item = this.v3State.getDocument<Partial<ModelHealthHistoryEntry>>(V3_MODEL_HEALTH_DOCUMENT_TYPE, id, {});
      return item.id ? cloneEntry(normalizeEntry(item)) : undefined;
    }
    const data = await this.readData();
    const entry = data.models[id];
    return entry ? cloneEntry(entry) : undefined;
  }

  async record(entry: ModelHealthHistoryEntry): Promise<ModelHealthHistoryEntry> {
    const normalized = normalizeEntry(entry);
    if (this.v3State) {
      this.v3State.saveDocument(V3_MODEL_HEALTH_DOCUMENT_TYPE, normalized.id, normalized);
      this.pruneV3();
      return cloneEntry(normalized);
    }
    return await this.enqueueWrite(async () => {
      const data = await this.readData();
      data.models[normalized.id] = normalized;
      await this.writeData(normalizeFile(data));
      return cloneEntry(normalized);
    });
  }

  private async readData(): Promise<ModelHealthHistoryFile> {
    if (this.cachedData) return this.cachedData;
    try {
      this.cachedData = normalizeFile(await readJsonFile<Partial<ModelHealthHistoryFile>>(this.filePath));
      return this.cachedData;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        this.cachedData = { models: {} };
        return this.cachedData;
      }
      throw error;
    }
  }

  private listV3(): ModelHealthHistoryEntry[] {
    return this.v3State!.listDocuments<Partial<ModelHealthHistoryEntry>>(V3_MODEL_HEALTH_DOCUMENT_TYPE)
      .map((document) => normalizeEntry(document.value))
      .filter((entry) => Boolean(entry.id))
      .map(cloneEntry)
      .sort((left, right) => left.purpose.localeCompare(right.purpose) || left.id.localeCompare(right.id));
  }

  private pruneV3(): void {
    const entries = this.v3State!.listDocuments<Partial<ModelHealthHistoryEntry>>(V3_MODEL_HEALTH_DOCUMENT_TYPE)
      .map((document) => ({ document, entry: normalizeEntry(document.value) }))
      .filter(({ entry }) => Boolean(entry.id))
      .sort((left, right) => {
        if (left.entry.selected !== right.entry.selected) return left.entry.selected ? -1 : 1;
        return right.entry.checkedAt.localeCompare(left.entry.checkedAt) || left.entry.id.localeCompare(right.entry.id);
      });
    for (const { document } of entries.slice(MAX_MODEL_HEALTH_HISTORY)) {
      this.v3State!.deleteDocument(V3_MODEL_HEALTH_DOCUMENT_TYPE, document.key);
    }
  }

  private async writeData(data: ModelHealthHistoryFile): Promise<void> {
    this.cachedData = data;
    await writeJsonFileAtomic(this.filePath, data);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

function normalizeFile(value: Partial<ModelHealthHistoryFile>): ModelHealthHistoryFile {
  const models: Record<string, ModelHealthHistoryEntry> = {};
  if (value.models && typeof value.models === "object") {
    for (const item of Object.values(value.models)) {
      const entry = normalizeEntry(item as Partial<ModelHealthHistoryEntry>);
      models[entry.id] = entry;
    }
  }
  return { models: pruneModels(models) };
}

function normalizeEntry(value: Partial<ModelHealthHistoryEntry>): ModelHealthHistoryEntry {
  return {
    id: String(value.id || "").trim().slice(0, 80),
    purpose: normalizePurpose(value.purpose),
    name: String(value.name || value.id || "模型").trim().slice(0, 120),
    shortName: String(value.shortName || value.name || value.id || "模型").trim().slice(0, 80),
    selected: value.selected === true,
    ok: value.ok === true,
    detail: String(value.detail || (value.ok ? "ok" : "unknown_error")).trim().slice(0, 500),
    model: String(value.model || "").trim().slice(0, 120),
    baseUrl: String(value.baseUrl || "").trim().slice(0, 300),
    checkedAt: normalizeIso(value.checkedAt) ?? new Date().toISOString(),
    latencyMs: normalizeLatency(value.latencyMs),
    cached: value.cached === true,
    skipped: value.skipped === true,
    source: value.source === "manual" || value.source === "overview" || value.source === "runtime" ? value.source : "health",
  };
}

function normalizePurpose(value: unknown): SystemModelPurpose {
  return value === "reply" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "tts" ||
    value === "custom"
    ? value
    : "custom";
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeLatency(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}

function cloneEntry(entry: ModelHealthHistoryEntry): ModelHealthHistoryEntry {
  return { ...entry };
}

function pruneModels(models: Record<string, ModelHealthHistoryEntry>): Record<string, ModelHealthHistoryEntry> {
  const entries = Object.values(models);
  if (entries.length <= MAX_MODEL_HEALTH_HISTORY) {
    return models;
  }
  const kept = entries
    .sort((left, right) => {
      if (left.selected !== right.selected) {
        return left.selected ? -1 : 1;
      }
      return right.checkedAt.localeCompare(left.checkedAt) || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_MODEL_HEALTH_HISTORY)
    .sort((left, right) => left.id.localeCompare(right.id));
  return Object.fromEntries(kept.map((entry) => [entry.id, entry]));
}
