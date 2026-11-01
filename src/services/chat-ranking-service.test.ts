import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessageTransport } from "../bot.js";
import { deliverOutboxRow, markOutboxDeliveryFailed } from "../index-ingress.js";
import { NapCatActionNotSentError, NapCatActionOutcomeUnknownError } from "../napcat-action-errors.js";
import { SharedDb } from "../shared/sqlite.js";
import { ChatRankingService, CHAT_RANKING_DOCUMENT, CHAT_RANKING_TTL_MS } from "./chat-ranking-service.js";
import { DailyReportStore } from "./daily-report-store.js";
import { SystemSettingsStore } from "./system-settings-store.js";
import { V3StateRepository } from "./v3-state-repository.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B9sAAAAASUVORK5CYII=", "base64");
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-chat-ranking-")), db = new SharedDb(path.join(dir, "state.db"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const repo = new V3StateRepository(db, { stateEncryptionKey: "0".repeat(64) });
  repo.markCutover();
  repo.saveGroup({ groupId: "10001", enabled: true, currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], dailyReportTopUserCount: 3, dailyReportEnabled: false });
  repo.saveCapabilityPolicy({ version: 1, updatedAt: new Date().toISOString(), enabledCapabilities: ["daily_reports"] });
  const settings = new SystemSettingsStore("", [], undefined, repo); await settings.getInternal();
  const insert = (msgId: string, text: string, extra: Record<string, unknown> = {}) => db.insertMessage({ groupId: "10001", userId: "20001", selfId: "12345", msgId, msgTime: Date.now(), text, imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: Date.now(), ...extra });
  insert("first", "GPT 模型代码"); insert("second", "午饭吃外卖", { userId: "20002" }); insert("query", "#排行");
  const root = path.join(dir, "group-statistics"), store = new DailyReportStore("", repo);
  const service = new ChatRankingService(store, root, repo, async () => PNG);
  const sent: string[] = [], transport: MessageTransport = {
    async sendGroupMessage(_group, text) { sent.push(text); return { platformMessageId: `qq-${sent.length}` }; },
    async sendGroupImage(_group, bytes) { sent.push(bytes); return { platformMessageId: `qq-${sent.length}` }; },
  };
  const input = { group: repo.getGroup("10001")!, userId: "20001", sourceMessageId: "query" };
  return { dir, db, repo, settings, insert, root, store, service, sent, transport, input };
}

test("ranking emits one durable text/image batch across duplicate calls and restart, with real ordered receipts", async t => {
  const f = await fixture(t);
  await Promise.all([f.service.send(f.input, f.transport), new ChatRankingService(f.store, f.root, f.repo, async () => PNG).send(f.input, f.transport)]);
  await new ChatRankingService(f.store, f.root, f.repo, async () => { assert.fail("duplicate render"); }).send(f.input, f.transport);
  const rows = f.db.db.prepare("SELECT * FROM outbox ORDER BY id").all(); assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "chat_ranking_text"); assert.equal(rows[1]!.kind, "chat_ranking_image");
  assert.equal(rows[0]!.batch_id, rows[1]!.batch_id); assert.equal(rows[1]!.delay_before_ms, 0);
  assert.match(String(rows[1]!.text), /^[a-f0-9]{64}$/u); assert.equal(rows[1]!.topic_id, null);
  const first = f.db.claimOutbox(10); assert.equal(first.length, 1); assert.equal(first[0]!.kind, "chat_ranking_text");
  await deliverOutboxRow(f.db, f.transport, first[0]!, undefined, undefined, undefined, undefined, undefined, f.service);
  assert.match(f.sent[0]!, /今日消息 2 条/u);
  const second = f.db.claimOutbox(10); assert.equal(second.length, 1); assert.equal(second[0]!.kind, "chat_ranking_image");
  await deliverOutboxRow(f.db, f.transport, second[0]!, undefined, undefined, undefined, undefined, undefined, f.service);
  assert.match(f.sent[1]!, /^base64:\/\//u); assert.equal(f.db.claimOutbox(10).length, 0);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM outbox WHERE status='sent' AND platform_message_id IS NOT NULL").get()!.n, 2);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM v3_daily_report_runs").get()!.n, 0);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM v3_daily_report_outputs").get()!.n, 0);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM v3_daily_report_messages").get()!.n, 0);
});

test("ranking source filters duplicate, bot, command, recalled and foreign-group records and reads fresh records", async t => {
  const f = await fixture(t);
  f.insert("second", "重复"); f.insert("bot", "机器人", { isBotMsg: true }); f.insert("control", "#帮助");
  f.insert("other", "其他群", { groupId: "10002" }); f.insert("recall", "这条被撤回");
  f.db.db.prepare("INSERT INTO retracted(msg_key,retracted_at) VALUES(?,?)").run("10001:recall", Date.now());
  await f.service.send(f.input, f.transport);
  assert.equal(f.repo.listDocuments<{ snapshot: { totalMessages: number } }>(CHAT_RANKING_DOCUMENT)[0]!.value.snapshot.totalMessages, 2);
  f.insert("third", "游戏副本"); f.insert("next-query", "#排行");
  await f.service.send({ ...f.input, sourceMessageId: "next-query" }, f.transport);
  assert.equal(f.repo.listDocuments<{ sourceMessageId: string; snapshot: { totalMessages: number } }>(CHAT_RANKING_DOCUMENT).find(d => d.value.sourceMessageId === "next-query")!.value.snapshot.totalMessages, 3);
});

test("render failure retains text and explains image failure without leaving a blocked image row", async t => {
  const f = await fixture(t);
  const service = new ChatRankingService(f.store, f.root, f.repo, async () => { throw new Error("font missing"); });
  await service.send(f.input, f.transport);
  const rows = f.db.claimOutbox(10); assert.equal(rows.length, 1);
  await deliverOutboxRow(f.db, f.transport, rows[0]!, undefined, undefined, undefined, undefined, undefined, service);
  assert.match(f.sent[0]!, /图片暂时生成失败/u); assert.equal(f.db.db.prepare("SELECT count(*) n FROM outbox").get()!.n, 1);
});

test("disabled group, command, rollout, capability, blacklist and changed permission discard queued ranking", async t => {
  for (const change of ["group", "command", "permission", "rollout", "capability", "blacklist", "recall"] as const) {
    await t.test(change, async sub => {
      const f = await fixture(sub); await f.service.send(f.input, f.transport);
      const row = f.db.claimOutbox(1)[0]!;
      if (change === "group") f.repo.saveGroup({ ...f.input.group, enabled: false });
      if (change === "blacklist") f.repo.saveGroup({ ...f.input.group, blacklistedUserIds: ["20001"] });
      if (change === "command" || change === "permission") await f.settings.update({ commands: (await f.settings.getInternal()).commands.map(c => c.id === "chat_ranking" ? { ...c, enabled: change !== "command", permission: change === "permission" ? "super_admin" : c.permission } : c) });
      if (change === "rollout") f.repo.saveDocument("chat-ranking-rollout", "default", { allowedGroupIds: [] });
      if (change === "capability") f.repo.saveCapabilityPolicy({ version: 1, enabledCapabilities: [], updatedAt: new Date().toISOString() });
      if (change === "recall") f.db.db.prepare("INSERT INTO retracted(msg_key,retracted_at) VALUES(?,?)").run("10001:query", Date.now());
      await assert.rejects(deliverOutboxRow(f.db, f.transport, row, undefined, undefined, undefined, undefined, undefined, f.service), /chat_ranking_unavailable/u);
      assert.equal(markOutboxDeliveryFailed(f.db, row, new Error("chat_ranking_unavailable")), "terminal");
      assert.equal(f.db.db.prepare("SELECT count(*) n FROM outbox WHERE status='cancelled'").get()!.n, 2); assert.equal(f.sent.length, 0);
    });
  }
});

test("expired ranking and forged cross-group image references never send", async t => {
  const f = await fixture(t); await f.service.send(f.input, f.transport);
  const row = f.db.claimOutbox(1)[0]!;
  await assert.rejects(deliverOutboxRow(f.db, f.transport, row, Date.now() + CHAT_RANKING_TTL_MS + 1000, undefined, undefined, undefined, undefined, f.service), /chat_ranking_expired/u);
  assert.throws(() => f.service.validate({ ...row, group_id: "10002" }), /chat_ranking_unavailable/u);
  const image = { ...row, id: row.id + 1, kind: "chat_ranking_image" };
  await assert.rejects(f.service.imageFor(image), /chat_ranking_text_unconfirmed/u);
  assert.throws(() => f.service.validate({ ...row, text: "../../secret" }), /chat_ranking_unavailable/u);
});

test("unknown sends and interrupted sending rows do not retry; confirmed-not-sent uses existing retry policy", async t => {
  const f = await fixture(t); await f.service.send(f.input, f.transport);
  const row = f.db.claimOutbox(1)[0]!;
  assert.equal(markOutboxDeliveryFailed(f.db, row, new NapCatActionNotSentError("offline")), "retryable");
  f.db.db.prepare("UPDATE outbox SET retry_after=0 WHERE id=?").run(row.id);
  const retry = f.db.claimOutbox(1)[0]!;
  assert.equal(markOutboxDeliveryFailed(f.db, retry, new NapCatActionOutcomeUnknownError("timeout")), "terminal");
  assert.equal(f.db.claimOutbox(10).length, 0); assert.equal(f.sent.length, 0);
  f.insert("new-query", "#排行"); await f.service.send({ ...f.input, sourceMessageId: "new-query" }, f.transport);
  const interrupted = f.db.claimOutbox(1)[0]!;
  f.db.recoverStaleSendingOutbox(Date.now() + 61_000);
  assert.equal(f.db.db.prepare("SELECT status,retry_after FROM outbox WHERE id=?").get(interrupted.id)!.retry_after, null);
  assert.equal(f.db.claimOutbox(10).length, 0);
});

test("cleanup removes old orphan and completed files but preserves young and actively referenced files", async t => {
  const f = await fixture(t); await f.service.send(f.input, f.transport);
  const first = f.db.claimOutbox(1)[0]!;
  const file = path.join(f.root, `${first.text}.png`);
  const old = new Date(Date.now() - 25 * 3_600_000); await utimes(file, old, old);
  await f.service.cleanup(); assert.ok((await readFile(file)).length);
  const orphan = path.join(f.root, `${"a".repeat(64)}.png`); await writeFile(orphan, PNG); await utimes(orphan, old, old);
  await writeFile(path.join(f.root, "unrelated.txt"), "keep"); await f.service.cleanup();
  await assert.rejects(readFile(orphan), /ENOENT/u); assert.equal(await readFile(path.join(f.root, "unrelated.txt"), "utf8"), "keep");
  await f.service.cleanup(Date.now() + 25 * 3_600_000);
  assert.ok((await readFile(file)).length, "an active sending reference protects the file");
  f.db.recoverStaleSendingOutbox(Date.now() + 25 * 3_600_000);
  await f.service.cleanup(Date.now() + 25 * 3_600_000);
  await assert.rejects(readFile(file), /ENOENT/u); assert.equal(f.repo.listDocuments(CHAT_RANKING_DOCUMENT).length, 0);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM outbox WHERE status='cancelled'").get()!.n, 2);
  assert.deepEqual(await readdir(f.root), ["unrelated.txt"]);
});

test("a missing image never sends", async t => {
  const f = await fixture(t); await f.service.send(f.input, f.transport);
  const text = f.db.claimOutbox(1)[0]!;
  await deliverOutboxRow(f.db, f.transport, text, undefined, undefined, undefined, undefined, undefined, f.service);
  const image = f.db.claimOutbox(1)[0]!;
  await unlink(path.join(f.root, `${image.text}.png`));
  await assert.rejects(f.service.imageFor(image), /ENOENT/u);
});

test("a symlinked image cannot read outside the persistent statistics directory", async t => {
  const f = await fixture(t); await f.service.send(f.input, f.transport);
  const text = f.db.claimOutbox(1)[0]!;
  await deliverOutboxRow(f.db, f.transport, text, undefined, undefined, undefined, undefined, undefined, f.service);
  const image = f.db.claimOutbox(1)[0]!, file = path.join(f.root, `${image.text}.png`);
  const outside = path.join(f.dir, "outside.png"); await writeFile(outside, PNG); await unlink(file);
  try { await symlink(outside, file, "file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require Windows Developer Mode or administrator privileges"); return; } throw error; }
  await assert.rejects(f.service.imageFor(image), /chat_ranking_image_unavailable/u);
  assert.equal(f.sent.length, 1);
});
