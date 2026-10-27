import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "./shared/sqlite.js";
import { WorkerTransport } from "./worker-transport.js";
import { deliverOutboxRow, markOutboxDeliveryFailed } from "./index-ingress.js";
import { NapCatActionOutcomeUnknownError, NapCatActionNotSentError } from "./napcat-action-errors.js";
import type { MessageTransport } from "./bot.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dafeiyu-delivery-"));
  const dbPath = path.join(dir, "shared.db");
  const db = new SharedDb(dbPath);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dbPath, worker: new WorkerTransport(db) };
}

test("emitter schedules actual receipt-relative bubble delays without blocking another group", async t => {
  const { db, dbPath, worker } = fixture(t);
  const now = Date.now();
  const receipts = await worker.sendGroupMessageBatch("100", ["第一句", "第二句", "第三句"]);
  await worker.sendMemeGroupImage("100", "asset-reference", receipts.at(-1)?.deliveryId);
  await worker.sendGroupMessage("200", "跨群立即处理");
  const first = db.claimOutbox(10, now);
  assert.deepEqual(first.map(row => row.group_id), ["100", "200"]);
  db.ackOutboxDelivery(first[0]!.id, "qq-1", now);
  db.ackOutboxDelivery(first[1]!.id, "qq-other", now);
  const second = db.db.prepare("SELECT * FROM outbox WHERE delivery_id=?").get(receipts[1]!.deliveryId!) as { delay_before_ms: number };
  assert.ok(second.delay_before_ms >= 1500 && second.delay_before_ms <= 3500);
  const reopened = new SharedDb(dbPath);
  try {
    assert.equal(reopened.claimOutbox(10, now + second.delay_before_ms - 1).length, 0);
    const [row] = reopened.claimOutbox(10, now + second.delay_before_ms);
    assert.equal(row?.text, "第二句");
    reopened.ackOutboxDelivery(row!.id, "qq-2", now + second.delay_before_ms);
    const [third] = reopened.claimOutbox(10, now + second.delay_before_ms + 3500);
    assert.equal(third?.text, "第三句");
    reopened.ackOutboxDelivery(third!.id, "qq-3", now + second.delay_before_ms + 3500);
    const [image] = reopened.claimOutbox(10, now + second.delay_before_ms + 3500);
    assert.equal(image?.kind, "meme_image");
    assert.equal(image?.text, "asset-reference");
    const transport: MessageTransport = {
      async sendGroupMessage() { throw new Error("unexpected text"); },
      async sendGroupImage(groupId, file) { assert.equal(groupId, "100"); assert.equal(file, "base64://gif"); return { platformMessageId: "qq-image" }; },
    };
    await deliverOutboxRow(reopened, transport, image!, undefined, undefined, undefined, {
      async getAsset() { return { enabled: true } as never; }, async loadImageFile() { return "base64://gif"; },
    });
    assert.equal(reopened.claimOutbox(10, now + 60_000).length, 0);
  } finally { reopened.close(); }
});

test("later replies in the same group wait for the preceding bubbles and image", async t => {
  const { db, worker } = fixture(t);
  const now = Date.now();
  const firstBatch = await worker.sendGroupMessageBatch("100", ["首轮一", "首轮二"]);
  await worker.sendMemeGroupImage("100", "首轮表情", firstBatch.at(-1)?.deliveryId);
  await worker.sendGroupMessageBatch("100", ["下一轮"]);
  const [first] = db.claimOutbox(10, now);
  assert.equal(first?.text, "首轮一");
  db.ackOutboxDelivery(first!.id, "qq-1", now);
  await worker.sendGroupMessage("200", "其他群继续");
  assert.deepEqual(db.claimOutbox(10, now + 100).map(row => row.group_id), ["200"]);
  const [second] = db.claimOutbox(10, now + 3500);
  assert.equal(second?.text, "首轮二");
  db.ackOutboxDelivery(second!.id, "qq-2", now + 3500);
  const [image] = db.claimOutbox(10, now + 3500);
  assert.equal(image?.text, "首轮表情");
  db.ackOutboxDelivery(image!.id, "qq-3", now + 3500);
  assert.equal(db.claimOutbox(10, now + 3500)[0]?.text, "下一轮");
});

test("terminal or ambiguous text failures cancel remaining bubbles and image", async t => {
  const { db, worker } = fixture(t);
  const receipts = await worker.sendGroupMessageBatch("100", ["首句", "尾句"]);
  await worker.sendMemeGroupImage("100", "asset", receipts.at(-1)?.deliveryId);
  const [first] = db.claimOutbox(10);
  db.markOutboxFailed(first!.id, null);
  assert.equal(db.claimOutbox(10, Date.now() + 10_000).length, 0);
  const rows = db.db.prepare("SELECT status,retry_after FROM outbox").all();
  assert.ok(rows.every(row => row.status === "failed" && row.retry_after === null));
});

test("group_poke confirms success without a message id; unknown results never retry", async t => {
  const { db } = fixture(t);
  let calls = 0;
  const transport: MessageTransport = { async sendGroupMessage() {}, async sendGroupImage() {}, async sendGroupPoke(groupId, userId) { calls++; assert.equal(groupId, "100"); assert.equal(userId, "123"); } };
  const id = db.enqueueOutbox("100", null, "123", "poke");
  const [row] = db.claimOutbox(1);
  assert.equal(await deliverOutboxRow(db, transport, row!), undefined);
  assert.equal(db.db.prepare("SELECT status,platform_message_id FROM outbox WHERE id=?").get(id)?.status, "sent");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM bot_messages").get()?.n, 0);
  assert.equal(calls, 1);
  db.enqueueOutbox("100", null, "123", "poke");
  const [uncertain] = db.claimOutbox(1);
  transport.sendGroupPoke = async () => { throw new NapCatActionOutcomeUnknownError("lost receipt"); };
  await assert.rejects(() => deliverOutboxRow(db, transport, uncertain!));
  assert.equal(markOutboxDeliveryFailed(db, uncertain!, new NapCatActionOutcomeUnknownError("unknown")), "terminal");
  assert.equal(db.claimOutbox(1, Date.now() + 10_000).length, 0);
  db.enqueueOutbox("100", null, "123", "poke");
  const [notSent] = db.claimOutbox(1);
  assert.equal(markOutboxDeliveryFailed(db, notSent!, new NapCatActionNotSentError("offline")), "retryable");
  assert.equal(db.claimOutbox(1, Date.now() + 3000).length, 1);
});
