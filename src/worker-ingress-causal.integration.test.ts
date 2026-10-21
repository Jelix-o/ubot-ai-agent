import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotApplication, type MessageReceipt, type MessageTransport } from "./bot.js";
import { IngressApp, normalizeIngressMessageTime } from "./index-ingress.js";
import { WorkerApp } from "./index-worker.js";
import { GroupLock } from "./services/group-lock.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { AiService } from "./services/ai-service.js";
import { ConversationContextRepository } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import { RecentGroupEvidenceService } from "./services/recent-group-evidence-service.js";
import { V3StateRepository } from "./services/v3-state-repository.js";
import { REQUIRED_V3_RUNTIME_CAPABILITIES } from "./services/v3-runtime-state.js";
import { openSharedDb, type SharedDb } from "./shared/sqlite.js";
import type {
  AiReply,
  AiIdentityContext,
  ConversationTurn,
  GroupBotConfig,
  NapcatGroupMessageEvent,
  SkillDefinition,
  MessageImageInput,
} from "./types.js";
import { WorkerTransport } from "./worker-transport.js";
import type { BtSearchRuntime } from "./services/bt-search-service.js";

const BOT_QQ = "12345";
const GROUP_ID = "67890";
const USER_ID = "20001";
const TEST_STATE_KEY = "0".repeat(64);

test("Ingress clamps future OneBot timestamps to receipt time", () => {
  const receivedAt = Date.parse("2026-08-27T03:00:00.000Z");

  assert.equal(
    normalizeIngressMessageTime(Math.floor((receivedAt + 60 * 60 * 1000) / 1_000), receivedAt),
    receivedAt,
  );
  assert.equal(
    normalizeIngressMessageTime(Math.floor((receivedAt - 30_000) / 1_000), receivedAt),
    receivedAt - 30_000,
  );
  assert.equal(normalizeIngressMessageTime(undefined, receivedAt), receivedAt);
});

class FakeNapCatTransport extends EventEmitter implements MessageTransport {
  readonly sent: Array<{ groupId: string; text: string; platformMessageId: string }> = [];
  private nextMessageId = 9_001;

  async sendGroupMessage(groupId: string, text: string): Promise<MessageReceipt> {
    const platformMessageId = String(this.nextMessageId++);
    this.sent.push({ groupId, text, platformMessageId });
    return { platformMessageId };
  }

  async sendGroupRecord(groupId: string, text: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, text);
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, imageFile);
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, text);
  }

  start(): void {}

  close(): void {}
}

class GatedEmitterTransport extends EventEmitter implements MessageTransport {
  activeSends = 0;
  maxConcurrentSends = 0;
  firstSendStarted = false;
  private releaseFirstSend!: () => void;
  private readonly firstSendGate = new Promise<void>((resolve) => {
    this.releaseFirstSend = resolve;
  });
  private sendCount = 0;

  async sendGroupMessage(_groupId: string, _text: string): Promise<MessageReceipt> {
    this.activeSends += 1;
    this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this.activeSends);
    const current = ++this.sendCount;
    try {
      if (current === 1) {
        this.firstSendStarted = true;
        await this.firstSendGate;
      }
      return { platformMessageId: `gated-${current}` };
    } finally {
      this.activeSends -= 1;
    }
  }

  async sendGroupRecord(groupId: string, text: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, text);
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, imageFile);
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<MessageReceipt> {
    return this.sendGroupMessage(groupId, text);
  }

  release(): void {
    this.releaseFirstSend();
  }

  start(): void {}

  close(): void {}
}

class StartupFailureTransport extends EventEmitter implements MessageTransport {
  started = false;
  closed = false;

  async sendGroupMessage(): Promise<MessageReceipt> {
    return { platformMessageId: "startup-failure" };
  }

  async sendGroupRecord(): Promise<MessageReceipt> {
    return { platformMessageId: "startup-failure" };
  }

  async sendGroupImage(): Promise<MessageReceipt> {
    return { platformMessageId: "startup-failure" };
  }

  async sendGroupAiRecord(): Promise<MessageReceipt> {
    return { platformMessageId: "startup-failure" };
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }
}

class AsyncStartupFailureTransport extends EventEmitter implements MessageTransport {
  started = false;
  closed = false;

  async sendGroupMessage(): Promise<MessageReceipt> {
    return { platformMessageId: "async-startup-failure" };
  }

  async sendGroupRecord(): Promise<MessageReceipt> {
    return { platformMessageId: "async-startup-failure" };
  }

  async sendGroupImage(): Promise<MessageReceipt> {
    return { platformMessageId: "async-startup-failure" };
  }

  async sendGroupAiRecord(): Promise<MessageReceipt> {
    return { platformMessageId: "async-startup-failure" };
  }

  async start(): Promise<void> {
    this.started = true;
    throw new Error("transport_start_failed");
  }

  close(): void {
    this.closed = true;
  }
}

class GatedWorkerTransport extends WorkerTransport {
  firstDraftReady = false;
  private gateFirstDraft = true;
  private releaseDraft!: () => void;
  private readonly draftRelease = new Promise<void>((resolve) => {
    this.releaseDraft = resolve;
  });

  override async sendGroupMessage(groupId: string, text: string): Promise<MessageReceipt | undefined> {
    const receipt = await super.sendGroupMessage(groupId, text);
    if (this.gateFirstDraft) {
      this.gateFirstDraft = false;
      this.firstDraftReady = true;
      await this.draftRelease;
    }
    return receipt;
  }

  publishFirstDraft(): void {
    this.releaseDraft();
  }
}

class CapturingAiService {
  readonly calls: Array<{ history: ConversationTurn[]; userInput: string; identityContext?: unknown; images?: MessageImageInput[]; scenarioInstruction?: string }> = [];

  constructor(
    private readonly replyForCall: (callNumber: number, userInput: string) => string =
      (callNumber) => callNumber === 1 ? "first answer" : "follow-up answer",
  ) {}

  async generateReply(args: {
    history: ConversationTurn[];
    userInput: string;
    identityContext?: unknown;
    images?: MessageImageInput[];
    scenarioInstruction?: string;
  }): Promise<AiReply> {
    this.calls.push({
      history: args.history.map((turn) => ({ ...turn })),
      userInput: args.userInput,
      identityContext: args.identityContext,
      images: args.images,
      scenarioInstruction: args.scenarioInstruction,
    });
    return {
      text: this.replyForCall(this.calls.length, args.userInput),
      model: "fake-reply-model",
      skillId: "assistant",
    };
  }
}

const groupConfig: GroupBotConfig = {
  groupId: GROUP_ID,
  currentSkillId: "assistant",
  allowedSkillIds: ["assistant"],
  switcherUserIds: [],
  liveChatUserIds: [],
  liveChatDelayMinutes: 5,
  dailyReportEnabled: false,
  dailyReportTime: "18:00",
  dailyReportTopUserCount: 3,
  holidayCountdownEnabled: false,
  holidayCountdownTime: "09:00",
};

const assistantSkill: SkillDefinition = {
  id: "assistant",
  name: "assistant",
  systemPrompt: "Answer the current question.",
  styleRules: ["concise"],
  knowledge: [],
  temperature: 0.2,
  maxContextTurns: 12,
};

test("Ingress emitter allows only one claim-and-delivery pass at a time", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ingress-single-flight-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const queueDb = openSharedDb(dataDir);
  const transport = new GatedEmitterTransport();
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, transport);
  t.after(async () => {
    await ingress.stop();
    queueDb.close();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  queueDb.enqueueOutbox(GROUP_ID, null, "first");
  const emitter = ingress as unknown as { runEmitterSafely(): Promise<void> };
  const firstPass = emitter.runEmitterSafely();
  await waitFor(() => transport.firstSendStarted);
  queueDb.enqueueOutbox(GROUP_ID, null, "second");
  const overlappingPass = emitter.runEmitterSafely();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(transport.maxConcurrentSends, 1);
  transport.release();
  await Promise.all([firstPass, overlappingPass]);
  await emitter.runEmitterSafely();
  assert.equal(transport.maxConcurrentSends, 1);
  assert.equal((queueDb.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'sent'").get() as { count: number }).count, 2);
});

test("Ingress startup failure cleans up transport, timers, read API, and its database", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ingress-startup-failure-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const transport = new StartupFailureTransport();
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, transport);
  const internals = ingress as unknown as {
    messageRecalls: { start(): void; stop(): Promise<void> };
    readApi: { server: { listening: boolean } };
    sharedDb: SharedDb;
  };
  let recallsStopped = false;
  internals.messageRecalls = {
    start() {
      throw new Error("recall_start_failed");
    },
    async stop() {
      recallsStopped = true;
    },
  };
  t.after(async () => {
    await ingress.stop();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(ingress.start(), /recall_start_failed/);
  assert.equal(transport.started, true);
  assert.equal(transport.closed, true);
  assert.equal(recallsStopped, true);
  assert.equal(internals.readApi.server.listening, false);
  assert.throws(() => internals.sharedDb.db.prepare("SELECT 1").get());
});

test("Ingress awaits asynchronous transport startup failures before reporting ready", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ingress-async-startup-failure-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const transport = new AsyncStartupFailureTransport();
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, transport);
  const internals = ingress as unknown as {
    readApi: { server: { listening: boolean } };
    sharedDb: SharedDb;
  };
  t.after(async () => {
    await ingress.stop();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(ingress.start(), /transport_start_failed/);
  assert.equal(transport.started, true);
  assert.equal(transport.closed, true);
  assert.equal(internals.readApi.server.listening, false);
  assert.throws(() => internals.sharedDb.db.prepare("SELECT 1").get());
});

test("WorkerApp stop drains active messages before its shared database is closed", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-stop-drain-"));
  const db = openSharedDb(dataDir);
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let markHandlerStarted!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  const bot = {
    getBotQq: () => BOT_QQ,
    async handleGroupMessage(): Promise<void> {
      markHandlerStarted();
      await handlerGate;
    },
  } as unknown as BotApplication;
  const worker = new WorkerApp({
    dataDir,
    sharedDb: db,
    botApp: bot,
    consumerKey: "worker:stop-drain",
    isBlacklistedUser: async () => true,
  });
  t.after(async () => {
    releaseHandler();
    await worker.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  db.insertMessage({
    groupId: GROUP_ID,
    userId: USER_ID,
    selfId: BOT_QQ,
    msgId: "stop-drain",
    msgTime: Date.now(),
    text: "blacklisted message",
    imagesJson: "[]",
    hasAtBot: true,
    isBotMsg: false,
    createdAt: Date.now(),
  });
  worker.start();
  await handlerStarted;

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stopped, false, "WorkerApp.stop must wait for an active message handler");
  assert.doesNotThrow(() => db.db.prepare("SELECT 1").get());

  releaseHandler();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(db.pollMessages("worker:stop-drain", 100).length, 0);
  assert.doesNotThrow(() => db.db.prepare("SELECT 1").get());
});

test("Ingress -> WorkerApp -> outbox -> real QQ receipt -> quoted causal chain", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-ingress-causal-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const napcat = new FakeNapCatTransport();
  const workerTransportDb = openSharedDb(dataDir);
  const botContextDb = openSharedDb(dataDir);
  const observerDb = openSharedDb(dataDir);
  const workerTransport = new GatedWorkerTransport(workerTransportDb);
  const repository = new ConversationContextRepository(botContextDb);
  const aiService = new CapturingAiService();
  const bot = createBot(workerTransport, repository, aiService);
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, napcat);
  const worker = new WorkerApp({
    dataDir,
    sharedDb: workerTransportDb,
    botApp: bot,
    consumerKey: "worker:causal-integration",
    isBlacklistedUser: async () => false,
  });

  t.after(async () => {
    await worker.stop();
    await bot.stop();
    await ingress.stop();
    observerDb.close();
    botContextDb.close();
    workerTransportDb.close();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await ingress.start();
  worker.start();

  napcat.emit("groupMessage", inboundEvent({
    messageId: 101,
    text: "first question",
    eventTimeSeconds: Math.floor(Date.now() / 1_000),
  }));

  await waitFor(() => workerTransport.firstDraftReady);
  const preparing = observerDb.db.prepare(
    "SELECT status, topic_id, branch_id, source_turn_id, turn_id FROM outbox ORDER BY id LIMIT 1",
  ).get() as {
    status: string;
    topic_id: string;
    branch_id: string;
    source_turn_id: number;
    turn_id: number | null;
  };
  const preparingRoute = routeForMessage(observerDb, "101");
  assert.ok(preparingRoute);
  const sourceMessage = observerDb.db.prepare(
    "SELECT sender_card, sender_nickname FROM messages WHERE group_id = ? AND msg_id = ?",
  ).get(GROUP_ID, "101") as { sender_card: string | null; sender_nickname: string | null };
  assert.deepEqual({ ...sourceMessage }, { sender_card: "测试群名片", sender_nickname: "Tester" });
  assert.deepEqual(
    (aiService.calls[0]?.identityContext as { currentSpeaker?: unknown } | undefined)?.currentSpeaker,
    { senderCard: "测试群名片", senderNickname: "Tester" },
  );
  assert.deepEqual(
    { ...preparing },
    {
      status: "preparing",
      topic_id: preparingRoute.topic_id,
      branch_id: preparingRoute.branch_id,
      source_turn_id: preparingRoute.parent_turn_id ?? routeTurnId(observerDb, "101"),
      turn_id: null,
    },
  );
  assert.deepEqual(
    observerDb.claimOutbox(10, Date.now()),
    [],
    "Ingress must not deliver a draft before its assistant turn is persisted",
  );
  workerTransport.publishFirstDraft();

  await waitFor(() => napcat.sent.length === 1);
  assert.equal(napcat.sent[0]?.text, "first answer");
  assert.equal(napcat.sent[0]?.platformMessageId, "9001");

  const firstRoute = routeForMessage(observerDb, "101");
  assert.ok(firstRoute);
  const firstAssistant = repository.getMessageContext(GROUP_ID, "9001");
  assert.equal(firstAssistant?.direction, "assistant");
  assert.equal(firstAssistant?.branchId, firstRoute.branch_id);
  assert.ok(firstAssistant?.turnId);
  assert.equal(
    repository.getMessageContext("another-group", "9001"),
    undefined,
    "a real QQ message id must only restore context inside its group",
  );

  napcat.emit("groupMessage", inboundEvent({
    messageId: 102,
    text: "why?",
    replyToMessageId: "9001",
    hasAtBot: false,
    // QQ timestamps have one-second precision. Moving to the next second keeps
    // the quoted assistant receipt causally older than this inbound message.
    eventTimeSeconds: Math.floor(Date.now() / 1_000) + 1,
  }));

  await waitFor(() => aiService.calls.length === 2);
  await waitFor(() => napcat.sent.length === 2);

  const secondRoute = routeForMessage(observerDb, "102");
  assert.ok(secondRoute);
  assert.equal(secondRoute.reply_to_message_id, "9001");
  assert.equal(secondRoute.route_reason, "explicit-reply");
  assert.equal(secondRoute.topic_id, firstRoute.topic_id);
  assert.equal(secondRoute.branch_id, firstRoute.branch_id);
  assert.equal(secondRoute.parent_turn_id, firstAssistant?.turnId);

  const secondCall = aiService.calls[1]!;
  assert.equal(secondCall.userInput, "why?");
  assert.deepEqual(secondCall.history.map((turn) => turn.role), ["user", "assistant"]);
  assert.match(secondCall.history[0]!.content, /first question/);
  assert.equal(secondCall.history[1]!.content, "first answer");
  assert.equal(
    secondCall.history.some((turn) => turn.content.includes("follow-up answer")),
    false,
  );
  assert.equal(napcat.sent[1]?.platformMessageId, "9002");

  const quotedBotDecision = participationDecisionForMessage(observerDb, "102");
  assert.deepEqual(quotedBotDecision && {
    action: quotedBotDecision.action,
    reason: quotedBotDecision.reason,
    signals: JSON.parse(quotedBotDecision.signals_json),
  }, {
    action: "reply",
    reason: "explicit_reply",
    signals: {
      hasAtBot: false,
      hasReply: true,
      hasImages: false,
      isCommand: false,
      isConversationCommand: false,
      groupMuted: false,
      keywordTriggered: false,
    },
  });

  napcat.emit("groupMessage", inboundEvent({
    messageId: 103,
    text: "this is for another member",
    replyToMessageId: "ordinary-member-message",
    hasAtBot: false,
    eventTimeSeconds: Math.floor(Date.now() / 1_000) + 2,
  }));
  await waitFor(() => participationDecisionForMessage(observerDb, "103") !== undefined);
  assert.equal(aiService.calls.length, 2, "quoting a non-bot message must not create an AI reply");
  assert.equal(napcat.sent.length, 2, "quoting a non-bot message must not enter the outbox");
  const quotedMemberDecision = participationDecisionForMessage(observerDb, "103");
  assert.deepEqual(quotedMemberDecision && {
    action: quotedMemberDecision.action,
    reason: quotedMemberDecision.reason,
    signals: JSON.parse(quotedMemberDecision.signals_json),
  }, {
    action: "observe",
    reason: "ambient_observation",
    signals: {
      hasAtBot: false,
      hasReply: false,
      hasImages: false,
      isCommand: false,
      isConversationCommand: false,
      groupMuted: false,
      keywordTriggered: false,
    },
  });

  napcat.emit("groupMessage", inboundEvent({
    messageId: 104,
    text: "根据现有聊天记录锐评一下",
    mentionTargetUserId: "2409332588",
    eventTimeSeconds: Math.floor(Date.now() / 1_000) + 3,
  }));
  await waitFor(() => aiService.calls.length === 3);
  await waitFor(() => napcat.sent.length === 3);

  const evaluationCall = aiService.calls[2]!;
  const evaluationIdentity = evaluationCall.identityContext as {
    interactionTargets?: Array<{ userId?: string; source: string }>;
    recentGroupEvidenceRequested?: boolean;
    recentGroupEvidenceTargetUserId?: string;
  };
  assert.deepEqual(evaluationIdentity.interactionTargets, [
    { userId: "2409332588", names: ["2409332588"], source: "mention" },
  ]);
  assert.equal(evaluationIdentity.recentGroupEvidenceRequested, true);
  assert.equal(evaluationIdentity.recentGroupEvidenceTargetUserId, "2409332588");
  const persistedEvaluation = observerDb.db.prepare(
    "SELECT verified_mention_user_ids_json FROM messages WHERE group_id = ? AND msg_id = ?",
  ).get(GROUP_ID, "104") as { verified_mention_user_ids_json: string };
  assert.deepEqual(JSON.parse(persistedEvaluation.verified_mention_user_ids_json), ["2409332588"]);
});

test("unquoted group question receives a short ambient window without joining the prior branch", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-ambient-context-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const napcat = new FakeNapCatTransport();
  const workerTransportDb = openSharedDb(dataDir);
  const botContextDb = openSharedDb(dataDir);
  const observerDb = openSharedDb(dataDir);
  const workerTransport = new WorkerTransport(workerTransportDb);
  const repository = new ConversationContextRepository(botContextDb);
  const aiService = new CapturingAiService((callNumber) => callNumber === 1
    ? "现代梗圈顶流必须是常公，手谕直接批到前线"
    : "常公就是蒋中正");
  const bot = createBot(
    workerTransport,
    repository,
    aiService,
    new RecentGroupEvidenceService(botContextDb),
  );
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, napcat);
  const worker = new WorkerApp({
    dataDir,
    sharedDb: workerTransportDb,
    botApp: bot,
    consumerKey: "worker:ambient-context-integration",
    isBlacklistedUser: async () => false,
  });

  t.after(async () => {
    await worker.stop();
    await bot.stop();
    await ingress.stop();
    observerDb.close();
    botContextDb.close();
    workerTransportDb.close();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await ingress.start();
  worker.start();
  const now = Math.floor(Date.now() / 1_000);
  napcat.emit("groupMessage", inboundEvent({
    messageId: 301,
    userId: "493213481",
    text: "我国史上著名的微操达人",
    eventTimeSeconds: now,
  }));
  await waitFor(() => (
    (observerDb.db.prepare("SELECT status FROM outbox ORDER BY id DESC LIMIT 1").get() as { status?: string } | undefined)?.status === "sent"
  ));

  napcat.emit("groupMessage", inboundEvent({
    messageId: 302,
    userId: "1569671790",
    text: "微操是指轻轻的操妹子吗",
    hasAtBot: false,
    eventTimeSeconds: now + 1,
  }));
  await waitFor(() => Boolean(observerDb.db.prepare("SELECT 1 FROM messages WHERE msg_id = '302'").get()));
  await new Promise((resolve) => setTimeout(resolve, 5));

  napcat.emit("groupMessage", inboundEvent({
    messageId: 303,
    userId: "493213481",
    text: "常工与中正比如何",
    eventTimeSeconds: now + 2,
  }));
  await waitFor(() => aiService.calls.length === 2);

  const firstRoute = routeForMessage(observerDb, "301");
  const secondRoute = routeForMessage(observerDb, "303");
  assert.ok(firstRoute);
  assert.ok(secondRoute);
  assert.equal(secondRoute.route_reason, "new-topic");
  assert.equal(secondRoute.parent_turn_id, null);
  assert.notEqual(secondRoute.topic_id, firstRoute.topic_id);

  const ambient = (aiService.calls[1]?.identityContext as {
    ambientGroupContext?: Array<{ role: string; userId?: string; text: string }>;
  } | undefined)?.ambientGroupContext ?? [];
  assert.ok(ambient.some((message) => message.role === "bot" && message.text.includes("常公")));
  assert.ok(ambient.some((message) => message.userId === "1569671790" && message.text.includes("微操")));
});

test("Ingress records rate-limited messages but Worker skips them without an AI reply", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-ingress-rate-limit-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const napcat = new FakeNapCatTransport();
  const workerTransportDb = openSharedDb(dataDir);
  const botContextDb = openSharedDb(dataDir);
  const observerDb = openSharedDb(dataDir);
  const workerTransport = new WorkerTransport(workerTransportDb);
  const repository = new ConversationContextRepository(botContextDb);
  const aiService = new CapturingAiService();
  const bot = createBot(workerTransport, repository, aiService);
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
  }, napcat);
  const worker = new WorkerApp({
    dataDir,
    sharedDb: workerTransportDb,
    botApp: bot,
    consumerKey: "worker:rate-limit-integration",
    isBlacklistedUser: async () => false,
  });

  t.after(async () => {
    await worker.stop();
    await bot.stop();
    await ingress.stop();
    observerDb.close();
    botContextDb.close();
    workerTransportDb.close();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await ingress.start();
  worker.start();
  const now = Math.floor(Date.now() / 1_000);
  for (let messageId = 201; messageId <= 207; messageId += 1) {
    napcat.emit("groupMessage", inboundEvent({
      messageId,
      text: `burst ${messageId}`,
      eventTimeSeconds: now,
    }));
    await waitFor(() => (
      (observerDb.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n === messageId - 200
    ));
  }

  await waitFor(() => (
    (observerDb.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:rate-limit-integration") as { watermark_id: number } | undefined)?.watermark_id === 7
  ));

  const dropped = observerDb.db.prepare(
    "SELECT processable, drop_reason FROM messages WHERE msg_id = ?",
  ).get("207") as { processable: number; drop_reason: string | null };
  assert.deepEqual({ ...dropped }, { processable: 0, drop_reason: "rate_limited" });
  assert.equal(aiService.calls.length, 6);
  await waitFor(() => napcat.sent.length === 6);
  assert.equal(napcat.sent.length, 6);
});

test("blacklisted @ bypasses ingress limits without creating conversation state", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-ingress-blacklisted-"));
  const readApiPort = await reservePort();
  const restoreEnvironment = setRequiredEnvironment(readApiPort);
  const napcat = new FakeNapCatTransport();
  const workerTransportDb = openSharedDb(dataDir);
  const botContextDb = openSharedDb(dataDir);
  const observerDb = openSharedDb(dataDir);
  const state = new V3StateRepository(observerDb, { stateEncryptionKey: TEST_STATE_KEY });
  const blacklistedUserId = "30001";
  const blacklistedGroup: GroupBotConfig = {
    ...groupConfig,
    blacklistedUserIds: [blacklistedUserId],
    dailyReportEnabled: true,
  };
  state.markCutover();
  state.saveCapabilityPolicy({
    version: 1,
    enabledCapabilities: [...REQUIRED_V3_RUNTIME_CAPABILITIES],
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
  state.saveGroups({ groups: [blacklistedGroup] });

  const workerTransport = new WorkerTransport(workerTransportDb);
  const repository = new ConversationContextRepository(botContextDb);
  const aiService = new CapturingAiService();
  const dailyReportRecords: Array<{ groupId: string; userId: string; text: string }> = [];
  const bot = createBot(workerTransport, repository, aiService, undefined, {
    groupConfigOverrides: {
      blacklistedUserIds: [blacklistedUserId],
      dailyReportEnabled: true,
    },
    dailyReportRecords,
  });
  const ingress = new IngressApp({
    botQq: BOT_QQ,
    dataDir,
    metricsDir: path.join(dataDir, "shared", "metrics"),
    stateEncryptionKey: TEST_STATE_KEY,
  }, napcat);
  const worker = new WorkerApp({
    dataDir,
    sharedDb: workerTransportDb,
    botApp: bot,
    consumerKey: "worker:blacklisted-rate-limit-integration",
    isBlacklistedUser: async (groupId, userId) => (
      (state.getGroup(groupId)?.blacklistedUserIds ?? []).includes(userId)
    ),
    stateEncryptionKey: TEST_STATE_KEY,
  });

  t.after(async () => {
    await worker.stop();
    await bot.stop();
    await ingress.stop();
    observerDb.close();
    botContextDb.close();
    workerTransportDb.close();
    restoreEnvironment();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await ingress.start();
  worker.start();
  const now = Math.floor(Date.now() / 1_000);
  napcat.emit("groupMessage", inboundEvent({
    messageId: 400,
    userId: "30002",
    text: "",
    atOnly: true,
    eventTimeSeconds: now,
  }));
  assert.equal(
    (observerDb.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_id = '400'").get() as { n: number }).n,
    0,
  );

  for (let messageId = 401; messageId <= 406; messageId += 1) {
    napcat.emit("groupMessage", inboundEvent({
      messageId,
      userId: blacklistedUserId,
      text: `blacklisted burst ${messageId}`,
      eventTimeSeconds: now,
    }));
    await waitFor(() => Boolean(observerDb.db.prepare("SELECT 1 FROM messages WHERE msg_id = ?").get(String(messageId))));
  }
  await waitFor(() => napcat.sent.length === 6);

  // The seventh message is a valid platform @ segment with no text payload.
  // It must bypass the bucket and add exactly one image response.
  const sentBeforeAtOnly = napcat.sent.length;
  napcat.emit("groupMessage", inboundEvent({
    messageId: 407,
    userId: blacklistedUserId,
    text: "",
    atOnly: true,
    eventTimeSeconds: now,
  }));
  await waitFor(() => Boolean(observerDb.db.prepare("SELECT 1 FROM messages WHERE msg_id = '407'").get()));
  await waitFor(() => napcat.sent.length === sentBeforeAtOnly + 1);

  const seventh = observerDb.db.prepare(
    "SELECT processable, drop_reason FROM messages WHERE msg_id = ?",
  ).get("407") as { processable: number; drop_reason: string | null };
  assert.deepEqual({ ...seventh }, { processable: 1, drop_reason: null });
  assert.equal(napcat.sent.length, 7);
  assert.ok(napcat.sent.every((message) => message.text.startsWith("base64://")));
  assert.equal(aiService.calls.length, 0);
  assert.equal(dailyReportRecords.length, 6);

  const responses = observerDb.db.prepare(
    `SELECT kind, reply_to, topic_id, branch_id, source_turn_id, turn_id, status
       FROM outbox ORDER BY id`,
  ).all() as Array<{
    kind: string;
    reply_to: string | null;
    topic_id: string | null;
    branch_id: string | null;
    source_turn_id: number | null;
    turn_id: number | null;
    status: string;
  }>;
  assert.equal(responses.length, 7);
  for (const response of responses) {
    assert.deepEqual({ ...response }, {
      kind: "image",
      reply_to: null,
      topic_id: null,
      branch_id: null,
      source_turn_id: null,
      turn_id: null,
      status: "sent",
    });
  }

  for (let messageId = 401; messageId <= 407; messageId += 1) {
    const sourceState = observerDb.db.prepare(
      `SELECT r.source_row_id AS route_id, d.source_row_id AS decision_id
         FROM messages m
         LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
         LEFT JOIN participation_decisions d ON d.source_row_id = m.id
        WHERE m.msg_id = ?`,
    ).get(String(messageId)) as { route_id: number | null; decision_id: number | null };
    assert.deepEqual({ ...sourceState }, { route_id: null, decision_id: null });
  }
  assert.equal(
    (observerDb.db.prepare("SELECT COUNT(*) AS n FROM conversation_turns").get() as { n: number }).n,
    0,
  );

  // Blacklist commands remain Bot-owned and must not fall through to the meme.
  const sentBeforeCommand = napcat.sent.length;
  napcat.emit("groupMessage", inboundEvent({
    messageId: 408,
    userId: blacklistedUserId,
    text: "#拉黑",
    eventTimeSeconds: now,
  }));
  await waitFor(() => dailyReportRecords.length === 7);
  await waitFor(() => (
    (observerDb.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:blacklisted-rate-limit-integration") as { watermark_id: number } | undefined)?.watermark_id === 8
  ));
  assert.equal(napcat.sent.length, sentBeforeCommand);
  const commandSourceState = observerDb.db.prepare(
    `SELECT r.source_row_id AS route_id, d.source_row_id AS decision_id
       FROM messages m
       LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
       LEFT JOIN participation_decisions d ON d.source_row_id = m.id
      WHERE m.msg_id = ?`,
  ).get("408") as { route_id: number | null; decision_id: number | null };
  assert.deepEqual({ ...commandSourceState }, { route_id: null, decision_id: null });

  // The exemption is narrow: a non-blacklisted mention and a blacklisted
  // non-mention remain subject to the existing per-group token bucket.
  napcat.emit("groupMessage", inboundEvent({
    messageId: 409,
    userId: "30002",
    text: "ordinary burst",
    eventTimeSeconds: now,
  }));
  napcat.emit("groupMessage", inboundEvent({
    messageId: 410,
    userId: blacklistedUserId,
    text: "blacklisted without mention",
    hasAtBot: false,
    eventTimeSeconds: now,
  }));
  await waitFor(() => Boolean(observerDb.db.prepare("SELECT 1 FROM messages WHERE msg_id = '410'").get()));
  await waitFor(() => (
    (observerDb.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get("worker:blacklisted-rate-limit-integration") as { watermark_id: number } | undefined)?.watermark_id === 10
  ));

  for (const messageId of ["409", "410"]) {
    const dropped = observerDb.db.prepare(
      "SELECT processable, drop_reason FROM messages WHERE msg_id = ?",
    ).get(messageId) as { processable: number; drop_reason: string | null };
    assert.deepEqual({ ...dropped }, { processable: 0, drop_reason: "rate_limited" });
  }
  assert.equal(napcat.sent.length, sentBeforeCommand);
  assert.equal(aiService.calls.length, 0);
});

interface TestBotOptions {
  groupConfigOverrides?: Partial<GroupBotConfig>;
  groupMemoryStore?: ConstructorParameters<typeof BotApplication>[14];
  dailyReportRecords?: Array<{ groupId: string; userId: string; text: string }>;
  btSearchService?: BtSearchRuntime;
}

function createBot(
  transport: WorkerTransport,
  repository: ConversationContextRepository,
  aiService: CapturingAiService,
  recentGroupEvidenceService?: RecentGroupEvidenceService,
  options: TestBotOptions = {},
): BotApplication {
  const configuredGroup: GroupBotConfig = {
    ...groupConfig,
    ...options.groupConfigOverrides,
  };
  const groupConfigService = {
    async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
      return groupId === GROUP_ID
        ? {
          ...configuredGroup,
          allowedSkillIds: [...configuredGroup.allowedSkillIds],
          switcherUserIds: [...configuredGroup.switcherUserIds],
          liveChatUserIds: [...configuredGroup.liveChatUserIds],
          ...(configuredGroup.blacklistedUserIds
            ? { blacklistedUserIds: [...configuredGroup.blacklistedUserIds] }
            : {}),
        }
        : undefined;
    },
  };
  const skillService = {
    async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
      return skillId === assistantSkill.id ? assistantSkill : undefined;
    },
  };
  const conversationStore = {
    async flush(): Promise<void> {},
    async clearUser(): Promise<void> {},
    async clearGroup(): Promise<void> {},
  };
  const dailyReportService = {
    async recordMessage(input: { groupId: string; userId: string; text: string }): Promise<void> {
      options.dailyReportRecords?.push({
        groupId: input.groupId,
        userId: input.userId,
        text: input.text,
      });
    },
  };
  const scheduledReminderService = {
    parseCreateRequest(): null {
      return null;
    },
  };

  return new BotApplication(
    transport,
    groupConfigService as never,
    skillService as never,
    conversationStore as never,
    aiService as never,
    {} as never,
    dailyReportService as never,
    {} as never,
    scheduledReminderService as never,
    {} as never,
    new GroupLock(),
    new LiveChatService(),
    BOT_QQ,
    false,
    options.groupMemoryStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    repository,
    new ConversationContextRouter(repository),
    undefined,
    undefined,
    undefined,
    undefined,
    recentGroupEvidenceService,
    undefined, undefined, undefined, undefined,
    options.btSearchService,
  );
}

class ConversationReplayAi extends CapturingAiService {
  readonly resolutions: Array<any> = [];
  readonly replies: Array<Partial<AiReply> & { text: string }> = [];
  resolve: (data: any) => Record<string, unknown> = data => ({
    intent: "chat", relation: data.candidates.length ? "follow_up" : "new", resolvedInput: data.text,
    topicCandidateId: data.candidates.find((item: any) => item.ownerUserId === data.userId)?.id,
    selectedMessageIds: data.messages.map((item: any) => item.messageId), needsMoreContext: false,
  });
  async resolveConversationContext(args: { data: string }): Promise<string> {
    const data = JSON.parse(args.data);
    this.resolutions.push(data);
    return JSON.stringify(this.resolve(data));
  }
  override async generateReply(args: Parameters<CapturingAiService["generateReply"]>[0]): Promise<AiReply> {
    return { ...await super.generateReply(args), ...(this.replies.shift() ?? { text: "接住了" }) };
  }
}

function conversationReplay(t: test.TestContext, overrides: Partial<GroupBotConfig> = {}, gated = false, groupMemoryStore?: TestBotOptions["groupMemoryStore"]) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "huixian-replay-"));
  const db = openSharedDb(dataDir), repository = new ConversationContextRepository(db);
  const transport = gated ? new GatedWorkerTransport(db) : new WorkerTransport(db);
  const ai = new ConversationReplayAi();
  const bot = createBot(transport, repository, ai, new RecentGroupEvidenceService(db), { groupConfigOverrides: { visionEnabled: true, ...overrides }, groupMemoryStore });
  let time = Date.now() - 90_000, messageId = 40_000;
  t.after(async () => { await bot.stop(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const add = (text: string, userId = USER_ID, options: { image?: boolean; passive?: boolean; elapsed?: number; replyToMessageId?: string; excludedDrop?: boolean } = {}) => {
    time += options.elapsed ?? 1_000;
    const id = ++messageId;
    const images = options.image ? [{ url: "https://example.test/score.png" }] : [];
    const sourceRowId = db.insertMessage({ groupId: GROUP_ID, userId, selfId: BOT_QQ, msgId: String(id), msgTime: time, createdAt: time, text,
      imagesJson: JSON.stringify(images), hasAtBot: !options.passive, isBotMsg: false,
      ...(options.excludedDrop ? { processable: false, dropReason: "rate_limited" } : {}),
    });
    const event = inboundEvent({ messageId: id, userId, text, eventTimeSeconds: Math.floor(time / 1_000), hasAtBot: !options.passive, replyToMessageId: options.replyToMessageId });
    if (options.image) (event.message as any[]).push({ type: "image", data: images[0] });
    const input = { sourceRowId, groupId: GROUP_ID, userId, sourceMessageId: String(id), text, hasImages: options.image, nowMs: time, replyToMessageId: options.replyToMessageId };
    return { input, event, id: String(id) };
  };
  const ask = async (...args: Parameters<typeof add>) => {
    const message = add(...args);
    const route = await bot.prepareConversationRoute(message.input);
    await bot.handleGroupMessage(message.event, undefined, route);
    return { ...message, route: route! };
  };
  const ack = () => {
    const rows = db.db.prepare("SELECT id FROM outbox WHERE status = 'pending'").all() as Array<{ id: number }>;
    for (const row of rows) db.ackOutboxDelivery(row.id, `receipt-${row.id}`, time + 100);
  };
  const identity = (index = ai.calls.length - 1) => ai.calls[index]?.identityContext as AiIdentityContext;
  return { db, repository, transport, ai, bot, add, ask, ack, identity };
}

const replayIdentities = [
  { userIds: [USER_ID], names: ["成员甲", "甲别称", "管理员"], note: "不应读取的个人画像" },
  { userIds: ["20002"], names: ["成员乙", "乙别称", "重名"] },
  { userIds: ["20003"], names: ["成员丙", "重名"] },
];
const identityOutbox = (f: ReturnType<typeof conversationReplay>) => f.db.db.prepare("SELECT id, text, status, reply_to FROM outbox ORDER BY id").all() as Array<{ id: number; text: string; status: string; reply_to: string }>;

test("identity replay: saved who queries skip topic/reply models and all profile reads, then publish through outbox", async t => {
  const memory = new Proxy({}, { get() { throw new Error("identity must not read member profiles"); } }) as TestBotOptions["groupMemoryStore"];
  const f = conversationReplay(t, { manualIdentities: replayIdentities, ambientGroupContextEnabled: false, memoryDisabledUserIds: ["20002"] }, false, memory);
  f.add("旁边的话题不该影响身份查询", "20002", { passive: true });
  let directoryReads = 0;
  f.transport.listGroupMembers = async () => { directoryReads++; throw new Error("unnecessary directory read"); };
  const a = await f.ask("甲别称是谁");
  const b = await f.ask("谁是乙别称");
  await f.ask("认识甲别称吗");
  await f.ask("我是谁");
  await f.ask("管理员是谁");
  assert.equal(f.ai.resolutions.length, 0);
  assert.equal(f.ai.calls.length, 0);
  assert.equal(directoryReads, 0);
  const rows = identityOutbox(f);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].text, "甲别称就是成员甲。");
  assert.equal(rows[1].text, "乙别称就是成员乙。");
  assert.equal(rows[3].text, "你是成员甲。");
  assert.equal(rows[0].reply_to, a.id);
  assert.equal(rows[1].reply_to, b.id);
  assert.ok(rows.every(row => row.status === "pending"));
  f.ack();
  assert.ok(identityOutbox(f).every(row => row.status === "sent"));
});

test("identity replay: real mentions and same-group quoted authors resolve, conflicts and duplicate names clarify", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  const mention = f.add("他是谁");
  (mention.event.message as any[]).push({ type: "at", data: { qq: "20002" } });
  const route = await f.bot.prepareConversationRoute(mention.input);
  await f.bot.handleGroupMessage(mention.event, undefined, route);
  assert.equal(identityOutbox(f)[0].text, "这位是成员乙。");
  f.transport.getMessage = async id => ({ messageId: id, groupId: GROUP_ID, userId: "20002", text: "旧发言", images: [] });
  await f.ask("他是谁", USER_ID, { replyToMessageId: "quoted-author" });
  assert.equal(identityOutbox(f)[1].text, "这位是成员乙。");
  const conflict = f.add("甲别称是谁");
  (conflict.event.message as any[]).push({ type: "at", data: { qq: "20002" } });
  await f.bot.handleGroupMessage(conflict.event, undefined, await f.bot.prepareConversationRoute(conflict.input));
  assert.match(identityOutbox(f)[2].text, /外号对应的人.*引用的那位/);
  await f.ask("重名是谁");
  assert.match(identityOutbox(f)[3].text, /不止一位/);
  f.transport.getMessage = async id => ({ messageId: id, groupId: "different-group", userId: "20002", text: "跨群不可读", images: [] });
  await f.ask("他是谁", USER_ID, { replyToMessageId: "foreign-author" });
  assert.match(identityOutbox(f)[4].text, /你指的是哪位/);
  assert.equal(f.ai.calls.length + f.ai.resolutions.length, 0);
});

test("identity replay: directory rename and failure keep confirmed account mappings, never fabricate names", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  f.transport.listGroupMembers = async () => [{ user_id: 20001, card: "全新名片" }];
  await f.ask("成员甲是谁");
  assert.match(identityOutbox(f)[0].text, /全新名片/);
  f.transport.listGroupMembers = async () => { throw new Error("directory offline"); };
  await f.ask("成员甲是谁");
  assert.match(identityOutbox(f)[1].text, /能对上人/);
  assert.doesNotMatch(identityOutbox(f)[1].text, /不认识|无法确认|全新名片/);
  await f.ask("甲别称是不是成员甲");
  assert.match(identityOutbox(f)[2].text, /^是同一位/);
  assert.equal(f.ai.calls.length + f.ai.resolutions.length, 0);
});

test("identity replay: concurrent entry and retry after restart reuse one outbox delivery", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  let directoryReads = 0;
  f.transport.listGroupMembers = async () => { directoryReads++; return [{ user_id: 20001, card: "当前名片" }]; };
  const message = f.add("成员甲是谁");
  const route = await f.bot.prepareConversationRoute(message.input);
  await Promise.all([f.bot.handleGroupMessage(message.event, undefined, route), f.bot.handleGroupMessage(message.event, undefined, route)]);
  assert.equal(directoryReads, 1);
  assert.equal(identityOutbox(f).length, 1);
  const restarted = createBot(f.transport, new ConversationContextRepository(f.db), f.ai, undefined, { groupConfigOverrides: { manualIdentities: replayIdentities } });
  t.after(() => restarted.stop());
  await restarted.handleGroupMessage(message.event, undefined, route);
  assert.equal(identityOutbox(f).length, 1);
  const claimed = f.db.claimOutbox(1);
  assert.equal(claimed.length, 1);
  assert.equal(f.db.claimOutbox(1).length, 0);
  f.db.ackOutboxDelivery(claimed[0].id, "identity-receipt");
  await restarted.handleGroupMessage(message.event, undefined, route);
  assert.equal(identityOutbox(f).length, 1);
  assert.equal(f.ai.calls.length + f.ai.resolutions.length, 0);
});

test("identity replay: directory deadline preserves a known mapping and late results never send another reply", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  let finish!: (members: Array<{ user_id: number; card: string }>) => void;
  f.transport.listGroupMembers = () => new Promise(resolve => { finish = resolve; });
  await f.ask("成员甲是谁");
  assert.equal(identityOutbox(f).length, 1);
  assert.match(identityOutbox(f)[0].text, /能对上人/);
  finish([{ user_id: 20001, card: "迟到的名片" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(identityOutbox(f).length, 1);
  assert.doesNotMatch(identityOutbox(f)[0].text, /迟到的名片/);
  assert.equal(f.ai.calls.length + f.ai.resolutions.length, 0);
});

test("identity replay: an unregistered real @ uses only the bounded directory step", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  let unboundedReads = 0;
  f.transport.resolveMemberIdentities = async () => { unboundedReads++; return []; };
  f.transport.listGroupMembers = async () => [{ user_id: 20004, card: "成员丁" }];
  const message = f.add("他是谁");
  (message.event.message as any[]).push({ type: "at", data: { qq: "20004" } });
  await f.bot.handleGroupMessage(message.event, undefined, await f.bot.prepareConversationRoute(message.input));
  assert.match(identityOutbox(f)[0].text, /成员丁/);
  assert.equal(unboundedReads, 0);
  assert.equal(f.ai.calls.length + f.ai.resolutions.length, 0);
});

test("identity replay: unregistered names and public figures remain ordinary questions without alias substring matches", async t => {
  const f = conversationReplay(t, { manualIdentities: replayIdentities });
  for (const text of ["李白是谁", "陌生人是谁", "甲别称二号是谁"]) await f.ask(text);
  assert.equal(f.ai.calls.length, 3);
  assert.equal(f.ai.resolutions.length, 0);
  assert.ok(f.ai.calls.every(call => (call.identityContext as AiIdentityContext | undefined)?.manualIdentities?.every(identity => identity.userIds.every(id => id === USER_ID))));
});

test("replay: first mention can evaluate prior discussion, including rate-limited background, without asking for context again", async t => {
  const f = conversationReplay(t);
  const a = f.add("我觉得熟练就不该紧张", "20002", { passive: true });
  const b = f.add("熟练和在乎输赢又不是一回事", USER_ID, { passive: true, excludedDrop: true });
  f.ai.replies.push({ text: "熟练管操作，在乎输赢管心跳，这俩不冲突" });
  const question = await f.ask("你来说说，别胡扯");
  assert.equal(f.ai.resolutions.length, 0);
  assert.deepEqual(f.identity().ambientGroupContext?.map(message => message.messageId), [a.id, b.id]);
  assert.equal(f.identity().replyPlan?.intent, "opinion");
  assert.equal(f.identity().replyPlan?.explanation, "on_request");
  assert.equal(f.db.db.prepare("SELECT reply_to FROM outbox WHERE source_turn_id = ?").get(question.route.turnId)?.reply_to, question.id);
});

test("replay: a bare opinion follows the current cluster without reading a stale branch, resolver, or durable memory", async t => {
  let durableMemoryReads = 0;
  const memoryStore = {
    async listRelevantEnabled() {
      durableMemoryReads++;
      return [];
    },
  } as unknown as TestBotOptions["groupMemoryStore"];
  const f = conversationReplay(t, {}, false, memoryStore);

  const game = await f.ask("打游戏时我总会紧张");
  f.ack();
  durableMemoryReads = 0;
  const currentA = f.add("破甲中转到底是什么？", "20002", { passive: true, elapsed: 121_001 });
  const currentB = f.add("这事可能不太合法", "20003", { passive: true });
  const resolverCallsBefore = f.ai.resolutions.length;
  f.ai.replies.push({ text: "现在这段是在聊这件事，违法的路子别碰。" });

  const opinion = await f.ask("你来说说");

  assert.equal(f.ai.resolutions.length, resolverCallsBefore);
  assert.equal(durableMemoryReads, 0);
  assert.notEqual(opinion.route.branchId, game.route.branchId);
  assert.equal(f.identity().replyPlan?.anchor?.kind, "recent_cluster");
  assert.deepEqual(f.identity().ambientGroupContext?.map(message => message.messageId), [currentA.id, currentB.id]);
  assert.doesNotMatch(JSON.stringify(f.identity()), /打游戏时我总会紧张/);
});

test("replay: a bare opinion joins the one active shared discussion without inheriting its owner's branch", async t => {
  const f = conversationReplay(t);
  const original = await f.ask("这局到底该不该硬开");
  f.ack();
  const current = f.add("我觉得刚才那个判断有点保守", "20002", { passive: true });
  f.ai.replies.push({ text: "我会看局势，不会硬把每波都当决赛。" });

  const opinion = await f.ask("你来说说", "20003");

  assert.equal(opinion.route.topicId, original.route.topicId);
  assert.notEqual(opinion.route.branchId, original.route.branchId);
  assert.equal(opinion.route.routeReason, "resolved-shared-topic");
  assert.equal(f.identity().replyPlan?.anchor?.kind, "recent_cluster");
  assert.ok(f.identity().ambientGroupContext?.some(message => message.messageId === current.id));
});

test("replay: a length-truncated model envelope never becomes an outbox answer or a state update", async t => {
  const f = conversationReplay(t);
  const model = new AiService("https://example.invalid", "test-key", "reply-test", {
    async create() { return { choices: [{ finish_reason: "length", message: { content: '{"text":"尚未完成的模型草稿","stateUpdate":{"coveredPoints":["错误地记成已解释"]}}' } }] }; },
  } as never, { providerCapabilities: { streaming: false } });
  f.ai.generateReply = args => model.generateReply({ ...args, skill: assistantSkill, identityContext: args.identityContext as AiIdentityContext | undefined });
  await f.ask("给点看法");
  const rows = f.db.db.prepare("SELECT text FROM outbox").all() as Array<{ text: string }>;
  assert.ok(rows.length > 0);
  assert.doesNotMatch(rows.map(row => row.text).join("\n"), /尚未完成的模型草稿|错误地记成已解释|stateUpdate/);
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM conversation_state_updates").get()?.n, 0);
});

test("replay: captured reply text with a split state suffix gets one controlled format repair before delivery", async t => {
  const f = conversationReplay(t);
  f.ai.replies.push(
    { text: [
      "按这个简化算法，大概是四千多。",
      '这两个条件会明显影响结果{"stateUpdate":{"coveredPoints":["养老金估算"],"questions":[{"key":"pension","userId":"20001","text":"缴费基数和退休年龄","status":"answered"}]},"review":{"repeatsAnswered":false,"reasksKnown":false,"unsupportedReversal":false}}',
    ].join("\n\n") },
    { text: "这句重新整理过了。" },
  );

  await f.ask("给点看法");

  const outbox = f.db.db.prepare("SELECT text FROM outbox ORDER BY id").all() as Array<{ text: string }>;
  const assistantTurns = f.db.db.prepare("SELECT content FROM conversation_turns WHERE role = 'assistant' ORDER BY id").all() as Array<{ content: string }>;
  assert.equal(f.ai.calls.length, 2);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0]?.text ?? "", /^这句重新整理过了/);
  assert.match(f.ai.calls[1]?.scenarioInstruction ?? "", /FORMAT RETRY/);
  assert.doesNotMatch(outbox.map(row => row.text).join("\n"), /stateUpdate|coveredPoints|养老金估算|这两个条件会明显影响结果/);
  assert.doesNotMatch(assistantTurns.map(turn => turn.content).join("\n"), /stateUpdate|coveredPoints|养老金估算|这两个条件会明显影响结果/);
  const updates = f.db.db.prepare("SELECT update_json FROM conversation_state_updates").all() as Array<{ update_json: string }>;
  // State snapshots legitimately use protocol field names. Only the rejected
  // draft's values or an envelope wrapper would prove an internal leak here.
  assert.doesNotMatch(updates.map(update => update.update_json).join("\n"), /stateUpdate|养老金估算|这两个条件会明显影响结果/);
});

test("replay: final outbox boundary rejects a state suffix before any split message is queued", async t => {
  const f = conversationReplay(t);
  const sendTextMessages = (f.bot as unknown as {
    sendTextMessages(groupId: string, messages: string[]): Promise<unknown>;
  }).sendTextMessages.bind(f.bot);

  await assert.rejects(
    sendTextMessages(GROUP_ID, [
      "按这个简化算法，大概是四千多。",
      '这两个条件会明显影响结果{"stateUpdate":{"coveredPoints":["养老金估算"]}}',
    ]),
    { name: "ConversationReplyEnvelopeError" },
  );

  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 0);
});

test("replay: game conditions survive a fishing detour and the same speaker can return to an older topic", async t => {
  const f = conversationReplay(t);
  const nextId = "40001";
  f.ai.replies.push({ text: "认真是认真，喝水也成了顺手动作", conversationUpdate: {
    knownFacts: [{ userId: USER_ID, text: "只有打游戏时这样，喝水成了习惯", sourceMessageIds: [nextId] }],
    coveredPoints: ["喝水习惯建议"], questions: [{ key: "only-game", userId: USER_ID, text: "平时也会吗", status: "answered" }],
    conclusion: { text: "游戏时紧张和习惯性喝水", evidenceIds: [nextId] },
  } });
  const game = await f.ask("只有打游戏才这样，喝水已经成了习惯");
  f.ack();
  f.ai.resolve = data => ({ intent: "chat", relation: "new", resolvedInput: data.text, selectedMessageIds: [] });
  const fish = await f.ask("昨晚钓鱼睡过头了");
  f.ack();
  f.add("再也不熬夜钓鱼了", "20002", { passive: true });
  f.ai.resolve = data => ({ intent: "confirm", relation: "follow_up", resolvedInput: "游戏时紧张是太认真了吗", topicCandidateId: data.candidates.find((item: any) => item.id === game.route.branchId)?.id, selectedMessageIds: [game.id] });
  f.ai.replies.push({ text: "有点，操作熟了，胜负欲可没退休" });
  const follow = await f.ask("是太认真了吗");
  assert.equal(follow.route.branchId, game.route.branchId);
  assert.notEqual(follow.route.branchId, fish.route.branchId);
  assert.equal(f.identity().conversationState?.knownFacts[0]?.text, "只有打游戏时这样，喝水成了习惯");
  assert.equal(f.identity().conversationState?.questions[0]?.status, "answered");
  assert.equal(f.ai.calls.at(-1)?.history.some(turn => turn.content.includes("钓鱼")), false);
  assert.equal(f.identity().replyPlan?.explanation, "on_request");
  f.ack();
  f.ai.resolve = () => ({ intent: "explain", relation: "follow_up", resolvedInput: "解释为什么熟练了还会紧张", topicCandidateId: game.route.branchId, selectedMessageIds: [game.id] });
  await f.ask("为什么？详细解释一下");
  assert.equal(f.identity().replyPlan?.explanation, "requested");
  assert.equal(f.identity().conversationState?.knownFacts[0]?.userId, USER_ID);
});

test("replay: another member's heckling shares the discussion but not the original member's task or private branch", async t => {
  const f = conversationReplay(t);
  f.ai.replies.push({ text: "行，队里的大腿是吧😂", conversationUpdate: { conclusion: { text: "本人说把把 carry，暂无战绩材料", evidenceIds: ["40001"] } } });
  const boast = await f.ask("我把把 carry"); f.ack();
  f.ai.resolve = () => ({ intent: "challenge", relation: "follow_up", resolvedInput: "回应群友对把把carry的起哄", topicCandidateId: boast.route.branchId, selectedMessageIds: [boast.id] });
  f.ai.replies.push({ text: "你这拆台速度，比他交战绩还快" });
  const heckle = await f.ask("他在吹牛", "20002");
  assert.equal(heckle.route.topicId, boast.route.topicId);
  assert.notEqual(heckle.route.branchId, boast.route.branchId);
  assert.equal(f.ai.calls.at(-1)?.history.length, 0);
  assert.match(f.identity().ambientGroupContext?.[0]?.text ?? "", /把把 carry/);
  assert.equal(f.identity().conversationState?.knownFacts.length, 0);
  assert.equal(f.repository.orchestration.isTaskCurrent(boast.route.sourceRowId), true);
});

test("replay: image followed 15 seconds later by look-at-the-image cancels the old unpublished draft and carries the actual image", async t => {
  const f = conversationReplay(t, {}, true);
  f.ai.replies.push({ text: "旧图片草稿" });
  const image = f.add("", USER_ID, { image: true });
  const first = await f.bot.prepareConversationRoute(image.input);
  const old = f.bot.handleGroupMessage(image.event, undefined, first);
  await waitFor(() => (f.transport as GatedWorkerTransport).firstDraftReady);
  const caption = f.add("看图说话", USER_ID, { elapsed: 15_000 });
  const follow = await f.bot.prepareConversationRoute(caption.input);
  assert.equal(follow?.branchId, first?.branchId);
  assert.equal(f.repository.orchestration.isTaskCurrent(image.input.sourceRowId), false);
  (f.transport as GatedWorkerTransport).publishFirstDraft();
  await old;
  f.ai.replies.push({ text: "这张战绩确实能打" });
  await f.bot.handleGroupMessage(caption.event, undefined, follow);
  const rows = f.db.db.prepare("SELECT text, status, reply_to FROM outbox ORDER BY id").all() as Array<{ text: string; status: string; reply_to: string }>;
  assert.equal(rows[0]?.status, "cancelled");
  assert.equal(rows[1]?.status, "pending");
  assert.equal(rows[1]?.reply_to, caption.id);
  assert.equal(f.ai.calls.at(-1)?.images?.[0]?.url, "https://example.test/score.png");
  assert.ok(f.identity().replyPlan?.mediaSourceMessageIds?.includes(image.id));
  assert.equal(rows.some(row => /没.*图|补发/.test(row.text)), false);
});

test("replay: a short reaction to an acknowledged bot reply keeps the quoted reply as the authority anchor", async t => {
  const f = conversationReplay(t, { memoryDisabledUserIds: ["20002"] });
  await f.ask("先说一句");
  f.ack();
  const delivered = f.db.db.prepare("SELECT platform_message_id FROM outbox WHERE status = 'sent' ORDER BY id LIMIT 1")
    .get() as { platform_message_id: string } | undefined;
  assert.ok(delivered?.platform_message_id);

  let remoteReads = 0;
  f.transport.getMessage = async () => {
    remoteReads += 1;
    return undefined;
  };
  const resolverCalls = f.ai.resolutions.length;
  f.ai.replies.push({ text: "我刚才那句确实有点歪，你是在吐槽这个吧" });
  const reaction = await f.ask("？？？？", USER_ID, { replyToMessageId: delivered!.platform_message_id });

  assert.equal(remoteReads, 0);
  assert.equal(f.ai.resolutions.length, resolverCalls);
  assert.equal(reaction.route.routeReason, "explicit-reply");
  assert.equal(f.identity().replyContext?.text, "接住了");
  assert.equal(f.identity().replyPlan?.anchor?.kind, "explicit_reply");
  assert.match(f.ai.calls.at(-1)?.scenarioInstruction ?? "", /已恢复引用消息/);
  assert.equal(identityOutbox(f).at(-1)?.text, "我刚才那句确实有点歪，你是在吐槽这个吧");
});

test("replay: a remote quote recovered for routing survives a transient second lookup failure", async t => {
  const f = conversationReplay(t);
  let remoteReads = 0;
  f.transport.getMessage = async id => {
    remoteReads += 1;
    return remoteReads === 1
      ? { messageId: id, groupId: GROUP_ID, userId: "20002", text: "这是远端刚恢复的引用内容", images: [] }
      : undefined;
  };
  const resolverCalls = f.ai.resolutions.length;
  f.ai.replies.push({ text: "这句我看到了，别急着开骂" });

  const reaction = await f.ask("fw", USER_ID, { replyToMessageId: "remote-only-quote" });

  assert.equal(remoteReads, 1);
  assert.equal(f.ai.resolutions.length, resolverCalls);
  assert.equal(f.identity().replyContext?.text, "这是远端刚恢复的引用内容");
  assert.equal(f.identity().replyPlan?.anchor?.kind, "explicit_reply");
  assert.equal(reaction.route.routeReason, "explicit-reply-miss");
  assert.equal(identityOutbox(f).at(-1)?.text, "这句我看到了，别急着开骂");
});

test("replay: a quote recovered only during handling replaces an earlier re-quote placeholder", async t => {
  const f = conversationReplay(t);
  let remoteReads = 0;
  f.transport.getMessage = async id => {
    remoteReads += 1;
    return remoteReads === 1
      ? undefined
      : { messageId: id, groupId: GROUP_ID, userId: "20002", text: "第二次读取到的引用内容", images: [] };
  };
  f.ai.replies.push({ text: "这条我后面读到了，按它继续说。" });

  const reaction = await f.ask("？？？？", USER_ID, { replyToMessageId: "late-remote-quote" });

  assert.equal(remoteReads, 2);
  assert.equal(f.identity().replyContext?.text, "第二次读取到的引用内容");
  assert.equal(f.identity().replyPlan?.anchor?.kind, "explicit_reply");
  assert.equal(f.repository.orchestration.getResolution(reaction.input.sourceRowId)?.clarification, undefined);
  assert.equal(f.repository.orchestration.getResolution(reaction.input.sourceRowId)?.anchor?.kind, "explicit_reply");
  assert.match(identityOutbox(f).at(-1)?.text ?? "", /^这条我后面读到了，按它继续说/);
});

test("replay: an explicit bot quote keeps adjacent local discussion as supporting evidence", async t => {
  const f = conversationReplay(t);
  await f.ask("先说一句");
  f.ack();
  const delivered = f.db.db.prepare("SELECT platform_message_id FROM outbox WHERE status = 'sent' ORDER BY id LIMIT 1")
    .get() as { platform_message_id: string } | undefined;
  assert.ok(delivered?.platform_message_id);
  const nearby = f.add("我觉得刚才那句还有一点没说清", "20002", { passive: true });
  f.ai.replies.push({ text: "你是在问刚才那句，我也看到了后面的补充。" });

  await f.ask("？？？？", USER_ID, { replyToMessageId: delivered!.platform_message_id });

  const evidenceIds = f.identity().ambientGroupContext?.map(message => message.messageId) ?? [];
  assert.equal(f.identity().replyContext?.text, "接住了");
  assert.equal(f.identity().replyPlan?.anchor?.kind, "explicit_reply");
  assert.ok(evidenceIds.includes(delivered!.platform_message_id));
  assert.ok(evidenceIds.includes(nearby.id));
});

test("replay: duplicate-question review rewrites only once and records only the chosen reply", async t => {
  const f = conversationReplay(t);
  f.ai.replies.push({ text: "平时也会吗", replyCheck: { repeatsAnswered: false, reasksKnown: true, unsupportedReversal: false } }, { text: "那就先改顺手拿杯子的动作" });
  await f.ask("只有游戏时这样，其他时候不会");
  assert.equal(f.ai.calls.length, 2);
  assert.match(f.ai.calls[1].scenarioInstruction!, /定向修正一次/);
  const rows = f.db.db.prepare("SELECT text FROM outbox").all() as Array<{ text: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "那就先改顺手拿杯子的动作");
});

test("replay: known conditions outlive ordinary prompt-history trimming within the active topic", async t => {
  const f = conversationReplay(t);
  f.ai.replies.push({ text: "先记住这个条件", conversationUpdate: { knownFacts: [{ userId: USER_ID, text: "只有游戏时出现", sourceMessageIds: ["40001"] }] } });
  await f.ask("只有游戏时出现这个状态"); f.ack();
  for (let i = 0; i < 18; i++) { await f.ask(`所以呢 ${i}`); f.ack(); }
  assert.equal(f.ai.calls.at(-1)?.history.some(turn => turn.content.includes("只有游戏时出现这个状态")), false);
  assert.equal(f.identity().conversationState?.knownFacts[0]?.text, "只有游戏时出现");
});

test("replay: context disabled and excluded members stay outside the resolver and final prompt", async t => {
  const f = conversationReplay(t, { memoryDisabledUserIds: ["20002"] });
  f.add("不允许读取的个人条件", "20002", { passive: true });
  f.add("允许读取的讨论", USER_ID, { passive: true });
  await f.ask("你来说说");
  assert.doesNotMatch(JSON.stringify(f.ai.resolutions), /不允许读取/);
  assert.doesNotMatch(JSON.stringify(f.ai.calls), /不允许读取/);
  const disabled = conversationReplay(t, { ambientGroupContextEnabled: false });
  disabled.add("关闭背景时不该读到", "20002", { passive: true });
  await disabled.ask("你来说说");
  assert.equal(disabled.ai.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(disabled.ai.resolutions), /不该读到/);
  assert.match(String(disabled.db.db.prepare("SELECT text FROM outbox").get()?.text), /引用/);
});

test("replay: a forged reply id cannot import a quoted message from another group", async t => {
  const f = conversationReplay(t);
  f.transport.getMessage = async () => ({ messageId: "foreign-message", groupId: "different-group", userId: "20002", text: "其他群的个人条件不该进入当前群", images: [] });
  await f.ask("你怎么看这个说法", USER_ID, { replyToMessageId: "foreign-message" });
  assert.equal(f.ai.calls.length, 0);
  assert.match(identityOutbox(f).at(-1)?.text ?? "", /重新引用/);
  assert.doesNotMatch(JSON.stringify(f.ai.calls), /其他群的个人条件/);
  assert.doesNotMatch(JSON.stringify(f.ai.resolutions), /其他群的个人条件/);
});

test("Worker isolates both BT entries without mentions, routes or later context leakage", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "worker-bt-"));
  const db = openSharedDb(dataDir);
  const transport = new WorkerTransport(db);
  const repository = new ConversationContextRepository(db);
  const ai = new CapturingAiService();
  const searches: string[] = [];
  const bot = createBot(transport, repository, ai, undefined, { btSearchService: { async search(request) {
    searches.push(request.query);
    return { query: request.query, requestedType: "anime", resolvedType: "anime", items: [{ title: "测试资源", magnet: "magnet:?xt=urn:btih:123&dn=%E6%B5%8B%E8%AF%95", torrent: "", page: "https://example.test/item", size: "1 GB", resolution: "1080P", subtitle: "中字", sources: ["nyaa"], episodeStart: 0, episodeEnd: 0, isBatch: false }], sites: [], warnings: [],
      totalResults: 1, rawResultCount: 1, uniqueResultCount: 1, durationMs: 0, fromCache: false, cacheAgeMs: 0, budgetExceeded: false };
  } } });
  const worker = new WorkerApp({ dataDir, sharedDb: db, botApp: bot, consumerKey: "worker:bt-test", isBlacklistedUser: async () => false });
  t.after(async () => { await bot.stop(); await worker.stop(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const now = Date.now();
  const insert = (text: string, id: string, time: number) => db.insertMessage({ groupId: GROUP_ID, userId: USER_ID, selfId: BOT_QQ, msgId: id,
    msgTime: time, text, imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: time });
  insert("#bt 测试 anime", "bt-hash", now - 4000);
  insert("/bt 测试 anime", "bt-slash", now - 3000);
  worker.start();
  await waitFor(() => (db.db.prepare("SELECT watermark_id FROM consumers WHERE key='worker:bt-test'").get() as { watermark_id: number })?.watermark_id === 2);
  assert.equal(searches.length, 2);
  assert.equal(ai.calls.length, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM conversation_message_routes").get() as { n: number }).n, 0);
  const outbox = db.db.prepare("SELECT id, kind, text, forward_payload_json, topic_id, branch_id FROM outbox").all() as Array<{ id: number; kind: string; text: string; forward_payload_json: string; topic_id: string | null; branch_id: string | null }>;
  assert.equal(outbox.length, 2);
  for (const row of outbox) {
    assert.equal(row.topic_id, null);
    assert.equal(row.branch_id, null);
    assert.ok(row.text.startsWith("【BT 搜索】"));
    assert.equal(row.kind, "forward");
    assert.equal(JSON.parse(row.forward_payload_json).length, 2);
    db.ackOutboxDelivery(row.id, `bt-receipt-${row.id}`, now - 2000);
  }
  const sourceRowId = insert("current question", "context-boundary", now);
  const context = db.listAmbientGroupContext({ groupId: GROUP_ID, beforeSourceRowId: sourceRowId, lookbackMs: 60_000, limit: 30 });
  assert.deepEqual(context, []);
  assert.deepEqual(db.listRecentGroupMessages(GROUP_ID, now - 60_000).map(row => row.text), ["current question"]);
});

function inboundEvent(input: {
  messageId: number;
  userId?: string;
  text: string;
  eventTimeSeconds: number;
  replyToMessageId?: string;
  hasAtBot?: boolean;
  mentionTargetUserId?: string;
  atOnly?: boolean;
}): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: Number(BOT_QQ),
    group_id: Number(GROUP_ID),
    user_id: Number(input.userId ?? USER_ID),
    message_id: input.messageId,
    time: input.eventTimeSeconds,
    raw_message: input.text,
    message: [
      ...(input.replyToMessageId
        ? [{ type: "reply", data: { id: input.replyToMessageId } }]
        : []),
      ...(input.hasAtBot === false ? [] : [{ type: "at", data: { qq: BOT_QQ } }]),
      ...(input.atOnly ? [] : [{ type: "text", data: { text: input.text } }]),
      ...(input.mentionTargetUserId
        ? [{ type: "at", data: { qq: input.mentionTargetUserId } }]
        : []),
    ],
    sender: {
      user_id: Number(input.userId ?? USER_ID),
      nickname: "Tester",
      card: "测试群名片",
      role: "member",
    },
  };
}

function participationDecisionForMessage(db: SharedDb, messageId: string): {
  action: string;
  reason: string;
  signals_json: string;
} | undefined {
  return db.db.prepare(
    `SELECT d.action, d.reason, d.signals_json
       FROM participation_decisions d
       JOIN messages m ON m.id = d.source_row_id
      WHERE m.group_id = ? AND m.msg_id = ?`,
  ).get(GROUP_ID, messageId) as {
    action: string;
    reason: string;
    signals_json: string;
  } | undefined;
}

function routeForMessage(db: SharedDb, messageId: string): {
  topic_id: string;
  branch_id: string;
  reply_to_message_id: string | null;
  route_reason: string;
  parent_turn_id: number | null;
} | undefined {
  return db.db.prepare(
    `SELECT r.topic_id, r.branch_id, r.reply_to_message_id, r.route_reason, r.parent_turn_id
       FROM conversation_message_routes r
       JOIN messages m ON m.id = r.source_row_id
      WHERE m.group_id = ? AND m.msg_id = ?`,
  ).get(GROUP_ID, messageId) as {
    topic_id: string;
    branch_id: string;
    reply_to_message_id: string | null;
    route_reason: string;
    parent_turn_id: number | null;
  } | undefined;
}

function routeTurnId(db: SharedDb, messageId: string): number {
  const row = db.db.prepare(
    `SELECT r.turn_id
       FROM conversation_message_routes r
       JOIN messages m ON m.id = r.source_row_id
      WHERE m.group_id = ? AND m.msg_id = ?`,
  ).get(GROUP_ID, messageId) as { turn_id: number } | undefined;
  assert.ok(row);
  return row.turn_id;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function setRequiredEnvironment(readApiPort: number): () => void {
  const values: Record<string, string> = {
    BOT_QQ,
    INGRESS_READ_API_PORT: String(readApiPort),
    INGRESS_READ_API_TOKEN: "test-ingress-read-token",
    NAPCAT_MODE: "forward",
    NAPCAT_WS_URL: "ws://127.0.0.1:1",
    OPENAI_BASE_URL: "https://unused.example/v1",
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "test-model",
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
