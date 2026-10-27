import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GroupsConfigFile } from "../types.js";
import { GroupConfigService, GroupConfigValidationError } from "./group-config-service.js";
import type { GroupConfigShadowWriter } from "./group-config-sqlite-shadow-repository.js";

test("manual names replace primary and aliases without resurrecting old names after directory refresh", async () => {
  await withService({ groups: [{ groupId: "67890", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], manualIdentities: [{ userIds: ["2458031445"], names: ["外包仔", "外包仙人"], note: "原备注" }] }] }, async service => {
    await service.updateManualIdentity("67890", "2458031445", { names: ["外包仙人"], note: "描述性备注" });
    assert.deepEqual((await service.getGroup("67890"))?.manualIdentities?.[0]?.names, ["外包仙人"]);
    await service.upsertGroupsFromNapcat([{ groupId: "67890", groupName: "原群名片仍旧" }]);
    assert.deepEqual((await service.getGroup("67890"))?.manualIdentities?.[0], { userIds: ["2458031445"], names: ["外包仙人"], note: "描述性备注" });
    await service.updateManualIdentity("67890", "2458031445", { names: ["外包仙人", "外包仔"] });
    assert.deepEqual((await service.getGroup("67890"))?.manualIdentities?.[0]?.names, ["外包仙人", "外包仔"]);
    await service.updateManualIdentity("67890", "2458031445", { names: ["外包仙人"] });
    assert.deepEqual((await service.getGroup("67890"))?.manualIdentities?.[0]?.names, ["外包仙人"]);
  });
});

test("old and new groups default to global while explicit super-admin overrides can resume following", async () => {
  await withService({ groups: [{ groupId: "67890", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], replyModelMode: "ds" }] }, async service => {
    assert.equal((await service.getGroup("67890"))?.replyModelSource, "global");
    await service.upsertGroupsFromNapcat([{ groupId: "100200" }]);
    assert.equal((await service.getGroup("100200"))?.replyModelSource, "global");
    assert.equal((await service.updateReplyModelMode("100200", "gpt")).replyModelSource, "override");
    assert.equal((await service.updateGroupConfig("100200", { replyModelSource: "global" })).replyModelSource, "global");
    assert.equal((await service.getGroup("67890"))?.replyModelMode, "ds");
  });
});

test("daily report count accepts 1 through 20, survives reload and preserves other groups", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-report-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "groups.json");
  const group = { groupId: "67890", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [] };
  await writeFile(filePath, JSON.stringify({ groups: [
    { ...group, dailyReportTopUserCount: 3 },
    { ...group, groupId: "100200", dailyReportTopUserCount: 5 },
    { ...group, groupId: "300400" },
  ] }));
  const service = new GroupConfigService(filePath);
  assert.equal((await service.getGroup("67890"))?.dailyReportTopUserCount, 3);
  assert.equal((await service.getGroup("300400"))?.dailyReportTopUserCount, 5);
  for (const count of [1, 6, 20]) {
    assert.equal((await service.updateGroupConfig("67890", { dailyReportTopUserCount: count })).dailyReportTopUserCount, count);
    assert.equal((await new GroupConfigService(filePath).getGroup("67890"))?.dailyReportTopUserCount, count);
  }
  for (const count of [0, -1, 21, 1.5, NaN, Infinity]) {
    await assert.rejects(service.updateGroupConfig("67890", { dailyReportTopUserCount: count }),
      (error: unknown) => error instanceof GroupConfigValidationError && error.code === "invalid_group_config");
    assert.equal((await new GroupConfigService(filePath).getGroup("67890"))?.dailyReportTopUserCount, 20);
  }
  assert.equal((await service.getGroup("100200"))?.dailyReportTopUserCount, 5);
  assert.equal((await service.getGroup("300400"))?.dailyReportTopUserCount, 5);
});

async function withService<T>(
  data: GroupsConfigFile,
  run: (service: GroupConfigService) => Promise<T>,
  shadowWriter?: GroupConfigShadowWriter,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-config-service-"));
  const filePath = path.join(dir, "groups.json");

  try {
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return await run(new GroupConfigService(filePath, shadowWriter));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("group config mirrors only after an explicit sync or a successful JSON write", async () => {
  const snapshots: GroupsConfigFile[] = [];
  const shadowWriter: GroupConfigShadowWriter = {
    syncFromAuthoritative(config) {
      snapshots.push(JSON.parse(JSON.stringify(config)) as GroupsConfigFile);
      return { status: "created", snapshotHash: "test", groupCount: config.groups.length };
    },
  };
  await withService(
    {
      groups: [{
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: [],
        liveChatUserIds: [],
      }],
    },
    async (service) => {
      await service.getAll();
      assert.equal(snapshots.length, 0, "ordinary configuration reads must not write the shadow");

      assert.equal(await service.syncShadowFromAuthoritative(), true);
      assert.equal(snapshots.length, 1);

      await service.updateBotMuted("67890", true);
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[1]?.groups[0]?.botMuted, true);
    },
    shadowWriter,
  );
});

test("SQLite shadow failure cannot prevent a JSON group configuration update", async () => {
  const failingShadowWriter: GroupConfigShadowWriter = {
    syncFromAuthoritative() {
      throw new Error("sqlite_unavailable");
    },
  };
  await withService(
    {
      groups: [{
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: [],
        liveChatUserIds: [],
      }],
    },
    async (service) => {
      assert.equal((await service.updateBotMuted("67890", true)).botMuted, true);
      assert.equal((await service.getGroup("67890"))?.botMuted, true);
    },
    failingShadowWriter,
  );
});

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
          blacklistedUserIds: ["20001", "bad", "20001", " 20002 "],
          ...({ roastModeUserIds: ["20003"] } as Record<string, unknown>),
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
      assert.deepEqual((await service.getGroup("67891"))?.blacklistedUserIds, []);
      assert.equal(Object.hasOwn((await service.getGroup("67890")) ?? {}, "roastModeUserIds"), false);
      assert.equal((await service.getGroup("67890"))?.replyModelMode, "gpt");
      assert.equal((await service.getGroup("67890"))?.dailyReportEnabled, false);
      assert.equal((await service.getGroup("67890"))?.holidayCountdownEnabled, false);
      assert.equal((await service.getGroup("67890"))?.scheduledRemindersEnabled, false);
      assert.equal(Object.hasOwn((await service.getGroup("67890")) ?? {}, "voiceReplyEnabled"), false);
      assert.equal(Object.hasOwn((await service.getGroup("67890")) ?? {}, "defaultVoiceReplyEnabled"), false);
      assert.equal((await service.getGroup("67890"))?.opsAlertsEnabled, false);
      assert.equal((await service.getGroup("67890"))?.onlineLookupEnabled, false);
      assert.equal((await service.getGroup("67890"))?.visionEnabled, true);
      assert.equal((await service.getGroup("67890"))?.ambientGroupContextEnabled, true);
      assert.equal((await service.getGroup("67890"))?.naturalImageRequestsEnabled, true);
      assert.equal((await service.getGroup("67890"))?.imageGenerationEnabled, true);
      assert.equal((await service.getGroup("67890"))?.participationMode, "mentions_only");

      const enabled = await service.updateGroupConfig("67891", {
        dailyReportEnabled: true,
        holidayCountdownEnabled: true,
        scheduledRemindersEnabled: true,
        opsAlertsEnabled: true,
        onlineLookupEnabled: true,
        visionEnabled: false,
        ambientGroupContextEnabled: false,
        naturalImageRequestsEnabled: false,
      });
      assert.equal(enabled.dailyReportEnabled, true);
      assert.equal(enabled.holidayCountdownEnabled, true);
      assert.equal(enabled.scheduledRemindersEnabled, true);
      assert.equal(Object.hasOwn(enabled, "voiceReplyEnabled"), false);
      assert.equal(Object.hasOwn(enabled, "defaultVoiceReplyEnabled"), false);
      assert.equal(enabled.opsAlertsEnabled, true);
      assert.equal(enabled.onlineLookupEnabled, true);
      assert.equal(enabled.visionEnabled, false);
      assert.equal(enabled.ambientGroupContextEnabled, false);
      assert.equal(enabled.naturalImageRequestsEnabled, false);
      assert.equal(enabled.imageGenerationEnabled, true);
      const legacyPatch = await service.updateGroupConfig("67891", {
        imageGenerationEnabled: false,
      } as unknown as Parameters<typeof service.updateGroupConfig>[1]);
      assert.equal(legacyPatch.imageGenerationEnabled, true);
    },
  );
});

test("NapCat bootstrap uses the packaged huixian skill and inactive broadcasts", async () => {
  await withService(
    { groups: [] },
    async (service) => {
      const groups = await service.upsertGroupsFromNapcat([{ groupId: "67890", groupName: "New group" }]);
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0]?.allowedSkillIds, ["huixian"]);
      assert.equal(groups[0]?.currentSkillId, "huixian");
      assert.equal(groups[0]?.enabled, false);
      assert.equal(groups[0]?.opsAlertsEnabled, false);
      assert.equal(groups[0]?.visionEnabled, true);
      assert.equal(groups[0]?.naturalImageRequestsEnabled, true);
      assert.equal(groups[0]?.imageGenerationEnabled, true);
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
        participationMode: "mentions_only",
        allowedSkillIds: ["zxp", "zxp", "assistant"],
        switcherUserIds: ["10001", "10001"],
        liveChatUserIds: ["20001"],
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
        blacklistedUserIds: ["30001"],
        opsAlertsEnabled: false,
        onlineLookupEnabled: false,
        visionEnabled: true,
        ambientGroupContextEnabled: false,
        naturalImageRequestsEnabled: false,
      });

      assert.equal(updated.currentSkillId, "huixian");
      assert.equal(updated.replyModelMode, "mimo");
      assert.equal(updated.participationMode, "mentions_only");
      assert.deepEqual(updated.allowedSkillIds, ["huixian"]);
      assert.deepEqual(updated.switcherUserIds, ["10001"]);
      assert.deepEqual(updated.liveChatUserIds, ["20001"]);
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
      assert.equal(Object.hasOwn(updated, "voiceReplyEnabled"), false);
      assert.equal(Object.hasOwn(updated, "defaultVoiceReplyEnabled"), false);
      assert.deepEqual(updated.blacklistedUserIds, ["30001"]);
      assert.equal(updated.opsAlertsEnabled, false);
      assert.equal(updated.onlineLookupEnabled, false);
      assert.equal(updated.visionEnabled, true);
      assert.equal(updated.ambientGroupContextEnabled, false);
      assert.equal(updated.naturalImageRequestsEnabled, false);
      assert.equal(updated.imageGenerationEnabled, true);
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
        () => service.updateGroupConfig("67890", { roastModeUserIds: ["20002"] } as never),
        { code: "roast_mode_retired", statusCode: 410 },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { replyModelMode: "../bad" }),
        { code: "invalid_group_config" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { participationMode: "noisy" as never }),
        /invalid_group_config/,
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { naturalImageRequestsEnabled: "invalid" as never }),
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
      await assert.rejects(
        () => service.updateGroupConfig("67890", {
          manualIdentities: [
            { userIds: ["20001"], names: ["季博神"] },
            { userIds: ["20001"], names: ["季博初"] },
          ],
        }),
        { code: "duplicate_manual_identity_user_id" },
      );
    },
  );
});

test("group config strips retired voice switches on read and rejects them on update", async () => {
  await withService(
    {
      groups: [
        {
          groupId: "67890",
          currentSkillId: "assistant",
          allowedSkillIds: ["assistant"],
          switcherUserIds: [],
          liveChatUserIds: [],
          ...({
            voiceReplyEnabled: false,
            defaultVoiceReplyEnabled: true,
          } as Record<string, unknown>),
        } as GroupsConfigFile["groups"][number],
      ],
    },
    async (service) => {
      const normalized = await service.getGroup("67890");
      assert.equal(Object.hasOwn(normalized ?? {}, "voiceReplyEnabled"), false);
      assert.equal(Object.hasOwn(normalized ?? {}, "defaultVoiceReplyEnabled"), false);

      await assert.rejects(
        () => service.updateGroupConfig("67890", { voiceReplyEnabled: true } as never),
        { code: "voice_feature_retired" },
      );
      await assert.rejects(
        () => service.updateGroupConfig("67890", { defaultVoiceReplyEnabled: true } as never),
        { code: "voice_feature_retired" },
      );
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
