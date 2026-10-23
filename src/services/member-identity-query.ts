import type { AiInteractionTarget, GroupBotConfig, NapcatGroupMember } from "../types.js";

export const IDENTITY_UNCONFIRMED = "暂时无法确认这两个称呼是否指同一位群友，请明确 @ 或回复要核对的成员。";
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");

function exactAliasIds(group: GroupBotConfig, label: string): string[] {
  if (!label || /^\d+$/u.test(label)) return [];
  return [...new Set((group.manualIdentities ?? [])
    .filter(identity => identity.names.some(name => normalize(name) === normalize(label)))
    .flatMap(identity => identity.userIds))];
}

export interface MemberIdentityQuery {
  kind: "who" | "recognize" | "self" | "compare";
  label: string;
  groupScoped?: boolean;
  check?: IdentityCheck;
}

export interface MemberIdentityResolution {
  kind: MemberIdentityQuery["kind"];
  status: "resolved" | "ambiguous" | "unknown" | "conflict" | "fallback";
  source: "saved_alias" | "member_object" | "current_speaker" | "directory";
  targetIds: string[];
  reason: string;
  text: string;
  needsDirectory: boolean;
  /** Whether the caller should send the deterministic identity response. */
  handled: boolean;
}

const personPronoun = /^(?:他|她|这位|这人|这个人|这位群友)$/u;
const realTargetIds = (targets: AiInteractionTarget[], botQq: string) => [...new Set(targets
  .filter(target => target.source === "mention" || target.source === "reply")
  .flatMap(target => target.userId && target.userId !== botQq ? [target.userId] : []))];
const realMentionIds = (targets: AiInteractionTarget[], botQq: string) => [...new Set(targets
  .filter(target => target.source === "mention")
  .flatMap(target => target.userId && target.userId !== botQq ? [target.userId] : []))];

function normalizeDeicticImagePersonQuestion(text: string): string {
  return text.normalize("NFKC").trim()
    .replace(/^(?:(?:请问|请|麻烦(?:你)?|帮我|(?:你(?:帮我)?)?(?:看看|看下|看一下)|告诉我|说说|你知道)[，,：:\s]*)+/u, "")
    .replace(/[?？。!！]+$/u, "")
    .replace(/(?:吗|嘛|呢|啊|呀)$/u, "")
    .replace(/\s+/gu, "");
}

/**
 * A visual-deictic person question that should ask for a picture when no
 * image anchor exists. It deliberately excludes names, @ mentions and pronouns.
 */
export function isExplicitImagePersonQuestion(text: string): boolean {
  const value = normalizeDeicticImagePersonQuestion(text);
  return /^(?:这|这个|这位|这人|这个人)(?:是)?(?:谁|哪位|哪个)$/u.test(value) ||
    /^(?:(?:这|那)(?:张)?(?:图|图片|照片)|图|图片|照片)(?:里|中|上)?(?:的)?(?:(?:这|那)(?:个(?:人)?|位|人)?|此人|人|人物)?(?:是)?(?:谁|哪位|哪个)$/u.test(value);
}

/**
 * These phrases identify the subject by visual deixis, not by a member name.
 * They only mean "use the image" after the caller has already established a
 * same-group image anchor; on their own, they remain ordinary identity syntax.
 */
export function isDeicticImagePersonQuestion(text: string): boolean {
  return isExplicitImagePersonQuestion(text) || /^(?:他|她)(?:是)?(?:谁|哪位)$/u.test(normalizeDeicticImagePersonQuestion(text));
}

function identityLabel(text: string): { kind: "who" | "recognize"; label: string; groupScoped: boolean } | undefined {
  const value = text.normalize("NFKC").trim().replace(/[?？。!！]+$/u, "").replace(/(?:吗|嘛|呢)$/u, "").trim();
  const prefix = "(?:请问|告诉我|说说|你知道|你还记得|知道|还记得)?";
  const who = value.match(new RegExp(`^${prefix}(.{0,40}?)(?:是谁|是哪位|是哪个)$`, "u"));
  const reverse = value.match(/^(?:请问)?谁是(.{1,40})$/u);
  const recognize = value.match(/^(?:你)?(?:认识|认得)(.{1,40})$/u);
  const label = (who?.[1] ?? reverse?.[1] ?? recognize?.[1])?.trim();
  if (label === undefined) return undefined;
  const groupScoped = /^(?:群里|本群|我们群)(?:的)?/u.test(label);
  return { kind: recognize ? "recognize" : "who", label: label.replace(/^(?:群里|本群|我们群)(?:的)?/u, "").trim(), groupScoped };
}

/** A cheap syntactic check for queue routing; it never authorizes member data reads. */
export function isMemberIdentityQuerySyntax(text: string): boolean {
  return Boolean(identityLabel(text.replace(/@\d+\b/gu, "").trim()));
}

/** Saved aliases can be isolated before routing because both operands are already verified. */
export function isSavedIdentityComparisonSyntax(text: string, group: GroupBotConfig): boolean {
  const check = parseIdentityCheck(text, group, [], "");
  return Boolean(
    check && !check.fallbackReason &&
    exactAliasIds(group, check.left).length > 0 &&
    exactAliasIds(group, check.right).length > 0,
  );
}

/** Unknown unanchored names stay ordinary questions, including public figures. */
export function parseMemberIdentityQuery(text: string, group: GroupBotConfig, targets: AiInteractionTarget[], botQq: string): MemberIdentityQuery | undefined {
  if (isExplicitImagePersonQuestion(text)) return undefined;
  const check = parseIdentityCheck(text, group, targets, botQq);
  if (check) return { kind: "compare", label: check.left, check };
  const explicit = realTargetIds(targets, botQq);
  const parsed = identityLabel(text.replace(/@(\d+)\b/gu, (token, id: string) => explicit.includes(id) ? "" : token).trim());
  if (!parsed) return undefined;
  if (/^(?:我|本人|自己)$/u.test(parsed.label)) return { ...parsed, kind: "self" };
  if (!parsed.groupScoped && !personPronoun.test(parsed.label) && !exactAliasIds(group, parsed.label).length && !realTargetIds(targets, botQq).length) return undefined;
  return parsed;
}

export function resolveMemberIdentityQuery(query: MemberIdentityQuery, args: {
  group: GroupBotConfig; userId: string; targets: AiInteractionTarget[]; botQq: string;
  members?: NapcatGroupMember[]; senderCard?: string; senderNickname?: string;
}): MemberIdentityResolution {
  const { group, members = [] } = args;
  const explicit = realTargetIds(args.targets, args.botQq);
  if (query.kind === "compare") {
    const answer = answerIdentityCheck(query.check!, group, members);
    return {
      kind: query.kind,
      status: !answer.handled ? "fallback" : ["same_qq", "different_qq"].includes(answer.reason) ? "resolved" : answer.reason === "target_conflict" ? "conflict" : "ambiguous",
      source: explicit.length ? "member_object" : "saved_alias",
      ...answer,
      needsDirectory: !answer.handled && args.members === undefined && identityCheckNeedsDirectory(query.check!, group),
    };
  }
  let ids = query.kind === "self" ? [args.userId] : exactAliasIds(group, query.label);
  let source: MemberIdentityResolution["source"] = query.kind === "self" ? "current_speaker" : ids.length ? "saved_alias" : "member_object";
  const result = (status: MemberIdentityResolution["status"], reason: string, text: string, needsDirectory = false): MemberIdentityResolution =>
    ({ kind: query.kind, status, source, targetIds: ids, reason, text, needsDirectory, handled: true });
  if (ids.length > 1) return result("ambiguous", "ambiguous_saved_alias", "这个称呼对应不止一位群友，你 @ 一下要问的那位？");
  if (query.kind !== "self" && ids.length && explicit.some(id => id !== ids[0])) return result("conflict", "target_conflict", "你问的是这个外号对应的人，还是你 @ 或引用的那位？");
  if (/^\d+$/u.test(query.label)) return result("unknown", "unverified_numeric_label", "请用真实 @ 或引用消息指定成员。");
  if (!ids.length && (!query.label || personPronoun.test(query.label) || /^@\d+$/u.test(query.label))) {
    ids = /^@\d+$/u.test(query.label) ? explicit.filter(id => id === query.label.slice(1)) : explicit;
    if (ids.length !== 1) return result("ambiguous", "missing_member_object", "你指的是哪位？@ 一下或引用他的消息就行。");
  }
  if (!ids.length) {
    ids = [...new Set(members.filter(member => [member.card, member.nickname].some(name => name && normalize(name) === normalize(query.label)))
      .map(member => String(member.user_id)))];
    source = "directory";
    if (ids.length > 1) return result("ambiguous", "duplicate_platform_name", "群里不止一位用这个名字，你 @ 一下要问的那位？");
    if (!ids.length) return result("unknown", "unknown_member_name", "这个称呼还没对上具体群友，你 @ 一下那位？", members.length === 0);
    if (explicit.some(id => id !== ids[0])) return result("conflict", "target_conflict", "这个名字和你 @ 或引用的成员对不上，你问哪位？");
  }
  const identities = (group.manualIdentities ?? []).filter(identity => identity.userIds.includes(ids[0]!));
  const canonical = identities.length === 1 ? identities[0]!.names[0] : undefined;
  const member = members.find(member => String(member.user_id) === ids[0]);
  const platformName = member?.card?.trim() || member?.nickname?.trim() ||
    (query.kind === "self" ? args.senderCard?.trim() || args.senderNickname?.trim() : undefined);
  if (query.kind === "self") return result("resolved", "current_speaker", canonical || platformName ? `你是${canonical || platformName}。` : "我能确认你的发言账号，但还没拿到你的称呼。", !canonical && !platformName);
  const intro = query.kind === "recognize" ? "认识，" : "";
  if (canonical && query.label && normalize(canonical) !== normalize(query.label) && !personPronoun.test(query.label) && !/^@\d+$/u.test(query.label)) {
    return result("resolved", "saved_alias", `${intro}${query.label}就是${canonical}。`);
  }
  const label = personPronoun.test(query.label) || !query.label || /^@\d+$/u.test(query.label) ? "这位" : query.label;
  if (platformName && normalize(platformName) !== normalize(query.label)) return result("resolved", "verified_member", `${intro}${label}就是群里「${platformName}」那位。`);
  if (canonical && label === "这位") return result("resolved", "verified_member", `${intro}这位是${canonical}。`);
  if (platformName) return result("resolved", "verified_member", `${intro}${label}就是群里用「${platformName}」这个名字的成员。`);
  return result("resolved", "known_identity_without_display", `${intro}${label}这个称呼能对上人，不过他的当前群名片暂时没取到。`, true);
}

export interface IdentityCheck {
  left: string;
  right: string;
  explicitIds: string[];
  /** Only platform mention segments can authorize a literal @QQ operand. */
  mentionIds: string[];
  /** The comparison is ordinary prose and must resume the normal chat path. */
  fallbackReason?: "narrative" | "relationship_or_intent";
}

const comparisonNarrative = /[，,；;：:。]/u;
const comparisonRelationshipOrIntent = /(?:暗恋|喜欢|爱慕|讨厌|在乎|追(?:我|他|她)?|想(?:要|让|跟|我|他|她)|会不会|有没有|觉得|认为|说(?:我|他|她)?|骂(?:我|他|她)?|吊(?:我|他|她)?|配不配|能不能|愿不愿意)/u;

function stripVerifiedMentionPrefix(text: string, mentionIds: string[]): string {
  const prefix = text.match(/^(?:(?:@\d+)\s*)+/u);
  if (!prefix) return text;
  const ids = [...prefix[0].matchAll(/@(\d+)\b/gu)].map(match => match[1]!);
  if (!ids.length || ids.some(id => !mentionIds.includes(id))) return text;
  return text.slice(prefix[0].length).trim();
}

function comparisonFallbackReason(left: string, right: string, group: GroupBotConfig): IdentityCheck["fallbackReason"] {
  if (comparisonNarrative.test(left) || comparisonNarrative.test(right)) return "narrative";
  const unresolvedOperands = [left, right].filter(label => !exactAliasIds(group, label).length).join(" ");
  return comparisonRelationshipOrIntent.test(unresolvedOperands) ? "relationship_or_intent" : undefined;
}

/** Only a saved identity or a real member object can activate this lookup. */
export function parseIdentityCheck(
  text: string, group: GroupBotConfig, targets: AiInteractionTarget[], botQq: string,
): IdentityCheck | undefined {
  const explicitIds = realTargetIds(targets, botQq);
  const mentionIds = realMentionIds(targets, botQq);
  const value = stripVerifiedMentionPrefix(text.normalize("NFKC").trim(), mentionIds);
  const match = value.match(/^(?:请问|请确认|确认一下)?(.{0,30}?)(?:是不是|是否是)(.{1,30}?)(?:[?？。！!]|吗|嘛|呢)*$/u);
  if (!match) return undefined;
  const left = match[1]!.trim();
  const right = match[2]!.trim();
  if (!exactAliasIds(group, left).length && !exactAliasIds(group, right).length && !explicitIds.length) return undefined;
  const fallbackReason = comparisonFallbackReason(left, right, group);
  return { left, right, explicitIds, mentionIds, ...(fallbackReason ? { fallbackReason } : {}) };
}

export function identityCheckNeedsDirectory(check: IdentityCheck, group: GroupBotConfig): boolean {
  if (check.fallbackReason) return false;
  const anchored = (label: string) => exactAliasIds(group, label).length > 0 ||
    (label.startsWith("@") && check.mentionIds.includes(label.slice(1))) ||
    ((!label || /^(?:他|她|这位|这人|这个人|这位群友)$/u.test(label)) && check.explicitIds.length > 0);
  const cannotResolveFromDirectory = (label: string) => /^@?\d+$/u.test(label) && !check.mentionIds.includes(label.replace(/^@/u, ""));
  return [check.left, check.right].some(label => !anchored(label) && !cannotResolveFromDirectory(label));
}

export function answerIdentityCheck(check: IdentityCheck, group: GroupBotConfig, members: NapcatGroupMember[] = []) {
  const fallback = (reason: string, targetIds: string[]) => ({ handled: false, text: "", targetIds, reason });
  if (check.fallbackReason) return fallback(check.fallbackReason, check.explicitIds);
  const resolve = (label: string, left: boolean): string[] => {
    if (/^@\d+$/u.test(label) && check.mentionIds.includes(label.slice(1))) return [label.slice(1)];
    const aliases = exactAliasIds(group, label);
    // Never let a platform name silently disambiguate a duplicated saved alias.
    if (aliases.length) return aliases;
    if ((left && !label) || /^(?:他|她|这位|这人|这个人|这位群友)$/u.test(label)) return check.explicitIds;
    if (/^\d+$/u.test(label)) return [];
    return [...new Set(members.filter(member => [member.card, member.nickname]
      .some(name => name && normalize(name) === normalize(label))).map(member => String(member.user_id)))];
  };
  const left = resolve(check.left, true);
  const right = resolve(check.right, false);
  const targetIds = [...new Set([...left, ...right, ...check.explicitIds])];
  const explicitConflict = check.explicitIds.some(id => !left.includes(id) && !right.includes(id));
  if (check.explicitIds.length > 1 || explicitConflict || left.length > 1 || right.length > 1) {
    return { handled: true, text: IDENTITY_UNCONFIRMED, targetIds, reason: explicitConflict || check.explicitIds.length > 1 ? "target_conflict" : "mapping_not_unique" };
  }
  if (left.length === 0 || right.length === 0) {
    return fallback("unmatched_member", targetIds);
  }
  return {
    handled: true,
    text: left[0] === right[0] ? "是同一位群友，这两个称呼对应同一个 QQ。" : "不是同一位群友，这两个称呼对应不同的 QQ。",
    targetIds, reason: left[0] === right[0] ? "same_qq" : "different_qq",
  };
}

/** Deadline includes directory refresh; a late result is never delivered. */
export async function refreshIdentityDirectory(read: () => Promise<NapcatGroupMember[]>, timeoutMs = 3000): Promise<NapcatGroupMember[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("identity_directory_timeout")), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
