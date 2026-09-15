import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MessageReceipt, MessageTransport } from "./bot.js";
import { deliverOutboxRow, markOutboxDeliveryFailed, OutboxAcknowledgementError } from "./index-ingress.js";
import { NapCatActionNotSentError, NapCatActionOutcomeUnknownError } from "./napcat-reverse-server.js";
import { ConversationContextRepository, type ConversationRoute } from "./services/conversation-context-repository.js";
import { SharedDb } from "./shared/sqlite.js";
import { WorkerTransport } from "./worker-transport.js";

class ReceiptTransport implements MessageTransport {
  readonly deliveries: Array<{ groupId: string; kind: string; text: string }> = [];

  constructor(private readonly resolveId: (groupId: string, text: string) => string) {}

  async sendGroupMessage(groupId: string, text: string): Promise<MessageReceipt> {
    this.deliveries.push({ groupId, kind: "text", text });
    return { platformMessageId: this.resolveId(groupId, text) };
  }

  async sendGroupRecord(groupId: string, text: string): Promise<MessageReceipt> {
    this.deliveries.push({ groupId, kind: "record", text });
    return { platformMessageId: this.resolveId(groupId, text) };
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<MessageReceipt> {
    this.deliveries.push({ groupId, kind: "image", text: imageFile });
    return { platformMessageId: this.resolveId(groupId, imageFile) };
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<MessageReceipt> {
    this.deliveries.push({ groupId, kind: "airecord", text });
    return { platformMessageId: this.resolveId(groupId, text) };
  }
}

function tempDbPath(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outbox-receipt-integration-"));
  return { dbPath: path.join(dir, "bot-shared.db"), dir };
}

function createRoute(
  repository: ConversationContextRepository,
  sourceRowId: number,
  groupId: string,
  sourceMessageId: string,
): ConversationRoute {
  return repository.saveMessageRoute({
    sourceRowId,
    groupId,
    userId: `user-${groupId}`,
    sourceMessageId,
    routeReason: "new-topic",
    content: `question in ${groupId}`,
    createdAt: 1_000 + sourceRowId,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("WorkerTransport keeps concurrent async send chains on their own routes", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repository = new ConversationContextRepository(db);
  const transport = new WorkerTransport(db);
  const routeA = createRoute(repository, 1, "same-group", "source-a");
  const routeB = createRoute(repository, 2, "same-group", "source-b");
  const bFirstSent = deferred();
  const aSent = deferred();

  const chainA = transport.runWithConversationContext(routeA, async () => {
    await bFirstSent.promise;
    await transport.sendGroupMessage("same-group", "a-only");
    aSent.resolve();
  });
  const chainB = transport.runWithConversationContext(routeB, async () => {
    await transport.sendGroupMessage("same-group", "b-first");
    bFirstSent.resolve();
    await aSent.promise;
    await transport.sendGroupMessage("same-group", "b-second");
  });
  await Promise.all([chainA, chainB]);

  const rows = db.db.prepare(
    "SELECT text, topic_id, branch_id FROM outbox ORDER BY id",
  ).all() as Array<{ text: string; topic_id: string; branch_id: string }>;
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { text: "b-first", topic_id: routeB.topicId, branch_id: routeB.branchId },
      { text: "a-only", topic_id: routeA.topicId, branch_id: routeA.branchId },
      { text: "b-second", topic_id: routeB.topicId, branch_id: routeB.branchId },
    ],
  );
});

test("WorkerTransport queues image outbox rows and ingress delivers them as images", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const workerDb = new SharedDb(dbPath);
  const ingressDb = new SharedDb(dbPath);
  t.after(() => {
    workerDb.close();
    ingressDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const imageFile = "base64://blacklisted-at-meme";
  const workerTransport = new WorkerTransport(workerDb);
  const receipt = await workerTransport.sendGroupImage("group-image", imageFile);
  assert.deepEqual(receipt, { deliveryId: "outbox:1" });

  const queued = workerDb.db.prepare(
    "SELECT group_id, kind, text, status FROM outbox WHERE id = 1",
  ).get() as { group_id: string; kind: string; text: string; status: string };
  assert.deepEqual({ ...queued }, {
    group_id: "group-image",
    kind: "image",
    text: imageFile,
    status: "pending",
  });

  const transport = new ReceiptTransport(() => "qq-image-1");
  const row = ingressDb.claimOutbox(1, 2_000)[0]!;
  const platformMessageId = await deliverOutboxRow(ingressDb, transport, row, 2_100);
  assert.equal(platformMessageId, "qq-image-1");
  assert.deepEqual(transport.deliveries, [{
    groupId: "group-image",
    kind: "image",
    text: imageFile,
  }]);
});

test("generated image outbox rows are materialized as base64 and removed after acknowledgement", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const imageRoot = path.join(dir, "generated-images");
  mkdirSync(imageRoot, { recursive: true });
  const imagePath = path.join(imageRoot, "generated.png");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(imagePath, image);

  const workerTransport = new WorkerTransport(db);
  await workerTransport.sendGeneratedGroupImage("group-image", imagePath);
  const row = db.claimOutbox(1, 2_000)[0]!;
  assert.equal(row.kind, "generated_image");
  const transport = new ReceiptTransport(() => "qq-generated-1");
  await deliverOutboxRow(db, transport, row, 2_100, undefined, imageRoot);

  assert.deepEqual(transport.deliveries, [{
    groupId: "group-image",
    kind: "image",
    text: `base64://${image.toString("base64")}`,
  }]);
  assert.equal(existsSync(imagePath), false);
});

test("ambiguous generated image delivery is terminal and cannot be sent three times", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = db.enqueueOutbox("group-image", null, "managed.png", "generated_image");
  const row = db.claimOutbox(1, 2_000)[0]!;
  const disposition = markOutboxDeliveryFailed(
    db,
    row,
    new NapCatActionOutcomeUnknownError("send_group_msg timed out"),
  );
  assert.equal(disposition, "terminal");
  const stored = db.db.prepare("SELECT status, attempts, retry_after FROM outbox WHERE id = ?").get(id) as {
    status: string;
    attempts: number;
    retry_after: number | null;
  };
  assert.deepEqual({ ...stored }, { status: "failed", attempts: 1, retry_after: null });
  assert.equal(db.claimOutbox(1, Date.now() + 60_000).length, 0);
});

test("generated images retry only when NapCat was disconnected before dispatch", (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = db.enqueueOutbox("group-image", null, "managed.png", "generated_image");
  const row = db.claimOutbox(1, 2_000)[0]!;
  const disposition = markOutboxDeliveryFailed(
    db,
    row,
    new NapCatActionNotSentError("not connected"),
  );
  assert.equal(disposition, "retryable");
  const stored = db.db.prepare("SELECT status, attempts, retry_after FROM outbox WHERE id = ?").get(id) as {
    status: string;
    attempts: number;
    retry_after: number | null;
  };
  assert.equal(stored.status, "failed");
  assert.equal(stored.attempts, 1);
  assert.equal(typeof stored.retry_after, "number");
  assert.equal(db.claimOutbox(1, Date.now() + 60_000).length, 1);
});

test("ordinary outbox messages retain their existing retry behavior", (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = db.enqueueOutbox("group-text", null, "hello", "text");
  const row = db.claimOutbox(1, 2_000)[0]!;
  assert.equal(markOutboxDeliveryFailed(db, row, new NapCatActionOutcomeUnknownError("timeout")), "retryable");
  assert.equal(db.claimOutbox(1, Date.now() + 60_000)[0]?.id, id);
});

test("generated image delivery rejects paths outside the managed directory", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const outsidePath = path.join(dir, "outside.png");
  writeFileSync(outsidePath, Buffer.from("not used"));
  const id = db.enqueueOutbox("group-image", null, outsidePath, "generated_image");
  const row = db.claimOutbox(1, 2_000)[0]!;
  await assert.rejects(
    deliverOutboxRow(db, new ReceiptTransport(() => "qq-never"), row, 2_100, undefined, path.join(dir, "generated-images")),
    /outside the managed directory/,
  );
  assert.equal(id, row.id);
});

test("generated image delivery rejects forged files inside the managed directory", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const imageRoot = path.join(dir, "generated-images");
  mkdirSync(imageRoot, { recursive: true });
  const forgedPath = path.join(imageRoot, "forged.png");
  writeFileSync(forgedPath, Buffer.from("this is not a png"));
  db.enqueueOutbox("group-image", null, forgedPath, "generated_image");
  const row = db.claimOutbox(1, 2_000)[0]!;
  await assert.rejects(
    deliverOutboxRow(db, new ReceiptTransport(() => "qq-never"), row, 2_100, undefined, imageRoot),
    /invalid size or type/,
  );
});

test("Worker outbox receipts are internal ids until every real multipart QQ id is bound to one assistant turn", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const workerDb = new SharedDb(dbPath);
  const ingressDb = new SharedDb(dbPath);
  let restartedDb: SharedDb | undefined;
  t.after(() => {
    workerDb.close();
    ingressDb.close();
    restartedDb?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const repository = new ConversationContextRepository(workerDb);
  const route = createRoute(repository, 1, "group-1", "user-message-1");
  const workerTransport = new WorkerTransport(workerDb);
  workerTransport.setConversationContext(route);
  const receipts = [
    await workerTransport.sendGroupMessage("group-1", "part one"),
    await workerTransport.sendGroupMessage("group-1", "part two"),
  ].filter((receipt): receipt is MessageReceipt => Boolean(receipt));
  workerTransport.setConversationContext(undefined);

  assert.equal(receipts.length, 2);
  assert.deepEqual(
    receipts.map((receipt) => ({ deliveryId: receipt.deliveryId, platformMessageId: receipt.platformMessageId })),
    [
      { deliveryId: "outbox:1", platformMessageId: undefined },
      { deliveryId: "outbox:2", platformMessageId: undefined },
    ],
    "outbox ids must never masquerade as QQ message ids",
  );

  // Routed replies remain invisible until the worker persists one assistant
  // turn and atomically publishes every multipart row.
  const napcat = new ReceiptTransport((_groupId, text) => text === "part one" ? "qq-501" : "qq-502");
  assert.deepEqual(ingressDb.claimOutbox(10, 2_000), []);

  const assistant = repository.appendAssistantTurn({
    topicId: route.topicId,
    branchId: route.branchId,
    parentTurnId: route.turnId,
    content: "part one\npart two",
    deliveryId: receipts[0]!.deliveryId,
    deliveryIds: receipts.map((receipt) => receipt.deliveryId!),
    createdAt: 2_200,
  });
  const claimed = ingressDb.claimOutbox(10, 2_300);
  assert.equal(claimed.length, 2);
  for (const row of claimed) {
    await deliverOutboxRow(ingressDb, napcat, row, 2_400 + row.id);
  }

  assert.equal(repository.getMessageContext("group-1", "qq-501")?.turnId, assistant.id);
  assert.equal(repository.getMessageContext("group-1", "qq-502")?.turnId, assistant.id);
  assert.deepEqual(
    (workerDb.db.prepare(
      "SELECT delivery_id, platform_message_id, turn_id, status FROM outbox ORDER BY id",
    ).all() as Array<{ delivery_id: string; platform_message_id: string; turn_id: number; status: string }>)
      .map((row) => ({ ...row })),
    [
      { delivery_id: "outbox:1", platform_message_id: "qq-501", turn_id: assistant.id, status: "sent" },
      { delivery_id: "outbox:2", platform_message_id: "qq-502", turn_id: assistant.id, status: "sent" },
    ],
  );

  // Repeated acknowledgement is idempotent, and sent rows survive a process
  // restart without becoming eligible for delivery again.
  ingressDb.ackOutboxDelivery(claimed[0]!.id, "qq-501", 9_999);
  workerDb.close();
  ingressDb.close();
  restartedDb = new SharedDb(dbPath);
  const restartedRepository = new ConversationContextRepository(restartedDb);
  assert.equal(restartedRepository.getMessageContext("group-1", "qq-501")?.turnId, assistant.id);
  assert.equal(restartedRepository.getMessageContext("group-1", "qq-502")?.turnId, assistant.id);
  assert.equal(restartedDb.claimOutbox(10, 100_000).length, 0);
  assert.throws(
    () => restartedDb.ackOutboxDelivery(claimed[0]!.id, "qq-conflict"),
    /different platform message id/,
  );
});

test("identical platform message ids in different groups remain isolated", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const workerDb = new SharedDb(dbPath);
  const ingressDb = new SharedDb(dbPath);
  t.after(() => {
    workerDb.close();
    ingressDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repository = new ConversationContextRepository(workerDb);
  const workerTransport = new WorkerTransport(workerDb);
  const routes = [
    createRoute(repository, 1, "group-a", "source-a"),
    createRoute(repository, 2, "group-b", "source-b"),
  ];
  const receipts: MessageReceipt[] = [];
  const assistantTurnIds: number[] = [];

  for (const [index, route] of routes.entries()) {
    const groupId = index === 0 ? "group-a" : "group-b";
    workerTransport.setConversationContext(route);
    const receipt = await workerTransport.sendGroupMessage(groupId, `reply-${index}`);
    assert.ok(receipt);
    receipts.push(receipt);
    const assistant = repository.appendAssistantTurn({
      topicId: route.topicId,
      branchId: route.branchId,
      parentTurnId: route.turnId,
      content: `reply-${index}`,
      deliveryId: receipt.deliveryId,
      deliveryIds: [receipt.deliveryId!],
      createdAt: 2_000 + index,
    });
    assistantTurnIds.push(assistant.id);
  }
  workerTransport.setConversationContext(undefined);

  const napcat = new ReceiptTransport(() => "same-platform-id");
  for (const row of ingressDb.claimOutbox(10, 3_000)) {
    await deliverOutboxRow(ingressDb, napcat, row, 3_100 + row.id);
  }

  const groupA = repository.getMessageContext("group-a", "same-platform-id");
  const groupB = repository.getMessageContext("group-b", "same-platform-id");
  assert.equal(groupA?.topicId, routes[0]!.topicId);
  assert.equal(groupA?.turnId, assistantTurnIds[0]);
  assert.equal(groupB?.topicId, routes[1]!.topicId);
  assert.equal(groupB?.turnId, assistantTurnIds[1]);
  assert.notEqual(groupA?.branchId, groupB?.branchId);
  assert.equal(repository.getMessageContext("group-c", "same-platform-id"), undefined);
});

test("acknowledgement failure quarantines a successful QQ send instead of resending it", async (t) => {
  const { dbPath, dir } = tempDbPath();
  const db = new SharedDb(dbPath);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = db.enqueueOutbox("group-1", null, "send once");
  const row = db.claimOutbox(1)[0]!;
  const transport = new ReceiptTransport(() => "qq-once");
  const originalAck = db.ackOutboxDelivery.bind(db);
  db.ackOutboxDelivery = (() => {
    throw new Error("sqlite busy after send");
  }) as typeof db.ackOutboxDelivery;

  await assert.rejects(
    deliverOutboxRow(db, transport, row),
    OutboxAcknowledgementError,
  );
  db.ackOutboxDelivery = originalAck;
  assert.equal(transport.deliveries.length, 1);
  assert.equal(db.claimOutbox(1, Date.now() + 60_000).length, 0);
  const stored = db.db.prepare("SELECT status, retry_after FROM outbox WHERE id = ?").get(id) as {
    status: string;
    retry_after: number | null;
  };
  assert.deepEqual({ ...stored }, { status: "failed", retry_after: null });
});
