import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
      memoryDisabledUserIds: [],
    }],
  }, null, 2), "utf8");

  const memoryStore = new GroupMemoryStore(path.join(tmp, "memory.json"));
  const candidateStore = new GroupMemoryCandidateStore(path.join(tmp, "candidates.json"));
  const knowledgeStore = new KnowledgeBaseStore(path.join(tmp, "knowledge.json"));
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

  service = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: "admin",
    password: "secret",
    sessionSecret: "visual-secret",
    groupConfigService: new GroupConfigService(groupsPath),
    groupMemoryStore: memoryStore,
    groupMemoryCandidateService: new GroupMemoryCandidateService(candidateStore, memoryStore, {
      async extractGroupMemoryCandidates() {
        return [];
      },
    }),
    knowledgeBaseStore: knowledgeStore,
    profileRecordStore: new ProfileRecordStore(path.join(tmp, "profile-records.json")),
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
    async listGroupMembers() {
      return members.map(([user_id, card, role]) => ({ user_id: Number(user_id), card, nickname: card, role }));
    },
    async listGroups() {
      return [
        { group_id: 866209871, group_name: "UBot Test Group", member_count: 42, max_member_count: 500 },
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
  await runStaticAdminSmoke();

  if (process.env.ADMIN_SMOKE_SCREENSHOTS === "1") {
    await captureCdpScreenshots(baseUrl, auth.cookie, [
      ["login", "/login", { width: 1600, height: 1000 }],
      ...pages.map(([name, route]) => [name, route, { width: 1600, height: 1000 }]),
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
    ]);
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
  assertIncludes(settings, "v-model=\"model.id\"", "model id editor");
  assertIncludes(settings, "type=\"password\"", "write-only model api key");
  assertIncludes(settings, "modelTemplate(purpose = activePurpose.value)", "new model active purpose template");
  assertIncludes(settings, "selectedModelIds", "selected model per purpose");
  assertIncludes(settings, "检测连接", "model connection test action");
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

async function captureCdpScreenshots(baseUrl, cookie, targets) {
  const remotePort = 9200 + Math.floor(Math.random() * 1000);
  const userDataDir = path.join(tmp, "chrome-profile");
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
                if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
              })()`,
            });
            await delay(250);
          }
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
    screenshotWarnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    chrome.kill();
    await delay(300);
  }
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
