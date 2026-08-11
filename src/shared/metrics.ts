import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight in-process metrics persisted to `data/shared/metrics/` — one file
 * per process (`metrics-<process>.json`) so multiple processes never clobber
 * each other. The admin process aggregates the whole directory for the
 * "系统状态" page; the worker reads it to back the `#状态` command.
 *
 * Metric ids follow the upgrade plan section 6:
 *   1 msg_ingress_qps              (ingress)
 *   2 llm_latency_p95              (worker/gateway)
 *   3 llm_error_rate               (worker/gateway)
 *   4 end_to_end_reply_latency_p95 (worker)
 *   5 per_key_queue_depth_max      (router)
 *   6 dedup_hit_rate               (ingress)
 *   7 duplicate_reply_rate         (worker, audit marker)
 *   8 image_stage1_failure_rate    (worker)
 *   11 cancelled_task_rate         (worker)
 *   13 bot_self_trigger_blocked    (ingress)
 */

const MAX_LATENCY_SAMPLES = 500;

export interface MetricsSnapshot {
  process: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  latencySamples: Record<string, number[]>;
}

export interface MetricsSummary {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  latencyP95: Record<string, number>;
  updatedAt: string;
}

export class Metrics {
  private readonly counters: Record<string, number> = {};
  private readonly gauges: Record<string, number> = {};
  private readonly latencySamples: Record<string, number[]> = {};
  private readonly flushTimer: NodeJS.Timeout;
  private readonly dir: string;
  private readonly startedAt = new Date().toISOString();
  private readonly processName: string;

  constructor(metricsDir: string, options: { processName?: string; flushIntervalMs?: number } = {}) {
    this.dir = metricsDir;
    this.processName = options.processName ?? "unknown";
    const flushIntervalMs = options.flushIntervalMs ?? 30_000;
    this.flushTimer = setInterval(() => {
      try {
        this.flush();
      } catch {
        // Best-effort persistence; ignore write failures.
      }
    }, flushIntervalMs);
    this.flushTimer.unref();
  }

  inc(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  setGauge(name: string, value: number): void {
    this.gauges[name] = value;
  }

  observeLatency(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      return;
    }
    const samples = this.latencySamples[name] ?? (this.latencySamples[name] = []);
    samples.push(ms);
    if (samples.length > MAX_LATENCY_SAMPLES) {
      samples.splice(0, samples.length - MAX_LATENCY_SAMPLES);
    }
    this.counters[`${name}:count`] = (this.counters[`${name}:count`] ?? 0) + 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      process: this.processName,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      latencySamples: Object.fromEntries(
        Object.entries(this.latencySamples).map(([name, samples]) => [name, [...samples]]),
      ),
    };
  }

  flush(): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `metrics-${this.processName}.json`);
    writeFileSync(file, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
  }

  stop(): void {
    clearInterval(this.flushTimer);
    this.flush();
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function readSnapshotFiles(metricsDir: string): MetricsSnapshot[] {
  const snapshots: MetricsSnapshot[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(metricsDir);
  } catch {
    return snapshots;
  }
  for (const entry of entries) {
    if (!entry.startsWith("metrics-") || !entry.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(metricsDir, entry), "utf8")) as MetricsSnapshot;
      if (parsed && typeof parsed === "object" && typeof parsed.counters === "object") {
        snapshots.push(parsed);
      }
    } catch {
      // Ignore corrupt or half-written files (atomic rename not used here).
    }
  }
  return snapshots;
}

/**
 * Reads all `metrics-*.json` under the directory and aggregates them
 * (counters summed, gauges maxed, p95 across all latency samples).
 */
export function readMetricsSummary(metricsDir: string): MetricsSummary {
  const snapshots = readSnapshotFiles(metricsDir);

  const counters: Record<string, number> = {};
  const gauges: Record<string, number> = {};
  const allLatencySamples: Record<string, number[]> = {};
  let updatedAt = "";

  for (const snapshot of snapshots) {
    if (snapshot.updatedAt > updatedAt) {
      updatedAt = snapshot.updatedAt;
    }
    for (const [key, value] of Object.entries(snapshot.counters ?? {})) {
      counters[key] = (counters[key] ?? 0) + (typeof value === "number" ? value : 0);
    }
    for (const [key, value] of Object.entries(snapshot.gauges ?? {})) {
      if (typeof value === "number") {
        gauges[key] = Math.max(gauges[key] ?? 0, value);
      }
    }
    for (const [name, samples] of Object.entries(snapshot.latencySamples ?? {})) {
      if (!Array.isArray(samples)) {
        continue;
      }
      const target = allLatencySamples[name] ?? (allLatencySamples[name] = []);
      for (const sample of samples) {
        if (typeof sample === "number" && Number.isFinite(sample)) {
          target.push(sample);
        }
      }
    }
  }

  const latencyP95: Record<string, number> = {};
  for (const [name, samples] of Object.entries(allLatencySamples)) {
    latencyP95[name] = percentile(samples, 95);
  }

  return { counters, gauges, latencyP95, updatedAt };
}
