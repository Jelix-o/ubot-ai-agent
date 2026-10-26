import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotApplication } from "./bot.js";
import { WorkerApp } from "./index-worker.js";
import { openSharedDb } from "./shared/sqlite.js";
import { ImageRequestRepository } from "./services/image-request-repository.js";
import type { NapcatGroupMessageEvent } from "./types.js";

const BOT_QQ = "12345";
const GROUP_ID = "67890";

test("Worker routes only canonical bot mentions into per-member natural image queues", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-natural-image-"));
  const db = openSharedDb(dataDir);
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let markOtherMemberStarted!: () => void;
  const otherMemberStarted = new Promise<void>((resolve) => {
    markOtherMemberStarted = resolve;
  });
  const routeFacts: Array<{
    messageId: string;
    hasTrustedBotMention: boolean;
    hasTrustedReply: boolean;
    replyIsGeneratedImage: boolean;
  }> = [];
  const handled: Array<{ messageId: string; message: NapcatGroupMessageEvent["message"]; options: unknown }> = [];

  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async isSystemCommand() { return false; },
    async getNaturalImageRequest(
      event: NapcatGroupMessageEvent,
      facts: { hasTrustedBotMention: boolean; hasTrustedReply: boolean; replyIsGeneratedImage: boolean },
    ) {
      routeFacts.push({
        messageId: String(event.message_id),
        hasTrustedBotMention: facts.hasTrustedBotMention,
        hasTrustedReply: facts.hasTrustedReply,
        replyIsGeneratedImage: facts.replyIsGeneratedImage,
      });
      return facts.hasTrustedBotMention || facts.replyIsGeneratedImage
        ? { kind: "generate", prompt: "测试" }
        : undefined;
    },
    async getParticipationDecision() {
      return { action: "ignore", reason: "no_trigger", score: 0, policyVersion: "test", signals: {} };
    },
    async handleGroupMessage(
      event: NapcatGroupMessageEvent,
      _signal?: AbortSignal,
      _route?: unknown,
      options?: unknown,
    ) {
      const messageId = String(event.message_id);
      handled.push({ messageId, message: event.message, options });
      if (messageId === "1001") {
        markFirstStarted();
        await firstRelease;
      }
      if (messageId === "1003") {
        markOtherMemberStarted();
      }
    },
  } as unknown as BotApplication;

  const worker = new WorkerApp({
    dataDir,
    sharedDb: db,
    botApp: bot,
    consumerKey: "worker:natural-image",
    isBlacklistedUser: async () => false,
  });
  t.after(async () => {
    releaseFirst();
    await worker.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const canonicalRequest = (text: string) => JSON.stringify([
    { type: "text", text: "请" },
    { type: "at", qq: BOT_QQ },
    { type: "text", text },
  ]);
  const insert = (args: {
    msgId: string;
    userId: string;
    text: string;
    canonicalSegmentsJson?: string;
    replyTo?: string;
  }) => db.insertMessage({
    groupId: GROUP_ID,
    userId: args.userId,
    selfId: BOT_QQ,
    msgId: args.msgId,
    msgTime: Date.now(),
    text: args.text,
    imagesJson: "[]",
    canonicalSegmentsJson: args.canonicalSegmentsJson,
    replyTo: args.replyTo,
    hasAtBot: true,
    isBotMsg: false,
    createdAt: Date.now(),
  });

  insert({
    msgId: "1001",
    userId: "20001",
    text: "请 生成一张沿海灯塔",
    canonicalSegmentsJson: canonicalRequest(" 生成一张沿海灯塔"),
  });
  insert({
    msgId: "1002",
    userId: "20001",
    text: "请 生成一张雨后街道",
    canonicalSegmentsJson: canonicalRequest(" 生成一张雨后街道"),
  });
  insert({
    msgId: "1003",
    userId: "20002",
    text: "请 生成一张山谷",
    canonicalSegmentsJson: canonicalRequest(" 生成一张山谷"),
  });
  // A textual/legacy @ must not authorize a natural request, even though its
  // old has_at_bot flag is set by the row fixture.
  insert({
    msgId: "1004",
    userId: "20003",
    text: `@${BOT_QQ} 生成一张不会触发的图片`,
  });
  db.db.prepare(
    `INSERT INTO image_previews
       (id, group_id, creator_user_id, source_message_id, model_id, model,
        fallback_used, mime_type, byte_size, content_sha256, status,
        created_at, updated_at, expires_at, output_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?)`,
  ).run(
    "preview-100",
    GROUP_ID,
    "20009",
    "source-100",
    "test-model",
    "test-model",
    0,
    "image/png",
    1,
    "0".repeat(64),
    Date.now(),
    Date.now(),
    Date.now() + 60_000,
    "generated-100",
  );
  db.db.prepare(
    `INSERT INTO image_previews
       (id, group_id, creator_user_id, source_message_id, model_id, model,
        fallback_used, mime_type, byte_size, content_sha256, status,
        publication_state, created_at, updated_at, expires_at, output_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 'pending', ?, ?, ?, ?)`,
  ).run(
    "preview-pending",
    GROUP_ID,
    "20009",
    "source-pending",
    "test-model",
    "test-model",
    0,
    "image/png",
    1,
    "1".repeat(64),
    Date.now(),
    Date.now(),
    Date.now() + 60_000,
    "generated-pending",
  );
  insert({
    msgId: "1005",
    userId: "20004",
    text: "把天空改成晚霞",
    replyTo: "generated-100",
    canonicalSegmentsJson: JSON.stringify([
      { type: "reply", id: "generated-100" },
      { type: "text", text: "把天空改成晚霞" },
    ]),
  });
  // A pre-canonical reply id has no ordered platform-segment provenance.
  // It must not authorize a natural continuous edit after restart/replay.
  insert({
    msgId: "1006",
    userId: "20005",
    text: "把天空改成晴天",
    replyTo: "generated-100",
  });
  // An archive is not an authority until its QQ Outbox link publishes it.
  insert({
    msgId: "1007",
    userId: "20006",
    text: "把天空改成夜晚",
    replyTo: "generated-pending",
    canonicalSegmentsJson: JSON.stringify([
      { type: "reply", id: "generated-pending" },
      { type: "text", text: "把天空改成夜晚" },
    ]),
  });

  worker.start();
  await firstStarted;
  await otherMemberStarted;
  assert.equal(
    handled.some((entry) => entry.messageId === "1002" && hasImageRoutingOptions(entry.options)),
    false,
    "same member requests must share one image queue",
  );

  const first = handled.find((entry) => entry.messageId === "1001");
  assert.ok(first);
  assert.equal(hasImageRoutingOptions(first.options), true);
  assert.deepEqual(first.message, [
    { type: "text", data: { text: "请" } },
    { type: "at", data: { qq: BOT_QQ } },
    { type: "text", data: { text: " 生成一张沿海灯塔" } },
  ], "canonical segment order must survive ingress-to-worker replay");

  assert.ok(routeFacts.some((fact) => fact.messageId === "1001" && fact.hasTrustedBotMention));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1004" && !fact.hasTrustedBotMention));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1005" && fact.hasTrustedReply));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1005" && fact.replyIsGeneratedImage));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1006" && !fact.hasTrustedReply));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1006" && !fact.replyIsGeneratedImage));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1007" && fact.hasTrustedReply));
  assert.ok(routeFacts.some((fact) => fact.messageId === "1007" && !fact.replyIsGeneratedImage));
  assert.equal(
    hasImageRoutingOptions(handled.find((entry) => entry.messageId === "1005")?.options),
    true,
    "a reply to a delivered, retained generated image may continue editing without a fresh @",
  );
  assert.equal(
    handled.some((entry) => entry.messageId === "1004" && hasImageRoutingOptions(entry.options)),
    false,
    "text that resembles @bot must remain outside natural image routing",
  );
  assert.equal(
    handled.some((entry) => entry.messageId === "1006" && hasImageRoutingOptions(entry.options)),
    false,
    "a legacy reply id must not authorize a natural continuous edit",
  );
  assert.equal(
    handled.some((entry) => entry.messageId === "1007" && hasImageRoutingOptions(entry.options)),
    false,
    "a pending archive must not authorize a natural continuous edit before QQ delivery",
  );

  releaseFirst();
  await waitFor(() => handled.some((entry) => entry.messageId === "1002" && hasImageRoutingOptions(entry.options)));
  await waitFor(() => (
    db.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:natural-image") as { watermark_id?: number } | undefined
  )?.watermark_id === 7);
});

test("Worker routes explicit image commands through the image queue and preserves an in-line real @", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-image-command-"));
  const db = openSharedDb(dataDir);
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let markOtherMemberStarted!: () => void;
  const otherMemberStarted = new Promise<void>((resolve) => {
    markOtherMemberStarted = resolve;
  });
  const handled: Array<{ messageId: string; message: NapcatGroupMessageEvent["message"]; options: unknown }> = [];

  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async getNaturalImageRequest() { return undefined; },
    async isImageGenerationCommand(text: string) {
      return /^#(?:生图|改图)(?:\s|$)/u.test(text.trim());
    },
    async isSystemCommand(text: string) { return text.trim().startsWith("#"); },
    async getParticipationDecision() {
      return { action: "ignore", reason: "no_trigger", score: 0, policyVersion: "test", signals: {} };
    },
    async handleGroupMessage(
      event: NapcatGroupMessageEvent,
      _signal?: AbortSignal,
      _route?: unknown,
      options?: unknown,
    ) {
      const messageId = String(event.message_id);
      handled.push({ messageId, message: event.message, options });
      if (messageId === "2001") {
        markFirstStarted();
        await firstRelease;
      }
      if (messageId === "2003") {
        markOtherMemberStarted();
      }
    },
  } as unknown as BotApplication;

  const worker = new WorkerApp({
    dataDir,
    sharedDb: db,
    botApp: bot,
    consumerKey: "worker:image-command",
    isBlacklistedUser: async () => false,
  });
  t.after(async () => {
    releaseFirst();
    await worker.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const insert = (args: {
    msgId: string;
    userId: string;
    text: string;
    canonicalSegmentsJson?: string;
  }) => db.insertMessage({
    groupId: GROUP_ID,
    userId: args.userId,
    selfId: BOT_QQ,
    msgId: args.msgId,
    msgTime: Date.now(),
    text: args.text,
    imagesJson: "[]",
    canonicalSegmentsJson: args.canonicalSegmentsJson,
    hasAtBot: false,
    isBotMsg: false,
    createdAt: Date.now(),
  });

  insert({
    msgId: "2001",
    userId: "20001",
    text: "#改图 让@30001 的头像吐舌头",
    canonicalSegmentsJson: JSON.stringify([
      { type: "text", text: "#改图 让" },
      { type: "at", qq: "30001" },
      { type: "text", text: " 的头像吐舌头" },
    ]),
  });
  insert({ msgId: "2002", userId: "20001", text: "#生图 一片山谷" });
  insert({ msgId: "2003", userId: "20002", text: "#改图 换成傍晚" });
  insert({ msgId: "2004", userId: "20003", text: "#帮助" });

  worker.start();
  await firstStarted;
  await otherMemberStarted;
  assert.equal(
    handled.some((entry) => entry.messageId === "2002"),
    false,
    "same member explicit image commands must share one image queue",
  );

  const first = handled.find((entry) => entry.messageId === "2001");
  assert.ok(first);
  assert.equal(hasImageRoutingOptions(first.options), true);
  assert.deepEqual(first.message, [
    { type: "text", data: { text: "#改图 让" } },
    { type: "at", data: { qq: "30001" } },
    { type: "text", data: { text: " 的头像吐舌头" } },
  ], "a real target @ must remain at its original position for avatar parsing");

  releaseFirst();
  await waitFor(() => handled.some((entry) => entry.messageId === "2002" && hasImageRoutingOptions(entry.options)));
  await waitFor(() => handled.some((entry) => entry.messageId === "2004"));
  assert.equal(
    hasImageRoutingOptions(handled.find((entry) => entry.messageId === "2004")?.options),
    false,
    "ordinary commands must not receive image-ledger source metadata",
  );
  await waitFor(() => (
    db.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:image-command") as { watermark_id?: number } | undefined
  )?.watermark_id === 4);
});

test("Worker records natural image outcomes from ledger status without content fields", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-image-metrics-"));
  const db = openSharedDb(dataDir);
  const repository = new ImageRequestRepository(db);
  const bot = {
    getBotQq: () => BOT_QQ,
    async getBtCommand() { return undefined; },
    async getHtmlPreviewRequest() { return undefined; },
    async getNaturalImageRequest() { return { kind: "generate", prompt: "unused" }; },
    async isSystemCommand() { return false; },
    async getParticipationDecision() {
      return { action: "ignore", reason: "no_trigger", score: 0, policyVersion: "test", signals: {} };
    },
    async handleGroupMessage() {},
  } as unknown as BotApplication;
  const worker = new WorkerApp({
    dataDir,
    sharedDb: db,
    botApp: bot,
    consumerKey: "worker:image-metrics",
    isBlacklistedUser: async () => false,
  });
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const insert = (msgId: string) => db.insertMessage({
    groupId: GROUP_ID,
    userId: "20001",
    selfId: BOT_QQ,
    msgId,
    msgTime: Date.now(),
    text: "生成一张风景",
    imagesJson: "[]",
    canonicalSegmentsJson: JSON.stringify([
      { type: "at", qq: BOT_QQ },
      { type: "text", text: "生成一张风景" },
    ]),
    hasAtBot: true,
    isBotMsg: false,
    createdAt: Date.now(),
  });
  const claim = (msgId: string) => repository.claim({
    groupId: GROUP_ID,
    sourceMessageId: msgId,
    sourceRowId: insert(msgId),
    creatorUserId: "20001",
    requestKind: "generation",
    triggerSource: "natural",
  }).request;

  // This one has no ledger entry, which covers an early policy/error rejection.
  insert("3001");
  claim("3002");
  const unknown = claim("3003");
  repository.markOutcomeUnknown(unknown.id, "result_unknown");
  const deliveryUnknown = claim("3004");
  db.db.prepare(
    "UPDATE image_requests SET status = 'delivery_unknown', error_code = 'delivery_unknown' WHERE id = ?",
  ).run(deliveryUnknown.id);
  const failed = claim("3005");
  repository.markFailed(failed.id, "content_blocked");

  worker.start();
  await waitFor(() => (
    db.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:image-metrics") as { watermark_id?: number } | undefined
  )?.watermark_id === 5);

  const counters = (worker as unknown as {
    metrics: { snapshot(): { counters: Record<string, number> } };
  }).metrics.snapshot().counters;
  assert.equal(counters.natural_image_request_matched, 5);
  assert.equal(counters.natural_image_request_rejected, 2);
  assert.equal(counters.image_request_duplicate_reused, 4);
  assert.equal(counters.image_request_outcome_unknown, 1);
  assert.equal(counters.image_request_delivery_unknown, 1);
});

function hasImageRoutingOptions(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "imageRequestSourceRowId" in value);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met within timeout");
}
