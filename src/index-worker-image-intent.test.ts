import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotApplication } from "./bot.js";
import { WorkerApp } from "./index-worker.js";
import {
  ImageIntentRouterError,
  type ImageIntentRouter,
  type ImageIntentRouterInput,
} from "./services/image-intent-router-plugin.js";
import { openSharedDb } from "./shared/sqlite.js";
import { parseNaturalImageRequestForIntent } from "./services/natural-image-request.js";
import { parseGroupMessage } from "./utils/message-parser.js";
import type { NapcatGroupMessageEvent } from "./types.js";

const BOT_QQ = "12345";
const TARGET_QQ = "54321";
const GROUP_ID = "67890";

test("Worker classifies a trusted mention once and passes only the locally materialized image request", async (t) => {
  const fixture = createFixture("worker-image-intent-configured-");
  t.after(() => fixture.dispose());

  const classifierInputs: ImageIntentRouterInput[] = [];
  let classifyCalls = 0;
  let legacyNaturalCalls = 0;
  const materializedActions: string[] = [];
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];

  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isImageGenerationCommand() { return false; },
    async isSystemCommand() { return false; },
    async isNaturalImageRoutingEnabled() { return true; },
    async getNaturalImageRequest() {
      legacyNaturalCalls += 1;
      return { kind: "generate", prompt: "legacy parser must not run" };
    },
    async getNaturalImageRequestForIntent(
      _event: NapcatGroupMessageEvent,
      _facts: unknown,
      action: string,
    ) {
      materializedActions.push(action);
      assert.equal(action, "avatar_edit");
      return {
        kind: "avatar_edit" as const,
        prompt: "美化一下",
        request: {
          targetText: "我",
          action: "美化一下",
          hasExplicitAvatarWord: true,
        },
      };
    },
    async getParticipationDecision() {
      return ignoredParticipation();
    },
    async handleGroupMessage(event: NapcatGroupMessageEvent, _signal?: AbortSignal, _route?: unknown, options?: unknown) {
      handled.push({
        messageId: String(event.message_id),
        options: asRecord(options),
      });
    },
  } as unknown as BotApplication;

  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify(input) {
      classifyCalls += 1;
      classifierInputs.push(input);
      return { action: "avatar_edit", modelId: "intent-small", model: "dafeiyu-small" };
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);

  const sourceRowId = fixture.insert({
    msgId: "8101",
    text: "将我头像美化一下",
    canonicalSegmentsJson: JSON.stringify([
      { type: "at", qq: BOT_QQ },
      { type: "text", text: " 将" },
      { type: "at", qq: TARGET_QQ },
      { type: "text", text: "的头像美化一下" },
    ]),
  });

  worker.start();
  await waitFor(() => handled.length === 1);

  assert.equal(classifyCalls, 1, "queue selection and handling must reuse the durable route");
  assert.equal(legacyNaturalCalls, 0, "a configured router must replace the legacy natural parser");
  // `keyOf` and the eventual handler each locally materialize the already
  // durable action. That work is deterministic and side-effect-free; only
  // the router model itself must run once.
  assert.deepEqual(materializedActions, ["avatar_edit", "avatar_edit"]);
  assert.equal(classifierInputs.length, 1);
  const classifierInput = classifierInputs[0]!;
  assert.deepEqual(classifierInput.facts, {
    hasTrustedBotMention: true,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
    attachmentCount: 0,
  });
  assert.match(classifierInput.sanitizedText, /美化一下/u);
  assert.equal(classifierInput.sanitizedText.includes(BOT_QQ), false, "the bot QQ must not reach the router");
  assert.equal(classifierInput.sanitizedText.includes(TARGET_QQ), false, "a real target mention must be opaque to the router");

  const options = handled[0]!.options;
  assert.equal(options?.imageRequestSourceRowId, sourceRowId);
  assert.equal(options?.naturalImageRoutingDecided, true);
  assert.deepEqual(options?.naturalImageRequest, {
    kind: "avatar_edit",
    prompt: "美化一下",
    request: {
      targetText: "我",
      action: "美化一下",
      hasExplicitAvatarWord: true,
    },
  });
  assert.deepEqual(readRoute(fixture.db, sourceRowId), {
    status: "classified",
    action: "avatar_edit",
    model_id: "intent-small",
    model: "dafeiyu-small",
    error_code: null,
  });
});

test("Worker records an unconfigured router as chat and never invokes the legacy natural parser", async (t) => {
  const fixture = createFixture("worker-image-intent-unconfigured-");
  t.after(() => fixture.dispose());

  let configurationChecks = 0;
  let classifyCalls = 0;
  let legacyNaturalCalls = 0;
  let materializeCalls = 0;
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({
    handled,
    onLegacyNatural: () => { legacyNaturalCalls += 1; },
    onMaterialize: () => { materializeCalls += 1; },
  });
  const router: ImageIntentRouter = {
    async isConfigured() {
      configurationChecks += 1;
      return false;
    },
    async classify() {
      classifyCalls += 1;
      return { action: "generate", modelId: "unexpected", model: "unexpected" };
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  const sourceRowId = fixture.insert({
    msgId: "8201",
    text: "生成一张海边灯塔",
    canonicalSegmentsJson: botMentionSegments("生成一张海边灯塔"),
  });

  worker.start();
  await waitFor(() => handled.length === 1);

  assert.equal(configurationChecks, 1, "terminal ledger state must avoid repeat configuration probes");
  assert.equal(classifyCalls, 0);
  assert.equal(legacyNaturalCalls, 0);
  assert.equal(materializeCalls, 0);
  assert.equal(handled[0]!.options?.naturalImageRoutingDecided, true);
  assert.equal(handled[0]!.options?.naturalImageRequest, undefined);
  assert.deepEqual(readRoute(fixture.db, sourceRowId), {
    status: "unavailable",
    action: null,
    model_id: null,
    model: null,
    error_code: "model_not_configured",
  });
});

test("Worker persists classifier failure as a chat fallback so replay does not classify again", async (t) => {
  const fixture = createFixture("worker-image-intent-failure-");
  t.after(() => fixture.dispose());

  let classifyCalls = 0;
  let legacyNaturalCalls = 0;
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({
    handled,
    onLegacyNatural: () => { legacyNaturalCalls += 1; },
  });
  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify() {
      classifyCalls += 1;
      throw new ImageIntentRouterError("invalid_response", {
        modelId: "intent-small",
        model: "dafeiyu-small",
      });
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  const sourceRowId = fixture.insert({
    msgId: "8301",
    text: "请画一张雨后的街道",
    canonicalSegmentsJson: botMentionSegments("请画一张雨后的街道"),
  });

  worker.start();
  await waitFor(() => handled.length === 1);

  // A fresh consumer observes the same ingress row after a restart. Its only
  // permissible routing result is the terminal unavailable ledger row; it
  // must not submit a second classifier request.
  await worker.stop();
  const replayWorker = fixture.createWorker(bot, router, `${fixture.consumerKey}-replay`);
  fixture.setWorker(replayWorker);
  replayWorker.start();
  await waitFor(() => handled.length === 2);

  assert.equal(classifyCalls, 1, "a replay must use the persisted unavailable result instead of classifying again");
  assert.equal(legacyNaturalCalls, 0);
  assert.equal(handled[0]!.options?.naturalImageRoutingDecided, true);
  assert.deepEqual(readRoute(fixture.db, sourceRowId), {
    status: "unavailable",
    action: null,
    model_id: "intent-small",
    model: "dafeiyu-small",
    error_code: "invalid_response",
  });
});

test("Worker does not dispatch a classifier after its background wait loses the route lease", async (t) => {
  const fixture = createFixture("worker-image-intent-lease-");
  t.after(() => fixture.dispose());

  let classifyCalls = 0;
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({ handled });
  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify() {
      classifyCalls += 1;
      return { action: "generate", modelId: "intent-small", model: "dafeiyu-small" };
    },
  };
  const worker = fixture.createWorker(bot, router, undefined, 1_000);
  fixture.setWorker(worker);
  const sourceRowId = fixture.insert({
    msgId: "8351",
    text: "请画一张雨后的街道",
    canonicalSegmentsJson: botMentionSegments("请画一张雨后的街道"),
  });

  let acquired = 0;
  const releases: Array<() => void> = [];
  const holders = Array.from({ length: 8 }, () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    return worker.backgroundLlmGate(async () => {
      acquired += 1;
      await held;
    });
  });

  try {
    await waitFor(() => acquired === 8);
    worker.start();
    await waitFor(() => {
      const route = fixture.db.db.prepare(
        "SELECT status FROM image_intent_routes WHERE source_row_id = ?",
      ).get(sourceRowId) as { status?: string } | undefined;
      return route?.status === "classifying";
    });

    // The request has a one-second lease but remains behind all background
    // slots. Once admitted, it must terminalize the stale route instead of
    // issuing a late classifier request.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  } finally {
    for (const release of releases) release();
    await Promise.all(holders);
  }

  await waitFor(() => handled.length === 1);
  assert.equal(classifyCalls, 0);
  assert.deepEqual(readRoute(fixture.db, sourceRowId), {
    status: "unavailable",
    action: null,
    model_id: null,
    model: null,
    error_code: "result_unknown",
  });
});

test("Worker keeps explicit image commands ahead of the configured intent router", async (t) => {
  const fixture = createFixture("worker-image-intent-command-");
  t.after(() => fixture.dispose());

  let configurationChecks = 0;
  let classifyCalls = 0;
  let materializeCalls = 0;
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isImageGenerationCommand(text: string) { return text.trim().startsWith("#生图"); },
    async isSystemCommand(text: string) { return text.trim().startsWith("#"); },
    async isNaturalImageRoutingEnabled() { return true; },
    async getNaturalImageRequestForIntent() {
      materializeCalls += 1;
      return { kind: "generate", prompt: "unexpected" };
    },
    async getParticipationDecision() { return ignoredParticipation(); },
    async handleGroupMessage(event: NapcatGroupMessageEvent, _signal?: AbortSignal, _route?: unknown, options?: unknown) {
      handled.push({ messageId: String(event.message_id), options: asRecord(options) });
    },
  } as unknown as BotApplication;
  const router: ImageIntentRouter = {
    async isConfigured() {
      configurationChecks += 1;
      return true;
    },
    async classify() {
      classifyCalls += 1;
      return { action: "generate", modelId: "unexpected", model: "unexpected" };
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  const sourceRowId = fixture.insert({
    msgId: "8401",
    text: "#生图 一片山谷",
    canonicalSegmentsJson: botMentionSegments("#生图 一片山谷"),
  });

  worker.start();
  await waitFor(() => handled.length === 1);

  assert.equal(configurationChecks, 0);
  assert.equal(classifyCalls, 0);
  assert.equal(materializeCalls, 0);
  assert.equal(handled[0]!.options?.imageRequestSourceRowId, sourceRowId);
  assert.equal(handled[0]!.options?.naturalImageRoutingDecided, undefined);
  const count = fixture.db.db.prepare(
    "SELECT COUNT(*) AS count FROM image_intent_routes WHERE source_row_id = ?",
  ).get(sourceRowId) as { count: number };
  assert.equal(count.count, 0);
});

test("Worker stages slow natural routing without blocking or corrupting a newer explicit image command", async (t) => {
  const fixture = createFixture("worker-image-intent-staging-");
  let releaseClassifier!: () => void;
  const classifierReleased = new Promise<void>((resolve) => { releaseClassifier = resolve; });
  let releaseExplicitImage!: () => void;
  const explicitImageReleased = new Promise<void>((resolve) => { releaseExplicitImage = resolve; });
  let classifierStarted = false;
  let explicitImageStarted = false;
  let materializeCalls = 0;
  t.after(async () => {
    releaseClassifier();
    releaseExplicitImage();
    await fixture.dispose();
  });

  const handled: string[] = [];
  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isImageGenerationCommand(text: string) { return text.trim().startsWith("#生图"); },
    async isSystemCommand(text: string) { return text.trim().startsWith("#"); },
    async isNaturalImageRoutingEnabled() { return true; },
    async getNaturalImageRequestForIntent(_event: NapcatGroupMessageEvent, _facts: unknown, action: string) {
      assert.equal(action, "generate");
      materializeCalls += 1;
      return { kind: "generate" as const, prompt: "一片山谷" };
    },
    async getParticipationDecision() { return ignoredParticipation(); },
    async handleGroupMessage(event: NapcatGroupMessageEvent) {
      const messageId = String(event.message_id);
      handled.push(messageId);
      if (messageId === "8462") {
        explicitImageStarted = true;
        await explicitImageReleased;
      }
    },
  } as unknown as BotApplication;
  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify() {
      classifierStarted = true;
      await classifierReleased;
      return { action: "generate", modelId: "intent-small", model: "dafeiyu-small" };
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  fixture.insert({
    msgId: "8461",
    text: "生成一张海边灯塔",
    canonicalSegmentsJson: botMentionSegments("生成一张海边灯塔"),
  });
  fixture.insert({
    msgId: "8462",
    text: "#生图 一片山谷",
    canonicalSegmentsJson: botMentionSegments("#生图 一片山谷"),
  });

  worker.start();
  await waitFor(() => classifierStarted);
  await waitFor(
    () => explicitImageStarted,
    1_000,
  );

  // The explicit command owns the image lane while the older natural request
  // resolves. Its active head must remain in place when the natural request
  // hands off into that same lane.
  releaseClassifier();
  await waitFor(() => materializeCalls >= 1);
  const runner = worker as unknown as {
    runner: { keys: Map<string, { queue: Array<{ msg_id: string }> }> };
  };
  await waitFor(() => runner.runner.keys.get(`${GROUP_ID}:image:20001`)?.queue.length === 2);
  assert.deepEqual(
    runner.runner.keys.get(`${GROUP_ID}:image:20001`)?.queue.map((message) => message.msg_id),
    ["8462", "8461"],
    "a handoff must queue behind an active image command",
  );

  releaseExplicitImage();
  await waitFor(() => handled.length === 2);
  await waitFor(() => fixture.db.pollMessages(fixture.consumerKey, 100).length === 0);
  assert.deepEqual(handled, ["8462", "8461"]);
});

test("Worker does not classify a recalled natural-image message", async (t) => {
  const fixture = createFixture("worker-image-intent-recalled-");
  t.after(() => fixture.dispose());

  let classifyCalls = 0;
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({ handled });
  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify() {
      classifyCalls += 1;
      return { action: "generate", modelId: "unexpected", model: "unexpected" };
    },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  const sourceRowId = fixture.insert({
    msgId: "8451",
    text: "生成一张不应分类的图片",
    canonicalSegmentsJson: botMentionSegments("生成一张不应分类的图片"),
  });
  fixture.db.markRetracted(GROUP_ID, "8451", Date.now());

  worker.start();
  await waitFor(() => (
    fixture.db.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get(fixture.consumerKey) as { watermark_id?: number } | undefined
  )?.watermark_id === sourceRowId);

  assert.equal(classifyCalls, 0);
  assert.equal(handled.length, 0);
  const count = fixture.db.db.prepare(
    "SELECT COUNT(*) AS count FROM image_intent_routes WHERE source_row_id = ?",
  ).get(sourceRowId) as { count: number };
  assert.equal(count.count, 0);
});

test("Worker sends router clarification outside the member image queue and without an image request source", async (t) => {
  const fixture = createFixture("worker-image-intent-clarification-");
  let releaseClarification!: () => void;
  const clarificationReleased = new Promise<void>((resolve) => { releaseClarification = resolve; });
  let markClarificationStarted!: () => void;
  const clarificationStarted = new Promise<void>((resolve) => { markClarificationStarted = resolve; });
  let markExplicitImageStarted!: () => void;
  const explicitImageStarted = new Promise<void>((resolve) => { markExplicitImageStarted = resolve; });
  t.after(async () => {
    releaseClarification();
    await fixture.dispose();
  });

  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isImageGenerationCommand(text: string) { return text.trim().startsWith("#生图"); },
    async isSystemCommand() { return false; },
    async isNaturalImageRoutingEnabled() { return true; },
    async getNaturalImageRequestForIntent(_event: NapcatGroupMessageEvent, _facts: unknown, action: string) {
      assert.equal(action, "clarification");
      return { kind: "clarification" as const, reason: "unrecognized_intent" as const };
    },
    async getParticipationDecision() { return ignoredParticipation(); },
    async handleGroupMessage(event: NapcatGroupMessageEvent, _signal?: AbortSignal, _route?: unknown, options?: unknown) {
      const messageId = String(event.message_id);
      handled.push({ messageId, options: asRecord(options) });
      if (messageId === "8501") {
        markClarificationStarted();
        await clarificationReleased;
      }
      if (messageId === "8502") {
        markExplicitImageStarted();
      }
    },
  } as unknown as BotApplication;
  const router: ImageIntentRouter = {
    async isConfigured() { return true; },
    async classify() { return { action: "clarification", modelId: "intent-small", model: "dafeiyu-small" }; },
  };
  const worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  fixture.insert({
    msgId: "8501",
    text: "我是不是可以让你画图",
    canonicalSegmentsJson: botMentionSegments("我是不是可以让你画图"),
  });

  worker.start();
  await clarificationStarted;
  fixture.insert({
    msgId: "8502",
    text: "#生图 一片山谷",
    canonicalSegmentsJson: botMentionSegments("#生图 一片山谷"),
  });
  await explicitImageStarted;

  const clarification = handled.find((entry) => entry.messageId === "8501")?.options;
  assert.ok(clarification);
  assert.equal(clarification.imageRequestSourceRowId, undefined);
  assert.equal(clarification.naturalImageRoutingDecided, true);
  assert.deepEqual(clarification.naturalImageRequest, {
    kind: "clarification",
    reason: "unrecognized_intent",
  });
  assert.equal(
    handled.find((entry) => entry.messageId === "8502")?.options?.imageRequestSourceRowId !== undefined,
    true,
    "the explicit image command must run while the clarification is still blocked",
  );
  const imageRequestCount = fixture.db.db.prepare(
    "SELECT COUNT(*) AS count FROM image_requests WHERE source_message_id = ?",
  ).get("8501") as { count: number };
  assert.equal(imageRequestCount.count, 0);
});

test("polite generation waits for same-member confirmation across restart without reclassification", async t => {
  const fixture = createFixture("image-confirmation-");
  t.after(() => fixture.dispose());
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({ handled });
  bot.getNaturalImageRequestForIntent = async (event, facts, action) => parseNaturalImageRequestForIntent({
    message: parseGroupMessage(event.message, BOT_QQ), ...facts,
    hasTrustedReply: facts.hasTrustedReply === true, replyIsGeneratedImage: facts.replyIsGeneratedImage === true,
  }, action);
  let calls = 0;
  const router: ImageIntentRouter = { async isConfigured() { return true; }, async classify() {
    calls++; return { action: "generate", modelId: "ds", model: "small" };
  } };
  let worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  const text = "你能生成一张蓝色鲸鱼图片吗";
  fixture.insert({ msgId: "question", text, canonicalSegmentsJson: botMentionSegments(text) });
  worker.start();
  await waitFor(() => handled.length === 1);
  assert.deepEqual(handled[0]?.options?.naturalImageRequest, { kind: "clarification", reason: "generation_confirmation" });
  assert.equal(handled[0]?.options?.imageRequestSourceRowId, undefined);
  await worker.stop();
  const confirmationRow = fixture.insert({ msgId: "confirm", text: "确认生成", canonicalSegmentsJson: botMentionSegments("确认生成") });
  worker = fixture.createWorker(bot, router);
  fixture.setWorker(worker);
  worker.start();
  await waitFor(() => handled.length === 2);
  assert.equal(calls, 1);
  assert.deepEqual(handled[1]?.options?.naturalImageRequest, { kind: "generate", prompt: text, requiresConfirmation: false });
  assert.equal(handled[1]?.options?.imageRequestSourceRowId, confirmationRow);
  fixture.insert({ msgId: "confirm-again", text: "确认生成", canonicalSegmentsJson: botMentionSegments("确认生成") });
  await waitFor(() => handled.length === 3);
  assert.deepEqual(handled[2]?.options?.naturalImageRequest, { kind: "clarification", reason: "confirmation_expired" });
  assert.equal(calls, 1);
});

test("image permission preflight prevents classifier and legacy rule fallback", async t => {
  const fixture = createFixture("intent-denied-");
  t.after(() => fixture.dispose());
  const handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }> = [];
  const bot = createChatBot({ handled, onLegacyNatural() { assert.fail("legacy parser"); } });
  bot.canRouteNaturalImageRequest = async () => false;
  const worker = fixture.createWorker(bot, { async isConfigured() { assert.fail("configuration check"); }, async classify() { assert.fail("classifier"); } });
  fixture.setWorker(worker);
  fixture.insert({ msgId: "denied", text: "生成一张山景", canonicalSegmentsJson: botMentionSegments("生成一张山景") });
  worker.start();
  await waitFor(() => Number(fixture.db.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get(fixture.consumerKey)?.watermark_id) > 0);
  assert.equal(fixture.db.db.prepare("SELECT count(*) AS count FROM image_intent_routes").get()?.count, 0);
});

function createFixture(prefix: string): {
  db: ReturnType<typeof openSharedDb>;
  createWorker: (
    bot: BotApplication,
    imageIntentRouter: ImageIntentRouter,
    consumerKeyOverride?: string,
    imageIntentRouteLeaseMs?: number,
  ) => WorkerApp;
  dispose: () => Promise<void>;
  insert: (input: { msgId: string; text: string; canonicalSegmentsJson: string }) => number;
  setWorker: (worker: WorkerApp) => void;
  consumerKey: string;
} {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openSharedDb(dataDir);
  const consumerKey = `${prefix}${Math.random().toString(36).slice(2)}`;
  let worker: WorkerApp | undefined;
  return {
    db,
    consumerKey,
    createWorker: (bot, imageIntentRouter, consumerKeyOverride, imageIntentRouteLeaseMs) => new WorkerApp({
      dataDir,
      sharedDb: db,
      botApp: bot,
      consumerKey: consumerKeyOverride ?? consumerKey,
      isBlacklistedUser: async () => false,
      imageIntentRouter,
      imageIntentRouteLeaseMs,
    }),
    setWorker: (value) => { worker = value; },
    dispose: async () => {
      await worker?.stop();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    insert: ({ msgId, text, canonicalSegmentsJson }) => db.insertMessage({
      groupId: GROUP_ID,
      userId: "20001",
      selfId: BOT_QQ,
      msgId,
      msgTime: Date.now(),
      text,
      imagesJson: "[]",
      canonicalSegmentsJson,
      hasAtBot: true,
      isBotMsg: false,
      createdAt: Date.now(),
    }),
  };
}

function createChatBot(input: {
  handled: Array<{ messageId: string; options: Record<string, unknown> | undefined }>;
  onLegacyNatural?: () => void;
  onMaterialize?: () => void;
}): BotApplication {
  return {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isImageGenerationCommand() { return false; },
    async isSystemCommand() { return false; },
    async isNaturalImageRoutingEnabled() { return true; },
    async getNaturalImageRequest() {
      input.onLegacyNatural?.();
      return { kind: "generate", prompt: "legacy parser must not run" };
    },
    async getNaturalImageRequestForIntent() {
      input.onMaterialize?.();
      return { kind: "generate", prompt: "unexpected" };
    },
    async getParticipationDecision() {
      return ignoredParticipation();
    },
    async handleGroupMessage(event: NapcatGroupMessageEvent, _signal?: AbortSignal, _route?: unknown, options?: unknown) {
      input.handled.push({ messageId: String(event.message_id), options: asRecord(options) });
    },
  } as unknown as BotApplication;
}

function ignoredParticipation() {
  return { action: "ignore", reason: "no_trigger", score: 0, policyVersion: "test", signals: {} };
}

function botMentionSegments(text: string): string {
  return JSON.stringify([
    { type: "at", qq: BOT_QQ },
    { type: "text", text: ` ${text}` },
  ]);
}

function readRoute(db: ReturnType<typeof openSharedDb>, sourceRowId: number): {
  status: string;
  action: string | null;
  model_id: string | null;
  model: string | null;
  error_code: string | null;
} {
  const route = db.db.prepare(
    `SELECT status, action, model_id, model, error_code
       FROM image_intent_routes
      WHERE source_row_id = ?`,
  ).get(sourceRowId) as {
    status: string;
    action: string | null;
    model_id: string | null;
    model: string | null;
    error_code: string | null;
  } | undefined;
  assert.ok(route, "a trusted route must have a durable intent ledger row");
  return {
    status: route.status,
    action: route.action,
    model_id: route.model_id,
    model: route.model,
    error_code: route.error_code,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met within timeout");
}
