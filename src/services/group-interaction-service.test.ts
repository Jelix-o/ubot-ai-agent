import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import type { GroupBotConfig } from "../types.js";
import { GroupInteractionService, isInteractionQuietHour, type GroupPokeEvent } from "./group-interaction-service.js";

const now = Date.parse("2026-10-26T04:00:00Z");
const group: GroupBotConfig = { groupId: "100", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], ambientReplyEnabled: true, pokeReplyEnabled: true };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ubot-interactions-"));
  const dbPath = path.join(dir, "state.db");
  const db = new SharedDb(dbPath);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const service = new GroupInteractionService(db, "999", () => 0);
  const add = (id: number, userId = id % 2 ? "1" : "2", overrides: Partial<Parameters<SharedDb["insertMessage"]>[0]> = {}) => db.insertMessage({ groupId: "100", userId, selfId: "999", msgId: String(id), msgTime: now - 10_000 + id, text: "新话题 " + id, imagesJson: "[]", hasAtBot: false, isBotMsg: false, createdAt: now - 10_000 + id, ...overrides });
  return { db, dbPath, service, add };
}

test("read-air requires a fresh multi-member topic and durably limits evaluation", t => {
  const { service, add, db } = fixture(t);
  add(1); add(2);
  assert.deepEqual(service.ambientCandidate(group, now), []);
  add(3);
  assert.equal(service.ambientCandidate({ ...group, ambientReplyEnabled: false }, now).length, 0);
  assert.equal(service.ambientCandidate({ ...group, botMuted: true }, now).length, 0);
  assert.equal(service.ambientCandidate(group, now).length, 3);
  assert.equal(new GroupInteractionService(db, "999").ambientCandidate(group, now).length, 0);
  add(4, "2", { msgTime: now + 60_000, createdAt: now + 60_000 });
  assert.equal(service.ambientCandidate(group, now + 60_000).length, 4);
  assert.equal(service.claimAutomaticReply(group, true, now + 60_000), true);
  add(5, "1", { msgTime: now + 120_000, createdAt: now + 120_000 });
  assert.equal(service.ambientCandidate(group, now + 120_000).length, 0);
});

test("read-air filters commands, bot mentions, blacklist, recalls and a single speaker", t => {
  const { service, add, db } = fixture(t);
  add(1, "1"); add(2, "1"); add(3, "1");
  add(4, "2", { text: "#状态" });
  add(5, "2", { hasAtBot: true });
  add(6, "blocked");
  add(7, "2"); db.markRetracted("100", "7", now);
  assert.equal(service.ambientCandidate({ ...group, blacklistedUserIds: ["blocked"] }, now).length, 0);
  add(8, "2");
  db.registerInflight("100:branch", "task", now, "token");
  assert.equal(service.ambientCandidate(group, now).length, 0);
  assert.equal(service.ambientCandidate({ ...group, groupId: "200" }, now).length, 0);
});

test("Beijing quiet-hour boundaries cover 01:00 through 06:59", () => {
  assert.equal(isInteractionQuietHour(Date.parse("2026-10-25T16:59:59Z")), false);
  assert.equal(isInteractionQuietHour(Date.parse("2026-10-25T17:00:00Z")), true);
  assert.equal(isInteractionQuietHour(Date.parse("2026-10-25T22:59:59Z")), true);
  assert.equal(isInteractionQuietHour(Date.parse("2026-10-25T23:00:00Z")), false);
});

test("selected-member replies keep their thirty-second cadence and durable source claims independently of ambient rules", t => {
  const { service, db } = fixture(t);
  const selected = { ...group, participationMode: "selected_members" as const, liveChatDelaySeconds: 30 };
  assert.equal(service.claimAutomaticReply(selected, false, now, ["first"]), true);
  assert.equal(service.claimAutomaticReply(selected, false, now + 29_999, ["second"]), false);
  assert.equal(service.claimAutomaticReply(selected, false, now + 30_000, ["second"]), true);
  assert.equal(service.claimAutomaticReply(selected, true, now + 60_000, ["ambient"]), false);
  const restarted = new GroupInteractionService(db, "999");
  assert.equal(restarted.claimAutomaticReply(selected, false, now + 120_000, ["first"]), false);
  assert.equal(restarted.isSourceHandled("100", "second"), true);
  assert.equal(restarted.isSourceHandled("200", "second"), false);
  const night = Date.parse("2026-10-26T21:00:00Z");
  assert.equal(restarted.claimAutomaticReply({ ...selected, ambientReplyEnabled: false }, false, night, ["night"]), true);
  assert.equal(restarted.claimAutomaticReply(selected, true, night + 600_000, ["quiet"]), false);
  assert.equal(restarted.claimAutomaticReply({ ...selected, botMuted: true }, false, night + 600_000, ["muted"]), false);
});

test("ambient ignores sources already claimed by selected-member chat", t => {
  const { service, add } = fixture(t);
  add(1); add(2); add(3);
  assert.equal(service.claimAutomaticReply({ ...group, participationMode: "selected_members", liveChatDelaySeconds: 30 }, false, now - 70_000, ["1", "2"]), true);
  assert.equal(service.ambientCandidate(group, now).length, 0);
});

test("only genuine fresh targeted pokes pass probability, durable dedup and separate cooldowns", t => {
  const { service, db } = fixture(t);
  const event: GroupPokeEvent = { post_type: "notice", notice_type: "notify", sub_type: "poke", group_id: 100, user_id: 1, target_id: 999, self_id: 999, time: now / 1000 };
  assert.equal(service.queuePoke(event, { ...group, pokeReplyEnabled: false }, now), false);
  assert.equal(service.queuePoke({ ...event, target_id: 2 }, group, now), false);
  assert.equal(service.queuePoke({ ...event, user_id: 999 }, group, now), false);
  assert.equal(service.queuePoke({ ...event, time: event.time - 61 }, group, now), false);
  assert.equal(service.queuePoke(event, { ...group, blacklistedUserIds: ["1"] }, now), false);
  assert.equal(service.queuePoke(event, group, now), true);
  assert.equal(new GroupInteractionService(db, "999", () => 0).queuePoke(event, group, now), false);
  assert.equal(service.queuePoke({ ...event, time: event.time + 29, user_id: 2 }, group, now + 29_000), false);
  assert.equal(service.queuePoke({ ...event, time: event.time + 30, user_id: 2 }, group, now + 30_000), true);
  assert.equal(service.queuePoke({ ...event, time: event.time + 59 }, group, now + 59_000), false);
  assert.equal(service.queuePoke({ ...event, time: event.time + 60 }, group, now + 60_000), true);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='poke'").get()?.n, 3);
  assert.equal(new GroupInteractionService(db, "999", () => 0.25).queuePoke({ ...event, time: event.time + 120 }, group, now + 120_000), false);
});
