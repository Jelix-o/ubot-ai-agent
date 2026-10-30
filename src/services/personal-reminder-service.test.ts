import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import { PersonalReminderService } from "./personal-reminder-service.js";
import { beijingTime, parsePersonalReminder } from "./personal-reminder-parser.js";
import { deliverOutboxRow, markOutboxDeliveryFailed } from "../index-ingress.js";
import { NapCatActionNotSentError, NapCatActionOutcomeUnknownError } from "../napcat-reverse-server.js";

const now = new Date("2026-10-30T15:55:00.000Z"); // Friday, 23:55 Beijing.
test("one-shot parser handles Beijing date rollover, weekends, exact dates and relative times", () => {
  for (const [input, dueAt, topic] of [
    ["#提醒 10分钟后 喝水", "2026-10-30T16:05:00.000Z", "喝水"],
    ["明天上午9点提醒我开会", "2026-10-31T01:00:00.000Z", "开会"],
    ["提醒我 后天15:30 取快递", "2026-11-01T07:30:00.000Z", "取快递"],
    ["下周一下午3点半提醒我交材料", "2026-11-02T07:30:00.000Z", "交材料"],
    ["2027-01-01 00:01 看烟花", "2026-12-31T16:01:00.000Z", "看烟花"],
  ]) assert.deepEqual(parsePersonalReminder(input!, now), { dueAt, topic });
  assert.match(beijingTime("2026-10-31T01:00:00Z"), /2026\/10\/31.*09:00/);
});
test("one-shot parser asks for missing fields and rejects past or impossible dates without rolling them forward", () => {
  for (const input of ["9点喝水", "明天下午提醒我开会", "明天9点", "今天9点开会", "2026-02-30 09:00 喝水", "明天25:00 喝水", "0分钟后 喝水", "999999天后 喝水", "本周一9点 开会"]) assert.ok("question" in parsePersonalReminder(input, now), input);
});
async function fixture(run: (service: PersonalReminderService, repo: V3StateRepository, db: SharedDb) => void | Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ubot-personal-reminder-"));
  const db = new SharedDb(path.join(dir, "state.db"));
  try {
    const repo = new V3StateRepository(db, { stateEncryptionKey: "0".repeat(64) });
    for (const groupId of ["10001", "10002"]) repo.saveGroup({ groupId, enabled: true, currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], personalRemindersEnabled: true, scheduledRemindersEnabled: false });
    await run(new PersonalReminderService(repo), repo, db);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
test("personal reminders have owner/group isolation and atomic per-member and group quotas", async () => fixture((service, repo) => {
  const task = service.create("10001", "20001", "2026-10-31T01:00:00Z", "开会", now.getTime());
  assert.equal(service.cancel("10001", "20002", task.id), false);
  assert.equal(service.cancel("10002", "20001", task.id), false);
  for (let i = 1; i < 5; i++) service.create("10001", "20001", "2026-10-31T01:00:00Z", "喝水", now.getTime());
  assert.throws(() => service.create("10001", "20001", "2026-10-31T01:00:00Z", "喝水", now.getTime()), /reminder_limit/);
  assert.equal(service.cancel("10001", "20001", task.id.slice(9,17)), true);
  for (let i = 0; i < 46; i++) service.create("10001", String(30000 + i), "2026-10-31T01:00:00Z", "喝水", now.getTime());
  assert.throws(() => service.create("10001", "99999", "2026-10-31T01:00:00Z", "喝水", now.getTime()), /reminder_limit/);
  assert.equal(service.list("10002", "20001").length, 0);
  assert.equal(repo.getScheduledReminder(task.id)?.personalResult, "cancelled");
}));

test("a reminder queued on time becomes a missed notice after a long transport outage",async()=>fixture(async(service,repo,db)=>{
  const due = new Date("2026-10-31T01:00:00Z");
  const task = service.create("10001","20001",due.toISOString(),"不会补发的原始内容",now.getTime());
  service.tick(due);
  const rows = db.claimOutbox(1);
  const messages:string[]=[];
  await deliverOutboxRow(db,{async sendGroupMessage(_g,text){messages.push(text);return{messageId:"late-notice"};},async sendGroupImage(){}},rows[0]!,due.getTime()+300_001);
  assert.equal(messages.length,1);assert.match(messages[0]!,/已错过超过五分钟/);assert.doesNotMatch(messages[0]!,/不会补发的原始内容/);
  assert.equal(repo.getScheduledReminder(task.id)?.personalResult,"missed");
}));
test("one-shot claims survive restart, separate legacy scheduler, mark late/missed and honor switches", async () => fixture((service, repo, db) => {
  const due = new Date("2026-10-31T01:00:00Z");
  const task = service.create("10001", "20001", due.toISOString(), "开会", now.getTime());
  assert.equal(repo.claimDueScheduledReminders(due.getTime()).length, 0);
  new PersonalReminderService(repo).tick(new Date(due.getTime() + 60_000));
  service.tick(new Date(due.getTime() + 120_000));
  assert.equal(repo.getScheduledReminder(task.id)?.personalResult, "queued");
  let rows = db.db.prepare("SELECT * FROM outbox").all() as any[];
  assert.equal(rows.length, 1); assert.match(JSON.parse(rows[0].text).text, /延迟送达/);
  const missed = service.create("10001", "20001", due.toISOString(), "迟到", now.getTime());
  service.tick(new Date(due.getTime() + 300_001));
  assert.equal(repo.getScheduledReminder(missed.id)?.personalResult, "missed");
  const skipped = service.create("10002", "20001", due.toISOString(), "已关闭", now.getTime());
  repo.saveGroup({ ...repo.getGroup("10002")!, personalRemindersEnabled: false });
  service.tick(due);
  assert.equal(repo.getScheduledReminder(skipped.id)?.personalResult, "skipped");
  rows = db.db.prepare("SELECT * FROM outbox").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(markOutboxDeliveryFailed(db, rows[0], new NapCatActionOutcomeUnknownError("unknown")), "terminal");
  assert.equal(markOutboxDeliveryFailed(db, rows[1], new NapCatActionNotSentError("not sent")), "retryable");
}));
