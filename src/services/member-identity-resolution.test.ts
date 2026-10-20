import assert from "node:assert/strict";
import test from "node:test";
import { parseMemberIdentityQuery, resolveMemberIdentityQuery, refreshIdentityDirectory } from "./member-identity-query.js";
import type { AiInteractionTarget, GroupBotConfig } from "../types.js";

const group: GroupBotConfig = { groupId: "67890", currentSkillId: "huixian", allowedSkillIds: ["huixian"], liveChatUserIds: [], switcherUserIds: [], manualIdentities: [
  { userIds: ["20001"], names: ["成员甲", "甲哥", "群主"], note: "无关画像不能进入身份答案" },
  { userIds: ["20002"], names: ["成员乙", "同名"] },
  { userIds: ["20003"], names: ["成员丙", "同名"] },
] };
const mention: AiInteractionTarget[] = [{ userId: "20001", names: ["假名片"], source: "mention" }];
const query = (text: string, targets: AiInteractionTarget[] = []) => parseMemberIdentityQuery(text, group, targets, "12345");
const resolve = (text: string, targets: AiInteractionTarget[] = [], extra = {}) => resolveMemberIdentityQuery(query(text, targets)!, { group, userId: "20001", targets, botQq: "12345", ...extra });

test("who, reverse who, recognize and comparisons resolve only exact saved aliases", () => {
  for (const text of ["甲哥是谁？", "谁是甲哥", "认识甲哥吗", "你认识甲哥吗？"]) {
    const answer = resolve(text);
    assert.equal(answer.status, "resolved");
    assert.deepEqual(answer.targetIds, ["20001"]);
    assert.match(answer.text, /甲哥就是成员甲/);
    assert.equal(answer.needsDirectory, false);
    assert.equal(answer.text.includes("画像"), false);
  }
  assert.equal(resolve("甲哥是不是成员甲").reason, "same_qq");
  for (const text of ["小甲哥是谁", "甲哥二号是谁", "李白是谁", "认识陌生人吗", "20001是谁", "@20001是谁"]) assert.equal(query(text), undefined);
  assert.equal(query("甲哥是谁", [{ userId: "20002", source: "alias", names: [] }])?.kind, "who");
  assert.equal(resolve("20001是谁", mention).reason, "unverified_numeric_label");
});

test("self uses actual sender account, pronouns need real objects and aliases cannot override conflicts", () => {
  assert.equal(resolve("我是谁", [], { senderCard: "成员乙" }).text, "你是成员甲。");
  assert.equal(resolve("我是谁", [{ userId: "20002", source: "reply", names: [] }]).text, "你是成员甲。");
  assert.equal(resolve("群主是谁").text, "群主就是成员甲。");
  assert.equal(resolve("他是谁").reason, "missing_member_object");
  assert.equal(resolve("他是谁", mention).text, "这位是成员甲。");
  assert.equal(resolve("他是谁", [{ ...mention[0]!, source: "reply" }]).text, "这位是成员甲。");
  assert.equal(resolve("@20001是谁", mention).text, "这位是成员甲。");
  assert.equal(resolve("甲哥是谁", [{ userId: "20002", source: "mention", names: [] }]).status, "conflict");
  assert.equal(resolve("同名是谁", mention).status, "ambiguous");
  assert.equal(resolve("他是谁", [{ ...mention[0]!, source: "alias" }]).status, "ambiguous");
});

test("directory reads only exact names, detects duplicates and preserves aliases across member renames and timeout", async () => {
  const members = [{ user_id: 20001, card: "改过的新名片", nickname: "新昵称" }];
  const args = { group, userId: "20002", targets: [], botQq: "12345" };
  assert.deepEqual(resolve("成员甲是谁", [], { members }).targetIds, ["20001"]);
  assert.match(resolve("成员甲是谁", [], { members }).text, /改过的新名片/);
  const scoped = query("群里的改过的新名片是谁")!;
  assert.equal(resolveMemberIdentityQuery(scoped, { ...args, members }).status, "resolved");
  assert.equal(resolveMemberIdentityQuery(scoped, { ...args, members: [...members, { user_id: 20002, card: "改过的新名片" }] }).status, "ambiguous");
  const known = resolve("成员甲是谁");
  assert.equal(known.status, "resolved");
  assert.equal(known.needsDirectory, true);
  await assert.rejects(refreshIdentityDirectory(() => new Promise(() => {}), 10), /timeout/);
  assert.deepEqual(resolve("成员甲是谁"), known);
});
