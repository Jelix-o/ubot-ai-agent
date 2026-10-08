import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { currentModelOperation, instrumentCompletions, ModelTelemetryStore, recordModelRequest, setModelTelemetryStore, withModelOperation } from "./model-telemetry.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-telemetry-"));
  const db = new SharedDb(path.join(dir, "shared.db"));
  t.after(() => { setModelTelemetryStore(undefined); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new ModelTelemetryStore(db);
  setModelTelemetryStore(store);
  return { db, store };
}

type RecordOverrides = Omit<Partial<Parameters<typeof recordModelRequest>[0]>, "operation"> & {
  operation?: { purpose?: string; groupId?: string; modelId?: string };
};
function record(startedAt: number, overrides: RecordOverrides = {}) {
  const { operation, ...request } = overrides;
  withModelOperation(operation?.purpose ?? "reply", operation?.groupId ?? "g1", () => {
    recordModelRequest({ startedAt, model: "provider-model", status: "succeeded", response: {}, ...request });
  }, operation?.modelId ?? "model-a");
}

test("telemetry stores only safe request metadata and accepts explicit currency-qualified billing", (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  withModelOperation("reply", "g1", () => recordModelRequest({ startedAt: now, model: "provider-model", status: "succeeded", response: {
    model: "served-model", usage: { input_tokens: 12, output_tokens: 8 }, billing: { amount: "0.0042", currency: "USD" }, prompt: "private prompt", content: "private output",
  } }), "model-a");
  withModelOperation("image", "g1", () => recordModelRequest({ startedAt: now + 1, model: "image-model", status: "succeeded", images: 1, response: { billing: { amount: 0.5 } } }), "image-a");
  withModelOperation("reply", "g1", () => recordModelRequest({ startedAt: now + 2, model: "other-model", status: "failed", response: { billing: { amount: 4, currency: "EUR" }, usage: { prompt_tokens: 3 } } }), "model-b");

  const report = store.report({ from: now - 100, to: now + 1000, includeProbes: true });
  assert.equal(report.summary.calls, 3);
  assert.deepEqual(report.summary.charges, { USD: 0.0042, EUR: 4 });
  assert.equal(report.summary.billingCount, 2);
  assert.equal(report.summary.usageCount, 2);
  assert.equal(report.summary.images, 1);
  const requests = store.requests({ from: now - 100, to: now + 1000, includeProbes: true }).items;
  assert.equal(requests[0]?.model, "other-model");
  assert.equal(requests[1]?.actualAmount, null, "amount without explicit currency must not be counted");
  const persisted = db.db.prepare("SELECT record_json FROM model_requests ORDER BY started_at").all() as Array<{ record_json: string }>;
  assert.equal(persisted.some((row) => /private prompt|private output/.test(row.record_json)), false);
  assert.equal(Object.hasOwn(JSON.parse(persisted[0]!.record_json), "prompt"), false);
});

test("probes are excluded by default and retries/fallback calls retain one business operation id", async (t) => {
  const { store } = fixture(t);
  const startedAt = Date.now();
  withModelOperation("probe", undefined, () => recordModelRequest({ startedAt, model: "probe-model", status: "succeeded", response: {} }));
  let calls = 0;
  const client = instrumentCompletions({ create: async (_args: { model: string }) => ({ model: ++calls === 1 ? "primary" : "fallback", usage: { prompt_tokens: 1, completion_tokens: 2 } }) }, "configured-model");
  await withModelOperation("reply", "g2", async () => {
    await client.create({ model: "primary" });
    await client.create({ model: "fallback" });
  }, "model-primary");
  const filter = { from: startedAt - 100, to: Date.now() + 1000 };
  assert.equal(store.report(filter).summary.calls, 2);
  assert.equal(store.report({ ...filter, includeProbes: true }).summary.calls, 3);
  const records = store.requests({ ...filter, includeProbes: true }).items;
  const replyRecords = records.filter((item) => item.purpose === "reply");
  assert.equal(replyRecords.length, 2);
  assert.equal(replyRecords[0]?.operationId, replyRecords[1]?.operationId);
  assert.deepEqual(new Set(replyRecords.map((item) => item.model)), new Set(["primary", "fallback"]));
  assert.equal(currentModelOperation(), undefined);
});

test("streaming responses capture final usage and distinguish cancellation", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const client = instrumentCompletions({
    create: async () => {
      const call = ++calls;
      return (async function* () {
        yield { model: "stream-model", content: "private output" };
        if (call === 1) yield { model: "stream-model", usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }, prompt: "private prompt" };
        else throw new DOMException("request aborted", "AbortError");
      })();
    },
  }, "configured-stream-model");
  const startedAt = Date.now();
  await withModelOperation("reply", "g3", async () => {
    const stream = await client.create();
    for await (const _chunk of stream) { /* consume the complete response */ }
  }, "stream-model-id");
  await assert.rejects(withModelOperation("reply", "g3", async () => {
    const stream = await client.create();
    for await (const _chunk of stream) { /* consume until abort */ }
  }, "stream-model-id"));
  const records = store.requests({ from: startedAt - 100, to: Date.now() + 1_000 }).items;
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.status === "succeeded")?.totalTokens, 10);
  assert.equal(records.find(record => record.status === "cancelled")?.totalTokens, null);
  const persisted = JSON.stringify(records);
  assert.doesNotMatch(persisted, /private prompt|private output/);
});

test("daily rollups use Beijing dates across UTC midnight and retention removes only expired data", (t) => {
  const { db, store } = fixture(t);
  const beforeMidnight = Date.parse("2026-10-01T15:59:00.000Z");
  const afterMidnight = Date.parse("2026-10-01T16:01:00.000Z");
  record(beforeMidnight);
  record(afterMidnight, { operation: { purpose: "reply", groupId: "g1", modelId: "model-a" } });
  const from = Date.parse("2026-10-01T16:00:00.000Z");
  const to = Date.parse("2026-10-08T16:00:00.000Z");
  const report = store.report({ from, to });
  assert.equal(report.summary.calls, 1, "the first record is before the selected range");
  assert.deepEqual(report.series.filter((row: { calls: number }) => row.calls > 0).map((row: { time: string }) => row.time), ["2026-10-02"]);

  const now = Date.now();
  record(now - 31 * 86400_000);
  record(now - 181 * 86400_000, { operation: { purpose: "reply", groupId: "g1", modelId: "model-a" } });
  store.cleanup(now);
  const details = db.db.prepare("SELECT started_at FROM model_requests").all() as Array<{ started_at: number }>;
  const rollups = db.db.prepare("SELECT day FROM model_daily_usage").all() as Array<{ day: string }>;
  assert.equal(details.some((item) => item.started_at < now - 30 * 86400_000), false);
  assert.equal(rollups.some((item) => Date.parse(`${item.day}T00:00:00+08:00`) < now - 180 * 86400_000), false);
});
