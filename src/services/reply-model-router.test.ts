import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { ReplyOutputTruncatedError } from "./ai-service.js";
import type { SystemModelConfig, SystemSettings } from "../types.js";
import type { RuntimeAiService } from "./configured-ai-service.js";
import { ReplyModelRouter, retryableModelFailure } from "./reply-model-router.js";
import { defaultReplyRouting, type SystemSettingsStore } from "./system-settings-store.js";
import { LlmSemaphore, LlmSemaphoreTimeoutError } from "./llm-semaphore.js";

const group = { groupId: "test", replyModelSource: "global" as const };
function fixture(overrides: Partial<SystemSettings> = {}) {
  const models = ["sol", "gpt", "ds"].map(id => ({ id, purpose: "reply", enabled: true, apiKey: "secret", supportsVision: id === "gpt", model: id, baseUrl: `https://${id}.invalid` }) as SystemModelConfig);
  const settings = { models, selectedModelIds: { reply: "sol" }, replyRouting: { ...defaultReplyRouting(), fallbackModelIds: ["gpt", "ds"] }, ...overrides } as SystemSettings;
  const calls: string[] = [];
  const behavior: Record<string, (signal: AbortSignal) => Promise<string>> = {};
  const router = new ReplyModelRouter({ getInternal: async () => settings } as SystemSettingsStore, undefined, model => ({
    generateReply: async (args: { signal: AbortSignal }) => { calls.push(model.id); return behavior[model.id] ? behavior[model.id]!(args.signal) : model.id; },
  }) as unknown as RuntimeAiService);
  const run = async (options: Parameters<ReplyModelRouter["begin"]>[2] = {}, selectedGroup = group) => (await router.begin(selectedGroup, "chat", options)).run(service => service.generateReply({} as any));
  // The real caller always passes the attempt signal to the SDK.
  const execute = async (options: Parameters<ReplyModelRouter["begin"]>[2] = {}, selectedGroup: Parameters<ReplyModelRouter["begin"]>[0] = group) =>
    (await router.begin(selectedGroup, "chat", options)).run((service, signal) => service.generateReply({ signal } as any));
  return { router, settings, calls, behavior, execute, run };
}
const unavailable = () => Promise.reject(Object.assign(new Error("upstream unavailable"), { status: 503 }));

test("a truncated draft is replaced by a complete reply from the configured backup", async () => {
  const f = fixture();
  f.behavior.sol = () => Promise.reject(new ReplyOutputTruncatedError("sol", "length", 32_768, 100));
  const result = await f.execute();
  assert.equal(result.modelId, "gpt");
  assert.deepEqual(f.calls, ["sol", "gpt"]);
});

test("SDK connection failures and nested transport causes reach the next model", async () => {
  for (const error of [new OpenAI.APIConnectionError({}), new Error("provider failed", { cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }) })]) {
    const f = fixture(); f.behavior.sol = () => Promise.reject(error);
    assert.equal((await f.execute()).modelId, "gpt");
    assert.deepEqual(f.calls, ["sol", "gpt"]);
  }
});

test("streamed SDK service errors without HTTP status can fall back, but explicit authentication errors cannot", async () => {
  for (const type of ["upstream_error", "overloaded_error", "server_error", "rate_limit_error"]) {
    const f = fixture();
    f.behavior.sol = () => Promise.reject(new OpenAI.APIError(undefined, { message: "Please try again later.", type }, undefined, undefined));
    assert.equal((await f.execute()).modelId, "gpt");
    assert.deepEqual(f.calls, ["sol", "gpt"]);
  }
  const f = fixture();
  f.behavior.sol = () => Promise.reject(new OpenAI.APIError(401, { message: "overloaded", type: "upstream_error" }, undefined, undefined));
  await assert.rejects(f.execute()); assert.deepEqual(f.calls, ["sol"]);
  assert.equal(retryableModelFailure({ error: { type: "upstream_error", message: "Our servers are currently overloaded." } }), true);
});

test("routes primary first and uses configured backups once, silently", async () => {
  const f = fixture(); f.behavior.sol = unavailable; f.behavior.gpt = unavailable;
  const result = await f.execute();
  assert.equal(result.value, "ds"); assert.equal(result.modelId, "ds"); assert.equal(result.fallbackUsed, true);
  assert.deepEqual(f.calls, ["sol", "gpt", "ds"]);
});
test("group exceptions replace primary and candidates are deduplicated", async () => {
  const f = fixture(); f.behavior.gpt = unavailable;
  await f.execute({}, { groupId: "test", replyModelSource: "override", replyModelMode: "gpt" });
  assert.deepEqual(f.calls, ["gpt", "ds"]);
});
test("vision filters unsupported models; disabled and missing-key models are skipped", async () => {
  const f = fixture(); assert.equal((await f.execute({ vision: true })).modelId, "gpt");
  f.calls.length = 0; f.settings.models[0]!.enabled = false; f.settings.models[1]!.apiKey = "";
  assert.equal((await f.execute()).modelId, "ds"); assert.deepEqual(f.calls, ["ds"]);
});
test("disabling failover never invokes an alternate", async () => {
  const f = fixture(); f.settings.replyRouting!.fallbackEnabled = false; f.behavior.sol = unavailable;
  await assert.rejects(() => f.execute()); assert.deepEqual(f.calls, ["sol"]);
});
test("auth, content refusals, local saturation and cancellation do not fall back", async () => {
  for (const error of [Object.assign(new Error("invalid key"), { status: 401 }), new Error("content_filter"), new LlmSemaphoreTimeoutError(2)]) {
    const f = fixture(); f.behavior.sol = () => Promise.reject(error);
    await assert.rejects(() => f.execute()); assert.deepEqual(f.calls, ["sol"]);
  }
  const f = fixture(); const controller = new AbortController();
  f.behavior.sol = signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const result = f.execute({ signal: controller.signal }); setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => result); assert.deepEqual(f.calls, ["sol"]);
});
test("attempt timeout aborts the upstream and proceeds to a healthy model", async () => {
  const f = fixture(); f.settings.replyRouting!.chatAttemptTimeoutMs = 15; let aborted = false;
  f.behavior.sol = signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
  assert.equal((await f.execute()).modelId, "gpt"); assert.equal(aborted, true);
});
test("total budget is shared across attempts and HTML repair sessions", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture(); f.settings.replyRouting!.chatTotalTimeoutMs = 15;
  f.behavior.sol = signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { now += 15; reject(signal.reason); }, { once: true }));
  await assert.rejects(() => f.execute()); assert.deepEqual(f.calls, ["sol"]);
  const session = await f.router.begin(group, "html");
  assert.equal((await session.run(async () => "first")).modelId, "sol");
  assert.equal((await session.run(async () => "repair")).modelId, "gpt");
  assert.equal((await session.run(async () => "repair")).modelId, "ds");
  await assert.rejects(() => session.run(async () => "never"));
});
test("one model opening its breaker does not block healthy alternates; connection edits reset it", async () => {
  const f = fixture(); f.behavior.sol = unavailable;
  for (let i = 0; i < 6; i++) assert.equal((await f.execute()).modelId, "gpt");
  assert.equal(f.calls.filter(id => id === "sol").length, 5);
  f.settings.models[0]!.baseUrl = "https://repaired.invalid"; delete f.behavior.sol;
  assert.equal((await f.execute()).modelId, "sol");
});
test("queued cancellation releases the waiter without consuming a permit", async () => {
  const semaphore = new LlmSemaphore(1, 1_000); const release = await semaphore.acquire();
  const controller = new AbortController(); const waiting = semaphore.acquire(controller.signal); controller.abort();
  await assert.rejects(() => waiting); assert.equal(semaphore.waitingCount, 0); release(); assert.equal(semaphore.activeCount, 0);
});
test("empty output and parse errors are eligible; errors with 400/403 status are terminal", () => {
  assert.equal(retryableModelFailure(new Error("AI response was empty in non-stream mode.")), true);
  assert.equal(retryableModelFailure(new SyntaxError("Unexpected token in JSON")), true);
  assert.equal(retryableModelFailure(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(retryableModelFailure(Object.assign(new Error("forbidden"), { status: 403 })), false);
});
