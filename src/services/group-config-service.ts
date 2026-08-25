import type { GroupBotConfig, GroupManualIdentity, GroupsConfigFile, ParticipationMode, ReplyModelMode, ScheduleDateRule } from "../types.js";
import { logWarn } from "../logger.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";
import type { GroupConfigShadowWriter } from "./group-config-sqlite-shadow-repository.js";

export class GroupConfigValidationError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
  }
}

export type GroupConfigUpdateInput = Partial<Pick<
  GroupBotConfig,
  | "groupName"
  | "enabled"
  | "currentSkillId"
  | "replyModelMode"
  | "participationMode"
  | "allowedSkillIds"
  | "switcherUserIds"
  | "liveChatUserIds"
  | "roastModeUserIds"
  | "manualIdentities"
  | "liveChatDelaySeconds"
  | "dailyReportEnabled"
  | "dailyReportTime"
  | "dailyReportDateRule"
  | "dailyReportWeekdays"
  | "dailyReportTopUserCount"
  | "holidayCountdownEnabled"
  | "holidayCountdownTime"
  | "holidayCountdownDateRule"
  | "holidayCountdownWeekdays"
  | "botMuted"
  | "scheduledRemindersEnabled"
  | "blacklistedUserIds"
  | "opsAlertsEnabled"
  | "triggerKeywords"
  | "voiceReplyEnabled"
  | "defaultVoiceReplyEnabled"
  | "memoryDisabledUserIds"
  | "onlineLookupEnabled"
  | "visionEnabled"
>>;

export class GroupConfigService {
  private cachedConfig?: { data: GroupsConfigFile; loadedAt: number };
  // 跨进程生效：admin/worker 各自缓存，TTL 3s 保证后台改动 3 秒内收敛
  // （生产事故：30s 缓存导致后台"闭嘴"不生效）。
  private readonly cacheTtlMs = 3_000;

  constructor(
    private readonly filePath: string,
    private readonly shadowWriter?: GroupConfigShadowWriter,
  ) {}

  /**
   * Explicit startup/admin-maintenance sync for the Phase 1 SQLite shadow.
   * Runtime reads never call this, so GET routes remain free of shadow writes.
   */
  async syncShadowFromAuthoritative(): Promise<boolean> {
    return this.syncShadow(await this.readConfig(), "explicit_sync");
  }

  async getAll(): Promise<GroupBotConfig[]> {
    const data = await this.readConfig();
    return data.groups.map((group) => normalizeGroupConfig(group));
  }

  async getEnabledGroups(): Promise<GroupBotConfig[]> {
    const groups = await this.getAll();
    return groups.filter((group) => group.enabled !== false);
  }

  async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
    const data = await this.readConfig();
    const group = data.groups.find((item) => item.groupId === groupId);
    return group ? normalizeGroupConfig(group) : undefined;
  }

  async updateGroupConfig(groupId: string, input: GroupConfigUpdateInput): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const current = normalizeGroupConfig(data.groups[index]);
    const next = normalizeGroupConfigPatch(current, input);
    data.groups[index] = next;

    await this.writeConfig(data);
    return next;
  }

  async upsertGroupsFromNapcat(groups: Array<{ groupId: string; groupName?: string }>): Promise<GroupBotConfig[]> {
    const data = await this.readConfig();
    for (const incoming of groups) {
      const groupId = String(incoming.groupId).trim();
      if (!/^\d+$/.test(groupId)) {
        continue;
      }
      const index = data.groups.findIndex((group) => group.groupId === groupId);
      if (index >= 0) {
        const current = normalizeGroupConfig(data.groups[index]);
        data.groups[index] = normalizeGroupConfig({
          ...current,
          ...(incoming.groupName ? { groupName: incoming.groupName } : {}),
        });
        continue;
      }
      data.groups.push(normalizeGroupConfig({
        groupId,
        ...(incoming.groupName ? { groupName: incoming.groupName } : {}),
        enabled: false,
        currentSkillId: "huixian",
        allowedSkillIds: ["huixian"],
        switcherUserIds: [],
        liveChatUserIds: [],
        opsAlertsEnabled: false,
      }));
    }
    await this.writeConfig(data);
    return data.groups.map((group) => normalizeGroupConfig(group));
  }

  async updateCurrentSkill(groupId: string, skillId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    data.groups[index] = normalizeGroupConfig({
      ...data.groups[index],
      currentSkillId: skillId,
    });

    await this.writeConfig(data);
    return data.groups[index];
  }

  async updateReplyModelMode(groupId: string, mode: ReplyModelMode): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    data.groups[index] = normalizeGroupConfig({
      ...data.groups[index],
      replyModelMode: normalizeReplyModelMode(mode),
    });

    await this.writeConfig(data);
    return data.groups[index];
  }

  async addLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    if (!group.liveChatUserIds.includes(userId)) {
      group.liveChatUserIds.push(userId);
    }
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async removeLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    group.liveChatUserIds = group.liveChatUserIds.filter((item) => item !== userId);
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateLiveChatDelay(groupId: string, delayMinutes: number): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      liveChatDelayMinutes: delayMinutes,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateLiveChatDelaySeconds(groupId: string, delaySeconds: number): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      liveChatDelaySeconds: delaySeconds,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateDailyReportEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      dailyReportEnabled: enabled,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateDailyReportTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      dailyReportTime: time,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateHolidayCountdownEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      holidayCountdownEnabled: enabled,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateHolidayCountdownTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      holidayCountdownTime: time,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateBotMuted(groupId: string, muted: boolean): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      botMuted: muted,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateScheduledRemindersEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      scheduledRemindersEnabled: enabled,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateOpsAlertsEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig({
      ...data.groups[index],
      opsAlertsEnabled: enabled,
    });
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async addBlacklistedUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    group.blacklistedUserIds = Array.from(new Set([...(group.blacklistedUserIds ?? []), userId]));
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async removeBlacklistedUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    group.blacklistedUserIds = (group.blacklistedUserIds ?? []).filter((item) => item !== userId);
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async getSuperAdminUserIds(): Promise<string[]> {
    const data = await this.readConfig();
    return [...(data.superAdminUserIds ?? [])];
  }

  async isSuperAdmin(userId: string): Promise<boolean> {
    const data = await this.readConfig();
    return (data.superAdminUserIds ?? []).includes(userId);
  }

  async addAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    if (!group.switcherUserIds.includes(userId)) {
      group.switcherUserIds.push(userId);
    }
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async removeAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    group.switcherUserIds = group.switcherUserIds.filter((item) => item !== userId);
    data.groups[index] = group;

    await this.writeConfig(data);
    return group;
  }

  async updateManualIdentity(
    groupId: string,
    userId: string,
    input: { names: string[]; note?: string },
  ): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    const identities = group.manualIdentities ? [...group.manualIdentities] : [];
    const identityIndex = identities.findIndex((identity) => identity.userIds.includes(userId));
    const names = normalizeNames(input.names);
    if (names.length === 0) {
      names.push(userId);
    }
    const note = input.note?.trim();

    if (identityIndex >= 0) {
      const current = identities[identityIndex]!;
      identities[identityIndex] = {
        userIds: normalizeUserIds([...current.userIds, userId]),
        names,
        ...(note ? { note } : {}),
      };
    } else {
      identities.push({
        userIds: [userId],
        names,
        ...(note ? { note } : {}),
      });
    }

    const normalizedIdentities = normalizeManualIdentities(identities);
    assertUniqueManualIdentityUserIds(normalizedIdentities);
    group.manualIdentities = normalizedIdentities;
    data.groups[index] = group;
    await this.writeConfig(data);
    return group;
  }

  async removeManualIdentity(groupId: string, userId: string): Promise<GroupBotConfig> {
    const data = await this.readConfig();
    const index = data.groups.findIndex((group) => group.groupId === groupId);
    if (index === -1) {
      throw new Error(`Group ${groupId} is not configured.`);
    }

    const group = normalizeGroupConfig(data.groups[index]);
    group.manualIdentities = group.manualIdentities
      ?.filter((identity) => !identity.userIds.includes(userId));
    data.groups[index] = normalizeGroupConfig(group);
    await this.writeConfig(data);
    return data.groups[index]!;
  }

  invalidateCache(): void {
    this.cachedConfig = undefined;
  }

  private async readConfig(): Promise<GroupsConfigFile> {
    if (this.cachedConfig && Date.now() - this.cachedConfig.loadedAt < this.cacheTtlMs) {
      return this.cachedConfig.data;
    }

    const data = await readJsonFile<GroupsConfigFile>(this.filePath);
    this.cachedConfig = { data: normalizeGroupsConfigFile(data), loadedAt: Date.now() };
    return this.cachedConfig.data;
  }

  private async writeConfig(data: GroupsConfigFile): Promise<void> {
    this.cachedConfig = { data, loadedAt: Date.now() };
    await writeJsonFileAtomic(this.filePath, data);
    this.syncShadow(data, "json_write");
  }

  private syncShadow(data: GroupsConfigFile, reason: "explicit_sync" | "json_write"): boolean {
    if (!this.shadowWriter) {
      return false;
    }
    try {
      this.shadowWriter.syncFromAuthoritative(data);
      return true;
    } catch (error) {
      // JSON stays the only authority during the shadow phase. A SQLite
      // outage must never make a group configuration update fail or roll back.
      logWarn("Group config SQLite shadow sync failed; JSON remains authoritative.", {
        reason,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }
}

function normalizeGroupsConfigFile(data: GroupsConfigFile): GroupsConfigFile {
  return {
    superAdminUserIds: Array.from(new Set(data.superAdminUserIds ?? [])),
    groups: (data.groups ?? []).map((group) => normalizeGroupConfig(group)),
  };
}

function normalizeGroupConfig(group: GroupBotConfig): GroupBotConfig {
  const voiceReplyEnabled = group.voiceReplyEnabled === true;
  return {
    ...group,
    groupId: String(group.groupId || "").trim(),
    groupName: normalizeOptionalText(group.groupName, 80),
    enabled: group.enabled !== false,
    replyModelMode: normalizeReplyModelMode(group.replyModelMode),
    participationMode: normalizeParticipationMode(group.participationMode),
    allowedSkillIds: Array.from(new Set(group.allowedSkillIds ?? [])),
    switcherUserIds: Array.from(new Set(group.switcherUserIds ?? [])),
    liveChatUserIds: Array.from(new Set(group.liveChatUserIds ?? [])),
    roastModeUserIds: normalizeUserIds(group.roastModeUserIds),
    manualIdentities: normalizeManualIdentities(group.manualIdentities),
    liveChatDelaySeconds: normalizeDelaySeconds(group.liveChatDelaySeconds),
    liveChatDelayMinutes: normalizeDelayMinutes(group.liveChatDelayMinutes),
    dailyReportEnabled: group.dailyReportEnabled === true,
    dailyReportTime: normalizeDailyReportTime(group.dailyReportTime),
    dailyReportDateRule: normalizeDateRule(group.dailyReportDateRule),
    dailyReportWeekdays: normalizeWeekdays(group.dailyReportWeekdays),
    dailyReportTopUserCount: normalizeDailyReportTopUserCount(group.dailyReportTopUserCount),
    holidayCountdownEnabled: group.holidayCountdownEnabled === true,
    holidayCountdownTime: normalizeHolidayCountdownTime(group.holidayCountdownTime),
    holidayCountdownDateRule: normalizeDateRule(group.holidayCountdownDateRule),
    holidayCountdownWeekdays: normalizeWeekdays(group.holidayCountdownWeekdays),
    botMuted: group.botMuted === true,
    scheduledRemindersEnabled: group.scheduledRemindersEnabled === true,
    blacklistedUserIds: normalizeUserIds(group.blacklistedUserIds),
    opsAlertsEnabled: group.opsAlertsEnabled === true,
    triggerKeywords: normalizeTriggerKeywords(group.triggerKeywords),
    voiceReplyEnabled,
    defaultVoiceReplyEnabled: voiceReplyEnabled && group.defaultVoiceReplyEnabled === true,
    memoryDisabledUserIds: normalizeUserIds(group.memoryDisabledUserIds),
    onlineLookupEnabled: group.onlineLookupEnabled === true,
    visionEnabled: group.visionEnabled === true,
  };
}

function normalizeGroupConfigPatch(current: GroupBotConfig, input: GroupConfigUpdateInput): GroupBotConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GroupConfigValidationError("invalid_group_config");
  }

  const next: GroupBotConfig = { ...current };

  if ("groupName" in input) {
    next.groupName = normalizeOptionalText(input.groupName, 80);
  }
  if ("enabled" in input) {
    next.enabled = normalizeBoolean(input.enabled, "invalid_group_config");
  }
  if ("currentSkillId" in input) {
    next.currentSkillId = normalizeRequiredString(input.currentSkillId, "invalid_group_config");
  }
  if ("replyModelMode" in input) {
    next.replyModelMode = normalizeReplyModelModeStrict(input.replyModelMode);
  }
  if ("participationMode" in input) {
    next.participationMode = normalizeParticipationModeStrict(input.participationMode);
  }
  if ("allowedSkillIds" in input) {
    next.allowedSkillIds = normalizeSkillIds(input.allowedSkillIds);
  }
  if ("switcherUserIds" in input) {
    next.switcherUserIds = normalizeUserIdsStrict(input.switcherUserIds);
  }
  if ("liveChatUserIds" in input) {
    next.liveChatUserIds = normalizeUserIdsStrict(input.liveChatUserIds);
  }
  if ("roastModeUserIds" in input) {
    next.roastModeUserIds = normalizeUserIdsStrict(input.roastModeUserIds);
  }
  if ("manualIdentities" in input) {
    next.manualIdentities = normalizeManualIdentitiesStrict(input.manualIdentities);
  }
  if ("liveChatDelaySeconds" in input) {
    next.liveChatDelaySeconds = normalizePositiveInteger(input.liveChatDelaySeconds, "invalid_group_config");
    delete next.liveChatDelayMinutes;
  }
  if ("dailyReportEnabled" in input) {
    next.dailyReportEnabled = normalizeBoolean(input.dailyReportEnabled, "invalid_group_config");
  }
  if ("dailyReportTime" in input) {
    next.dailyReportTime = normalizeTimeStrict(input.dailyReportTime);
  }
  if ("dailyReportDateRule" in input) {
    next.dailyReportDateRule = normalizeDateRuleStrict(input.dailyReportDateRule);
  }
  if ("dailyReportWeekdays" in input) {
    next.dailyReportWeekdays = normalizeWeekdaysStrict(input.dailyReportWeekdays);
  }
  if ("dailyReportTopUserCount" in input) {
    next.dailyReportTopUserCount = normalizePositiveInteger(input.dailyReportTopUserCount, "invalid_group_config");
  }
  if ("holidayCountdownEnabled" in input) {
    next.holidayCountdownEnabled = normalizeBoolean(input.holidayCountdownEnabled, "invalid_group_config");
  }
  if ("holidayCountdownTime" in input) {
    next.holidayCountdownTime = normalizeTimeStrict(input.holidayCountdownTime);
  }
  if ("holidayCountdownDateRule" in input) {
    next.holidayCountdownDateRule = normalizeDateRuleStrict(input.holidayCountdownDateRule);
  }
  if ("holidayCountdownWeekdays" in input) {
    next.holidayCountdownWeekdays = normalizeWeekdaysStrict(input.holidayCountdownWeekdays);
  }
  if ("botMuted" in input) {
    next.botMuted = normalizeBoolean(input.botMuted, "invalid_group_config");
  }
  if ("scheduledRemindersEnabled" in input) {
    next.scheduledRemindersEnabled = normalizeBoolean(input.scheduledRemindersEnabled, "invalid_group_config");
  }
  if ("blacklistedUserIds" in input) {
    next.blacklistedUserIds = normalizeUserIdsStrict(input.blacklistedUserIds);
  }
  if ("opsAlertsEnabled" in input) {
    next.opsAlertsEnabled = normalizeBoolean(input.opsAlertsEnabled, "invalid_group_config");
  }
  if ("triggerKeywords" in input) {
    next.triggerKeywords = normalizeTriggerKeywordsStrict(input.triggerKeywords);
  }
  if ("voiceReplyEnabled" in input) {
    next.voiceReplyEnabled = normalizeBoolean(input.voiceReplyEnabled, "invalid_group_config");
    if (!next.voiceReplyEnabled) {
      next.defaultVoiceReplyEnabled = false;
    }
  }
  if ("defaultVoiceReplyEnabled" in input) {
    next.defaultVoiceReplyEnabled = normalizeBoolean(input.defaultVoiceReplyEnabled, "invalid_group_config");
    if (!next.voiceReplyEnabled) {
      next.defaultVoiceReplyEnabled = false;
    }
  }
  if ("memoryDisabledUserIds" in input) {
    next.memoryDisabledUserIds = normalizeUserIdsStrict(input.memoryDisabledUserIds);
  }
  if ("onlineLookupEnabled" in input) {
    next.onlineLookupEnabled = normalizeBoolean(input.onlineLookupEnabled, "invalid_group_config");
  }
  if ("visionEnabled" in input) {
    next.visionEnabled = normalizeBoolean(input.visionEnabled, "invalid_group_config");
  }

  return normalizeGroupConfig(next);
}

function normalizeOptionalText(value: unknown, limit: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : undefined;
}

function normalizeParticipationMode(value: unknown): ParticipationMode {
  return value === "mentions_only" || value === "mentions_and_keywords"
    ? value
    : value === "selected_members"
      ? "selected_members"
      : "mentions_only";
}

function normalizeParticipationModeStrict(value: unknown): ParticipationMode {
  if (value === "mentions_only" || value === "mentions_and_keywords" || value === "selected_members") {
    return value;
  }
  throw new GroupConfigValidationError("invalid_group_config");
}

function normalizeReplyModelMode(value: unknown): ReplyModelMode {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "gpt";
}

function normalizeReplyModelModeStrict(value: unknown): ReplyModelMode {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(text)) {
    return text;
  }
  throw new GroupConfigValidationError("invalid_group_config");
}

function normalizeRequiredString(value: unknown, code: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new GroupConfigValidationError(code);
  }
  return text;
}

function normalizeBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") {
    throw new GroupConfigValidationError(code);
  }
  return value;
}

function normalizePositiveInteger(value: unknown, code: string): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new GroupConfigValidationError(code);
  }
  return numberValue;
}

function normalizeTimeStrict(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{2}:\d{2}$/.test(text)) {
    throw new GroupConfigValidationError("invalid_time");
  }
  const [hourText, minuteText] = text.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new GroupConfigValidationError("invalid_time");
  }
  return text;
}

function normalizeSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new GroupConfigValidationError("invalid_group_config");
  }
  return Array.from(
    new Set(
      value
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  );
}

function normalizeDateRule(value: unknown): ScheduleDateRule {
  return value === "workday" || value === "holiday" || value === "custom" ? value : "all";
}

function normalizeDateRuleStrict(value: unknown): ScheduleDateRule {
  if (value === "all" || value === "workday" || value === "holiday" || value === "custom") {
    return value;
  }
  throw new GroupConfigValidationError("invalid_group_config");
}

function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)))
    .sort((left, right) => left - right);
}

function normalizeWeekdaysStrict(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new GroupConfigValidationError("invalid_group_config");
  }
  if (value.some((item) => !Number.isInteger(Number(item)) || Number(item) < 0 || Number(item) > 6)) {
    throw new GroupConfigValidationError("invalid_group_config");
  }
  return normalizeWeekdays(value);
}

function normalizeTriggerKeywords(value: GroupBotConfig["triggerKeywords"] | undefined): GroupBotConfig["triggerKeywords"] {
  if (!Array.isArray(value)) {
    return [{ keyword: "乘风", enabled: true }];
  }
  const normalized = value
    .map((item) => ({
      keyword: String(item?.keyword ?? "").trim().slice(0, 40),
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.keyword);
  const byKeyword = new Map<string, { keyword: string; enabled: boolean }>();
  for (const item of normalized) {
    if (!byKeyword.has(item.keyword)) {
      byKeyword.set(item.keyword, item);
    }
  }
  return [...byKeyword.values()];
}

function normalizeTriggerKeywordsStrict(value: unknown): GroupBotConfig["triggerKeywords"] {
  if (!Array.isArray(value)) {
    throw new GroupConfigValidationError("invalid_group_config");
  }
  return normalizeTriggerKeywords(value as GroupBotConfig["triggerKeywords"]);
}

function normalizeUserIdsStrict(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new GroupConfigValidationError("invalid_user_ids");
  }
  const normalized = value.map((userId) => String(userId).trim()).filter(Boolean);
  if (normalized.some((userId) => !/^\d+$/.test(userId))) {
    throw new GroupConfigValidationError("invalid_user_ids");
  }
  return Array.from(new Set(normalized));
}

function normalizeManualIdentitiesStrict(value: unknown): GroupManualIdentity[] {
  if (!Array.isArray(value)) {
    throw new GroupConfigValidationError("invalid_manual_identities");
  }

  const identities = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GroupConfigValidationError("invalid_manual_identities");
    }
    const record = item as Partial<GroupManualIdentity>;
    const userIds = normalizeManualIdentityUserIds(record.userIds);
    const names = normalizeNames(record.names);
    const note = typeof record.note === "string" ? record.note.trim() : undefined;
    if (userIds.length === 0 || names.length === 0) {
      throw new GroupConfigValidationError("invalid_manual_identities");
    }
    return {
      userIds,
      names,
      ...(note ? { note } : {}),
    };
  });

  const normalized = normalizeManualIdentities(identities) ?? [];
  assertUniqueManualIdentityUserIds(normalized);
  return normalized;
}

function assertUniqueManualIdentityUserIds(identities: GroupManualIdentity[] | undefined): void {
  const seen = new Set<string>();
  for (const identity of identities ?? []) {
    for (const userId of identity.userIds) {
      if (seen.has(userId)) {
        throw new GroupConfigValidationError("duplicate_manual_identity_user_id");
      }
      seen.add(userId);
    }
  }
}

function normalizeManualIdentityUserIds(value: unknown): string[] {
  try {
    return normalizeUserIdsStrict(value);
  } catch {
    throw new GroupConfigValidationError("invalid_manual_identities");
  }
}

function normalizeUserIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((userId) => String(userId).trim())
        .filter((userId) => /^\d+$/.test(userId)),
    ),
  );
}

function normalizeNames(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((name) => String(name).trim())
        .filter(Boolean),
    ),
  );
}

function normalizeManualIdentities(value: GroupManualIdentity[] | undefined): GroupManualIdentity[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const identities = value
    .map((identity) => {
      const userIds = Array.from(
        new Set(
          (identity.userIds ?? [])
            .map((userId) => String(userId).trim())
            .filter((userId) => /^\d+$/.test(userId)),
        ),
      );
      const names = normalizeNames(identity.names);
      const note = identity.note?.trim();

      if (userIds.length === 0 || names.length === 0) {
        return undefined;
      }

      return {
        userIds,
        names,
        ...(note ? { note } : {}),
      };
    })
    .filter((identity): identity is GroupManualIdentity => Boolean(identity));

  return identities.length > 0 ? identities : undefined;
}

function normalizeDelaySeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.max(15, Math.min(24 * 60 * 60, Math.floor(value)));
}

function normalizeDelayMinutes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 5;
  }

  return Math.max(1, Math.min(1440, Math.floor(value)));
}

function normalizeDailyReportTime(value: string | undefined): string {
  const normalized = value?.trim() ?? "17:59";
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(normalized) ? normalized : "17:59";
}

function normalizeDailyReportTopUserCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5;
  }

  return Math.max(1, Math.min(5, Math.floor(value)));
}

function normalizeHolidayCountdownTime(value: string | undefined): string {
  const normalized = value?.trim() ?? "09:00";
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(normalized) ? normalized : "09:00";
}
