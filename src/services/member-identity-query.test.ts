import assert from "node:assert/strict";
import test from "node:test";
import { answerIdentityCheck, identityCheckNeedsDirectory, isDeicticImagePersonQuestion, isExplicitImagePersonQuestion, parseIdentityCheck, refreshIdentityDirectory } from "./member-identity-query.js";
import type { GroupBotConfig, NapcatGroupMember } from "../types.js";

const group: GroupBotConfig = {
  groupId: "1", currentSkillId: "huixian", allowedSkillIds: ["huixian"], liveChatUserIds: [], switcherUserIds: [],
  manualIdentities: [
    { userIds: ["1418509802"], names: ["鸡哥", "鸡某"] },
    { userIds: ["429462108"], names: ["悠米", "重名"] },
    { userIds: ["2458031445"], names: ["外包仙人", "重名"] },
  ],
};
const members: NapcatGroupMember[] = [{ user_id: 1418509802, card: "成都林心如", nickname: "☉_☉" }];

test("deictic person questions are available to an established image anchor without widening named identity queries", () => {
  for (const text of ["这是哪位", "这是谁？", "这个人是谁", "图里是谁", "图片中这人是哪位", "照片上的人是谁", "她是谁啊"]) {
    assert.equal(isDeicticImagePersonQuestion(text), true, text);
  }
  for (const text of ["这是哪位", "这是谁？", "这个人是谁", "图里是谁", "图片中这人是哪位", "照片上的人是谁", "这张图里是谁", "图里这是谁", "图中这个是谁", "照片上这位是谁", "请问， 图里 这 是 谁？", "麻烦你看看这张图片里这个人是谁啊？"]) {
    assert.equal(isExplicitImagePersonQuestion(text), true, text);
  }
  for (const text of ["他是谁", "她是谁", "鸡哥是谁", "@1418509802 他是谁"]) {
    assert.equal(isExplicitImagePersonQuestion(text), false, text);
  }
  for (const text of ["鸡哥是谁", "谁是鸡哥", "我是谁", "群里他是谁", "@1418509802 他是谁", "这是什么"]) {
    assert.equal(isDeicticImagePersonQuestion(text), false, text);
  }
});

test("identity checks require an exact saved anchor and compare exact QQ mappings", () => {
  assert.equal(parseIdentityCheck("苹果是不是水果", group, [], "99"), undefined);
  assert.equal(parseIdentityCheck("小鸡哥是不是成都林心如", group, [], "99"), undefined);
  assert.equal(parseIdentityCheck("1418509802是不是成都林心如", group, [], "99"), undefined);
  const same = parseIdentityCheck("鸡哥是不是鸡某？", group, [], "99")!;
  assert.equal(identityCheckNeedsDirectory(same, group), false);
  assert.equal(answerIdentityCheck(same, group).reason, "same_qq");
  assert.equal(answerIdentityCheck(parseIdentityCheck("鸡哥是不是悠米", group, [], "99")!, group).reason, "different_qq");
  assert.equal(answerIdentityCheck(parseIdentityCheck("鸡哥是不是成都林心如", group, [], "99")!, group, members).reason, "same_qq");
});

test("directory duplicates, unknowns and explicit conflicting objects never guess", () => {
  const check = parseIdentityCheck("鸡哥是不是成都林心如", group, [], "99")!;
  assert.equal(answerIdentityCheck(check, group, [...members, { user_id: 20001, card: "成都林心如" }]).reason, "mapping_not_unique");
  assert.equal(answerIdentityCheck(check, group, []).reason, "mapping_not_unique");
  assert.equal(answerIdentityCheck(parseIdentityCheck("重名是不是成都林心如", group, [], "99")!, group, members).reason, "mapping_not_unique");
  const mention = [{ userId: "1418509802", names: [], source: "mention" as const }];
  assert.equal(answerIdentityCheck(parseIdentityCheck("他是不是成都林心如", group, mention, "99")!, group, members).reason, "same_qq");
  assert.equal(answerIdentityCheck({ ...check, explicitIds: ["429462108"] }, group, members).reason, "target_conflict");
  assert.equal(answerIdentityCheck(parseIdentityCheck("鸡哥是不是@1418509802", group, mention, "99")!, group).reason, "same_qq");
  assert.equal(answerIdentityCheck(parseIdentityCheck("@1418509802是不是鸡哥", group, mention, "99")!, group).reason, "same_qq");
  assert.equal(answerIdentityCheck(parseIdentityCheck("鸡哥是不是@429462108", group, [{ userId: "429462108", names: [], source: "mention" }], "99")!, group).reason, "different_qq");
  assert.equal(answerIdentityCheck(parseIdentityCheck("鸡哥是不是@1418509802", group, [], "99")!, group).reason, "mapping_not_unique", "typed @ alone cannot authorize identity mapping");
});

test("directory refresh is bounded, propagates failure and ignores late completions", async () => {
  assert.deepEqual(await refreshIdentityDirectory(async () => members, 20), members);
  await assert.rejects(refreshIdentityDirectory(async () => { throw new Error("offline"); }, 20), /offline/);
  let finish!: (members: NapcatGroupMember[]) => void;
  await assert.rejects(refreshIdentityDirectory(() => new Promise(resolve => { finish = resolve; }), 10), /identity_directory_timeout/);
  finish(members);
});
