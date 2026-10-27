import assert from "node:assert/strict";
import test from "node:test";

import type { GroupManualIdentity, NapcatGroupMember } from "../types.js";
import {
  avatarEditTargetErrorMessage,
  buildAvatarEditPrompt,
  parseAvatarEditRequest,
  resolveAvatarEditTarget,
  type AvatarEditRequest,
} from "./avatar-edit-request.js";

const BOT_QQ = "12345";
const REQUESTER_QQ = "20001";
const MEMBERS: NapcatGroupMember[] = [
  { user_id: 20001, nickname: "发起人", card: "小李" },
  { user_id: 30001, nickname: "阿张", card: "张三" },
  { user_id: 30002, nickname: "老张", card: "张三" },
  { user_id: 40001, nickname: "小王", card: "项目经理" },
  { user_id: 12345, nickname: "会仙", card: "会仙" },
];
const MANUAL_IDENTITIES: GroupManualIdentity[] = [
  { userIds: ["40001"], names: ["产品王", "小王"] },
  { userIds: ["30001"], names: ["开发张", "阿张"] },
];

function matchedRequest(text: string): AvatarEditRequest {
  const parsed = parseAvatarEditRequest(text);
  assert.equal(parsed.kind, "avatar_edit");
  return parsed.request;
}

function resolve(
  request: AvatarEditRequest,
  overrides: Partial<Parameters<typeof resolveAvatarEditTarget>[0]> = {},
) {
  return resolveAvatarEditTarget({
    request,
    requesterUserId: REQUESTER_QQ,
    botUserId: BOT_QQ,
    verifiedMentionUserIds: [],
    members: MEMBERS,
    manualIdentities: MANUAL_IDENTITIES,
    ...overrides,
  });
}

test("parses the avatar-edit form with optional command, 的 and 头像", () => {
  const full = parseAvatarEditRequest("#改图 让 产品王 的 头像 去 海边散步");
  assert.deepEqual(full, {
    kind: "avatar_edit",
    request: { targetText: "产品王", action: "海边散步", hasExplicitAvatarWord: true },
  });

  const omitted = parseAvatarEditRequest("让 我 去 弹吉他");
  assert.deepEqual(omitted, {
    kind: "avatar_edit",
    request: { targetText: "我", action: "弹吉他", hasExplicitAvatarWord: false },
  });
  assert.deepEqual(parseAvatarEditRequest("让@40001的头像吐舌头"), {
    kind: "avatar_edit",
    request: { targetText: "@40001", action: "吐舌头", hasExplicitAvatarWord: true },
  });
  assert.deepEqual(parseAvatarEditRequest("将我头像美化一下"), {
    kind: "avatar_edit",
    request: { targetText: "我", action: "美化一下", hasExplicitAvatarWord: true },
  });
  assert.deepEqual(parseAvatarEditRequest("把 产品王 的头像去海边散步"), {
    kind: "avatar_edit",
    request: { targetText: "产品王", action: "海边散步", hasExplicitAvatarWord: true },
  });
  assert.deepEqual(parseAvatarEditRequest("我头像美化一下"), {
    kind: "avatar_edit",
    request: { targetText: "我", action: "美化一下", hasExplicitAvatarWord: true },
  });
  assert.deepEqual(
    parseAvatarEditRequest("产品王头像美化一下"),
    { kind: "not_avatar_edit" },
    "only the self shorthand may omit 让 / 将 / 把",
  );
  assert.deepEqual(parseAvatarEditRequest("给图片加一条狗"), { kind: "not_avatar_edit" });
  assert.deepEqual(parseAvatarEditRequest("把产品王去海边散步"), { kind: "not_avatar_edit" });
  assert.deepEqual(
    parseAvatarEditRequest("把这张图片改成我的头像风格"),
    { kind: "not_avatar_edit" },
    "ordinary image editing wording must not be captured as an avatar target",
  );
  assert.deepEqual(parseAvatarEditRequest("把图图头像去海边散步"), {
    kind: "avatar_edit",
    request: { targetText: "图图", action: "海边散步", hasExplicitAvatarWord: true },
  });
  assert.deepEqual(parseAvatarEditRequest("让小王头像"), { kind: "invalid_avatar_edit", code: "action_missing" });
  assert.deepEqual(parseAvatarEditRequest("让头像去跑步"), { kind: "invalid_avatar_edit", code: "target_missing" });
});

test("resolves self, one verified @, QQ, a unique manual primary name and exact member names", () => {
  assert.deepEqual(resolve(matchedRequest("让我头像去跳舞")), {
    ok: true, target: { userId: REQUESTER_QQ, source: "self" },
  });
  assert.deepEqual(resolve(matchedRequest("让@40001头像去跳舞"), { verifiedMentionUserIds: ["40001"] }), {
    ok: true, target: { userId: "40001", source: "mention" },
  });
  assert.deepEqual(resolve(matchedRequest("让40001去跳舞")), {
    ok: true, target: { userId: "40001", source: "qq" },
  });
  assert.deepEqual(resolve(matchedRequest("让产品王的头像去跳舞")), {
    ok: true, target: { userId: "40001", source: "manual_identity" },
  });
  assert.deepEqual(resolve(matchedRequest("让阿张头像去跳舞")), {
    ok: true, target: { userId: "30001", source: "member_name" },
  });
  assert.deepEqual(resolve(matchedRequest("让项目经理头像去跳舞")), {
    ok: true, target: { userId: "40001", source: "member_name" },
  });
  assert.deepEqual(resolve(matchedRequest("让产品王头像去跳舞"), {
    manualIdentities: [...MANUAL_IDENTITIES, { userIds: ["40001"], names: ["产品王"] }],
  }), {
    ok: true, target: { userId: "40001", source: "manual_identity" },
  });
});

test("accepts only message-segment verified @ targets and rejects extra targets", () => {
  const mention = matchedRequest("让@40001头像去跳舞");
  assert.deepEqual(resolve(mention), { ok: false, code: "unverified_mention" });
  assert.deepEqual(resolve(mention, { verifiedMentionUserIds: ["30001"] }), { ok: false, code: "unverified_mention" });
  assert.deepEqual(resolve(mention, { verifiedMentionUserIds: ["40001", "30001"] }), { ok: false, code: "multiple_mentions" });
  assert.deepEqual(resolve(matchedRequest("让产品王头像去跳舞"), { verifiedMentionUserIds: ["40001"] }), {
    ok: false, code: "unexpected_mention",
  });
});

test("rejects unknown, ambiguous, bot and unavailable directory targets", () => {
  assert.deepEqual(resolve(matchedRequest("让张三头像去跳舞")), { ok: false, code: "ambiguous_target" });
  assert.deepEqual(resolve(matchedRequest("让不存在头像去跳舞")), { ok: false, code: "unknown_target" });
  assert.deepEqual(resolve(matchedRequest("让12345头像去跳舞")), { ok: false, code: "bot_target" });
  assert.deepEqual(resolve(matchedRequest("让@12345头像去跳舞"), { verifiedMentionUserIds: ["12345"] }), {
    ok: false, code: "bot_target",
  });
  assert.deepEqual(resolve(matchedRequest("让产品王头像去跳舞"), { memberDirectoryAvailable: false }), {
    ok: false, code: "member_directory_unavailable",
  });
});

test("enforces privacy opt-out for third parties but permits the member editing their own avatar", () => {
  const request = matchedRequest("让产品王头像去跳舞");
  assert.deepEqual(resolve(request, { memoryDisabledUserIds: ["40001"] }), {
    ok: false, code: "privacy_opt_out",
  });
  assert.deepEqual(resolve(request, { requesterUserId: "40001", memoryDisabledUserIds: ["40001"] }), {
    ok: true, target: { userId: "40001", source: "manual_identity" },
  });
});

test("builds a generic avatar prompt without leaking the target identity", () => {
  const request = matchedRequest("让产品王头像去雨中撑伞");
  const prompt = buildAvatarEditPrompt(request.action);
  assert.match(prompt, /图1/);
  assert.match(prompt, /雨中撑伞/);
  assert.doesNotMatch(prompt, /产品王|40001|QQ/);
  assert.throws(() => buildAvatarEditPrompt("   "), /avatar_edit_action_empty/);
  assert.match(prompt, /图2至图4/);
  assert.equal(avatarEditTargetErrorMessage("privacy_opt_out"), "该成员已关闭头像改图，请让对方自行发送 #改图，或改自己的头像");
});
