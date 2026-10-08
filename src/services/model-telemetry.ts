import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SharedDb } from "../shared/sqlite.js";

export interface ModelRequestRecord {
  id: string; operationId: string; groupId: string; modelId: string; model: string;
  purpose: string; probe: boolean; startedAt: number; durationMs: number;
  status: "succeeded" | "failed" | "cancelled";
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  images: number; actualAmount: number | null; currency: string | null;
}
export interface ModelOperationContext { operationId: string; groupId?: string; purpose?: string; modelId?: string; probe?: boolean }
const context = new AsyncLocalStorage<ModelOperationContext>();
let sink: ModelTelemetryStore | undefined;
export function setModelTelemetryStore(store: ModelTelemetryStore | undefined): void { sink = store; }
export function withModelOperation<T>(purpose: string, groupId: string | undefined, callback: () => T, modelId?: string): T {
  const parent = context.getStore();
  return context.run({ ...parent, operationId: parent?.operationId ?? randomUUID(), purpose,
    ...(groupId ? { groupId } : {}), ...(modelId ? { modelId } : {}), probe: purpose === "probe" || parent?.probe === true }, callback);
}
export function currentModelOperation(): ModelOperationContext | undefined { return context.getStore(); }
const token = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function recordModelRequest(input: { startedAt: number; model: string; status: ModelRequestRecord["status"]; response?: any; images?: number; operation?: ModelOperationContext }): void {
  if (!sink) return;
  const op = input.operation ?? context.getStore();
  const usage = input.response?.usage;
  // Only explicit actual billing objects are accepted. Unqualified cost fields,
  // credits, and token-rate calculations are deliberately never treated as money.
  const billing = input.response?.billing ?? input.response?.actual_cost;
  const amount = token(typeof billing?.amount === "string" && /^\d+(\.\d+)?$/.test(billing.amount) ? Number(billing.amount) : billing?.amount);
  const currency = typeof billing?.currency === "string" && /^[A-Z]{3}$/.test(billing.currency) ? billing.currency : null;
  const inputTokens = token(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = token(usage?.completion_tokens ?? usage?.output_tokens);
  try { sink.record({ id: randomUUID(), operationId: op?.operationId ?? randomUUID(), groupId: op?.groupId ?? "",
    modelId: op?.modelId ?? input.model, model: input.response?.model ?? input.model, purpose: op?.purpose ?? "reply", probe: op?.probe === true,
    startedAt: input.startedAt, durationMs: Math.max(0, Date.now() - input.startedAt), status: input.status,
    inputTokens, outputTokens,
    totalTokens: token(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    images: input.images ?? 0, actualAmount: currency ? amount : null, currency: amount !== null ? currency : null });
  } catch { /* Telemetry must never interrupt a model response. */ }
}
export function instrumentCompletions<T extends { create: (...args: any[]) => any }>(client: T, model: string): T {
  return new Proxy(client, { get(target, property) {
    if (property !== "create") return Reflect.get(target, property);
    return async (...args: any[]) => {
      const startedAt = Date.now(); const operation = context.getStore();
      try {
        const result = await target.create(...args);
        if (result && typeof result[Symbol.asyncIterator] === "function") {
          return (async function* () {
            let last: any = {}; let status: ModelRequestRecord["status"] = "cancelled";
            try {
              for await (const chunk of result) {
                for (const key of ["model", "usage", "billing", "actual_cost"]) if (chunk[key] != null) last[key] = chunk[key];
                yield chunk;
              }
              status = "succeeded";
            } catch (error) { status = isCancelled(error) ? "cancelled" : "failed"; throw error; }
            finally { recordModelRequest({ startedAt, model, response: last, status, operation }); }
          })();
        }
        recordModelRequest({ startedAt, model, response: result, status: "succeeded", operation }); return result;
      } catch (error) {
        // A provider capability refusal is local; it did not send a model request.
        if (!(error instanceof Error && error.message === "anthropic_stream_unsupported")) recordModelRequest({ startedAt, model, status: isCancelled(error) ? "cancelled" : "failed", operation });
        throw error;
      }
    };
  } });
}
function isCancelled(error: unknown): boolean { return error instanceof Error && (error.name === "AbortError" || /cancelled/i.test(error.message)); }
export function beijingDay(time: number): string { return new Date(time + 8 * 3600_000).toISOString().slice(0, 10); }
const buckets = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 180000, 300000, Infinity];
interface Aggregate { calls: number; succeeded: number; failed: number; cancelled: number; durationMs: number; inputTokens: number; outputTokens: number; totalTokens: number; usageCount: number; images: number; billingCount: number; charges: Record<string, number>; histogram: number[] }
function empty(): Aggregate { return { calls: 0, succeeded: 0, failed: 0, cancelled: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageCount: 0, images: 0, billingCount: 0, charges: {}, histogram: buckets.map(() => 0) }; }
function add(a: Aggregate, b: Aggregate): Aggregate { for (const key of ["calls", "succeeded", "failed", "cancelled", "durationMs", "inputTokens", "outputTokens", "totalTokens", "usageCount", "images", "billingCount"] as const) a[key] += b[key]; for (const [c, amount] of Object.entries(b.charges)) a.charges[c] = (a.charges[c] ?? 0) + amount; b.histogram.forEach((n, i) => a.histogram[i] += n); return a; }
function aggregate(r: ModelRequestRecord): Aggregate { const a = empty(); a.calls = 1; a[r.status] = 1; a.durationMs = r.durationMs; a.inputTokens = r.inputTokens ?? 0; a.outputTokens = r.outputTokens ?? 0; a.totalTokens = r.totalTokens ?? 0; a.usageCount = r.totalTokens !== null || r.inputTokens !== null || r.outputTokens !== null ? 1 : 0; a.images = r.images; if (r.actualAmount !== null && r.currency) { a.billingCount = 1; a.charges[r.currency] = r.actualAmount; } a.histogram[buckets.findIndex(b => r.durationMs <= b)] = 1; return a; }
export interface AnalyticsFilter { from: number; to: number; groupId?: string; modelId?: string; purpose?: string; includeProbes?: boolean; visibleGroupIds?: string[]; includeGlobal?: boolean }
export class ModelTelemetryStore {
  private lastCleanup = 0;
  constructor(private readonly sharedDb: SharedDb) {}
  record(record: ModelRequestRecord): void {
    const db = this.sharedDb.db; const day = beijingDay(record.startedAt);
    db.exec("SAVEPOINT model_telemetry_record");
    try {
      const inserted = db.prepare("INSERT OR IGNORE INTO model_requests(id,started_at,group_id,model_id,purpose,probe,record_json) VALUES(?,?,?,?,?,?,?)").run(record.id, record.startedAt, record.groupId, record.modelId, record.purpose, record.probe ? 1 : 0, JSON.stringify(record));
      if (inserted.changes) {
        const row = db.prepare("SELECT aggregate_json FROM model_daily_usage WHERE day=? AND group_id=? AND model_id=? AND purpose=? AND probe=?").get(day, record.groupId, record.modelId, record.purpose, record.probe ? 1 : 0) as { aggregate_json: string } | undefined;
        const value = add(row ? JSON.parse(row.aggregate_json) : empty(), aggregate(record));
        db.prepare("INSERT INTO model_daily_usage(day,group_id,model_id,purpose,probe,aggregate_json) VALUES(?,?,?,?,?,?) ON CONFLICT(day,group_id,model_id,purpose,probe) DO UPDATE SET aggregate_json=excluded.aggregate_json").run(day, record.groupId, record.modelId, record.purpose, record.probe ? 1 : 0, JSON.stringify(value));
        db.prepare("INSERT OR IGNORE INTO model_analytics_meta(key,value) VALUES('started_at',?)").run(String(record.startedAt));
      }
      db.exec("RELEASE model_telemetry_record");
    } catch (e) { db.exec("ROLLBACK TO model_telemetry_record; RELEASE model_telemetry_record"); throw e; }
    if (Date.now() - this.lastCleanup > 3600_000) { this.cleanup(); this.lastCleanup = Date.now(); }
  }
  cleanup(now = Date.now()): void { this.sharedDb.db.prepare("DELETE FROM model_requests WHERE started_at < ?").run(now - 30 * 86400_000); this.sharedDb.db.prepare("DELETE FROM model_daily_usage WHERE day < ?").run(beijingDay(now - 180 * 86400_000)); }
  private conditions(filter: AnalyticsFilter, daily = false): { sql: string; params: any[] } {
    const parts = [daily ? "day >= ? AND day <= ?" : "started_at >= ? AND started_at < ?"];
    const params: any[] = daily ? [beijingDay(filter.from), beijingDay(filter.to - 1)] : [filter.from, filter.to];
    if (!filter.includeProbes) parts.push("probe = 0");
    for (const [key, value] of [["group_id", filter.groupId], ["model_id", filter.modelId], ["purpose", filter.purpose]]) if (value) { parts.push(`${key} = ?`); params.push(value); }
    if (filter.visibleGroupIds) { const allowed = [...filter.visibleGroupIds, ...(filter.includeGlobal ? [""] : [])]; parts.push(allowed.length ? `group_id IN (${allowed.map(() => "?").join(",")})` : "0"); params.push(...allowed); }
    return { sql: parts.join(" AND "), params };
  }
  requests(filter: AnalyticsFilter, page = 1, pageSize = 25): { items: ModelRequestRecord[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } } {
    const c = this.conditions(filter); const db = this.sharedDb.db;
    const total = (db.prepare(`SELECT COUNT(*) AS total FROM model_requests WHERE ${c.sql}`).get(...c.params) as { total: number }).total;
    const items = (db.prepare(`SELECT record_json FROM model_requests WHERE ${c.sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...c.params, pageSize, (page - 1) * pageSize) as { record_json: string }[]).map(r => JSON.parse(r.record_json));
    return { items, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }
  report(filter: AnalyticsFilter): any {
    const rows: { time: string; aggregate: Aggregate }[] = [];
    const hourly = filter.to - filter.from <= 86400_000 && filter.from >= Date.now() - 30 * 86400_000;
    if (hourly) { const c = this.conditions(filter); for (const row of this.sharedDb.db.prepare(`SELECT record_json FROM model_requests WHERE ${c.sql}`).all(...c.params) as { record_json: string }[]) { const r: ModelRequestRecord = JSON.parse(row.record_json); rows.push({ time: new Date(Math.floor((r.startedAt + 8 * 3600_000) / 3600_000) * 3600_000).toISOString().slice(0, 13), aggregate: aggregate(r) }); } }
    else {
      // Daily rollups only represent whole Beijing days. Recent partial boundary
      // days are reconstructed from retained request rows so custom ranges do not
      // silently include calls outside the selected interval.
      const firstMidnight = Date.parse(`${beijingDay(filter.from)}T00:00:00+08:00`);
      const lastMidnight = Date.parse(`${beijingDay(filter.to - 1)}T00:00:00+08:00`);
      const fullFrom = filter.from === firstMidnight ? firstMidnight : firstMidnight + 86400_000;
      const fullTo = filter.to === lastMidnight + 86400_000 ? filter.to : lastMidnight;
      if (fullFrom < fullTo) {
        const c = this.conditions({ ...filter, from: fullFrom, to: fullTo }, true);
        for (const r of this.sharedDb.db.prepare(`SELECT day,aggregate_json FROM model_daily_usage WHERE ${c.sql}`).all(...c.params) as { day: string; aggregate_json: string }[]) rows.push({ time: r.day, aggregate: JSON.parse(r.aggregate_json) });
      }
      for (const [from, to] of [[filter.from, Math.min(fullFrom, filter.to)], [Math.max(fullTo, fullFrom), filter.to]]) {
        if (from >= to) continue;
        const c = this.conditions({ ...filter, from, to });
        for (const row of this.sharedDb.db.prepare(`SELECT record_json FROM model_requests WHERE ${c.sql}`).all(...c.params) as { record_json: string }[]) { const r: ModelRequestRecord = JSON.parse(row.record_json); rows.push({ time: beijingDay(r.startedAt), aggregate: aggregate(r) }); }
      }
    }
    const total = empty(); const series = new Map<string, Aggregate>();
    const step = hourly ? 3600_000 : 86400_000;
    const firstBucket = Math.floor((filter.from + 8 * 3600_000) / step) * step - 8 * 3600_000;
    for (let time = firstBucket; time < filter.to; time += step) series.set(hourly ? new Date(time + 8 * 3600_000).toISOString().slice(0, 13) : beijingDay(time), empty());
    for (const row of rows) { add(total, row.aggregate); add(series.get(row.time) ?? (series.set(row.time, empty()), series.get(row.time)!), row.aggregate); }
    let count = 0; let p95: number | null = null; for (let i = 0; i < buckets.length; i++) { count += total.histogram[i]; if (total.calls && count >= total.calls * .95) { p95 = Number.isFinite(buckets[i]) ? buckets[i] : null; break; } }
    const started = this.sharedDb.db.prepare("SELECT value FROM model_analytics_meta WHERE key='started_at'").get() as { value: string } | undefined;
    const choicesFilter = this.conditions({ ...filter, modelId: undefined, purpose: undefined }, true);
    const choices = this.sharedDb.db.prepare(`SELECT DISTINCT model_id,purpose FROM model_daily_usage WHERE ${choicesFilter.sql} ORDER BY model_id,purpose`).all(...choicesFilter.params) as { model_id: string; purpose: string }[];
    const options = { models: [...new Set(choices.map(row => row.model_id))].map(id => ({ id, label: id })), purposes: [...new Set(choices.map(row => row.purpose))] };
    return { options, summary: { ...total, successRate: total.calls ? total.succeeded / total.calls : null, averageLatencyMs: total.calls ? total.durationMs / total.calls : null, p95LatencyUpperBoundMs: p95, billingCoverage: total.calls ? total.billingCount / total.calls : null, usageCoverage: total.calls ? total.usageCount / total.calls : null }, series: [...series].sort(([a], [b]) => a.localeCompare(b)).map(([time, value]) => ({ time, ...value })), startedAt: started ? new Date(Number(started.value)).toISOString() : null, timezone: "Asia/Shanghai", retention: { detailDays: 30, aggregateDays: 180 } };
  }
}
