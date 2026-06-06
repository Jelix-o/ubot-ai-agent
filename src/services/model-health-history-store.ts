import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AiHealthStatus, SystemModelPurpose } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

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

export class ModelHealthHistoryStore {
  private cachedData?: ModelHealthHistoryFile;

  constructor(private readonly filePath: string) {}

  async list(): Promise<ModelHealthHistoryEntry[]> {
    const data = await this.readData();
    return Object.values(data.models).map(cloneEntry).sort((left, right) => left.purpose.localeCompare(right.purpose) || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ModelHealthHistoryEntry | undefined> {
    const data = await this.readData();
    const entry = data.models[id];
    return entry ? cloneEntry(entry) : undefined;
  }

  async record(entry: ModelHealthHistoryEntry): Promise<ModelHealthHistoryEntry> {
    const data = await this.readData();
    const normalized = normalizeEntry(entry);
    data.models[normalized.id] = normalized;
    await this.writeData(data);
    return cloneEntry(normalized);
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

  private async writeData(data: ModelHealthHistoryFile): Promise<void> {
    this.cachedData = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
  return { models };
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
    source: value.source === "manual" || value.source === "overview" || value.source === "runtime" ? value.source : "health",
  };
}

function normalizePurpose(value: unknown): SystemModelPurpose {
  return value === "reply" ||
    value === "profile" ||
    value === "memory" ||
    value === "dedup" ||
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
