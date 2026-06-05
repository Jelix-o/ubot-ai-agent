import type {
  GroupBotConfig,
  GroupManualIdentity,
  GroupMemberProfile,
  GroupMemory,
  GroupMemoryCandidate,
  NapcatGroupMember,
} from "../types.js";

export interface SubjectLabel {
  userId?: string;
  displayName: string;
  note?: string;
  label: string;
  unresolved: boolean;
}

export interface SubjectCount {
  userId: string;
  count: number;
}

export function buildGroupMemberProfiles(args: {
  groupConfig: GroupBotConfig;
  napcatMembers?: NapcatGroupMember[];
  memories?: GroupMemory[];
  candidates?: GroupMemoryCandidate[];
  memoryCounts?: SubjectCount[];
  pendingCandidateCounts?: SubjectCount[];
}): GroupMemberProfile[] {
  const profiles = new Map<string, GroupMemberProfile>();
  const disabledUserIds = new Set(args.groupConfig.memoryDisabledUserIds ?? []);

  for (const member of args.napcatMembers ?? []) {
    const userId = String(member.user_id);
    const manual = findManualIdentity(args.groupConfig.manualIdentities, userId);
    const displayName = firstNonEmpty(manual?.names[0], member.card, member.nickname, userId);
    profiles.set(userId, {
      userId,
      displayName,
      ...(member.card?.trim() ? { card: member.card.trim() } : {}),
      ...(member.nickname?.trim() ? { nickname: member.nickname.trim() } : {}),
      ...(member.role?.trim() ? { role: member.role.trim() } : {}),
      aliases: manual?.names ?? [],
      ...(manual?.note ? { note: manual.note } : {}),
      hasManualIdentity: Boolean(manual),
      memoryCount: 0,
      pendingCandidateCount: 0,
      memoryDisabled: disabledUserIds.has(userId),
    });
  }

  for (const identity of args.groupConfig.manualIdentities ?? []) {
    for (const userId of identity.userIds) {
      const existing = profiles.get(userId);
      if (existing) {
        profiles.set(userId, {
          ...existing,
          displayName: firstNonEmpty(identity.names[0], existing.displayName, userId),
          aliases: identity.names,
          ...(identity.note ? { note: identity.note } : {}),
          hasManualIdentity: true,
          memoryDisabled: disabledUserIds.has(userId),
        });
      } else {
        profiles.set(userId, {
          userId,
          displayName: firstNonEmpty(identity.names[0], userId),
          aliases: identity.names,
          ...(identity.note ? { note: identity.note } : {}),
          hasManualIdentity: true,
          memoryCount: 0,
          pendingCandidateCount: 0,
          memoryDisabled: disabledUserIds.has(userId),
        });
      }
    }
  }

  for (const memory of args.memories ?? []) {
    if (!memory.subjectUserId) {
      continue;
    }
    ensureProfile(profiles, args.groupConfig, memory.subjectUserId).memoryCount += 1;
  }

  for (const item of args.memoryCounts ?? []) {
    if (!item.userId || item.count <= 0) {
      continue;
    }
    ensureProfile(profiles, args.groupConfig, item.userId).memoryCount += item.count;
  }

  for (const candidate of args.candidates ?? []) {
    if (!candidate.subjectUserId || candidate.status !== "pending") {
      continue;
    }
    ensureProfile(profiles, args.groupConfig, candidate.subjectUserId).pendingCandidateCount += 1;
  }

  for (const item of args.pendingCandidateCounts ?? []) {
    if (!item.userId || item.count <= 0) {
      continue;
    }
    ensureProfile(profiles, args.groupConfig, item.userId).pendingCandidateCount += item.count;
  }

  return [...profiles.values()].sort((left, right) => {
    const leftActive = left.memoryCount + left.pendingCandidateCount;
    const rightActive = right.memoryCount + right.pendingCandidateCount;
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }
    return left.displayName.localeCompare(right.displayName, "zh-Hans-CN");
  });
}

export function buildSubjectLabel(
  groupConfig: GroupBotConfig,
  subjectUserId: string | undefined,
  members: GroupMemberProfile[] = [],
  type?: "member_profile" | "group_fact",
): SubjectLabel {
  if (!subjectUserId) {
    return type === "member_profile"
      ? { displayName: "未归属成员", label: "未归属成员", unresolved: true }
      : { displayName: "群整体", label: "群整体", unresolved: false };
  }

  const profile = members.find((member) => member.userId === subjectUserId);
  const manual = findManualIdentity(groupConfig.manualIdentities, subjectUserId);
  const displayName = firstNonEmpty(profile?.displayName, manual?.names[0], subjectUserId);
  const note = firstNonEmpty(profile?.note, manual?.note);
  const label = note
    ? `${displayName} / QQ ${subjectUserId} / ${note}`
    : `${displayName} / QQ ${subjectUserId}`;
  return {
    userId: subjectUserId,
    displayName,
    ...(note ? { note } : {}),
    label,
    unresolved: false,
  };
}

function ensureProfile(
  profiles: Map<string, GroupMemberProfile>,
  groupConfig: GroupBotConfig,
  userId: string,
): GroupMemberProfile {
  const existing = profiles.get(userId);
  if (existing) {
    return existing;
  }

  const manual = findManualIdentity(groupConfig.manualIdentities, userId);
  const created: GroupMemberProfile = {
    userId,
    displayName: firstNonEmpty(manual?.names[0], userId),
    aliases: manual?.names ?? [],
    ...(manual?.note ? { note: manual.note } : {}),
    hasManualIdentity: Boolean(manual),
    memoryCount: 0,
    pendingCandidateCount: 0,
    memoryDisabled: (groupConfig.memoryDisabledUserIds ?? []).includes(userId),
  };
  profiles.set(userId, created);
  return created;
}

function findManualIdentity(
  identities: GroupManualIdentity[] | undefined,
  userId: string,
): GroupManualIdentity | undefined {
  return identities?.find((identity) => identity.userIds.includes(userId));
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim()).find(Boolean) ?? "";
}
