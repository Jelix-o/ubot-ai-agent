import { writeFile } from "node:fs/promises";

import type { GroupBotConfig, GroupsConfigFile } from "../types.js";
import { readJsonFile } from "../utils/json-file.js";

export class GroupConfigService {
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
    const data = await readJsonFile<GroupsConfigFile>(this.filePath);
    return normalizeGroupsConfigFile(data);
  }

  private async writeConfig(data: GroupsConfigFile): Promise<void> {
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
    liveChatDelaySeconds: normalizeDelaySeconds(group.liveChatDelaySeconds),
    liveChatDelayMinutes: normalizeDelayMinutes(group.liveChatDelayMinutes),
    dailyReportEnabled: group.dailyReportEnabled !== false,
    dailyReportTime: normalizeDailyReportTime(group.dailyReportTime),
    dailyReportTopUserCount: normalizeDailyReportTopUserCount(group.dailyReportTopUserCount),
    holidayCountdownEnabled: group.holidayCountdownEnabled !== false,
    holidayCountdownTime: normalizeHolidayCountdownTime(group.holidayCountdownTime),
  };
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
