import { writeFile } from "node:fs/promises";

import type { GroupBotConfig, GroupManualIdentity, GroupsConfigFile } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

export class GroupConfigService {
  private cachedConfig?: GroupsConfigFile;

  constructor(private readonly filePath: string) {}

  async getAll(): Promise<GroupBotConfig[]> {
    const data = await this.readConfig();
    return data.groups.map((group) => normalizeGroupConfig(group));
  }

  async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
    const data = await this.readConfig();
    const group = data.groups.find((item) => item.groupId === groupId);
    return group ? normalizeGroupConfig(group) : undefined;
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

  private async readConfig(): Promise<GroupsConfigFile> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    const data = await readJsonFile<GroupsConfigFile>(this.filePath);
    this.cachedConfig = normalizeGroupsConfigFile(data);
    return this.cachedConfig;
  }

  private async writeConfig(data: GroupsConfigFile): Promise<void> {
    this.cachedConfig = data;
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeGroupsConfigFile(data: GroupsConfigFile): GroupsConfigFile {
  return {
    superAdminUserIds: Array.from(new Set(data.superAdminUserIds ?? [])),
    groups: (data.groups ?? []).map((group) => normalizeGroupConfig(group)),
  };
}

function normalizeGroupConfig(group: GroupBotConfig): GroupBotConfig {
  return {
    ...group,
    allowedSkillIds: Array.from(new Set(group.allowedSkillIds ?? [])),
    switcherUserIds: Array.from(new Set(group.switcherUserIds ?? [])),
    liveChatUserIds: Array.from(new Set(group.liveChatUserIds ?? [])),
    manualIdentities: normalizeManualIdentities(group.manualIdentities),
    liveChatDelaySeconds: normalizeDelaySeconds(group.liveChatDelaySeconds),
    liveChatDelayMinutes: normalizeDelayMinutes(group.liveChatDelayMinutes),
    dailyReportEnabled: group.dailyReportEnabled !== false,
    dailyReportTime: normalizeDailyReportTime(group.dailyReportTime),
    dailyReportTopUserCount: normalizeDailyReportTopUserCount(group.dailyReportTopUserCount),
    holidayCountdownEnabled: group.holidayCountdownEnabled !== false,
    holidayCountdownTime: normalizeHolidayCountdownTime(group.holidayCountdownTime),
    botMuted: group.botMuted === true,
    scheduledRemindersEnabled: group.scheduledRemindersEnabled !== false,
    blacklistedUserIds: normalizeUserIds(group.blacklistedUserIds),
    opsAlertsEnabled: group.opsAlertsEnabled !== false,
  };
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
      const names = Array.from(
        new Set(
          (identity.names ?? [])
            .map((name) => String(name).trim())
            .filter(Boolean),
        ),
      );
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
