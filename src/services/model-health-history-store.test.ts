import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelHealthHistoryEntry } from "./model-health-history-store.js";
import { ModelHealthHistoryStore } from "./model-health-history-store.js";

test("ModelHealthHistoryStore serializes concurrent records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-health-history-"));
  try {
    const store = new ModelHealthHistoryStore(path.join(dir, "model-health.json"));
    await Promise.all([
      store.record(makeEntry("reply-main", "reply")),
      store.record(makeEntry("profile-main", "profile")),
      store.record(makeEntry("tts-main", "tts")),
    ]);

    const entries = await store.list();
    assert.deepEqual(new Set(entries.map((entry) => entry.id)), new Set([
      "reply-main",
      "profile-main",
      "tts-main",
    ]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeEntry(id: string, purpose: ModelHealthHistoryEntry["purpose"]): ModelHealthHistoryEntry {
  return {
    id,
    purpose,
    name: id,
    shortName: id,
    selected: false,
    ok: true,
    detail: "ok",
    model: `${id}-model`,
    baseUrl: "https://model.example/v1",
    checkedAt: "2026-06-07T00:00:00.000Z",
    latencyMs: 12,
    cached: false,
    source: "manual",
  };
}
