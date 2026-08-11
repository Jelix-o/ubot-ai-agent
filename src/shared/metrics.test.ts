import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Metrics, readMetricsSummary } from "./metrics.js";

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "metrics-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("Metrics counts, gauges and latency samples aggregate via readMetricsSummary", (t) => {
  const dir = tempDir(t);

  const a = new Metrics(dir, { processName: "ingress", flushIntervalMs: 60_000 });
  a.inc("msg_ingress", 5);
  a.inc("dedup_hit");
  a.setGauge("per_key_queue_depth_max", 3);

  const b = new Metrics(dir, { processName: "worker", flushIntervalMs: 60_000 });
  b.inc("msg_ingress", 2);
  b.setGauge("per_key_queue_depth_max", 7);
  for (let i = 0; i < 10; i += 1) {
    b.observeLatency("llm", 100 + i * 10);
  }

  a.flush();
  b.flush();

  const summary = readMetricsSummary(dir);
  assert.equal(summary.counters["msg_ingress"], 7);
  assert.equal(summary.counters["dedup_hit"], 1);
  assert.equal(summary.gauges["per_key_queue_depth_max"], 7, "gauges must take the max");
  assert.equal(summary.latencyP95["llm"], 190, "nearest-rank p95 of 10 samples 100..190");
  assert.ok(summary.updatedAt);

  a.stop();
  b.stop();
});

test("readMetricsSummary tolerates missing or corrupt directories", () => {
  const summary = readMetricsSummary(path.join(os.tmpdir(), "does-not-exist-metrics"));
  assert.deepEqual(summary.counters, {});
  assert.deepEqual(summary.gauges, {});
  assert.deepEqual(summary.latencyP95, {});
});
