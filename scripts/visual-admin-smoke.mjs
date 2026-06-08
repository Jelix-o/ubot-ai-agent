import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { WebSocket } from "ws";

import { AdminHttpServer } from "../dist/admin-http-server.js";
import { AdminOperationLogService } from "../dist/services/admin-operation-log-service.js";
import { AdminTaskStore } from "../dist/services/admin-task-store.js";
import { GroupConfigService } from "../dist/services/group-config-service.js";
import { GroupMemoryCandidateService } from "../dist/services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "../dist/services/group-memory-candidate-store.js";
import { GroupMemoryStore } from "../dist/services/group-memory-store.js";
import { KnowledgeBaseStore } from "../dist/services/knowledge-base-store.js";
import { ProfileRecordStore } from "../dist/services/profile-record-store.js";
import { ModelHealthHistoryStore } from "../dist/services/model-health-history-store.js";
import { ScheduledReminderService } from "../dist/services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "../dist/services/scheduled-reminder-store.js";
import { SkillService } from "../dist/services/skill-service.js";
import { SystemSettingsStore } from "../dist/services/system-settings-store.js";

const chromeExe = process.env.CHROME_EXE
  || path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1223", "chrome-win64", "chrome.exe");
const snapshotsDir = path.resolve("release", "admin-ui-smoke");

await mkdir(snapshotsDir, { recursive: true });

const tmp = await mkdtemp(path.join(os.tmpdir(), "ubot-admin-smoke-"));
let service;
const screenshotWarnings = [];

try {
  const groupsPath = path.join(tmp, "groups.json");
  await writeFile(groupsPath, JSON.stringify({
    superAdminUserIds: ["99999"],
    groups: [{
      groupId: "866209871",
      groupName: "UBot Test Group",
      enabled: true,
      currentSkillId: "assistant",
      replyModelMode: "gpt",
      allowedSkillIds: ["assistant", "daily_report", "holiday_countdown", "scheduled_reminder"],
      switcherUserIds: ["99999", "123456789"],
      liveChatUserIds: ["234567890"],
      manualIdentities: [{
        userIds: ["3951154629"],
        names: ["Member A", "Operator A"],
        note: "Group operator identity for smoke testing.",
      }],
      liveChatDelaySeconds: 3,
      dailyReportEnabled: true,
      dailyReportTime: "10:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:30",
      botMuted: false,
      scheduledRemindersEnabled: true,
      blacklistedUserIds: ["987654321"],
      opsAlertsEnabled: true,
      triggerKeywords: [{ keyword: "bot", enabled: true }],
      voiceReplyEnabled: true,
      defaultVoiceReplyEnabled: true,
      memoryDisabledUserIds: [],
    }, {
      groupId: "777888999",
      groupName: "Viewer Second Group",
      enabled: true,
      currentSkillId: "assistant",
      replyModelMode: "gpt",
      allowedSkillIds: ["assistant"],
      switcherUserIds: [],
      liveChatUserIds: [],
      manualIdentities: [{
        userIds: ["3951154629"],
        names: ["Member A Second Group"],
        note: "Same QQ belongs to a second enabled group.",
      }],
      liveChatDelaySeconds: 3,
      dailyReportEnabled: false,
      dailyReportTime: "10:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: false,
      holidayCountdownTime: "09:30",
      botMuted: false,
      scheduledRemindersEnabled: true,
      blacklistedUserIds: [],
      opsAlertsEnabled: true,
      triggerKeywords: [],
      voiceReplyEnabled: true,
      defaultVoiceReplyEnabled: false,
      memoryDisabledUserIds: [],
    }, {
      groupId: "100200300",
      groupName: "Hidden Test Group",
      enabled: false,
      currentSkillId: "assistant",
      replyModelMode: "gpt",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      manualIdentities: [],
      liveChatDelaySeconds: 3,
      dailyReportEnabled: false,
      dailyReportTime: "10:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: false,
      holidayCountdownTime: "09:30",
      botMuted: true,
      scheduledRemindersEnabled: false,
      blacklistedUserIds: [],
      opsAlertsEnabled: false,
      triggerKeywords: [],
      voiceReplyEnabled: false,
      memoryDisabledUserIds: [],
    }],
  }, null, 2), "utf8");

  const memoryStore = new GroupMemoryStore(path.join(tmp, "memory.json"));
  const candidateStore = new GroupMemoryCandidateStore(path.join(tmp, "candidates.json"));
  const knowledgeStore = new KnowledgeBaseStore(path.join(tmp, "knowledge.json"));
  const hiddenDirectAccessFixtures = {};
  const skillsDir = path.join(tmp, "skills");
  await mkdir(skillsDir, { recursive: true });

  await writeFile(path.join(skillsDir, "assistant.json"), JSON.stringify({
    id: "assistant",
    name: "Default Assistant",
    systemPrompt: "Reply clearly and briefly.",
    styleRules: ["Use concise Chinese in production.", "Avoid long replies."],
    knowledge: ["Group FAQ first."],
    temperature: 0.7,
    maxContextTurns: 12,
  }, null, 2), "utf8");
  await writeFile(path.join(skillsDir, "daily_report.json"), JSON.stringify({
    id: "daily_report",
    name: "Daily Report Assistant",
    systemPrompt: "Summarize group activity.",
    styleRules: ["List key points."],
    knowledge: [],
    temperature: 0.5,
    maxContextTurns: 8,
  }, null, 2), "utf8");

  const members = [
    ["3951154629", "Member A", "admin"],
    ["1203344556", "Member B", "member"],
    ["2345566778", "Member C", "member"],
    ["9876543210", "Member D", "member"],
    ["4567890123", "Member E", "member"],
    ["6789012345", "Member F", "member"],
    ["7890123456", "Member G", "member"],
    ["9012345678", "Member H", "member"],
    ["1122334455", "Member I", "member"],
    ["2233445566", "Member J", "member"],
  ];
  const now = "2026-06-04T10:30:00.000Z";

  for (const [index, [userId, name]] of members.entries()) {
    await memoryStore.create({
      groupId: "866209871",
      type: "member_profile",
      subjectUserId: userId,
      title: index === 0 ? "Preference: simple meals" : `Profile: ${name}`,
      content: index === 0
        ? "Member A prefers simple meals and stable work routines."
        : `${name} participates steadily in group discussions about tools, plans, and shared documents.`,
      confidence: 0.82 + (index % 4) * 0.03,
      createdAt: now,
      evidence: {
        startAt: "2026-06-03T09:00:00.000Z",
        endAt: "2026-06-03T10:00:00.000Z",
        messageCount: 6 + index,
        speakers: [{ userId, userName: name }],
        summary: `${name} expressed preferences and recent plans in group chat.`,
      },
    });
  }

  await memoryStore.create({
    groupId: "866209871",
    type: "group_fact",
    title: "Group discusses AI tools and automation",
    content: "Members often discuss AI tools, document processing, reminders, and learning resources.",
    confidence: 0.9,
    createdAt: "2026-06-04T09:30:00.000Z",
  });
  await memoryStore.create({
    groupId: "777888999",
    type: "member_profile",
    subjectUserId: "3951154629",
    title: "Second group profile for Member A",
    content: "Member A also participates in the second enabled group and should see its read-only data.",
    confidence: 0.88,
    createdAt: "2026-06-04T10:31:00.000Z",
  });
  hiddenDirectAccessFixtures.memory = await memoryStore.create({
    groupId: "100200300",
    type: "group_fact",
    title: "Hidden group memory must never leak",
    content: "This hidden group memory exists only to catch access-control leaks.",
    confidence: 0.91,
    createdAt: "2026-06-04T10:32:00.000Z",
  });

  for (const [index, title] of [
    "User wants breakfast options with more protein",
    "User reports AI image generation is slow",
    "Group regularly shares learning materials",
    "User asks how to configure automatic replies",
    "Group discusses connecting a third-party payment provider",
  ].entries()) {
    await candidateStore.addCandidate({
      groupId: "866209871",
      type: index % 2 === 0 ? "member_profile" : "group_fact",
      subjectUserId: index % 2 === 0 ? members[index]?.[0] : undefined,
      title,
      content: `${title}; this candidate should be reviewed before entering long-term memory.`,
      confidence: 0.73 + index * 0.05,
      evidence: {
        startAt: "2026-06-04T08:00:00.000Z",
        endAt: "2026-06-04T08:10:00.000Z",
        messageCount: 3,
        speakers: [{ userId: members[index]?.[0] ?? "0", userName: members[index]?.[1] ?? "Member" }],
        summary: `Evidence summary for ${title}.`,
      },
    });
  }
  await candidateStore.addCandidate({
    groupId: "777888999",
    type: "member_profile",
    subjectUserId: "3951154629",
    title: "Second group candidate for viewer",
    content: "This second-group candidate should appear only when the viewer explicitly scopes to the second group.",
    confidence: 0.86,
  });
  hiddenDirectAccessFixtures.candidate = await candidateStore.addCandidate({
    groupId: "100200300",
    type: "group_fact",
    title: "Hidden group candidate must never leak",
    content: "This hidden candidate exists only to catch access-control leaks.",
    confidence: 0.84,
  });

  for (const item of [
    ["How do I reset my password?", "password reset,forgot password", "Ask an administrator to reset the password."],
    ["Which payment methods are supported?", "payment,checkout", "Supported methods depend on administrator configuration."],
    ["When is the bot online?", "working hours,online time", "The bot is online all day by default."],
  ]) {
    await knowledgeStore.create({
      groupId: "866209871",
      title: item[0],
      question: item[0],
      answer: item[2],
      keywords: item[1].split(","),
      enabled: true,
    });
  }
  await knowledgeStore.create({
    groupId: "777888999",
    title: "Second group read-only FAQ",
    question: "Can ordinary users see this second group?",
    answer: "Yes, when the QQ account is a member of the enabled group.",
    keywords: ["viewer", "second-group"],
    enabled: true,
  });
  await knowledgeStore.create({
    groupId: "100200300",
    title: "Hidden group FAQ must never leak",
    question: "Can hidden group knowledge leak?",
    answer: "No. This entry exists only to catch access-control leaks.",
    keywords: ["hidden-group"],
    enabled: true,
  });

  const scheduledReminderStore = new ScheduledReminderStore(path.join(tmp, "reminders.json"));
  for (const task of [
    { topic: "喝水提醒", scheduledTime: "10:00", advanceMinutes: 60, dateRule: "workday", enabled: true },
    { topic: "整理日报", scheduledTime: "17:45", advanceMinutes: 15, dateRule: "all", enabled: true },
    { topic: "周会提醒", scheduledTime: "09:30", advanceMinutes: 30, dateRule: "custom", weekdays: [1, 3, 5], enabled: false },
    { topic: "午休提醒", scheduledTime: "12:20", advanceMinutes: 10, dateRule: "workday", enabled: true },
  ]) {
    await scheduledReminderStore.addTask({
      groupId: "866209871",
      creatorUserId: "99999",
      intervalMinutes: Math.max(1, task.advanceMinutes),
      topic: task.topic,
      scheduledTime: task.scheduledTime,
      advanceMinutes: task.advanceMinutes,
      dateRule: task.dateRule,
      weekdays: task.weekdays || [],
      enabled: task.enabled,
      now: new Date(now),
    });
  }

  const adminTaskStore = new AdminTaskStore(path.join(tmp, "admin-tasks.json"));
  const smokeTask = await adminTaskStore.create({
    type: "profile-generate",
    title: "画像生成 3951154629",
    groupId: "866209871",
    subjectUserId: "3951154629",
    operatorUserId: "99999",
    detail: "overall",
  });
  await adminTaskStore.update(smokeTask.id, {
    status: "succeeded",
    progress: 100,
    startedAt: "2026-06-04T10:00:00.000Z",
    finishedAt: "2026-06-04T10:00:02.000Z",
    durationMs: 2000,
    result: { recordId: "profile-smoke", sourceMemoryCount: 4 },
  });
  const viewerSecondGroupTask = await adminTaskStore.create({
    type: "profile-generate",
    title: "画像生成 second group viewer",
    groupId: "777888999",
    subjectUserId: "3951154629",
    operatorUserId: "99999",
    detail: "overall",
  });
  await adminTaskStore.update(viewerSecondGroupTask.id, {
    status: "succeeded",
    progress: 100,
    startedAt: "2026-06-04T10:00:10.000Z",
    finishedAt: "2026-06-04T10:00:12.000Z",
    durationMs: 2000,
    result: { recordId: "profile-smoke-second-group", sourceMemoryCount: 1 },
  });
  const modelTask = await adminTaskStore.create({
    type: "model-check",
    title: "模型检测 全部分类",
    operatorUserId: "99999",
    detail: "manual",
  });
  await adminTaskStore.update(modelTask.id, {
    status: "failed",
    progress: 100,
    startedAt: "2026-06-04T10:01:00.000Z",
    finishedAt: "2026-06-04T10:01:04.000Z",
    durationMs: 4000,
    error: "Profile model timeout.",
  });
  const otherGroupTask = await adminTaskStore.create({
    type: "bulk-review",
    title: "批量审核 Hidden Test Group",
    groupId: "100200300",
    operatorUserId: "99999",
    detail: "approve 2 candidates",
  });
  hiddenDirectAccessFixtures.task = otherGroupTask;
  await adminTaskStore.update(otherGroupTask.id, {
    status: "succeeded",
    progress: 100,
    startedAt: "2026-06-04T10:03:00.000Z",
    finishedAt: "2026-06-04T10:03:01.000Z",
    durationMs: 1000,
    result: { approvedCount: 2 },
  });
  const adminOperationLogService = new AdminOperationLogService(path.join(tmp, "ops.jsonl"));
  await adminOperationLogService.record({
    timestamp: "2026-06-04T10:00:03.000Z",
    groupId: "866209871",
    operatorUserId: "99999",
    action: "profile_generate",
    target: "3951154629",
    detail: "overall",
  });
  await adminOperationLogService.record({
    timestamp: "2026-06-04T10:02:00.000Z",
    groupId: "866209871",
    operatorUserId: "99999",
    action: "model_check",
    target: "mimo",
    detail: "ok 126ms",
  });
  await adminOperationLogService.record({
    timestamp: "2026-06-04T10:02:30.000Z",
    groupId: "777888999",
    operatorUserId: "99999",
    action: "profile_generate",
    target: "3951154629",
    detail: "second group",
  });
  const modelHealthHistoryStore = new ModelHealthHistoryStore(path.join(tmp, "model-health-history.json"));
  await modelHealthHistoryStore.record({
    id: "gpt",
    purpose: "reply",
    name: "Env Reply Model",
    shortName: "gpt-env",
    selected: true,
    ok: true,
    detail: "Reply model health check is ok.",
    model: "gpt-env-model",
    baseUrl: "https://reply.example/v1",
    checkedAt: "2026-06-04T10:02:30.000Z",
    latencyMs: 88,
    cached: false,
    source: "manual",
  });
  await modelHealthHistoryStore.record({
    id: "mimo",
    purpose: "profile",
    name: "Env Profile Model",
    shortName: "mimo-v2.5-pro",
    selected: true,
    ok: true,
    detail: "Profile model health check is ok.",
    model: "mimo-v2.5-pro",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    checkedAt: "2026-06-04T10:02:45.000Z",
    latencyMs: 126,
    cached: false,
    source: "health",
  });

  const profileRecordStore = new ProfileRecordStore(path.join(tmp, "profile-records.json"));
  await profileRecordStore.create({
    groupId: "866209871",
    userId: "3951154629",
    type: "overall",
    summary: "Member A overall profile: steady operator, cares about reliable automation and concise answers.",
    sourceMemoryCount: 4,
    generatedAt: "2026-06-04T10:10:00.000Z",
    createdBy: "99999",
  });
  await profileRecordStore.create({
    groupId: "777888999",
    userId: "3951154629",
    type: "overall",
    summary: "Member A second group profile: visible to the same ordinary QQ viewer.",
    sourceMemoryCount: 1,
    generatedAt: "2026-06-04T10:11:00.000Z",
    createdBy: "99999",
  });
  hiddenDirectAccessFixtures.profileRecord = await profileRecordStore.create({
    groupId: "100200300",
    userId: "3951154629",
    type: "overall",
    summary: "Hidden group profile record must never leak to ordinary viewers.",
    sourceMemoryCount: 1,
    generatedAt: "2026-06-04T10:12:00.000Z",
    createdBy: "99999",
  });

  service = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: "admin",
    password: "secret",
    groupPassword: "group-secret",
    sessionSecret: "visual-secret",
    groupConfigService: new GroupConfigService(groupsPath),
    groupMemoryStore: memoryStore,
    groupMemoryCandidateService: new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [];
      },
    }),
    knowledgeBaseStore: knowledgeStore,
    profileRecordStore,
    adminTaskStore,
    modelHealthHistoryStore,
    systemSettingsStore: new SystemSettingsStore(path.join(tmp, "system-settings.json"), [
      {
        id: "gpt",
        name: "Env Reply Model",
        shortName: "gpt-env",
        baseUrl: "https://reply.example/v1",
        model: "gpt-env-model",
        purpose: "reply",
        apiKey: "reply-key",
        hasApiKey: true,
        enabled: true,
      },
      {
        id: "mimo",
        name: "Env Profile Model",
        shortName: "mimo-v2.5-pro",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        model: "mimo-v2.5-pro",
        purpose: "profile",
        apiKey: "profile-key",
        hasApiKey: true,
        enabled: true,
      },
    ]),
    skillService: new SkillService(skillsDir),
    scheduledReminderService: new ScheduledReminderService(
      scheduledReminderStore,
      { async generateScheduledReminderText() { return "Remember to handle pending work."; } },
    ),
    adminOperationLogService,
    dailyProfileReviewService: {
      async summarizeOverallProfileDetail(args) {
        return {
          summary: `${args.userId} overall profile: participates in technical and daily topics with clear preferences.`,
          generatedAt: now,
          memoryCount: 4,
          cached: false,
        };
      },
      async getYesterdaySummaryDetail(args) {
        return {
          summary: `${args.userId} yesterday profile: discussed work plans, AI tools, and daily preferences.`,
          generatedAt: now,
          memoryCount: 2,
          cached: true,
        };
      },
    },
    async getTransportHealthStatus() {
      return { ok: true, detail: "Reverse WebSocket connected on 0.0.0.0:6199/onebot/ws", checkedAt: now, latencyMs: 42 };
    },
    async getProfileAiHealthStatus(options) {
      return {
        ok: true,
        detail: options?.refresh ? "Profile AI health check is ok" : "Profile AI is ok",
        model: "mimo-v2.5-pro",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        checkedAt: now,
        latencyMs: 126,
        cached: !options?.refresh,
      };
    },
    async listGroupMembers(groupId) {
      if (String(groupId) === "777888999") {
        return [
          { user_id: 3951154629, card: "Member A Second Group", nickname: "Member A Second Group", role: "member" },
          { user_id: 3334445556, card: "Second Member", nickname: "Second Member", role: "member" },
        ];
      }
      return members.map(([user_id, card, role]) => ({ user_id: Number(user_id), card, nickname: card, role }));
    },
    async listGroups() {
      return [
        { group_id: 866209871, group_name: "UBot Test Group", member_count: 42, max_member_count: 500 },
        { group_id: 777888999, group_name: "Viewer Second Group", member_count: 2, max_member_count: 200 },
        { group_id: 100200300, group_name: "Hidden Test Group", member_count: 8, max_member_count: 200 },
      ];
    },
  });

  service.start();
  const rawServer = service.server;
  await new Promise((resolve) => rawServer.once("listening", resolve));
  const address = rawServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`ADMIN_SMOKE_URL=${baseUrl}`);

  const pages = [
    ["overview", "/"],
    ["groups", "/groups"],
    ["members", "/members"],
    ["candidates", "/candidates"],
    ["memories", "/memories"],
    ["profiles", "/profiles"],
    ["knowledge", "/knowledge"],
    ["tasks", "/tasks"],
    ["audit", "/audit"],
    ["health", "/health"],
    ["skills", "/skills"],
    ["commands", "/commands"],
    ["settings", "/settings"],
  ];

  const auth = await loginAndGetAuth(baseUrl);
  await runHttpSmoke(baseUrl, auth, pages);
  const groupAdminAuth = await loginGroupAdminAndGetAuth(baseUrl, "99999");
  const viewerAuth = await loginViewerAndGetAuth(baseUrl, "3951154629");
  await runGroupAdminHttpSmoke(baseUrl, groupAdminAuth);
  await runViewerHttpSmoke(baseUrl, viewerAuth, hiddenDirectAccessFixtures);
  await runViewerGroupAdminParitySmoke(baseUrl, viewerAuth, groupAdminAuth);
  await runStaticAdminSmoke();

  if (process.env.ADMIN_SMOKE_SCREENSHOTS === "1") {
    await runScreenshotStep("admin screenshots", () => captureCdpScreenshots(baseUrl, auth.cookie, [
      ["login", "/login", { width: 1600, height: 1000 }],
      ["login-viewer-mode", "/login", {
        width: 1600,
        height: 1000,
        click: ".mode-tabs button:nth-child(2)",
        expectText: ["普通用户", "QQ 账号", "只读进入"],
        expectNoSelector: 'input[type="password"]',
      }],
      ...pages.map(([name, route]) => [name, route, { width: 1600, height: 1000 }]),
      ["skills-editor", "/skills", { width: 1600, height: 1000, click: ".skill-table .table-row", afterClickScrollTo: ".tts-form-block" }],
      ["tasks-detail", "/tasks", { width: 1600, height: 1000, click: ".task-row .row-action", afterClickScrollTo: ".task-detail" }],
      ["audit-detail", "/audit", { width: 1600, height: 1000, click: ".audit-row .row-action", afterClickScrollTo: ".audit-detail" }],
      ["health-detail", "/health", { width: 1600, height: 1000, click: ".history-row .row-action", afterClickScrollTo: ".model-detail" }],
      ["groups-schedule", "/groups", { width: 1600, height: 1000, scrollTo: ".reminders-card" }],
      ["members-scrolled", "/members", { width: 1600, height: 1000, scrollY: 520 }],
      ["overview-mobile", "/", { width: 390, height: 844 }],
      ["groups-mobile", "/groups", { width: 390, height: 844 }],
      ["members-mobile", "/members", { width: 390, height: 844 }],
      ["candidates-mobile", "/candidates", { width: 390, height: 844 }],
      ["memories-mobile", "/memories", { width: 390, height: 844 }],
      ["tasks-mobile", "/tasks", { width: 390, height: 844 }],
      ["tasks-mobile-filters", "/tasks", { width: 390, height: 844, scrollTo: ".filter-card" }],
      ["settings-mobile", "/settings", { width: 390, height: 844 }],
    ]));
    await runScreenshotStep("viewer screenshots", () => captureCdpScreenshots(baseUrl, viewerAuth.cookie, [
      ["viewer-overview", "/", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-groups", "/groups", {
        width: 1600,
        height: 1000,
        expectSelector: ".readonly-banner",
        expectText: ["语音功能", "默认语音回复"],
        expectDisabledText: ["只读模式不可保存"],
      }],
      ["viewer-members", "/members", {
        width: 1600,
        height: 1000,
        expectSelector: ".readonly-banner",
        expectDisabledText: ["重新生成", "修改备注", "记忆去重", "禁用记忆"],
      }],
      ["viewer-memories-dedup", "/memories?userId=3951154629&type=member_profile&dedup=1", {
        width: 1600,
        height: 1000,
        expectSelector: ".readonly-banner",
        expectDisabledText: ["只读模式不可检测", "只读模式不可去重"],
      }],
      ["viewer-candidates", "/candidates", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-profiles", "/profiles", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-knowledge", "/knowledge", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-tasks", "/tasks", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-audit", "/audit", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-health", "/health", { width: 1600, height: 1000, expectSelector: ".readonly-banner" }],
      ["viewer-skills-blocked", "/skills", { width: 1600, height: 1000, expectPath: "/", expectSelector: ".readonly-banner" }],
      ["viewer-commands-blocked", "/commands", { width: 1600, height: 1000, expectPath: "/", expectSelector: ".readonly-banner" }],
      ["viewer-settings-blocked", "/settings", { width: 1600, height: 1000, expectPath: "/", expectSelector: ".readonly-banner" }],
      ["viewer-groups-mobile", "/groups", {
        width: 390,
        height: 844,
        expectSelector: ".readonly-banner",
        expectText: ["语音功能", "默认语音回复"],
      }],
      ["viewer-members-mobile", "/members", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
      ["viewer-candidates-mobile", "/candidates", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
      ["viewer-memories-mobile", "/memories", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
      ["viewer-profiles-mobile", "/profiles", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
      ["viewer-knowledge-mobile", "/knowledge", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
      ["viewer-tasks-mobile", "/tasks", { width: 390, height: 844, expectSelector: ".readonly-banner" }],
    ], { runTopbarSmoke: false }));
    await runScreenshotStep("contact sheet", () => writeContactSheet());
  }

  console.log(`ADMIN_SMOKE_SNAPSHOTS=${snapshotsDir}`);
  if (screenshotWarnings.length > 0) {
    console.warn(`ADMIN_SMOKE_SCREENSHOT_WARNINGS=${JSON.stringify(screenshotWarnings)}`);
  }
} finally {
  service?.close();
  await delay(500);
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

async function loginAndGetAuth(baseUrl) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret" }),
  });
  if (!response.ok) {
    throw new Error(`Admin smoke login failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("admin_session=")) {
    throw new Error(`Admin smoke login did not return an admin session cookie: ${setCookie}`);
  }
  const body = await response.json();
  const csrfToken = body?.session?.csrfToken || body?.csrfToken;
  if (!csrfToken) {
    throw new Error("Admin smoke login did not return a CSRF token.");
  }
  return { cookie, csrfToken };
}

async function loginViewerAndGetAuth(baseUrl, userId) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "viewer", username: userId }),
  });
  if (!response.ok) {
    throw new Error(`Viewer smoke login failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("admin_session=")) {
    throw new Error(`Viewer smoke login did not return an admin session cookie: ${setCookie}`);
  }
  const body = await response.json();
  const session = body?.session;
  const csrfToken = session?.csrfToken || body?.csrfToken;
  if (!csrfToken || session?.role !== "viewer" || session?.userId !== userId) {
    throw new Error(`Viewer smoke login returned an invalid session: ${JSON.stringify(body)}`);
  }
  return { cookie, csrfToken, userId };
}

async function loginGroupAdminAndGetAuth(baseUrl, userId) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "admin", username: userId, password: "group-secret" }),
  });
  if (!response.ok) {
    throw new Error(`Group admin smoke login failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("admin_session=")) {
    throw new Error(`Group admin smoke login did not return an admin session cookie: ${setCookie}`);
  }
  const body = await response.json();
  const session = body?.session;
  const csrfToken = session?.csrfToken || body?.csrfToken;
  if (!csrfToken || session?.role !== "group_admin" || session?.userId !== userId) {
    throw new Error(`Group admin smoke login returned an invalid session: ${JSON.stringify(body)}`);
  }
  return { cookie, csrfToken, userId };
}

async function runHttpSmoke(baseUrl, auth, pages) {
  const { cookie, csrfToken } = auth;
  const loginHtml = await fetchText(`${baseUrl}/login`);
  assertIncludes(loginHtml, "id=\"app\"", "login html");
  await writeFile(path.join(snapshotsDir, "login.html"), loginHtml, "utf8");

  for (const [name, route] of pages) {
    const html = await fetchText(`${baseUrl}${route}`);
    assertIncludes(html, "id=\"app\"", `${name} html`);
    await writeFile(path.join(snapshotsDir, `${name}.html`), html, "utf8");
  }

  const session = await fetchJson(`${baseUrl}/api/session`, cookie);
  if (session.role !== "super_admin") {
    throw new Error(`Expected super_admin session, got ${JSON.stringify(session)}`);
  }

  const overview = await fetchJson(`${baseUrl}/api/overview`, cookie);
  assertObjectPath(overview, "profileAiHealth.ok", true);
  assertObjectPath(overview, "transportHealth.ok", true);
  if (!overview.stats || overview.stats.pendingCandidateCount < 1) {
    throw new Error(`Overview stats did not include pending candidates: ${JSON.stringify(overview.stats)}`);
  }

  const health = await fetchJson(`${baseUrl}/api/health?refresh=1`, cookie);
  assertObjectPath(health, "profileAiHealth.ok", true);
  if (typeof health.profileAiHealth.latencyMs !== "number" || health.profileAiHealth.cached !== false) {
    throw new Error(`Health refresh did not expose latency/cache fields: ${JSON.stringify(health.profileAiHealth)}`);
  }

  const notifications = await fetchJson(`${baseUrl}/api/notifications`, cookie);
  if (notifications.pendingCandidateCount < 1 || !Array.isArray(notifications.latestCandidates)) {
    throw new Error(`Notification payload is incomplete: ${JSON.stringify(notifications)}`);
  }

  const groups = await fetchJson(`${baseUrl}/api/groups`, cookie);
  const group = groups.groups?.[0];
  if (!group?.groupId) {
    throw new Error(`Groups payload is incomplete: ${JSON.stringify(groups)}`);
  }

  const allTasks = await fetchJson(`${baseUrl}/api/tasks?page=1&pageSize=20`, cookie);
  if (!Array.isArray(allTasks.tasks) || allTasks.tasks.length < 3) {
    throw new Error(`Task center all-scope payload is incomplete: ${JSON.stringify(allTasks)}`);
  }
  if (!allTasks.tasks.some((task) => task.groupId === "100200300") || !allTasks.tasks.some((task) => !task.groupId)) {
    throw new Error(`Task center all-scope payload did not include cross-group and system tasks: ${JSON.stringify(allTasks.tasks)}`);
  }
  const currentGroupTasks = await fetchJson(`${baseUrl}/api/tasks?groupId=${encodeURIComponent(group.groupId)}&page=1&pageSize=20`, cookie);
  if (!Array.isArray(currentGroupTasks.tasks) || !currentGroupTasks.tasks.some((task) => task.groupId === group.groupId)) {
    throw new Error(`Task center current-group payload did not include the selected group task: ${JSON.stringify(currentGroupTasks)}`);
  }
  if (currentGroupTasks.tasks.some((task) => task.groupId && task.groupId !== group.groupId)) {
    throw new Error(`Task center current-group payload leaked another group task: ${JSON.stringify(currentGroupTasks.tasks)}`);
  }

  const modelOptions = await fetchJson(`${baseUrl}/api/model-options`, cookie);
  if (!Array.isArray(modelOptions.models) || !modelOptions.models.some((model) => model.id === "gpt")) {
    throw new Error(`Existing model options were not exposed to super admin: ${JSON.stringify(modelOptions)}`);
  }
  if (!Array.isArray(modelOptions.replyModels) || !modelOptions.replyModels.some((model) => model.id === "gpt")) {
    throw new Error(`Reply model switch list is incomplete: ${JSON.stringify(modelOptions)}`);
  }
  if ([...modelOptions.models, ...modelOptions.replyModels].some((model) => model.apiKey !== undefined)) {
    throw new Error("Model options leaked an API key.");
  }

  const settings = await fetchJson(`${baseUrl}/api/system-settings`, cookie);
  if (!Array.isArray(settings.models) || !settings.models.some((model) => model.id === "gpt")) {
    throw new Error(`System settings did not include existing models: ${JSON.stringify(settings.models)}`);
  }
  if (settings.models.some((model) => model.apiKey !== undefined)) {
    throw new Error("System settings leaked an API key.");
  }

  const updateSettings = await fetch(`${baseUrl}/api/system-settings`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({
      ...settings,
      models: [
        ...settings.models,
        {
          id: "smoke-reply",
          name: "Smoke Reply",
          shortName: "smoke-reply",
          baseUrl: "https://smoke-reply.example/v1",
          model: "smoke-reply-model",
          purpose: "reply",
          apiKey: "smoke-reply-key",
          enabled: true,
        },
      ],
    }),
  });
  if (!updateSettings.ok) {
    throw new Error(`System settings update failed: ${updateSettings.status} ${await updateSettings.text()}`);
  }
  const updatedModelOptions = await fetchJson(`${baseUrl}/api/model-options`, cookie);
  if (!updatedModelOptions.replyModels.some((model) => model.id === "smoke-reply" && model.label.includes("smoke-reply"))) {
    throw new Error(`Enabled added reply model did not enter switch list: ${JSON.stringify(updatedModelOptions.replyModels)}`);
  }
  if ([...(updatedModelOptions.models ?? []), ...updatedModelOptions.replyModels].some((model) => model.apiKey !== undefined)) {
    throw new Error("Updated model options leaked an API key.");
  }

  const members = await fetchJson(`${baseUrl}/api/groups/${encodeURIComponent(group.groupId)}/members?page=1&pageSize=5&includeNapcatMembers=1`, cookie);
  if (!Array.isArray(members.members) || members.members.length < 1 || !members.pagination) {
    throw new Error(`Members payload is not paginated: ${JSON.stringify(members)}`);
  }

  const memories = await fetchJson(`${baseUrl}/api/memories?groupId=${encodeURIComponent(group.groupId)}&subjectUserId=3951154629&page=1&pageSize=5`, cookie);
  if (!Array.isArray(memories.memories) || memories.memories.some((item) => item.subjectUserId !== "3951154629")) {
    throw new Error(`Member memory filter failed: ${JSON.stringify(memories)}`);
  }

  const skills = await fetchJson(`${baseUrl}/api/skills`, cookie);
  if (!Array.isArray(skills.skills) || !skills.skills.some((skill) => skill.id === "assistant")) {
    throw new Error(`Skills payload is incomplete: ${JSON.stringify(skills)}`);
  }

  const commands = await fetchJson(`${baseUrl}/api/commands`, cookie);
  if (!Array.isArray(commands.commands) || !commands.commands.some((command) => command.id === "model")) {
    throw new Error(`Commands payload is incomplete: ${JSON.stringify(commands)}`);
  }
}

function groupScopedReadableUrls(baseUrl, userId = "3951154629") {
  return [
    `${baseUrl}/api/overview`,
    `${baseUrl}/api/groups`,
    `${baseUrl}/api/groups/866209871/config`,
    `${baseUrl}/api/skill-options`,
    `${baseUrl}/api/groups/866209871/members?page=1&pageSize=20&includeNapcatMembers=1`,
    `${baseUrl}/api/groups/866209871/reminders`,
    `${baseUrl}/api/groups/866209871/schedule-preview?days=7`,
    `${baseUrl}/api/memories?groupId=866209871&subjectUserId=${encodeURIComponent(userId)}&page=1&pageSize=5`,
    `${baseUrl}/api/memory-candidates?groupId=866209871&page=1&pageSize=5`,
    `${baseUrl}/api/knowledge?groupId=866209871&page=1&pageSize=5`,
    `${baseUrl}/api/profile-records?groupId=866209871&userId=${encodeURIComponent(userId)}&page=1&pageSize=5`,
    `${baseUrl}/api/tasks?page=1&pageSize=20`,
    `${baseUrl}/api/logs?groupId=866209871&limit=20`,
    `${baseUrl}/api/health?refresh=1`,
    `${baseUrl}/api/model-options`,
    `${baseUrl}/api/notifications`,
  ];
}

async function runGroupAdminHttpSmoke(baseUrl, auth) {
  const { cookie, csrfToken, userId } = auth;
  const session = await fetchJson(`${baseUrl}/api/session`, cookie);
  if (
    session.role !== "group_admin" ||
    session.username !== userId ||
    session.userId !== userId ||
    JSON.stringify(session.allowedGroupIds) !== JSON.stringify(["866209871"])
  ) {
    throw new Error(`Group admin session is not scoped to the managed group: ${JSON.stringify(session)}`);
  }
  for (const url of groupScopedReadableUrls(baseUrl)) {
    await fetchJson(url, cookie);
  }
  const groupAdminConfig = await fetchJson(`${baseUrl}/api/groups/866209871/config`, cookie);
  assertVoiceReplyConfig(groupAdminConfig, "group admin group config");
  const groupAdminModelOptions = await fetchJson(`${baseUrl}/api/model-options`, cookie);
  if (groupAdminModelOptions.models !== undefined) {
    throw new Error(`Group admin model options exposed full model settings: ${JSON.stringify(groupAdminModelOptions)}`);
  }
  if (!groupAdminModelOptions.replyModels?.some((model) => model.id === "gpt")) {
    throw new Error(`Group admin reply model options are incomplete: ${JSON.stringify(groupAdminModelOptions)}`);
  }
  assertPublicReplyModelOptions(groupAdminModelOptions.replyModels, "Group admin");
  await expectJsonStatus(`${baseUrl}/api/system-settings`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  await expectJsonStatus(`${baseUrl}/api/skills`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  await expectJsonStatus(`${baseUrl}/api/commands`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });

  const updateGroup = await fetch(`${baseUrl}/api/groups/866209871/config`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ botMuted: true }),
  });
  if (!updateGroup.ok) {
    throw new Error(`Group admin could not update managed group config: ${updateGroup.status} ${await updateGroup.text()}`);
  }
  const afterUpdate = await updateGroup.json();
  if (afterUpdate.botMuted !== true) {
    throw new Error(`Group admin update did not apply to managed group config: ${JSON.stringify(afterUpdate)}`);
  }
  const restoreGroup = await fetch(`${baseUrl}/api/groups/866209871/config`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ botMuted: false }),
  });
  if (!restoreGroup.ok) {
    throw new Error(`Group admin could not restore managed group config: ${restoreGroup.status} ${await restoreGroup.text()}`);
  }
}

async function runViewerGroupAdminParitySmoke(baseUrl, viewerAuth, groupAdminAuth) {
  const readableUrls = groupScopedReadableUrls(baseUrl, viewerAuth.userId);
  for (const url of readableUrls) {
    const groupAdminResponse = await fetch(url, { headers: { Cookie: groupAdminAuth.cookie } });
    const viewerResponse = await fetch(url, { headers: { Cookie: viewerAuth.cookie } });
    if (!groupAdminResponse.ok || !viewerResponse.ok) {
      throw new Error(`Viewer/group-admin readable parity failed for ${url}: groupAdmin=${groupAdminResponse.status}, viewer=${viewerResponse.status}`);
    }
    await groupAdminResponse.arrayBuffer();
    await viewerResponse.arrayBuffer();
  }
}

async function runViewerHttpSmoke(baseUrl, auth, hiddenFixtures = {}) {
  const { cookie, csrfToken, userId } = auth;
  const expectedGroupIds = ["866209871", "777888999"];
  const expectedGroupIdSet = new Set(expectedGroupIds);
  const session = await fetchJson(`${baseUrl}/api/session`, cookie);
  if (
    session.role !== "viewer" ||
    session.username !== userId ||
    session.userId !== userId ||
    JSON.stringify(session.allowedGroupIds) !== JSON.stringify(expectedGroupIds)
  ) {
    throw new Error(`Viewer session is not scoped to the member's enabled groups: ${JSON.stringify(session)}`);
  }

  const groups = await fetchJson(`${baseUrl}/api/groups`, cookie);
  const groupIds = (groups.groups ?? []).map((group) => group.groupId);
  if (JSON.stringify(groupIds) !== JSON.stringify(expectedGroupIds)) {
    throw new Error(`Viewer groups leaked inaccessible groups: ${JSON.stringify(groups)}`);
  }
  assertVoiceReplyConfig(groups.groups?.[0], "viewer groups list");

  const viewerGroupConfig = await fetchJson(`${baseUrl}/api/groups/866209871/config`, cookie);
  assertVoiceReplyConfig(viewerGroupConfig, "viewer group config");
  const viewerSecondGroupConfig = await fetchJson(`${baseUrl}/api/groups/777888999/config`, cookie);
  if (viewerSecondGroupConfig.groupId !== "777888999" || viewerSecondGroupConfig.defaultVoiceReplyEnabled !== false) {
    throw new Error(`Viewer could not read second enabled group config: ${JSON.stringify(viewerSecondGroupConfig)}`);
  }
  await expectJsonStatus(`${baseUrl}/api/groups/100200300/config`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  await expectJsonStatus(`${baseUrl}/api/system-settings`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  await expectJsonStatus(`${baseUrl}/api/skills`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  await expectJsonStatus(`${baseUrl}/api/commands`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });

  const viewerModelOptions = await fetchJson(`${baseUrl}/api/model-options`, cookie);
  if (viewerModelOptions.models !== undefined) {
    throw new Error(`Viewer model options exposed full model settings: ${JSON.stringify(viewerModelOptions)}`);
  }
  if (!viewerModelOptions.replyModels?.some((model) => model.id === "gpt")) {
    throw new Error(`Viewer reply model options are incomplete: ${JSON.stringify(viewerModelOptions)}`);
  }
  assertPublicReplyModelOptions(viewerModelOptions.replyModels, "Viewer");

  const viewerOverview = await fetchJson(`${baseUrl}/api/overview`, cookie);
  const overviewGroupIds = (viewerOverview.groups ?? []).map((group) => group.groupId);
  if (JSON.stringify(overviewGroupIds) !== JSON.stringify(expectedGroupIds)) {
    throw new Error(`Viewer overview leaked inaccessible groups: ${JSON.stringify(viewerOverview.groups)}`);
  }
  if (!viewerOverview.recent?.candidates?.every((candidate) => expectedGroupIdSet.has(candidate.groupId))) {
    throw new Error(`Viewer overview leaked inaccessible candidates: ${JSON.stringify(viewerOverview.recent?.candidates)}`);
  }
  if (!viewerOverview.recent?.memories?.every((memory) => expectedGroupIdSet.has(memory.groupId))) {
    throw new Error(`Viewer overview leaked inaccessible memories: ${JSON.stringify(viewerOverview.recent?.memories)}`);
  }
  if (!viewerOverview.recent?.knowledge?.every((entry) => expectedGroupIdSet.has(entry.groupId))) {
    throw new Error(`Viewer overview leaked inaccessible knowledge: ${JSON.stringify(viewerOverview.recent?.knowledge)}`);
  }
  if (!viewerOverview.recent?.memories?.some((memory) => memory.groupId === "777888999")) {
    throw new Error(`Viewer overview did not include second enabled group memory: ${JSON.stringify(viewerOverview.recent?.memories)}`);
  }

  const viewerHealth = await fetchJson(`${baseUrl}/api/health?refresh=1`, cookie);
  if (
    viewerHealth.profileAiHealth.cached !== true ||
    viewerHealth.profileAiHealth.detail !== "restricted" ||
    viewerHealth.modelStatuses?.length !== 0 ||
    viewerHealth.abnormalModelStatuses?.length !== 0
  ) {
    throw new Error(`Viewer health refreshed model checks or exposed model details: ${JSON.stringify(viewerHealth)}`);
  }

  const viewerLogs = await fetchJson(`${baseUrl}/api/logs?groupId=866209871&limit=20`, cookie);
  if (!Array.isArray(viewerLogs.entries) || viewerLogs.entries.some((entry) => entry.groupId !== "866209871")) {
    throw new Error(`Viewer audit logs leaked another group: ${JSON.stringify(viewerLogs)}`);
  }
  const viewerSecondGroupLogs = await fetchJson(`${baseUrl}/api/logs?groupId=777888999&limit=20`, cookie);
  if (!Array.isArray(viewerSecondGroupLogs.entries) || !viewerSecondGroupLogs.entries.some((entry) => entry.groupId === "777888999")) {
    throw new Error(`Viewer audit logs did not include the second enabled group: ${JSON.stringify(viewerSecondGroupLogs)}`);
  }
  await expectJsonStatus(`${baseUrl}/api/logs`, {
    headers: { Cookie: cookie },
  }, 400, { error: "group_id_required" });

  const viewerTasks = await fetchJson(`${baseUrl}/api/tasks?page=1&pageSize=20`, cookie);
  if (!Array.isArray(viewerTasks.tasks) || viewerTasks.tasks.length < 1) {
    throw new Error(`Viewer task center did not include accessible group tasks: ${JSON.stringify(viewerTasks)}`);
  }
  if (viewerTasks.tasks.some((task) => !task.groupId || !expectedGroupIdSet.has(task.groupId))) {
    throw new Error(`Viewer task center leaked system or hidden-group tasks: ${JSON.stringify(viewerTasks.tasks)}`);
  }
  if (!viewerTasks.tasks.every((task) => task.groupId === "866209871")) {
    throw new Error(`Viewer default task center should stay scoped to the current group: ${JSON.stringify(viewerTasks.tasks)}`);
  }
  const viewerSecondGroupTasks = await fetchJson(`${baseUrl}/api/tasks?groupId=777888999&page=1&pageSize=20`, cookie);
  if (!Array.isArray(viewerSecondGroupTasks.tasks) || !viewerSecondGroupTasks.tasks.some((task) => task.groupId === "777888999")) {
    throw new Error(`Viewer task center did not include the second enabled group task when scoped: ${JSON.stringify(viewerSecondGroupTasks)}`);
  }
  if (viewerSecondGroupTasks.tasks.some((task) => task.groupId !== "777888999")) {
    throw new Error(`Viewer second-group task center leaked another scope: ${JSON.stringify(viewerSecondGroupTasks.tasks)}`);
  }
  const viewerTask = viewerTasks.tasks[0];
  await fetchJson(`${baseUrl}/api/tasks/${encodeURIComponent(viewerTask.id)}`, cookie);
  await expectJsonStatus(`${baseUrl}/api/tasks/${encodeURIComponent("missing-system-task")}`, {
    headers: { Cookie: cookie },
  }, 404, { error: "not_found" });

  const members = await fetchJson(`${baseUrl}/api/groups/866209871/members?page=1&pageSize=20&includeNapcatMembers=1`, cookie);
  if (!members.members?.some((member) => member.userId === userId)) {
    throw new Error(`Viewer member list did not include the logged-in QQ user: ${JSON.stringify(members)}`);
  }

  const defaultMemories = await fetchJson(`${baseUrl}/api/memories?page=1&pageSize=20`, cookie);
  assertCollectionOnlyGroup(defaultMemories, "memories", "866209871", "Viewer default memories");
  const defaultCandidates = await fetchJson(`${baseUrl}/api/memory-candidates?page=1&pageSize=20`, cookie);
  assertCollectionOnlyGroup(defaultCandidates, "candidates", "866209871", "Viewer default candidates");
  const defaultKnowledge = await fetchJson(`${baseUrl}/api/knowledge?page=1&pageSize=20`, cookie);
  assertCollectionOnlyGroup(defaultKnowledge, "entries", "866209871", "Viewer default knowledge");
  const defaultProfileRecords = await fetchJson(`${baseUrl}/api/profile-records?page=1&pageSize=20`, cookie);
  assertCollectionOnlyGroup(defaultProfileRecords, "records", "866209871", "Viewer default profile records");

  const memories = await fetchJson(`${baseUrl}/api/memories?groupId=866209871&subjectUserId=${encodeURIComponent(userId)}&page=1&pageSize=5`, cookie);
  if (!Array.isArray(memories.memories) || memories.memories.some((item) => item.groupId !== "866209871" || item.subjectUserId !== userId)) {
    throw new Error(`Viewer memories were not restricted to the selected member/group: ${JSON.stringify(memories)}`);
  }
  const secondGroupMemories = await fetchJson(`${baseUrl}/api/memories?groupId=777888999&subjectUserId=${encodeURIComponent(userId)}&page=1&pageSize=5`, cookie);
  if (!Array.isArray(secondGroupMemories.memories) || !secondGroupMemories.memories.some((item) => item.groupId === "777888999" && item.subjectUserId === userId)) {
    throw new Error(`Viewer memories did not include the second enabled group: ${JSON.stringify(secondGroupMemories)}`);
  }

  const knowledge = await fetchJson(`${baseUrl}/api/knowledge?groupId=866209871&page=1&pageSize=5`, cookie);
  if (!Array.isArray(knowledge.entries) || knowledge.entries.some((entry) => entry.groupId !== "866209871")) {
    throw new Error(`Viewer knowledge entries leaked another group: ${JSON.stringify(knowledge)}`);
  }
  const secondGroupKnowledge = await fetchJson(`${baseUrl}/api/knowledge?groupId=777888999&page=1&pageSize=5`, cookie);
  if (!Array.isArray(secondGroupKnowledge.entries) || !secondGroupKnowledge.entries.some((entry) => entry.groupId === "777888999")) {
    throw new Error(`Viewer knowledge did not include the second enabled group: ${JSON.stringify(secondGroupKnowledge)}`);
  }

  const profileRecords = await fetchJson(`${baseUrl}/api/profile-records?groupId=866209871&userId=${encodeURIComponent(userId)}&page=1&pageSize=5`, cookie);
  const profileRecord = profileRecords.records?.[0];
  if (!profileRecord?.id || profileRecords.records.some((record) => record.groupId !== "866209871" || record.userId !== userId)) {
    throw new Error(`Viewer profile records were not restricted to the selected member/group: ${JSON.stringify(profileRecords)}`);
  }
  await fetchJson(`${baseUrl}/api/profile-records/${encodeURIComponent(profileRecord.id)}`, cookie);
  await expectJsonStatus(`${baseUrl}/api/groups/866209871/members/3334445555/profile-summary?type=overall`, {
    headers: { Cookie: cookie },
  }, 403, { error: "readonly_session" });
  const uncachedProfileRecords = await fetchJson(`${baseUrl}/api/profile-records?groupId=866209871&userId=3334445555&page=1&pageSize=5`, cookie);
  if (uncachedProfileRecords.pagination?.total !== 0 || uncachedProfileRecords.records?.length !== 0) {
    throw new Error(`Viewer uncached profile summary created a profile record: ${JSON.stringify(uncachedProfileRecords)}`);
  }
  const secondGroupProfileRecords = await fetchJson(`${baseUrl}/api/profile-records?groupId=777888999&userId=${encodeURIComponent(userId)}&page=1&pageSize=5`, cookie);
  if (!Array.isArray(secondGroupProfileRecords.records) || !secondGroupProfileRecords.records.some((record) => record.groupId === "777888999" && record.userId === userId)) {
    throw new Error(`Viewer profile records did not include the second enabled group: ${JSON.stringify(secondGroupProfileRecords)}`);
  }

  const candidates = await fetchJson(`${baseUrl}/api/memory-candidates?groupId=866209871&page=1&pageSize=5`, cookie);
  const candidate = candidates.candidates?.[0];
  if (!candidate?.id) {
    throw new Error(`Viewer candidates payload is incomplete: ${JSON.stringify(candidates)}`);
  }
  const secondGroupCandidates = await fetchJson(`${baseUrl}/api/memory-candidates?groupId=777888999&page=1&pageSize=5`, cookie);
  if (!Array.isArray(secondGroupCandidates.candidates) || !secondGroupCandidates.candidates.some((item) => item.groupId === "777888999")) {
    throw new Error(`Viewer candidates did not include the second enabled group when scoped: ${JSON.stringify(secondGroupCandidates)}`);
  }
  await expectJsonStatus(`${baseUrl}/api/search?groupId=100200300&q=Hidden`, {
    headers: { Cookie: cookie },
  }, 403, { error: "forbidden" });
  for (const hiddenUrl of [
    `${baseUrl}/api/memories?groupId=100200300&page=1&pageSize=5`,
    `${baseUrl}/api/memory-candidates?groupId=100200300&page=1&pageSize=5`,
    `${baseUrl}/api/knowledge?groupId=100200300&page=1&pageSize=5`,
    `${baseUrl}/api/profile-records?groupId=100200300&page=1&pageSize=5`,
  ]) {
    await expectJsonStatus(hiddenUrl, {
      headers: { Cookie: cookie },
    }, 403, { error: "forbidden" });
  }
  for (const hiddenDetailUrl of [
    hiddenFixtures.memory?.id ? `${baseUrl}/api/memories/${encodeURIComponent(hiddenFixtures.memory.id)}` : undefined,
    hiddenFixtures.candidate?.id ? `${baseUrl}/api/memory-candidates/${encodeURIComponent(hiddenFixtures.candidate.id)}` : undefined,
    hiddenFixtures.profileRecord?.id ? `${baseUrl}/api/profile-records/${encodeURIComponent(hiddenFixtures.profileRecord.id)}` : undefined,
    hiddenFixtures.task?.id ? `${baseUrl}/api/tasks/${encodeURIComponent(hiddenFixtures.task.id)}` : undefined,
  ].filter(Boolean)) {
    await expectJsonStatus(hiddenDetailUrl, {
      headers: { Cookie: cookie },
    }, 403, { error: "forbidden" });
  }

  const readonlyRequests = [
    [`${baseUrl}/api/groups/866209871/config`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ botMuted: true }),
    }],
    [`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ profileSummaryMaxChars: 1200 }),
    }],
    [`${baseUrl}/api/knowledge/import/preview`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ groupId: "866209871", text: "Q: viewer import\nA: readonly" }),
    }],
    [`${baseUrl}/api/memory-candidates/${encodeURIComponent(candidate.id)}/reject`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    }],
    [`${baseUrl}/api/groups/866209871/reminders`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ topic: "viewer reminder", intervalMinutes: 30 }),
    }],
    [`${baseUrl}/api/profile-records/${encodeURIComponent(profileRecord.id)}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    }],
    [`${baseUrl}/api/groups/866209871/config`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ botMuted: true }),
    }],
  ];
  for (const [url, init] of readonlyRequests) {
    await expectJsonStatus(url, init, 403, { error: "readonly_session" });
  }

  const candidateAfterReadonlyWrites = await fetchJson(`${baseUrl}/api/memory-candidates/${encodeURIComponent(candidate.id)}`, cookie);
  if (candidateAfterReadonlyWrites.status !== "pending") {
    throw new Error(`Viewer readonly reject changed candidate state: ${JSON.stringify(candidateAfterReadonlyWrites)}`);
  }
}

function assertCollectionOnlyGroup(payload, key, expectedGroupId, label) {
  const items = payload?.[key];
  if (!Array.isArray(items) || items.length < 1 || items.some((item) => item.groupId !== expectedGroupId)) {
    throw new Error(`${label} leaked or omitted group-scoped data: ${JSON.stringify(payload)}`);
  }
}

function assertPublicReplyModelOptions(replyModels, label) {
  if (!Array.isArray(replyModels) || replyModels.length < 1) {
    throw new Error(`${label} reply model options are empty or invalid: ${JSON.stringify(replyModels)}`);
  }
  for (const model of replyModels) {
    const keys = Object.keys(model).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["enabled", "id", "label", "purpose"])) {
      throw new Error(`${label} reply model option exposed non-public fields: ${JSON.stringify(model)}`);
    }
    if (
      typeof model.id !== "string" ||
      typeof model.label !== "string" ||
      model.purpose !== "reply" ||
      typeof model.enabled !== "boolean"
    ) {
      throw new Error(`${label} reply model option has invalid public shape: ${JSON.stringify(model)}`);
    }
  }
}

async function runStaticAdminSmoke() {
  const [app, router, settings, groups, members, memories, profiles, skills, commands] = await Promise.all([
    readFile(path.resolve("admin", "src", "App.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "router.ts"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "SettingsView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "GroupsView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "MembersView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "MemoriesView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "ProfilesView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "SkillsView.vue"), "utf8"),
    readFile(path.resolve("admin", "src", "views", "CommandsView.vue"), "utf8"),
  ]);

  const healthIndex = router.indexOf('path: "/health"');
  const settingsIndex = router.indexOf('path: "/settings"');
  if (healthIndex < 0 || settingsIndex < 0 || healthIndex > settingsIndex) {
    throw new Error("Health status route must be immediately before system management.");
  }
  assertIncludes(app, "pendingCandidateCount", "notification badge");
  assertIncludes(settings, "/api/system-settings", "system settings API");
  assertIncludes(settings, ":value=\"model.id\"", "model id editor value binding");
  assertIncludes(settings, "updateModelId(model, $event)", "model id editor update handler");
  assertIncludes(settings, "type=\"password\"", "write-only model api key");
  assertIncludes(settings, "modelTemplate(purpose = activePurpose.value)", "new model active purpose template");
  assertIncludes(settings, "selectedModelIds", "selected model per purpose");
  assertIncludes(settings, "检测连接", "model connection test action");
  assertIncludes(settings, "检测全部模型", "all model connection test action");
  assertIncludes(settings, "/api/models/test-all", "all model test API");
  assertIncludes(settings, "/api/model-health-history", "model health history settings sync");
  assertIncludes(groups, "/api/model-options", "group model options");
  assertIncludes(groups, "v-for=\"model in replyModels\"", "reply model select list");
  assertIncludes(members, "viewMemberMemories", "member memory action");
  assertIncludes(members, "toggleMemoryCollection", "member memory disable action");
  assertIncludes(memories, "subjectUserId", "member memory filter");
  assertIncludes(profiles, "ProfileRecord", "profile records page");
  assertIncludes(skills, "skill.id", "skills real id field");
  assertIncludes(skills, "skill.name", "skills real name field");
  assertIncludes(commands, "command.primary", "command primary editor");
  if (commands.includes("<th>帮助文案</th>") || commands.includes("<span>帮助文案</span>")) {
    throw new Error("Command list should not show help text as a list column.");
  }
}

async function fetchText(url, cookie) {
  const response = await fetch(url, cookie ? { headers: { Cookie: cookie } } : undefined);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${url} ${response.status} ${await response.text()}`);
  }
  return await response.text();
}

async function fetchJson(url, cookie) {
  const response = await fetch(url, { headers: { Cookie: cookie } });
  if (!response.ok) {
    throw new Error(`Fetch JSON failed: ${url} ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function expectJsonStatus(url, init, expectedStatus, expectedBody) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (response.status !== expectedStatus || JSON.stringify(body) !== JSON.stringify(expectedBody)) {
    throw new Error(`Expected ${url} to return ${expectedStatus} ${JSON.stringify(expectedBody)}, got ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function assertVoiceReplyConfig(group, label) {
  if (!group || group.voiceReplyEnabled !== true || group.defaultVoiceReplyEnabled !== true) {
    throw new Error(`${label} did not expose enabled voice reply child settings: ${JSON.stringify(group)}`);
  }
  if (group.defaultVoiceReplyEnabled === true && group.voiceReplyEnabled !== true) {
    throw new Error(`${label} exposed default voice reply without voice reply enabled: ${JSON.stringify(group)}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`Expected ${label} to include ${expected}.`);
  }
}

function assertObjectPath(value, pathExpression, expected) {
  const actual = pathExpression.split(".").reduce((acc, key) => acc?.[key], value);
  if (actual !== expected) {
    throw new Error(`Expected ${pathExpression}=${expected}, got ${actual}.`);
  }
}

async function captureCdpScreenshots(baseUrl, cookie, targets, options = {}) {
  const remotePort = 9200 + Math.floor(Math.random() * 1000);
  const userDataDir = path.join(tmp, `chrome-profile-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  const chrome = spawn(chromeExe, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=MetricsReportingEnabled",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-sandbox",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const pageWsUrl = await waitForPageWebSocket(remotePort, stderr);
    const cdp = await connectCdp(pageWsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Network.setCookie", {
        name: "admin_session",
        value: cookie.replace(/^admin_session=/, ""),
        url: baseUrl,
        path: "/",
        httpOnly: true,
      });

      if (options.runTopbarSmoke !== false) {
        try {
          await runTopbarInteractionSmoke(cdp, baseUrl);
        } catch (error) {
          throw new Error(`Admin topbar interaction smoke failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const refreshedAuth = await loginAndGetAuth(baseUrl);
        await cdp.send("Network.setCookie", {
          name: "admin_session",
          value: refreshedAuth.cookie.replace(/^admin_session=/, ""),
          url: baseUrl,
          path: "/",
          httpOnly: true,
        });
      }
      await cdp.send("Runtime.evaluate", {
        expression: "localStorage.setItem('ubot-admin-theme', 'light')",
      });
      await navigateAndWait(cdp, `${baseUrl}/`);
      await waitForUiStable(cdp);

      for (const [name, route, viewport] of targets) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width < 600,
        });
        await navigateAndWait(cdp, `${baseUrl}${route}`);
        await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
        await waitForUiStable(cdp);
        await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
        await delay(120);
        if (!viewport.click) {
          await assertViewportExpectations(cdp, viewport, name);
        }
        if (viewport.scrollTo) {
          await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              const target = document.querySelector(${JSON.stringify(viewport.scrollTo)});
              if (target) {
                target.scrollIntoView({ block: "start", inline: "nearest" });
                window.scrollBy(0, -110);
              }
            })()`,
          });
          await delay(350);
        } else if (viewport.scrollY) {
          await cdp.send("Runtime.evaluate", { expression: `window.scrollTo(0, ${Number(viewport.scrollY) || 0})` });
          await delay(350);
        }
        if (viewport.click) {
          await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              const target = document.querySelector(${JSON.stringify(viewport.click)});
              if (target instanceof HTMLElement) target.click();
            })()`,
          });
          await delay(650);
          if (viewport.afterClickScrollTo) {
            await cdp.send("Runtime.evaluate", {
                expression: `(() => {
                  const target = document.querySelector(${JSON.stringify(viewport.afterClickScrollTo)});
                  if (target) target.scrollIntoView({ block: "center", inline: "nearest" });
                })()`,
            });
            await delay(250);
          }
          await assertViewportExpectations(cdp, viewport, `${name} after click`);
        }
        const result = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          fromSurface: true,
        });
        const outputPath = path.join(snapshotsDir, `${name}.png`);
        await writeFile(outputPath, Buffer.from(result.data, "base64"));
        const info = await stat(outputPath);
        if (info.size < 10_000) {
          throw new Error(`${name}.png is too small (${info.size} bytes), screenshot likely failed.`);
        }
      }
    } finally {
      cdp.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Admin topbar interaction smoke failed:")) {
      throw error;
    }
    screenshotWarnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    chrome.kill();
    await delay(300);
  }
}

async function runScreenshotStep(label, action, attempts = 2) {
  let finalError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const warningStart = screenshotWarnings.length;
    let thrownError;
    try {
      await action();
    } catch (error) {
      thrownError = error;
    }
    const newWarnings = screenshotWarnings.splice(warningStart);
    if (!thrownError && newWarnings.length === 0) {
      return;
    }
    const details = [
      thrownError instanceof Error ? thrownError.message : thrownError ? String(thrownError) : "",
      ...newWarnings,
    ].filter(Boolean);
    finalError = new Error(`${label} failed on attempt ${attempt}: ${details.join("; ")}`);
    if (attempt < attempts) {
      await delay(800);
    }
  }
  throw finalError ?? new Error(`${label} failed.`);
}

async function writeContactSheet() {
  const files = (await readdir(snapshotsDir))
    .filter((name) => name.endsWith(".png") && name !== "_contact-sheet.png")
    .sort();
  if (files.length === 0) return;

  const htmlPath = path.join(snapshotsDir, "_contact-sheet.html");
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin UI smoke contact sheet</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f5f7fb;
      color: #172033;
      font-family: Arial, sans-serif;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.25;
    }
    .meta {
      margin: 0 0 20px;
      color: #5f6f89;
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .shot {
      overflow: hidden;
      border: 1px solid #d8e0ef;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 10px 24px rgba(23, 32, 51, 0.08);
    }
    .shot img {
      display: block;
      width: 100%;
      height: 220px;
      object-fit: cover;
      object-position: top left;
      border-bottom: 1px solid #e4eaf4;
    }
    .name {
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.35;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <h1>Admin UI smoke contact sheet</h1>
  <p class="meta">${files.length} screenshots, generated ${new Date().toISOString()}</p>
  <main class="grid">
${files.map((name) => `    <figure class="shot"><img src="${escapeHtml(name)}" alt="${escapeHtml(name)}" /><figcaption class="name">${escapeHtml(name)}</figcaption></figure>`).join("\n")}
  </main>
</body>
</html>
`;
  await writeFile(htmlPath, html, "utf8");

  const remotePort = 9200 + Math.floor(Math.random() * 1000);
  const userDataDir = path.join(tmp, `chrome-contact-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  const chrome = spawn(chromeExe, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=MetricsReportingEnabled",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-sandbox",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const pageWsUrl = await waitForPageWebSocket(remotePort, () => stderr);
    const cdp = await connectCdp(pageWsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1200,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await navigateAndWait(cdp, pathToFileURL(htmlPath).href);
      await waitForExpression(
        cdp,
        `Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0)`,
        "contact sheet images to load",
      );
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      const outputPath = path.join(snapshotsDir, "_contact-sheet.png");
      await writeFile(outputPath, Buffer.from(result.data, "base64"));
      const info = await stat(outputPath);
      if (info.size < 50_000) {
        throw new Error(`_contact-sheet.png is too small (${info.size} bytes), contact sheet likely failed.`);
      }
    } finally {
      cdp.close();
    }
  } catch (error) {
    screenshotWarnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    chrome.kill();
    await delay(300);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runTopbarInteractionSmoke(cdp, baseUrl) {
  const enabledGroupIds = ["866209871", "777888999"];
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigateAndWait(cdp, `${baseUrl}/`);
  await waitForUiStable(cdp);
  await assertTopbarGroupOptions(cdp, enabledGroupIds, "initial topbar group select");

  await realClick(cdp, ".notify-btn");
  await delay(200);
  await assertElementVisible(cdp, '[data-smoke="review-candidates"]', "review candidates popover action");
  await realClick(cdp, '[data-smoke="review-candidates"]');
  await waitForLocationPath(cdp, "/candidates");

  await navigateAndWait(cdp, `${baseUrl}/`);
  await waitForUiStable(cdp);
  await realClick(cdp, 'button[title="Theme"]');
  await delay(200);
  await assertElementVisible(cdp, '[data-smoke="theme-dark"]', "theme dark action");
  await realClick(cdp, '[data-smoke="theme-dark"]');
  await waitForExpression(cdp, "document.documentElement.dataset.themeMode === 'dark'", "theme mode to become dark");

  await navigateAndWait(cdp, `${baseUrl}/settings`);
  await waitForUiStable(cdp);
  await assertTopbarGroupOptions(cdp, enabledGroupIds, "topbar group select after settings loads all groups");

  await realClick(cdp, ".user-chip");
  await delay(200);
  await assertElementVisible(cdp, '[data-smoke="logout"]', "logout action");
  await assertFrontendCanPost(cdp, "logout action");
  await realClick(cdp, '[data-smoke="logout"]');
  await waitForLogout(cdp, baseUrl);
}

async function assertTopbarGroupOptions(cdp, expectedGroupIds, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => Array.from(document.querySelectorAll(".group-select option")).map((item) => item.value))()`,
    returnByValue: true,
  });
  const actual = result.result?.value;
  if (!Array.isArray(actual)) {
    throw new Error(`Could not read ${label}.`);
  }
  const expected = [...expectedGroupIds].sort();
  const normalizedActual = [...actual].sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${label} to show ${JSON.stringify(expected)}, got ${JSON.stringify(normalizedActual)}.`);
  }
}

async function realClick(cdp, selector) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof HTMLElement)) return null;
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        hitMatchesTarget: hit === target || target.contains(hit),
        hitSummary: hit instanceof HTMLElement
          ? {
              tag: hit.tagName,
              className: hit.className,
              text: hit.textContent?.trim().slice(0, 80),
              smoke: hit.dataset.smoke || "",
            }
          : null,
      };
    })()`,
    returnByValue: true,
  });
  const box = result.result?.value;
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`Cannot click hidden or missing selector: ${selector}`);
  }
  if (!box.hitMatchesTarget) {
    throw new Error(`Cannot click selector because another element is on top: ${selector}; hit=${JSON.stringify(box.hitSummary)}`);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
}

async function assertElementVisible(cdp, selector, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof HTMLElement)) return false;
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) {
    throw new Error(`Expected visible element for ${label}: ${selector}`);
  }
}

async function assertViewportExpectations(cdp, viewport, label) {
  if (viewport.expectPath) {
    await waitForLocationPath(cdp, viewport.expectPath);
  }
  if (viewport.expectSelector) {
    await assertElementVisible(cdp, viewport.expectSelector, `${label} expected selector`);
  }
  if (viewport.expectText) {
    for (const text of viewport.expectText) {
      await assertTextVisible(cdp, text, label);
    }
  }
  if (viewport.expectNoSelector) {
    await assertNoElementVisible(cdp, viewport.expectNoSelector, `${label} hidden selector`);
  }
  if (viewport.expectDisabledText) {
    for (const text of viewport.expectDisabledText) {
      await assertButtonWithTextDisabled(cdp, text, label);
    }
  }
}

async function assertTextVisible(cdp, text, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const expected = ${JSON.stringify(text)};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent || !node.textContent.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement)) continue;
        const rect = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") {
          return true;
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) {
    throw new Error(`Expected visible text "${text}" for ${label}.`);
  }
}

async function assertNoElementVisible(cdp, selector, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const targets = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      return targets.every((target) => {
        if (!(target instanceof HTMLElement)) return true;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none";
      });
    })()`,
    returnByValue: true,
  });
  if (result.result?.value !== true) {
    throw new Error(`Expected no visible element for ${label}: ${selector}.`);
  }
}

async function assertButtonWithTextDisabled(cdp, text, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const expected = ${JSON.stringify(text)};
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((button) => (button.textContent || "").trim() === expected);
      if (!target) return { found: false };
      return { found: true, disabled: target.disabled, text: (target.textContent || "").trim() };
    })()`,
    returnByValue: true,
  });
  const state = result.result?.value;
  if (!state?.found || state.disabled !== true) {
    throw new Error(`Expected disabled button "${text}" for ${label}, got ${JSON.stringify(state)}.`);
  }
}

async function waitForLocationPath(cdp, expectedPath) {
  await waitForExpression(
    cdp,
    `location.pathname === ${JSON.stringify(expectedPath)}`,
    `location path ${expectedPath}`,
  );
}

async function assertFrontendCanPost(cdp, label) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const scripts = performance.getEntriesByType("resource").filter((item) => String(item.name).includes("/assets/"));
      const sessionStatus = await fetch("/api/session", { credentials: "include" }).then((res) => res.status).catch((error) => String(error));
      return {
        path: location.pathname,
        sessionStatus,
        assetCount: scripts.length,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const state = result.result?.value;
  if (state?.sessionStatus !== 200) {
    throw new Error(`Cannot run ${label}: browser session is not active (${JSON.stringify(state)}).`);
  }
}

async function waitForLogout(cdp, baseUrl) {
  const deadline = Date.now() + 6000;
  let lastState = "";
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `location.pathname`,
      returnByValue: true,
    });
    const path = result.result?.value;
    const sessionResult = await cdp.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(`${baseUrl}/api/session`)}, { credentials: "include" }).then((res) => res.status).catch((error) => String(error))`,
      awaitPromise: true,
      returnByValue: true,
    });
    const sessionStatus = sessionResult.result?.value;
    lastState = JSON.stringify({ path, sessionStatus });
    if (path === "/login" && sessionStatus === 401) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for logout. Last state: ${lastState}`);
}

async function waitForExpression(cdp, expression, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value === true) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForPageWebSocket(remotePort, getStderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJsonNoCookie(`http://127.0.0.1:${remotePort}/json`);
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Chrome DevTools endpoint did not become ready. ${typeof getStderr === "function" ? getStderr() : getStderr}`);
}

async function fetchJsonNoCookie(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch JSON failed: ${url} ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  ws.on("message", (chunk) => {
    const message = JSON.parse(chunk.toString());
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(`${message.error.message}: ${JSON.stringify(message.error)}`));
      return;
    }
    callbacks.resolve(message.result ?? {});
  });

  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              rejectSend(new Error(`CDP command timed out: ${method}`));
            }, 15_000);
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.once("error", reject);
  });
}

async function navigateAndWait(cdp, url) {
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", { expression: "document.readyState" });
    if (result.result?.value === "complete") return;
    await delay(250);
  }
  throw new Error(`Page did not finish loading: ${url}`);
}

async function waitForUiStable(cdp) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const text = document.body?.innerText || "";
        const hasLoadingElement = Boolean(document.querySelector(".page-loading,.empty"));
        const hasLoadingText = /正在加载|检测中|读取中|保存中|Loading/.test(text);
        return { stable: !hasLoadingElement || !hasLoadingText, textLength: text.length };
      })()`,
      returnByValue: true,
    });
    if (result.result?.value?.stable) return;
    await delay(250);
  }
  screenshotWarnings.push("UI still showed a loading marker before one or more screenshots.");
}
