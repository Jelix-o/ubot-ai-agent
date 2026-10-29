import type { GroupManualIdentity, NapcatGroupMember } from "../types.js";

/**
 * The narrow syntax that opts a #改图 request into avatar-reference mode.
 * Callers should pass the command suffix, or the parsed message text that
 * still contains the command prefix.
 */
export interface AvatarEditRequest {
  targetText: string;
  action: string;
  hasExplicitAvatarWord: boolean;
}

export type AvatarEditRequestParseResult =
  | { kind: "not_avatar_edit" }
  | { kind: "invalid_avatar_edit"; code: "target_missing" | "action_missing" }
  | { kind: "avatar_edit"; request: AvatarEditRequest };

export type AvatarEditTargetSource = "self" | "mention" | "qq" | "manual_identity" | "member_name";

export interface AvatarEditTarget {
  userId: string;
  source: AvatarEditTargetSource;
}

export type AvatarEditTargetErrorCode =
  | "multiple_mentions"
  | "unverified_mention"
  | "unexpected_mention"
  | "member_directory_unavailable"
  | "unknown_target"
  | "ambiguous_target"
  | "bot_target"
  | "privacy_opt_out";

export type AvatarEditTargetResolution =
  | { ok: true; target: AvatarEditTarget }
  | { ok: false; code: AvatarEditTargetErrorCode };

/**
 * Inputs deliberately contain only data already verified by the group-message
 * parser and the current group roster. This module never infers an identity
 * from free-form @ text or a remote profile response.
 */
export interface ResolveAvatarEditTargetInput {
  request: AvatarEditRequest;
  requesterUserId: string;
  botUserId: string;
  verifiedMentionUserIds: readonly string[];
  members: readonly NapcatGroupMember[];
  manualIdentities?: readonly GroupManualIdentity[];
  memoryDisabledUserIds?: readonly string[];
  memberDirectoryAvailable?: boolean;
}

/**
 * Parses the explicit avatar-edit forms. Once the user explicitly says
 * `头像`, `去` is optional (`让<目标>头像吐舌头` is intentional). Without
 * `头像`, `去` remains required so ordinary #改图 text keeps its existing
 * route.
 */
export function parseAvatarEditRequest(input: string): AvatarEditRequestParseResult {
  const text = stripLeadingEditCommand(normalizeWhitespace(input));
  const prefix = /^(让|将|把)\s*/u.exec(text)?.[1];
  const body = prefix ? text.slice(prefix.length).trim() : text;
  const explicitAvatar = /^([\s\S]*?)(?:\s*的)?\s*头像\s*(?:去\s*)?([\s\S]*)$/u.exec(body);
  if (explicitAvatar) {
    const targetText = explicitAvatar[1]!.replace(/的\s*$/u, "").trim();
    const action = explicitAvatar[2]!.trim();
    if (!targetText) {
      return { kind: "invalid_avatar_edit", code: "target_missing" };
    }
    if (!action) {
      return { kind: "invalid_avatar_edit", code: "action_missing" };
    }
    // `把这张图片改成我的头像风格` is an ordinary image edit, not a
    // member-avatar request. Keep the target parser narrow enough that this
    // familiar wording falls through to #改图's normal reference path.
    if (prefix && looksLikeImageEditSubject(targetText)) {
      return { kind: "not_avatar_edit" };
    }
    // The no-prefix shorthand is deliberately self-only.  A bare
    // "成员甲头像…" in ordinary chat must not acquire another member as an
    // avatar-edit target; other targets require 让 / 将 / 把.
    if (!prefix && targetText !== "我") {
      return { kind: "not_avatar_edit" };
    }
    return {
      kind: "avatar_edit",
      request: { targetText, action, hasExplicitAvatarWord: true },
    };
  }

  // Without an explicit "头像", preserve the deliberately narrow legacy
  // form: only "让<目标>去<动作>" can be an avatar edit. This keeps prose
  // such as "把图片改成..." outside the avatar target parser.
  if (prefix !== "让") {
    return { kind: "not_avatar_edit" };
  }

  const actionIndex = body.indexOf("去");
  if (actionIndex < 0) {
    return { kind: "not_avatar_edit" };
  }

  const action = body.slice(actionIndex + "去".length).trim();
  let targetText = body.slice(0, actionIndex).trim();
  targetText = targetText.replace(/的\s*$/u, "").trim();

  if (!targetText) {
    return { kind: "invalid_avatar_edit", code: "target_missing" };
  }
  if (!action) {
    return { kind: "invalid_avatar_edit", code: "action_missing" };
  }

  return {
    kind: "avatar_edit",
    request: { targetText, action, hasExplicitAvatarWord: false },
  };
}

/**
 * Resolves one target from an already-refreshed group directory. It uses exact
 * matching only: a QQ number, a message-segment @, a manual primary name, or
 * a member card/nickname. It intentionally never does fuzzy matching.
 */
export function resolveAvatarEditTarget(
  input: ResolveAvatarEditTargetInput,
): AvatarEditTargetResolution {
  const requesterUserId = input.requesterUserId.trim();
  const botUserId = input.botUserId.trim();
  const mentionUserIds = uniqueUserIds(input.verifiedMentionUserIds);
  if (mentionUserIds.length > 1) {
    return { ok: false, code: "multiple_mentions" };
  }

  const candidate = input.request.targetText.trim();
  if (candidate === "我") {
    if (mentionUserIds.length > 0) {
      return { ok: false, code: "unexpected_mention" };
    }
    return resolveDirectTarget(requesterUserId, "self", input, botUserId);
  }

  const atCandidate = /^@(.+)$/u.exec(candidate)?.[1]?.trim();
  if (atCandidate) {
    if (atCandidate === botUserId) {
      return { ok: false, code: "bot_target" };
    }
    if (mentionUserIds.length !== 1 || mentionUserIds[0] !== atCandidate) {
      return { ok: false, code: "unverified_mention" };
    }
    return resolveDirectoryTarget(atCandidate, "mention", input, botUserId);
  }

  if (mentionUserIds.length > 0) {
    return { ok: false, code: "unexpected_mention" };
  }
  if (candidate === botUserId) {
    return { ok: false, code: "bot_target" };
  }
  if (isQqNumber(candidate)) {
    return resolveDirectoryTarget(candidate, "qq", input, botUserId);
  }
  if (input.memberDirectoryAvailable === false) {
    return { ok: false, code: "member_directory_unavailable" };
  }

  const normalizedCandidate = normalizeName(candidate);
  if (!normalizedCandidate) {
    return { ok: false, code: "unknown_target" };
  }

  const manualMatches = (input.manualIdentities ?? []).filter((identity) =>
    normalizeName(identity.names[0] ?? "") === normalizedCandidate,
  );
  if (manualMatches.length > 0) {
    const memberIds = uniqueUserIds(manualMatches.flatMap((identity) => identity.userIds))
      .filter((userId) => hasCurrentMember(input.members, userId));
    if (memberIds.length > 1) {
      return { ok: false, code: "ambiguous_target" };
    }
    if (memberIds.length === 1) {
      return resolveDirectoryTarget(memberIds[0]!, "manual_identity", input, botUserId);
    }
    return { ok: false, code: "unknown_target" };
  }

  const nameMatches = uniqueUserIds(
    input.members
      .filter((member) => memberNameMatches(member, normalizedCandidate))
      .map((member) => String(member.user_id)),
  );
  if (nameMatches.length > 1) {
    return { ok: false, code: "ambiguous_target" };
  }
  if (nameMatches.length !== 1) {
    return { ok: false, code: "unknown_target" };
  }
  return resolveDirectoryTarget(nameMatches[0]!, "member_name", input, botUserId);
}

/**
 * Keeps the target identity out of the image prompt. The caller supplies this
 * string together with the resolved avatar as reference image 1.
 */
export function buildAvatarEditPrompt(action: string): string {
  const normalizedAction = normalizeWhitespace(action);
  if (!normalizedAction) {
    throw new Error("avatar_edit_action_empty");
  }
  return `以图1中的人物为主体，保留可识别的面部、发型和整体人物特征。图2至图4只可作为场景、风格或构图参考，不改变图1人物身份。${normalizedAction}`;
}

export function avatarEditTargetErrorMessage(code: AvatarEditTargetErrorCode): string {
  switch (code) {
    case "multiple_mentions":
      return "头像改图一次只能指定一位群成员，请只保留一个真实 @";
    case "unverified_mention":
      return "请使用消息里的真实 @ 指定头像改图目标，不能只输入文字 @";
    case "unexpected_mention":
      return "头像改图目标请使用真实 @、QQ 号、主称呼、群名片、昵称或“我”";
    case "member_directory_unavailable":
      return "当前无法核验群成员，请稍后重试或使用“我”";
    case "unknown_target":
      return "未能在当前群找到该成员，请使用真实 @ 或 QQ 号";
    case "ambiguous_target":
      return "该称呼对应多位成员，请使用真实 @ 或 QQ 号";
    case "bot_target":
      return "不能把机器人自身作为头像改图目标";
    case "privacy_opt_out":
      return "该成员已关闭头像改图，请让对方自行发送 #改图，或改自己的头像";
  }
}

export function avatarEditRequestParseErrorMessage(
  code: Extract<AvatarEditRequestParseResult, { kind: "invalid_avatar_edit" }> ["code"],
): string {
  return code === "target_missing" ? "想用谁的头像？可以说是自己的，或 @那位成员。" : "想把头像改成什么样？";
}

function resolveDirectoryTarget(
  userId: string,
  source: Exclude<AvatarEditTargetSource, "self">,
  input: ResolveAvatarEditTargetInput,
  botUserId: string,
): AvatarEditTargetResolution {
  if (input.memberDirectoryAvailable === false) {
    return { ok: false, code: "member_directory_unavailable" };
  }
  if (!hasCurrentMember(input.members, userId)) {
    return { ok: false, code: "unknown_target" };
  }
  return resolveDirectTarget(userId, source, input, botUserId);
}

function looksLikeImageEditSubject(value: string): boolean {
  // A bare "图" is a plausible member nickname (for example, "图图").
  // Treat it as an image subject only when paired with a demonstrative; the
  // longer image nouns are unambiguous on their own.
  return /(?:这[张幅]?|当前|原|参考)\s*(?:图片|图像|图|照片|插画|海报|壁纸)|(?:图片|图像|照片|插画|海报|壁纸)|(?:改成|修改|变成|换成|替换|编辑|修图|加上|添加|去掉|删除|移除|抹掉)/u.test(value);
}

function resolveDirectTarget(
  userId: string,
  source: AvatarEditTargetSource,
  input: ResolveAvatarEditTargetInput,
  botUserId: string,
): AvatarEditTargetResolution {
  if (!userId || userId === botUserId) {
    return { ok: false, code: "bot_target" };
  }
  const privacyDisabled = new Set(uniqueUserIds(input.memoryDisabledUserIds ?? []));
  if (userId !== input.requesterUserId.trim() && privacyDisabled.has(userId)) {
    return { ok: false, code: "privacy_opt_out" };
  }
  return { ok: true, target: { userId, source } };
}

function stripLeadingEditCommand(value: string): string {
  return value.replace(/^#改图(?:\s+|$)/u, "").trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("zh-Hans-CN")
    .replace(/\s+/gu, "");
}

function isQqNumber(value: string): boolean {
  return /^\d{5,12}$/u.test(value);
}

function hasCurrentMember(members: readonly NapcatGroupMember[], userId: string): boolean {
  return members.some((member) => String(member.user_id) === userId);
}

function memberNameMatches(member: NapcatGroupMember, normalizedCandidate: string): boolean {
  return [member.card, member.nickname]
    .some((name) => normalizeName(name ?? "") === normalizedCandidate);
}

function uniqueUserIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
