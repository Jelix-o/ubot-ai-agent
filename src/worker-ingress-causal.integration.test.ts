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
import { ConversationContextRepository } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import { RecentGroupEvidenceService } from "./services/recent-group-evidence-service.js";
import { V3StateRepository } from "./services/v3-state-repository.js";
import { REQUIRED_V3_RUNTIME_CAPABILITIES } from "./services/v3-runtime-state.js";
import { openSharedDb, type SharedDb } from "./shared/sqlite.js";
import type {
  AiReply,
  ConversationTurn,
  GroupBotConfig,
  NapcatGroupMessageEvent,
  SkillDefinition,
} from "./types.js";
import { WorkerTransport } from "./worker-transport.js";

const BOT_QQ = "12345";
const GROUP_ID = "67890";
const USER_ID = "20001";
const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
  readonly calls: Array<{ history: ConversationTurn[]; userInput: string; identityContext?: unknown }> = [];

  constructor(
    private readonly replyForCall: (callNumber: number, userInput: string) => string =
      (callNumber) => callNumber === 1 ? "first answer" : "follow-up answer",
  ) {}

  async generateReply(args: {
    history: ConversationTurn[];
    userInput: string;
    identityContext?: unknown;
  }): Promise<AiReply> {
    this.calls.push({
      history: args.history.map((turn) => ({ ...turn })),
      userInput: args.userInput,
      identityContext: args.identityContext,
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
    botApp: bot,
    consumerKey: "worker:causal-integration",
    isBlacklistedUser: async () => false,
  }, workerTransport);

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
    botApp: bot,
    consumerKey: "worker:ambient-context-integration",
    isBlacklistedUser: async () => false,
  }, workerTransport);

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
    botApp: bot,
    consumerKey: "worker:rate-limit-integration",
    isBlacklistedUser: async () => false,
  }, workerTransport);

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
    botApp: bot,
    consumerKey: "worker:blacklisted-rate-limit-integration",
    isBlacklistedUser: async (groupId, userId) => (
      (state.getGroup(groupId)?.blacklistedUserIds ?? []).includes(userId)
    ),
    stateEncryptionKey: TEST_STATE_KEY,
  }, workerTransport);

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
  dailyReportRecords?: Array<{ groupId: string; userId: string; text: string }>;
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
    undefined,
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
  );
}

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
