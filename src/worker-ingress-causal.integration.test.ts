import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotApplication, type MessageReceipt, type MessageTransport } from "./bot.js";
import { IngressApp } from "./index-ingress.js";
import { WorkerApp } from "./index-worker.js";
import { GroupLock } from "./services/group-lock.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { ConversationContextRepository } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
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
  readonly calls: Array<{ history: ConversationTurn[]; userInput: string }> = [];

  async generateReply(args: {
    history: ConversationTurn[];
    userInput: string;
  }): Promise<AiReply> {
    this.calls.push({
      history: args.history.map((turn) => ({ ...turn })),
      userInput: args.userInput,
    });
    return {
      text: this.calls.length === 1 ? "first answer" : "follow-up answer",
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
});

function createBot(
  transport: WorkerTransport,
  repository: ConversationContextRepository,
  aiService: CapturingAiService,
): BotApplication {
  const groupConfigService = {
    async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
      return groupId === GROUP_ID ? { ...groupConfig } : undefined;
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
    async recordMessage(): Promise<void> {},
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
  );
}

function inboundEvent(input: {
  messageId: number;
  text: string;
  eventTimeSeconds: number;
  replyToMessageId?: string;
}): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: Number(BOT_QQ),
    group_id: Number(GROUP_ID),
    user_id: Number(USER_ID),
    message_id: input.messageId,
    time: input.eventTimeSeconds,
    raw_message: input.text,
    message: [
      ...(input.replyToMessageId
        ? [{ type: "reply", data: { id: input.replyToMessageId } }]
        : []),
      { type: "at", data: { qq: BOT_QQ } },
      { type: "text", data: { text: input.text } },
    ],
    sender: {
      user_id: Number(USER_ID),
      nickname: "Tester",
      role: "member",
    },
  };
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
