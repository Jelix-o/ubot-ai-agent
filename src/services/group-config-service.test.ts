import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupsConfigFile } from "../types.js";
import { GroupConfigService } from "./group-config-service.js";

async function withService<T>(data: GroupsConfigFile, run: (service: GroupConfigService) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-config-service-"));
  const filePath = path.join(dir, "groups.json");

  try {
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return await run(new GroupConfigService(filePath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("group config defaults and normalizes blacklisted user ids", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
          roastModeUserIds: ["20003", "bad", "20003", " 20004 "],
          blacklistedUserIds: ["20001", "bad", "20001", " 20002 "],
        },
        {
          groupId: "67891",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
        },
      ],
    },
    async (service) => {
      assert.deepEqual((await service.getGroup("67890"))?.blacklistedUserIds, ["20001", "20002"]);
      assert.deepEqual((await service.getGroup("67890"))?.roastModeUserIds, ["20003", "20004"]);
      assert.deepEqual((await service.getGroup("67891"))?.blacklistedUserIds, []);
      assert.deepEqual((await service.getGroup("67891"))?.roastModeUserIds, []);
      assert.equal((await service.getGroup("67890"))?.replyModelMode, "gpt");
      assert.equal((await service.getGroup("67890"))?.defaultVoiceReplyEnabled, false);
    },
  );
});

test("group config updates reply model mode", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
        },
      ],
    },
    async (service) => {
      assert.equal((await service.getGroup("67890"))?.replyModelMode, "gpt");
      assert.equal((await service.updateReplyModelMode("67890", "mimo")).replyModelMode, "mimo");
      assert.equal((await service.getGroup("67890"))?.replyModelMode, "mimo");
      assert.equal((await service.updateReplyModelMode("67890", "gpt")).replyModelMode, "gpt");
      assert.equal((await service.updateReplyModelMode("67890", "reply-pro")).replyModelMode, "reply-pro");
    },
  );
});

test("group config updates full editable config with validation", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
        },
      ],
    },
    async (service) => {
      const updated = await service.updateGroupConfig("67890", {
        currentSkillId: "zxp",
        replyModelMode: "mimo",
        allowedSkillIds: ["zxp", "zxp", "assistant"],
        switcherUserIds: ["10001", "10001"],
        liveChatUserIds: ["20001"],
        roastModeUserIds: ["20002", "20002"],
        manualIdentities: [{ userIds: ["20001"], names: ["Tester"], note: "note" }],
        liveChatDelaySeconds: 30,
        dailyReportEnabled: false,
        dailyReportTime: "18:05",
        dailyReportDateRule: "custom",
        dailyReportWeekdays: [1, 3, 1],
        dailyReportTopUserCount: 5,
        holidayCountdownEnabled: false,
        holidayCountdownTime: "09:30",
        holidayCountdownDateRule: "workday",
        holidayCountdownWeekdays: [6],
        botMuted: true,
        scheduledRemindersEnabled: false,
        defaultVoiceReplyEnabled: true,
        blacklistedUserIds: ["30001"],
        opsAlertsEnabled: false,
      });

      assert.equal(updated.currentSkillId, "zxp");
      assert.equal(updated.replyModelMode, "mimo");
      assert.deepEqual(updated.allowedSkillIds, ["zxp", "assistant"]);
      assert.deepEqual(updated.switcherUserIds, ["10001"]);
      assert.deepEqual(updated.liveChatUserIds, ["20001"]);
      assert.deepEqual(updated.roastModeUserIds, ["20002"]);
      assert.equal(updated.liveChatDelaySeconds, 30);
      assert.equal(updated.dailyReportEnabled, false);
      assert.equal(updated.dailyReportTime, "18:05");
      assert.equal(updated.dailyReportDateRule, "custom");
      assert.deepEqual(updated.dailyReportWeekdays, [1, 3]);
      assert.equal(updated.dailyReportTopUserCount, 5);
      assert.equal(updated.holidayCountdownEnabled, false);
      assert.equal(updated.holidayCountdownTime, "09:30");
      assert.equal(updated.holidayCountdownDateRule, "workday");
      assert.deepEqual(updated.holidayCountdownWeekdays, [6]);
      assert.equal(updated.botMuted, true);
      assert.equal(updated.scheduledRemindersEnabled, false);
      assert.equal(updated.defaultVoiceReplyEnabled, true);
      assert.deepEqual(updated.blacklistedUserIds, ["30001"]);
      assert.equal(updated.opsAlertsEnabled, false);
      assert.deepEqual(updated.manualIdentities?.[0], { userIds: ["20001"], names: ["Tester"], note: "note" });

      await assert.rejects(
        () => service.updateGroupConfig("67890", { dailyReportTime: "24:00" }),
        { code: "invalid_time" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { dailyReportDateRule: "bad" as never }),
        { code: "invalid_group_config" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { holidayCountdownWeekdays: [1, 8] }),
        { code: "invalid_group_config" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { switcherUserIds: ["bad"] }),
        { code: "invalid_user_ids" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { roastModeUserIds: ["bad"] }),
        { code: "invalid_user_ids" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { replyModelMode: "../bad" }),
        { code: "invalid_group_config" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { manualIdentities: [{ userIds: ["20001"], names: [] }] }),
        { code: "invalid_manual_identities" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { manualIdentities: [{ userIds: ["bad"], names: ["Tester"] }] }),
        { code: "invalid_manual_identities" },
      );
    },
  );
});

test("group config keeps default voice reply as a child switch of voice reply", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
          voiceReplyEnabled: false,
          defaultVoiceReplyEnabled: true,
        },
      ],
    },
    async (service) => {
      const normalized = await service.getGroup("67890");
      assert.equal(normalized?.voiceReplyEnabled, false);
      assert.equal(normalized?.defaultVoiceReplyEnabled, false);

      const defaultOn = await service.updateGroupConfig("67890", { defaultVoiceReplyEnabled: true });
      assert.equal(defaultOn.voiceReplyEnabled, false);
      assert.equal(defaultOn.defaultVoiceReplyEnabled, false);

      const voiceOn = await service.updateGroupConfig("67890", { voiceReplyEnabled: true, defaultVoiceReplyEnabled: true });
      assert.equal(voiceOn.voiceReplyEnabled, true);
      assert.equal(voiceOn.defaultVoiceReplyEnabled, true);

      const voiceOff = await service.updateGroupConfig("67890", { voiceReplyEnabled: false });
      assert.equal(voiceOff.voiceReplyEnabled, false);
      assert.equal(voiceOff.defaultVoiceReplyEnabled, false);
    },
  );
});

test("group config adds and removes blacklisted users", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
        },
      ],
    },
    async (service) => {
      assert.deepEqual((await service.addBlacklistedUser("67890", "20001")).blacklistedUserIds, ["20001"]);
      assert.deepEqual((await service.addBlacklistedUser("67890", "20001")).blacklistedUserIds, ["20001"]);
      assert.deepEqual((await service.addBlacklistedUser("67890", "20002")).blacklistedUserIds, ["20001", "20002"]);
      assert.deepEqual((await service.removeBlacklistedUser("67890", "20001")).blacklistedUserIds, ["20002"]);
    },
  );
});
