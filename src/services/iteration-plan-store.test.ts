import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IterationPlanStore } from "./iteration-plan-store.js";

async function withStore<T>(run: (store: IterationPlanStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iteration-plan-store-"));
  try {
    return await run(new IterationPlanStore(path.join(dir, "plans.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("IterationPlanStore creates plans and tracks approval/application state", async () => {
  await withStore(async (store) => {
    const plan = await store.create({
      title: "Self iteration V1",
      summary: "Collect feedback and generate a /goal plan.",
      generatedBy: "manual",
      scope: "mixed",
      riskLevel: "low",
      goalPrompt: "Run npm test and deploy /opt/ai-project",
      evidence: [{ type: "feedback", title: "Feedback", detail: "Need better replies", entityId: "f1" }],
      recommendations: [{ type: "code", title: "Add workflow", detail: "Implement iteration workflow" }],
    });

    assert.equal(plan.status, "draft");
    assert.equal(plan.evidence.length, 1);
    assert.equal(plan.recommendations.length, 1);

    const approved = await store.updateStatus(plan.id, "approved", { operatorUserId: "admin" });
    assert.equal(approved?.status, "approved");

    const applied = await store.recordApplied(plan.id, "admin");
    assert.equal(applied?.status, "applied");
    assert.equal(applied?.appliedBy, "admin");
    assert.ok(applied?.appliedAt);
  });
});

test("IterationPlanStore supports pagination and query filters", async () => {
  await withStore(async (store) => {
    await store.create({
      title: "Code plan",
      summary: "backend endpoint",
      generatedBy: "manual",
      scope: "code",
      goalPrompt: "npm test /opt/ai-project",
    });
    await store.create({
      title: "Config plan",
      summary: "model settings",
      generatedBy: "manual",
      scope: "config",
      goalPrompt: "npm test /opt/ai-project",
    });

    const code = await store.listPage({ scope: "code", page: 1, pageSize: 20 });
    assert.equal(code.pagination.total, 1);
    assert.equal(code.plans[0]?.title, "Code plan");

    const query = await store.listPage({ q: "model settings", page: 1, pageSize: 20 });
    assert.equal(query.pagination.total, 1);
    assert.equal(query.plans[0]?.title, "Config plan");
  });
});
