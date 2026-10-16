import type { AiInteractionTarget, GroupBotConfig, NapcatGroupMember } from "../types.js";

export const IDENTITY_UNCONFIRMED = "暂时无法确认这两个称呼是否指同一位群友，请明确 @ 或回复要核对的成员。";
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");

function exactAliasIds(group: GroupBotConfig, label: string): string[] {
  if (!label || /^\d+$/u.test(label)) return [];
  return [...new Set((group.manualIdentities ?? [])
    .filter(identity => identity.names.some(name => normalize(name) === normalize(label)))
    .flatMap(identity => identity.userIds))];
}

export interface IdentityCheck {
  left: string;
  right: string;
  explicitIds: string[];
}

/** Only a saved identity or a real member object can activate this lookup. */
export function parseIdentityCheck(
  text: string, group: GroupBotConfig, targets: AiInteractionTarget[], botQq: string,
): IdentityCheck | undefined {
  const match = text.normalize("NFKC").trim().match(/^(?:请问|请确认|确认一下)?(.{0,30}?)(?:是不是|是否是)(.{1,30}?)(?:[?？。！!]|吗|嘛|呢)*$/u);
  if (!match) return undefined;
  const left = match[1]!.trim();
  const right = match[2]!.trim();
  const explicitIds = [...new Set(targets.flatMap(target => target.userId && target.userId !== botQq ? [target.userId] : []))];
  if (!exactAliasIds(group, left).length && !exactAliasIds(group, right).length && !explicitIds.length) return undefined;
  return { left, right, explicitIds };
}

export function identityCheckNeedsDirectory(check: IdentityCheck, group: GroupBotConfig): boolean {
  const anchored = (label: string) => exactAliasIds(group, label).length > 0 ||
    (label.startsWith("@") && check.explicitIds.includes(label.slice(1))) ||
    ((!label || /^(?:他|她|这位|这人|这个人|这位群友)$/u.test(label)) && check.explicitIds.length === 1);
  return !anchored(check.left) || !anchored(check.right);
}

export function answerIdentityCheck(check: IdentityCheck, group: GroupBotConfig, members: NapcatGroupMember[] = []) {
  const resolve = (label: string, left: boolean): string[] => {
    if (/^@\d+$/u.test(label) && check.explicitIds.includes(label.slice(1))) return [label.slice(1)];
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
  if (left.length !== 1 || right.length !== 1 || explicitConflict) {
    return { text: IDENTITY_UNCONFIRMED, targetIds, reason: explicitConflict ? "target_conflict" : "mapping_not_unique" };
  }
  return {
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
