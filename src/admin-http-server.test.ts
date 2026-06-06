import assert from "node:assert/strict";
import { request } from "node:http";
import { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpServer } from "./admin-http-server.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./services/group-memory-candidate-store.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { ModelHealthHistoryStore } from "./services/model-health-history-store.js";
import { ProfileRecordStore } from "./services/profile-record-store.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { SkillService } from "./services/skill-service.js";
import { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import { ScheduledReminderStore } from "./services/scheduled-reminder-store.js";
import type { GroupBotConfig, GroupMemberProfile, NapcatGroupMember } from "./types.js";

let activeCsrfToken = "";

async function fetch(input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (activeCsrfToken && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const headers = new Headers(init.headers);
    if (!headers.has("X-CSRF-Token")) {
      headers.set("X-CSRF-Token", activeCsrfToken);
    }
    return globalThis.fetch(input, { ...init, headers });
  }
  return globalThis.fetch(input, init);
}

async function rawGet(url: string, headers: Record<string, string> = {}): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("admin http server protects APIs and serves authenticated dashboard data", async () => {
  activeCsrfToken = "";
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-http-"));
  const groupsPath = path.join(dir, "groups.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      groupsPath,
      JSON.stringify({
        superAdminUserIds: ["99999"],
        groups: [
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: [],
          },
        ],
      }),
      "utf8",
    ),
  );

  const groupMemoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
  await groupMemoryStore.create({
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "20001",
    title: "Tester preference",
    content: "Tester likes concise answers.",
    createdAt: "2026-06-01T10:00:00.000Z",
    evidence: {
      startAt: "2026-06-01T09:50:00.000Z",
      endAt: "2026-06-01T10:00:00.000Z",
      messageCount: 3,
      speakers: [{ userId: "20001", userName: "TesterCard" }],
      summary: "Tester said they prefer concise answers.",
    },
  });
  await groupMemoryStore.create({
    groupId: "67890",
    type: "group_fact",
    title: "Latest fact",
    content: "Latest memory should be shown first.",
    createdAt: "2026-06-02T10:00:00.000Z",
  });
  await groupMemoryStore.create({
    groupId: "67890",
    type: "group_fact",
    title: "Another fact",
    content: "Another memory for pagination.",
    createdAt: "2026-06-03T10:00:00.000Z",
  });
  const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
  const orphanCandidate = await candidateStore.addCandidate({
    groupId: "67890",
    type: "member_profile",
    title: "Unknown member profile",
    content: "Someone likes late-night chats.",
  });
  const batchFactCandidate = await candidateStore.addCandidate({
    groupId: "67890",
    type: "group_fact",
    title: "Batch fact",
    content: "Batch approval should use one API call.",
    evidence: {
      startAt: "2026-06-03T09:00:00.000Z",
      endAt: "2026-06-03T09:02:00.000Z",
      messageCount: 2,
      speakers: [{ userId: "20002", userName: "BatchUser" }],
      summary: "BatchUser discussed a group-level fact that should be approved in bulk.",
    },
  });
  const knowledgeBaseStore = new KnowledgeBaseStore(path.join(dir, "knowledge.json"));
  const knowledgeEntry = await knowledgeBaseStore.create({
    groupId: "67890",
    title: "报销流程",
    question: "怎么报销",
    answer: "先贴发票，再登记。",
    keywords: ["报销", "发票"],
  });
  await knowledgeBaseStore.create({
    groupId: "67890",
    title: "会议室",
    question: "会议室怎么订",
    answer: "找行政登记。",
    keywords: ["会议室"],
  });
  const skillsDir = path.join(dir, "skills");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(skillsDir, { recursive: true }).then(() =>
    writeFile(path.join(skillsDir, "assistant.json"), JSON.stringify({
      id: "assistant",
      name: "Assistant",
      systemPrompt: "You are helpful.",
      styleRules: [],
      knowledge: [],
      temperature: 0.7,
      maxContextTurns: 12,
    }), "utf8"),
  ));
  const systemSettingsStore = new SystemSettingsStore(path.join(dir, "system-settings.json"), [
    {
      id: "gpt",
      name: "Env Reply Model",
      shortName: "gpt-env",
      baseUrl: "https://reply-env.example/v1",
      model: "gpt-env-model",
      purpose: "reply",
      apiKey: "env-reply-key",
      hasApiKey: true,
      enabled: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "mimo",
      name: "Env Profile Model",
      shortName: "mimo-env",
      baseUrl: "https://profile-env.example/v1",
      model: "mimo-env-model",
      purpose: "profile",
      apiKey: "env-profile-key",
      hasApiKey: true,
      enabled: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ]);
  const profileRecordStore = new ProfileRecordStore(path.join(dir, "profile-records.json"));
  const adminTaskStore = new AdminTaskStore(path.join(dir, "admin-tasks.json"));
  const modelHealthHistoryStore = new ModelHealthHistoryStore(path.join(dir, "model-health.json"));
  await adminTaskStore.run({
    type: "profile-generate",
    title: "Profile task for Tester",
    groupId: "67890",
    subjectUserId: "20001",
    operatorUserId: "99999",
    detail: "overall",
  }, async () => ({ recordId: "profile-http-search", sourceMemoryCount: 2 }));
  await assert.rejects(
    () => adminTaskStore.run({
      type: "model-check",
      title: "Broken model check",
      operatorUserId: "99999",
    }, async () => {
      throw new Error("probe timeout");
    }),
    /probe timeout/,
  );
  const otherGroupTask = await adminTaskStore.create({
    type: "bulk-review",
    title: "Other group bulk review",
    groupId: "100200300",
    operatorUserId: "99999",
    detail: "Cross-group task should only appear in super admin all-scope task queries.",
  });
  await adminTaskStore.update(otherGroupTask.id, {
    status: "succeeded",
    progress: 100,
    result: { approvedCount: 8 },
  });
  const skillService = new SkillService(skillsDir);
  const scheduledReminderService = new ScheduledReminderService(
    new ScheduledReminderStore(path.join(dir, "reminders.json")),
    { async generateScheduledReminderText() { return "remember this"; } } as never,
  );
  let listGroupMembersCalls = 0;
  let profileHealthCalls = 0;
  let lastProfileHealthRefresh = false;
  let semanticJudgeCalls = 0;
  const service = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: "admin",
    password: "secret",
    groupPassword: "group-secret",
    sessionSecret: "test-secret",
    groupConfigService: new GroupConfigService(groupsPath),
    groupMemoryStore,
    groupMemoryCandidateService: new GroupMemoryCandidateService(
      candidateStore,
      groupMemoryStore,
      {
        async extractGroupMemoryCandidates() {
          return [];
        },
      },
    ),
    knowledgeBaseStore,
    scheduledReminderService,
    skillService,
    adminTaskStore,
    modelHealthHistoryStore,
    systemSettingsStore,
    profileRecordStore,
    adminOperationLogService: new AdminOperationLogService(path.join(dir, "ops.jsonl")),
    dailyProfileReviewService: ({
      async summarizeOverallProfileDetail(args: { groupConfig: GroupBotConfig; userId: string; members?: GroupMemberProfile[] }) {
        return {
          summary: `${args.userId} 完整群聊画像。`,
          generatedAt: "2026-06-03T10:00:00.000Z",
          memoryCount: 3,
          cached: false,
        };
      },
      async getYesterdaySummaryDetail(args: { groupConfig: GroupBotConfig; userId: string; members?: GroupMemberProfile[] }) {
        return {
          summary: `${args.userId} 完整昨日画像。`,
          generatedAt: "2026-06-03T11:00:00.000Z",
          memoryCount: 1,
          cached: true,
        };
      },
    } as never),
    async getTransportHealthStatus() {
      return { ok: true, detail: "ok" };
    },
    async getProfileAiHealthStatus(options) {
      profileHealthCalls += 1;
      lastProfileHealthRefresh = options?.refresh === true;
      return {
        ok: true,
        detail: options?.refresh ? "profile refreshed" : "profile ok",
        model: "mimo-v2.5-pro",
        baseUrl: "https://profile.example/v1",
        checkedAt: "2026-06-03T00:00:00.000Z",
        latencyMs: 12,
        cached: false,
      };
    },
    async judgeMemorySemanticRelation(args) {
      semanticJudgeCalls += 1;
      const pairText = `${args.candidate.content}\n${args.existing.content}`;
      if (pairText.includes("Tester wants short answers") && pairText.includes("Tester likes concise answers")) {
        return { action: "duplicate", reason: "same preference in different wording" };
      }
      return { action: "new", reason: "different memory" };
    },
    async listGroupMembers(): Promise<NapcatGroupMember[]> {
      listGroupMembersCalls += 1;
      return [
        { user_id: 20001, card: "TesterCard", nickname: "TesterNick", role: "member" },
        { user_id: 30002, nickname: "Newbie", role: "member" },
      ];
    },
  });

  try {
    service.start();
    const rawServer = (service as unknown as { server: { once(event: "listening", listener: () => void): void; address(): AddressInfo | null } }).server;
    await new Promise<void>((resolve) => rawServer.once("listening", resolve));
    const address = rawServer.address();
    assert.ok(address);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/api/groups`);
    assert.equal(unauthorized.status, 401);

    const loginPage = await fetch(`${baseUrl}/login`);
    assert.equal(loginPage.status, 200);
    const loginPageText = await loginPage.text();
    assert.equal(loginPageText.includes('id="app"'), true);
    assert.equal(loginPageText.includes("/assets/"), true);
    assert.equal(loginPageText.includes("ubot-admin-theme"), true);
    const assetMatch = loginPageText.match(/src="([^"]+\.js)"/);
    assert.ok(assetMatch?.[1]);

    const adminCss = await fetch(`${baseUrl}/admin.css`);
    assert.equal(adminCss.status, 200);
    assert.equal(adminCss.headers.get("content-type")?.includes("text/css"), true);
    const adminCssText = await adminCss.text();
    assert.equal(adminCssText.includes(".app-shell"), true);
    assert.equal(adminCssText.includes(".filter-summary"), true);
    assert.equal(adminCssText.includes(".detail-block"), true);
    assert.equal(adminCssText.includes(".page-loading"), true);
    assert.equal(adminCssText.includes('html[data-theme="dark"]'), true);
    assert.equal(adminCssText.includes(".theme-control"), true);
    assert.equal(adminCssText.includes(".group-config-summary"), true);
    assert.equal(adminCssText.includes(".settings-layout"), true);
    assert.equal(adminCssText.includes(".status-tabs"), true);
    assert.equal(adminCssText.includes(".review-row"), true);
    assert.equal(adminCssText.includes(".memory-group"), true);
    assert.equal(adminCssText.includes(".filter-panel"), true);
    assert.equal(adminCssText.includes(".sticky-actions"), true);

    const adminLoginJs = await fetch(`${baseUrl}/admin-login.js`);
    assert.equal(adminLoginJs.status, 200);
    assert.equal(adminLoginJs.headers.get("content-type")?.includes("javascript"), true);
    const adminLoginJsText = await adminLoginJs.text();
    assert.equal(adminLoginJsText.includes("/api/login"), true);
    assert.doesNotThrow(() => new Function(adminLoginJsText));

    const badLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    assert.equal(badLogin.status, 401);

    for (let index = 0; index < 5; index += 1) {
      const failed = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "locked-user", password: "wrong" }),
      });
      assert.equal(failed.status, index === 4 ? 401 : 401);
    }
    const lockedLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "locked-user", password: "wrong" }),
    });
    assert.equal(lockedLogin.status, 429);
    assert.deepEqual(await lockedLogin.json(), { error: "too_many_login_attempts" });

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { session: { csrfToken: string } };
    activeCsrfToken = loginBody.session.csrfToken;
    const superAdminCsrfToken = activeCsrfToken;
    assert.match(activeCsrfToken, /^[A-Za-z0-9_-]{32,}$/);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie?.includes("HttpOnly"));

    const unauthenticatedLogout = await globalThis.fetch(`${baseUrl}/api/logout`, { method: "POST" });
    assert.equal(unauthenticatedLogout.status, 401);

    const logoutWithoutCsrf = await globalThis.fetch(`${baseUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(logoutWithoutCsrf.status, 403);
    assert.deepEqual(await logoutWithoutCsrf.json(), { error: "csrf_required" });

    const csrfBlocked = await globalThis.fetch(`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ profileSummaryMaxChars: 1200 }),
    });
    assert.equal(csrfBlocked.status, 403);
    assert.deepEqual(await csrfBlocked.json(), { error: "csrf_required" });

    const invalidJsonBody = await fetch(`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJsonBody.status, 400);
    assert.deepEqual(await invalidJsonBody.json(), { error: "invalid_json" });

    const oversizedJsonBody = await fetch(`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    assert.equal(oversizedJsonBody.status, 413);
    assert.deepEqual(await oversizedJsonBody.json(), { error: "request_body_too_large" });

    const groups = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(groups.status, 200);
    assert.equal(((await groups.json()) as { groups: unknown[] }).groups.length, 1);

    const sessionInfo = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(sessionInfo.status, 200);
    const sessionInfoBody = await sessionInfo.json() as { role: string; username: string; allowedGroupIds: string[] };
    assert.equal(sessionInfoBody.role, "super_admin");
    assert.equal(sessionInfoBody.username, "admin");
    assert.deepEqual(sessionInfoBody.allowedGroupIds, []);

    const notifications = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(notifications.status, 200);
    const notificationsBody = await notifications.json() as { pendingCandidateCount: number; latestCandidates: Array<{ id: string }> };
    assert.equal(notificationsBody.pendingCandidateCount, 2);
    assert.equal(notificationsBody.latestCandidates.some((item) => item.id === batchFactCandidate.id), true);

    const searchedTasksByResult = await fetch(`${baseUrl}/api/tasks?q=profile-http-search&page=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(searchedTasksByResult.status, 200);
    const searchedTasksByResultBody = await searchedTasksByResult.json() as { tasks: Array<{ type: string; subjectUserId?: string }>; pagination: { total: number } };
    assert.equal(searchedTasksByResultBody.pagination.total, 1);
    assert.equal(searchedTasksByResultBody.tasks[0]?.type, "profile-generate");
    assert.equal(searchedTasksByResultBody.tasks[0]?.subjectUserId, "20001");

    const searchedTasksByError = await fetch(`${baseUrl}/api/tasks?q=probe%20timeout&page=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(searchedTasksByError.status, 200);
    const searchedTasksByErrorBody = await searchedTasksByError.json() as { tasks: Array<{ type: string; status: string }>; pagination: { total: number } };
    assert.equal(searchedTasksByErrorBody.pagination.total, 1);
    assert.equal(searchedTasksByErrorBody.tasks[0]?.type, "model-check");
    assert.equal(searchedTasksByErrorBody.tasks[0]?.status, "failed");

    const allScopeTasks = await fetch(`${baseUrl}/api/tasks?page=1&pageSize=20`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(allScopeTasks.status, 200);
    const allScopeTasksBody = await allScopeTasks.json() as { tasks: Array<{ type: string; groupId?: string }>; pagination: { total: number } };
    assert.equal(allScopeTasksBody.pagination.total, 3);
    assert.equal(allScopeTasksBody.tasks.some((task) => task.groupId === "67890" && task.type === "profile-generate"), true);
    assert.equal(allScopeTasksBody.tasks.some((task) => task.groupId === "100200300" && task.type === "bulk-review"), true);
    assert.equal(allScopeTasksBody.tasks.some((task) => !task.groupId && task.type === "model-check"), true);

    const currentGroupTasks = await fetch(`${baseUrl}/api/tasks?groupId=67890&page=1&pageSize=20`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(currentGroupTasks.status, 200);
    const currentGroupTasksBody = await currentGroupTasks.json() as { tasks: Array<{ type: string; groupId?: string }>; pagination: { total: number } };
    assert.equal(currentGroupTasksBody.pagination.total, 1);
    assert.equal(currentGroupTasksBody.tasks[0]?.groupId, "67890");
    assert.equal(currentGroupTasksBody.tasks[0]?.type, "profile-generate");

    const settingsRead = await fetch(`${baseUrl}/api/system-settings`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(settingsRead.status, 200);
    const settingsReadBody = await settingsRead.json() as { models: Array<{ id: string; name: string; shortName: string; baseUrl: string; model: string; purpose: string; enabled: boolean; hasApiKey: boolean }> };
    const settingsUpdate = await fetch(`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        profileSummaryMaxChars: 1200,
        profileShortSummaryMaxChars: 160,
        dailyProfileReviewEnabled: false,
        dailyProfileReviewTime: "01:30",
        memoryDedupEnabled: true,
        memoryDedupTime: "22:15",
        models: [
          ...settingsReadBody.models,
          {
            id: "profile-main",
            name: "Profile Main",
            shortName: "mimo",
            baseUrl: "https://example.test/v1",
            model: "mimo-v2.5-pro",
            purpose: "profile",
            apiKey: "secret-key",
            enabled: true,
            hasApiKey: false,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          {
            id: "reply-pro",
            name: "Reply Pro",
            shortName: "reply-pro",
            baseUrl: "https://reply-pro.example/v1",
            model: "reply-pro-model",
            purpose: "reply",
            apiKey: "reply-pro-key",
            enabled: true,
            hasApiKey: false,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          {
            id: "tts-main",
            name: "TTS Main",
            shortName: "tts",
            baseUrl: "https://tts.example/v1",
            model: "tts-model",
            purpose: "tts",
            apiKey: "tts-secret-key",
            enabled: true,
            hasApiKey: false,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          {
            id: "tts-disabled",
            name: "Disabled TTS",
            shortName: "tts-off",
            baseUrl: "https://tts-disabled.example/v1",
            model: "mimo-v2.5-tts",
            purpose: "tts",
            apiKey: "disabled-tts-key",
            enabled: false,
            hasApiKey: false,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    });
    assert.equal(settingsUpdate.status, 200);
    const settingsUpdateBody = await settingsUpdate.json() as {
      dailyProfileReviewEnabled: boolean;
      dailyProfileReviewTime: string;
      memoryDedupEnabled: boolean;
      memoryDedupTime: string;
      models: Array<{ id: string; hasApiKey: boolean; apiKey?: string }>;
    };
    assert.equal(settingsUpdateBody.dailyProfileReviewEnabled, false);
    assert.equal(settingsUpdateBody.dailyProfileReviewTime, "01:30");
    assert.equal(settingsUpdateBody.memoryDedupTime, "22:15");
    const invalidSettingsUpdate = await fetch(`${baseUrl}/api/system-settings`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ memoryDedupTime: "25:00" }),
    });
    assert.equal(invalidSettingsUpdate.status, 400);
    assert.deepEqual(await invalidSettingsUpdate.json(), { error: "invalid_time" });
    assert.equal(settingsUpdateBody.models[0]?.hasApiKey, true);
    assert.equal(settingsUpdateBody.models[0]?.apiKey, undefined);
    assert.equal(settingsUpdateBody.models.some((item) => item.id === "gpt"), true);
    assert.equal(settingsUpdateBody.models.some((item) => item.id === "mimo"), true);
    const internalSettings = await systemSettingsStore.getInternal();
    assert.equal(internalSettings.models.find((item) => item.id === "profile-main")?.apiKey, "secret-key");
    assert.equal(internalSettings.models.find((item) => item.id === "reply-pro")?.apiKey, "reply-pro-key");
    const settingsReadAfterWrite = await fetch(`${baseUrl}/api/system-settings`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(settingsReadAfterWrite.status, 200);
    const settingsReadAfterWriteBody = await settingsReadAfterWrite.json() as { models: Array<{ id: string; hasApiKey: boolean; apiKey?: string }> };
    assert.equal(settingsReadAfterWriteBody.models[0]?.hasApiKey, true);
    assert.equal(settingsReadAfterWriteBody.models[0]?.apiKey, undefined);
    assert.equal(settingsReadAfterWriteBody.models.some((item) => item.id === "gpt"), true);
    assert.equal(settingsReadAfterWriteBody.models.some((item) => item.id === "mimo"), true);
    assert.equal(settingsReadAfterWriteBody.models.every((item) => item.apiKey === undefined), true);

    const modelOptions = await fetch(`${baseUrl}/api/model-options`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(modelOptions.status, 200);
    const modelOptionsBody = await modelOptions.json() as {
      models: Array<{ id: string; apiKey?: string; hasApiKey: boolean }>;
      replyModels: Array<{ id: string; label: string; apiKey?: string }>;
    };
    assert.equal(modelOptionsBody.models.some((item) => item.id === "gpt" && item.hasApiKey), true);
    assert.equal(modelOptionsBody.models.some((item) => item.id === "mimo" && item.hasApiKey), true);
    assert.equal(modelOptionsBody.models.every((item) => item.apiKey === undefined), true);
    assert.equal(modelOptionsBody.replyModels.some((item) => item.id === "reply-pro" && item.label.includes("reply-pro")), true);
    assert.equal(modelOptionsBody.replyModels.some((item) => item.id === "mimo" || item.id === "profile-main"), false);
    assert.equal(modelOptionsBody.replyModels.every((item) => item.apiKey === undefined), true);

    const originalFetchForAllModels = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith(baseUrl)) {
        return originalFetchForAllModels(input, init);
      }
      return new Response(JSON.stringify({ error: "probe failed" }), { status: 503, headers: { "Content-Type": "application/json" } });
    };
    let allModelCheck: Response | undefined;
    try {
      allModelCheck = await fetch(`${baseUrl}/api/models/test-all`, {
        method: "POST",
        headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      globalThis.fetch = originalFetchForAllModels;
    }
    assert.ok(allModelCheck);
    assert.equal(allModelCheck.status, 200);
    const allModelCheckBody = await allModelCheck.json() as { statuses: Array<{ id: string; ok: boolean; purpose: string; skipped?: boolean }>; summary: { total: number; abnormal: number } };
    assert.equal(allModelCheckBody.statuses.some((item) => item.id === "reply-pro" && item.ok === false), true);
    assert.equal(allModelCheckBody.statuses.some((item) => item.id === "gpt" && item.purpose === "reply"), true);
    assert.equal(allModelCheckBody.statuses.some((item) => item.id === "tts-disabled" && item.ok === true && item.skipped === true), true);
    assert.equal(allModelCheckBody.statuses.some((item) => item.id === "tts-disabled" && item.ok === false), false);
    assert.ok(allModelCheckBody.summary.total >= allModelCheckBody.statuses.length);
    assert.ok(allModelCheckBody.summary.abnormal > 0);
    const allCheckHistory = await modelHealthHistoryStore.list();
    assert.equal(allCheckHistory.some((item) => item.id === "reply-pro" && item.source === "manual"), true);

    const skillsList = await fetch(`${baseUrl}/api/skills`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(skillsList.status, 200);
    assert.equal(((await skillsList.json()) as { skills: Array<{ id: string }> }).skills.some((item) => item.id === "assistant"), true);

    const createSkill = await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "memory_helper",
        name: "Memory Helper",
        systemPrompt: "Help organize memory safely.",
        styleRules: ["Be concise."],
        knowledge: ["Use verified facts."],
        temperature: 0.6,
        maxContextTurns: 8,
      }),
    });
    assert.equal(createSkill.status, 201);
    const createSkillBody = await createSkill.json() as { id: string; name: string; styleRules: string[] };
    assert.equal(createSkillBody.id, "memory_helper");
    assert.equal(createSkillBody.name, "Memory Helper");
    assert.deepEqual(createSkillBody.styleRules, ["Be concise."]);

    const duplicateSkill = await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "memory_helper",
        name: "Memory Helper",
        systemPrompt: "Duplicate.",
        styleRules: [],
        knowledge: [],
        temperature: 0.7,
        maxContextTurns: 8,
      }),
    });
    assert.equal(duplicateSkill.status, 400);
    assert.equal(((await duplicateSkill.json()) as { error: string }).error, "skill_exists");

    const invalidSkill = await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "../bad",
        name: "Bad",
        systemPrompt: "Bad.",
        styleRules: [],
        knowledge: [],
        temperature: 0.7,
        maxContextTurns: 8,
      }),
    });
    assert.equal(invalidSkill.status, 400);
    assert.equal(((await invalidSkill.json()) as { error: string }).error, "invalid_skill_id");

    const readSkill = await fetch(`${baseUrl}/api/skills/memory_helper`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(readSkill.status, 200);
    assert.equal(((await readSkill.json()) as { id: string }).id, "memory_helper");

    const updateSkill = await fetch(`${baseUrl}/api/skills/memory_helper`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Memory Helper Updated",
        systemPrompt: "Help organize memory safely and briefly.",
        styleRules: ["Be concise.", "Keep Chinese output."],
        knowledge: ["Use verified facts."],
        temperature: 0.5,
        maxContextTurns: 10,
      }),
    });
    assert.equal(updateSkill.status, 200);
    const updateSkillBody = await updateSkill.json() as { id: string; name: string; maxContextTurns: number };
    assert.equal(updateSkillBody.id, "memory_helper");
    assert.equal(updateSkillBody.name, "Memory Helper Updated");
    assert.equal(updateSkillBody.maxContextTurns, 10);

    const exportSkill = await fetch(`${baseUrl}/api/skills/export?id=memory_helper`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(exportSkill.status, 200);
    const exportSkillBody = await exportSkill.json() as { id: string; raw: string };
    assert.equal(exportSkillBody.id, "memory_helper");
    assert.equal(JSON.parse(exportSkillBody.raw).name, "Memory Helper Updated");

    const importSkill = await fetch(`${baseUrl}/api/skills/import`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: JSON.stringify({
          id: "imported_skill",
          name: "Imported Skill",
          systemPrompt: "Imported prompt.",
          styleRules: [],
          knowledge: [],
          temperature: 0.7,
          maxContextTurns: 12,
        }),
      }),
    });
    assert.equal(importSkill.status, 201);
    assert.equal(((await importSkill.json()) as { id: string }).id, "imported_skill");

    const invalidSkillImport = await fetch(`${baseUrl}/api/skills/import`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "{bad json" }),
    });
    assert.equal(invalidSkillImport.status, 400);
    assert.equal(((await invalidSkillImport.json()) as { error: string }).error, "invalid_skill_json");

    const backupSkills = await fetch(`${baseUrl}/api/skills/backup`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(backupSkills.status, 200);
    const backupSkillsBody = await backupSkills.json() as { backupDir: string; files: string[] };
    assert.equal(typeof backupSkillsBody.backupDir, "string");
    assert.equal(backupSkillsBody.files.includes("assistant.json"), true);
    assert.equal(backupSkillsBody.files.includes("memory_helper.json"), true);

    const deleteImportedSkill = await fetch(`${baseUrl}/api/skills/imported_skill`, {
      method: "DELETE",
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(deleteImportedSkill.status, 200);
    assert.equal(((await deleteImportedSkill.json()) as { ok: boolean }).ok, true);

    const commandsList = await fetch(`${baseUrl}/api/commands`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(commandsList.status, 200);
    const commandsListBody = await commandsList.json() as {
      commands: Array<{
        id: string;
        title: string;
        primary: string;
        aliases: string[];
        permission: string;
        enabled: boolean;
        help: string;
      }>;
    };
    assert.equal(commandsListBody.commands.length > 0, true);
    const originalProfileCommand = commandsListBody.commands.find((item) => item.id === "profile_yesterday");
    assert.ok(originalProfileCommand);

    const commandsUpdate = await fetch(`${baseUrl}/api/commands`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          {
            ...originalProfileCommand,
            title: "Yesterday Profile",
            primary: "#昨日报告",
            aliases: ["#昨日画像", "#昨天画像", "#昨日画像"],
            permission: "super_admin",
            help: "Updated help text",
          },
          {
            id: "unknown_dangerous_command",
            title: "Danger",
            primary: "#danger",
            aliases: [],
            permission: "super_admin",
            enabled: true,
            help: "Must be ignored",
          },
        ],
      }),
    });
    assert.equal(commandsUpdate.status, 200);
    const commandsUpdateBody = await commandsUpdate.json() as { commands: typeof commandsListBody.commands };
    const updatedProfileCommand = commandsUpdateBody.commands.find((item) => item.id === "profile_yesterday");
    assert.equal(updatedProfileCommand?.title, "Yesterday Profile");
    assert.equal(updatedProfileCommand?.primary, "#昨日报告");
    assert.deepEqual(updatedProfileCommand?.aliases, ["#昨日画像", "#昨天画像"]);
    assert.equal(updatedProfileCommand?.permission, originalProfileCommand.permission);
    assert.equal(updatedProfileCommand?.help, "Updated help text");
    assert.equal(commandsUpdateBody.commands.some((item) => item.id === "unknown_dangerous_command"), false);

    const compressedGroups = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: cookie ?? "", "Accept-Encoding": "gzip" },
    });
    assert.equal(compressedGroups.status, 200);
    assert.equal(compressedGroups.headers.get("content-encoding"), null);
    assert.equal(((await compressedGroups.json()) as { groups: unknown[] }).groups.length, 1);

    const dashboardPage = await fetch(`${baseUrl}/`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(dashboardPage.status, 200);
    const dashboardPageText = await dashboardPage.text();
    assert.equal(dashboardPageText.includes('id="app"'), true);
    assert.equal(dashboardPageText.includes("/assets/"), true);

    const vueAsset = await fetch(`${baseUrl}${assetMatch[1]}`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(vueAsset.status, 200);
    assert.equal(vueAsset.headers.get("content-type")?.includes("javascript"), true);
    const vueAssetText = await vueAsset.text();
    assert.equal(vueAssetText.includes("/api/session"), true);
    assert.equal(vueAssetText.includes("ubot-admin-theme"), true);
    assert.equal(vueAssetText.includes("CandidatesView-"), true);
    const candidateAssetPath = vueAssetText.match(/assets\/CandidatesView-[^"']+\.js/)?.[0];
    assert.ok(candidateAssetPath);
    const candidateAsset = await fetch(`${baseUrl}/${candidateAssetPath}`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(candidateAsset.status, 200);
    assert.equal(candidateAsset.headers.get("content-type")?.includes("javascript"), true);
    const candidateAssetText = await candidateAsset.text();
    assert.equal(candidateAssetText.includes("/api/memory-candidates/bulk-approve"), true);

    const adminAppJs = await fetch(`${baseUrl}/admin-app.js`);
    assert.equal(adminAppJs.status, 200);
    assert.equal(adminAppJs.headers.get("content-type")?.includes("javascript"), true);
    const adminAppJsText = await adminAppJs.text();
    assert.equal(adminAppJsText.includes("renderOverview"), true);
    assert.equal(adminAppJsText.includes("query.set('evidence', 'preview')"), true);
    assert.equal(adminAppJsText.includes("data-load-evidence"), true);
    assert.equal(adminAppJsText.includes("readStateFromUrl()"), true);
    assert.equal(adminAppJsText.includes("syncUrlState"), true);
    assert.equal(adminAppJsText.includes("popstate"), true);
    assert.equal(adminAppJsText.includes("history[replace ? 'replaceState' : 'pushState']"), true);
    assert.equal(adminAppJsText.includes("filterSummaryHtml"), true);
    assert.equal(adminAppJsText.includes("data-clear-candidate-filters"), true);
    assert.equal(adminAppJsText.includes("data-clear-member-filters"), true);
    assert.equal(adminAppJsText.includes("data-clear-knowledge-filters"), true);
    assert.equal(adminAppJsText.includes("expandedCandidateIds"), true);
    assert.equal(adminAppJsText.includes("data-toggle-memory-details"), true);
    assert.equal(adminAppJsText.includes("ownerMemberOptionsSlotHtml(renderOptions = false)"), true);
    assert.equal(adminAppJsText.includes("groupsLoadedAt"), true);
    assert.equal(adminAppJsText.includes("data-refresh-groups"), true);
    assert.equal(adminAppJsText.includes("setPageLoading"), true);
    assert.equal(adminAppJsText.includes("renderCacheTtlMs"), true);
    assert.equal(adminAppJsText.includes("invalidateRenderCache"), true);
    assert.equal(adminAppJsText.includes("cloneData"), true);
    assert.equal(adminAppJsText.includes("themeStorageKey"), true);
    assert.equal(adminAppJsText.includes("applyTheme"), true);
    assert.equal(adminAppJsText.includes("prefers-color-scheme"), true);
    assert.equal(adminAppJsText.includes("looksLikeMemberSearch"), true);
    assert.equal(adminAppJsText.includes("data-jump-view=\"health\""), true);
    assert.equal(adminAppJsText.includes("data-load-profile-summary"), true);
    assert.equal(adminAppJsText.includes("profile-summary?type="), true);
    assert.equal(adminAppJsText.includes("group-config-summary"), true);
    assert.equal(adminAppJsText.includes("settings-layout"), true);
    assert.equal(adminAppJsText.includes("status-tabs"), true);
    assert.equal(adminAppJsText.includes("review-row"), true);
    assert.equal(adminAppJsText.includes("memory-group"), true);
    assert.equal(adminAppJsText.includes("filter-panel"), true);
    assert.equal(adminAppJsText.includes("sticky-actions"), true);
    assert.equal(adminAppJsText.includes("候选记忆审核"), true);
    assert.equal(adminAppJsText.includes("长期记忆库"), true);
    assert.equal(adminAppJsText.includes("查看群聊画像"), true);
    assert.equal(adminAppJsText.includes("查看昨日画像"), true);
    assert.doesNotThrow(() => new Function(adminAppJsText));

    const compressedAdminAppJs = await rawGet(`${baseUrl}/admin-app.js`, { "Accept-Encoding": "gzip" });
    assert.equal(compressedAdminAppJs.statusCode, 200);
    assert.equal(compressedAdminAppJs.headers["content-encoding"], "gzip");
    assert.equal(compressedAdminAppJs.headers.vary, "Accept-Encoding");
    assert.equal(gunzipSync(compressedAdminAppJs.body).toString("utf8").includes("renderOverview"), true);

    const compressedVueAsset = await rawGet(`${baseUrl}${assetMatch[1]}`, { Cookie: cookie ?? "", "Accept-Encoding": "gzip" });
    assert.equal(compressedVueAsset.statusCode, 200);
    assert.equal(compressedVueAsset.headers["content-type"]?.includes("javascript"), true);

    const overview = await fetch(`${baseUrl}/api/overview?groupId=67890`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as {
      groupId?: string;
      stats: { groupCount: number; memoryCount: number; pendingCandidateCount: number; knowledgeCount: number };
      profileAiHealth?: { ok: boolean; detail: string; model: string; baseUrl: string; latencyMs: number; cached: boolean };
      recent?: {
        candidates: Array<{ id: string; title: string; subjectLabel?: { label: string } }>;
        memories: Array<{ title: string; subjectLabel?: { label: string } }>;
        knowledge: Array<{ id: string; title: string }>;
      };
    };
    assert.equal(overviewBody.groupId, "67890");
    assert.equal(overviewBody.stats.groupCount, 1);
    assert.equal(overviewBody.stats.memoryCount, 3);
    assert.equal(overviewBody.stats.pendingCandidateCount, 2);
    assert.equal(overviewBody.stats.knowledgeCount, 2);
    assert.deepEqual(overviewBody.profileAiHealth, {
      ok: true,
      detail: "profile ok",
      model: "mimo-v2.5-pro",
      baseUrl: "https://profile.example/v1",
      checkedAt: "2026-06-03T00:00:00.000Z",
      latencyMs: 12,
      cached: false,
    });
    assert.equal(overviewBody.recent?.candidates.some((candidate) => candidate.id === orphanCandidate.id), true);
    assert.equal(overviewBody.recent?.candidates.some((candidate) => candidate.id === batchFactCandidate.id), true);
    assert.equal(overviewBody.recent?.memories[0]?.title, "Another fact");
    assert.equal(overviewBody.recent?.knowledge.some((entry) => entry.id === knowledgeEntry.id), true);

    const unauthorizedMembers = await fetch(`${baseUrl}/api/groups/67890/members`);
    assert.equal(unauthorizedMembers.status, 401);

    const unauthorizedProfileSummary = await fetch(`${baseUrl}/api/groups/67890/members/20001/profile-summary?type=overall`);
    assert.equal(unauthorizedProfileSummary.status, 401);

    const unauthorizedGroupConfig = await fetch(`${baseUrl}/api/groups/67890/config`);
    assert.equal(unauthorizedGroupConfig.status, 401);

    const groupConfig = await fetch(`${baseUrl}/api/groups/67890/config`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(groupConfig.status, 200);
    const groupConfigBody = await groupConfig.json() as { groupId: string; replyModelMode: string; dailyReportEnabled: boolean };
    assert.equal(groupConfigBody.groupId, "67890");
    assert.equal(groupConfigBody.replyModelMode, "gpt");
    assert.equal(groupConfigBody.dailyReportEnabled, true);

    const invalidGroupConfig = await fetch(`${baseUrl}/api/groups/67890/config`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ ...groupConfigBody, switcherUserIds: ["bad"] }),
    });
    assert.equal(invalidGroupConfig.status, 400);
    assert.deepEqual(await invalidGroupConfig.json(), { error: "invalid_user_ids" });

    const updateGroupConfig = await fetch(`${baseUrl}/api/groups/67890/config`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        currentSkillId: "assistant",
        replyModelMode: "mimo",
        allowedSkillIds: ["assistant", "assistant", "zxp"],
        switcherUserIds: ["99999"],
        liveChatUserIds: ["20001"],
        manualIdentities: [],
        liveChatDelaySeconds: 45,
        dailyReportEnabled: true,
        dailyReportTime: "18:30",
        dailyReportTopUserCount: 5,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "08:15",
        botMuted: false,
        scheduledRemindersEnabled: true,
        blacklistedUserIds: ["30002"],
        opsAlertsEnabled: true,
      }),
    });
    assert.equal(updateGroupConfig.status, 200);
    const updateGroupConfigBody = await updateGroupConfig.json() as {
      replyModelMode: string;
      allowedSkillIds: string[];
      liveChatDelaySeconds: number;
      dailyReportEnabled: boolean;
      botMuted: boolean;
      manualIdentities?: Array<{ userIds: string[]; names: string[]; note?: string }>;
    };
    assert.equal(updateGroupConfigBody.replyModelMode, "mimo");
    assert.deepEqual(updateGroupConfigBody.allowedSkillIds, ["assistant", "zxp"]);
    assert.equal(updateGroupConfigBody.liveChatDelaySeconds, 45);
    assert.equal(updateGroupConfigBody.dailyReportEnabled, true);
    assert.equal(updateGroupConfigBody.botMuted, false);
    assert.deepEqual(updateGroupConfigBody.manualIdentities ?? [], []);

    const schedulePreview = await fetch(`${baseUrl}/api/groups/67890/schedule-preview?days=2`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(schedulePreview.status, 200);
    const schedulePreviewBody = await schedulePreview.json() as {
      days: number;
      previews: Array<{ date: string; items: Array<{ type: string; time: string; enabled: boolean }> }>;
    };
    const localToday = new Date();
    localToday.setHours(0, 0, 0, 0);
    assert.equal(schedulePreviewBody.days, 2);
    assert.equal(schedulePreviewBody.previews.length, 2);
    assert.equal(schedulePreviewBody.previews[0]?.date, formatTestLocalDateKey(localToday));
    assert.equal(schedulePreviewBody.previews[1]?.date, formatTestLocalDateKey(new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() + 1)));
    assert.deepEqual(
      schedulePreviewBody.previews[0]?.items.map((item) => [item.type, item.time, item.enabled]),
      [["holiday_countdown", "08:15", true], ["daily_report", "18:30", true]],
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }
      return new Response("api_key=secret-key Authorization: Bearer sk-testsecret", { status: 401 });
    };
    let health: Response | undefined;
    try {
      health = await fetch(`${baseUrl}/api/health?refresh=1`, {
        headers: { Cookie: cookie ?? "" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(health);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as {
      profileAiHealth?: { detail: string };
      modelStatuses: Array<{ id: string; detail: string; baseUrl?: string; model?: string }>;
      serverStatus?: unknown;
      pid?: number;
    };
    assert.equal(healthBody.profileAiHealth?.detail, "profile refreshed");
    assert.ok(healthBody.serverStatus);
    assert.equal(typeof healthBody.pid, "number");
    const ttsHealth = healthBody.modelStatuses.find((item) => item.id === "tts-main");
    assert.ok(ttsHealth);
    assert.equal(ttsHealth.detail.includes("secret-key"), false);
    assert.equal(ttsHealth.detail.includes("sk-testsecret"), false);
    assert.equal(ttsHealth.detail.includes("[REDACTED]"), true);
    const ttsHistory = (await modelHealthHistoryStore.list()).find((item) => item.id === "tts-main");
    assert.ok(ttsHistory);
    assert.equal(ttsHistory.detail.includes("secret-key"), false);
    assert.equal(ttsHistory.detail.includes("sk-testsecret"), false);
    assert.equal(lastProfileHealthRefresh, true);
    assert.ok(profileHealthCalls >= 2);

    const members = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(members.status, 200);
    const memberBody = await members.json() as { members: Array<{ userId: string; displayName: string; memoryCount: number; pendingCandidateCount: number }>; pagination: { page: number; pageSize: number; total: number; totalPages: number } };
    assert.equal(memberBody.members.some((member) => member.userId === "20001" && member.memoryCount === 1), true);
    assert.equal(memberBody.pagination.total, 1);
    assert.equal(listGroupMembersCalls, 0);

    const pagedMembers = await fetch(`${baseUrl}/api/groups/67890/members?page=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(pagedMembers.status, 200);
    const pagedMemberBody = await pagedMembers.json() as typeof memberBody;
    assert.equal(pagedMemberBody.members.length, 1);
    assert.equal(pagedMemberBody.pagination.total, 1);
    assert.equal(listGroupMembersCalls, 0);

    const searchedMembers = await fetch(`${baseUrl}/api/groups/67890/members?q=Newbie&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(searchedMembers.status, 200);
    const searchedMemberBody = await searchedMembers.json() as typeof memberBody;
    assert.equal(searchedMemberBody.pagination.total, 0);
    assert.equal(listGroupMembersCalls, 0);

    const refreshedMembers = await fetch(`${baseUrl}/api/groups/67890/members?refresh=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(refreshedMembers.status, 200);
    const refreshedMemberBody = await refreshedMembers.json() as typeof memberBody;
    assert.equal(refreshedMemberBody.pagination.total, 2);
    assert.equal(refreshedMemberBody.members.some((member) => member.userId === "20001" && member.displayName === "TesterCard" && member.memoryCount === 1), true);
    assert.ok(listGroupMembersCalls >= 1);
    const callsAfterFirstMemberLoad = listGroupMembersCalls;

    const searchedSyncedMembers = await fetch(`${baseUrl}/api/groups/67890/members?q=Newbie&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(searchedSyncedMembers.status, 200);
    const searchedSyncedMemberBody = await searchedSyncedMembers.json() as typeof memberBody;
    assert.equal(searchedSyncedMemberBody.pagination.total, 1);
    assert.equal(searchedSyncedMemberBody.members[0]?.userId, "30002");
    assert.equal(listGroupMembersCalls, callsAfterFirstMemberLoad);

    const allMembers = await fetch(`${baseUrl}/api/groups/67890/members?all=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(allMembers.status, 200);
    const allMemberBody = await allMembers.json() as typeof memberBody;
    assert.equal(allMemberBody.members.length, 2);
    assert.equal(allMemberBody.pagination.totalPages, 1);
    assert.equal(listGroupMembersCalls, callsAfterFirstMemberLoad);

    const cachedMembers = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(cachedMembers.status, 200);
    assert.equal(listGroupMembersCalls, callsAfterFirstMemberLoad);

    const memoryCountBeforeProfileRecords = (await groupMemoryStore.list("67890")).length;
    const overallProfileSummary = await fetch(`${baseUrl}/api/groups/67890/members/20001/profile-summary?type=overall&refresh=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(overallProfileSummary.status, 200);
    const overallProfileSummaryBody = await overallProfileSummary.json() as { groupId: string; userId: string; type: string; summary: string; generatedAt: string; memoryCount: number; cached: boolean; subjectLabel?: { label: string } };
    assert.equal(overallProfileSummaryBody.groupId, "67890");
    assert.equal(overallProfileSummaryBody.userId, "20001");
    assert.equal(overallProfileSummaryBody.type, "overall");
    assert.equal(overallProfileSummaryBody.summary, "20001 完整群聊画像。");
    assert.equal(overallProfileSummaryBody.generatedAt, "2026-06-03T10:00:00.000Z");
    assert.equal(overallProfileSummaryBody.memoryCount, 3);
    assert.equal(overallProfileSummaryBody.cached, false);
    assert.equal(overallProfileSummaryBody.subjectLabel?.label.includes("QQ 20001"), true);

    const profileRecords = await fetch(`${baseUrl}/api/profile-records?groupId=67890&userId=20001&type=overall`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(profileRecords.status, 200);
    const profileRecordsBody = await profileRecords.json() as { records: Array<{ groupId: string; userId: string; type: string; summary: string }> };
    assert.equal(profileRecordsBody.records.length, 1);
    assert.equal(profileRecordsBody.records[0]?.groupId, "67890");
    assert.equal(profileRecordsBody.records[0]?.userId, "20001");
    assert.equal(profileRecordsBody.records[0]?.type, "overall");

    const cachedOverallProfileSummary = await fetch(`${baseUrl}/api/groups/67890/members/20001/profile-summary?type=overall`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(cachedOverallProfileSummary.status, 200);
    const cachedOverallProfileSummaryBody = await cachedOverallProfileSummary.json() as { summary: string; cached: boolean; sourceMemoryCount: number; record?: { id: string } };
    assert.equal(cachedOverallProfileSummaryBody.summary, "20001 完整群聊画像。");
    assert.equal(cachedOverallProfileSummaryBody.cached, true);
    assert.equal(cachedOverallProfileSummaryBody.sourceMemoryCount, 3);
    const profileRecordsAfterCachedRead = await fetch(`${baseUrl}/api/profile-records?groupId=67890&userId=20001&type=overall`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(((await profileRecordsAfterCachedRead.json()) as { records: unknown[] }).records.length, 1);

    const refreshedOverallProfileSummary = await fetch(`${baseUrl}/api/groups/67890/members/20001/profile-summary?type=overall&refresh=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(refreshedOverallProfileSummary.status, 200);
    assert.equal(((await refreshedOverallProfileSummary.json()) as { cached: boolean }).cached, false);
    const profileRecordsAfterRefresh = await fetch(`${baseUrl}/api/profile-records?groupId=67890&userId=20001&type=overall`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(((await profileRecordsAfterRefresh.json()) as { records: unknown[] }).records.length, 2);

    const createdProfileRecord = await fetch(`${baseUrl}/api/profile-records`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", userId: "20001", type: "overall" }),
    });
    assert.equal(createdProfileRecord.status, 201);
    const createdProfileRecordBody = await createdProfileRecord.json() as { record?: { id: string; type: string; createdBy: string; shareToken?: string }; summary: string; cached: boolean };
    assert.equal(createdProfileRecordBody.summary, "20001 完整群聊画像。");
    assert.equal(createdProfileRecordBody.cached, false);
    assert.equal(createdProfileRecordBody.record?.type, "overall");
    assert.equal(createdProfileRecordBody.record?.createdBy, "admin");
    assert.ok(createdProfileRecordBody.record?.id);
    assert.match(createdProfileRecordBody.record?.shareToken ?? "", /^[A-Za-z0-9_-]{32,}$/);

    const publicProfile = await fetch(`${baseUrl}/profile/${createdProfileRecordBody.record.shareToken}`);
    assert.equal(publicProfile.status, 200);
    const publicProfileText = await publicProfile.text();
    assert.equal(publicProfileText.includes("20001 完整群聊画像。"), true);
    assert.equal(publicProfileText.includes("noindex,nofollow"), true);
    assert.equal(publicProfileText.includes("groupId"), false);
    assert.equal(publicProfileText.includes("后台"), false);

    const regeneratedProfileRecord = await fetch(`${baseUrl}/api/profile-records/${createdProfileRecordBody.record.id}`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(regeneratedProfileRecord.status, 200);
    const regeneratedProfileRecordBody = await regeneratedProfileRecord.json() as { record?: { id: string; shareToken?: string }; cached: boolean };
    assert.equal(regeneratedProfileRecordBody.record?.id, createdProfileRecordBody.record.id);
    assert.equal(regeneratedProfileRecordBody.record?.shareToken, createdProfileRecordBody.record.shareToken);
    assert.equal(regeneratedProfileRecordBody.cached, false);

    const yesterdayProfileSummary = await fetch(`${baseUrl}/api/groups/67890/members/20001/profile-summary?type=yesterday&refresh=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(yesterdayProfileSummary.status, 200);
    const yesterdayProfileSummaryBody = await yesterdayProfileSummary.json() as { type: string; summary: string; memoryCount: number; cached: boolean };
    assert.equal(yesterdayProfileSummaryBody.type, "yesterday");
    assert.equal(yesterdayProfileSummaryBody.summary, "20001 完整昨日画像。");
    assert.equal(yesterdayProfileSummaryBody.memoryCount, 1);
    assert.equal(yesterdayProfileSummaryBody.cached, true);
    assert.equal((await groupMemoryStore.list("67890")).length, memoryCountBeforeProfileRecords);
    const profileRecordsForPermission = await fetch(`${baseUrl}/api/profile-records?groupId=67890&userId=20001`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(profileRecordsForPermission.status, 200);
    const profileRecordsForPermissionBody = await profileRecordsForPermission.json() as { records: Array<{ id: string }> };
    const profileRecordIdForPermission = profileRecordsForPermissionBody.records[0]?.id;
    assert.ok(profileRecordIdForPermission);

    const invalidPublicProfile = await fetch(`${baseUrl}/profile/not-a-real-share-token-1234567890`);
    assert.equal(invalidPublicProfile.status, 404);
    assert.equal((await invalidPublicProfile.text()).includes("画像不存在或已失效"), true);

    const disposableProfileRecord = await fetch(`${baseUrl}/api/profile-records`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", userId: "20001", type: "overall" }),
    });
    assert.equal(disposableProfileRecord.status, 201);
    const disposableProfileRecordBody = await disposableProfileRecord.json() as { record?: { id: string; shareToken?: string } };
    assert.ok(disposableProfileRecordBody.record?.id);
    assert.ok(disposableProfileRecordBody.record?.shareToken);
    const deletePublicProfileRecord = await fetch(`${baseUrl}/api/profile-records/${disposableProfileRecordBody.record.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(deletePublicProfileRecord.status, 200);
    const deletedPublicProfile = await fetch(`${baseUrl}/profile/${disposableProfileRecordBody.record.shareToken}`);
    assert.equal(deletedPublicProfile.status, 404);

    const updateIdentity = await fetch(`${baseUrl}/api/groups/67890/members/30002/identity`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["新人"], note: "测试备注" }),
    });
    assert.equal(updateIdentity.status, 200);
    const updateIdentityBody = await updateIdentity.json() as { member?: { userId: string; displayName: string; aliases: string[]; note?: string; hasManualIdentity: boolean; memoryCount: number; pendingCandidateCount: number } };
    assert.deepEqual(updateIdentityBody.member, {
      userId: "30002",
      displayName: "新人",
      nickname: "Newbie",
      role: "member",
      aliases: ["新人"],
      note: "测试备注",
      hasManualIdentity: true,
      memoryCount: 0,
      pendingCandidateCount: 0,
      memoryDisabled: false,
    });
    const updatedGroups = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: cookie ?? "" },
    });
    const updatedGroupBody = await updatedGroups.json() as { groups: Array<{ manualIdentities?: Array<{ userIds: string[]; names: string[]; note?: string }> }> };
    assert.deepEqual(updatedGroupBody.groups[0]?.manualIdentities?.find((identity) => identity.userIds.includes("30002")), {
      userIds: ["30002"],
      names: ["新人"],
      note: "测试备注",
    });
    const membersAfterIdentityUpdate = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(membersAfterIdentityUpdate.status, 200);
    const membersAfterIdentityUpdateBody = await membersAfterIdentityUpdate.json() as { members: Array<{ userId: string; note?: string; aliases?: string[] }> };
    assert.equal(membersAfterIdentityUpdateBody.members.find((member) => member.userId === "30002")?.note, "测试备注");

    const listCallsBeforeLightPages = listGroupMembersCalls;
    const memories = await fetch(`${baseUrl}/api/memories?groupId=67890&page=1&pageSize=2`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memoryBody = await memories.json() as { memories: Array<{ id: string; title: string; type: string; subjectUserId?: string; content: string; confidence: number; enabled: boolean; evidence?: { messageCount: number }; subjectLabel?: { label: string } }>; pagination: { page: number; pageSize: number; total: number; totalPages: number } };
    assert.equal(memoryBody.pagination.total, 3);
    assert.equal(memoryBody.memories.length, 2);
    assert.equal(memoryBody.memories[0]?.title, "Another fact");
    assert.equal(memoryBody.memories[1]?.title, "Latest fact");
    assert.equal(listGroupMembersCalls, listCallsBeforeLightPages);

    const previewMemories = await fetch(`${baseUrl}/api/memories?groupId=67890&q=concise&page=1&pageSize=2&evidence=preview`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(previewMemories.status, 200);
    const previewMemoryBody = await previewMemories.json() as {
      memories: Array<{ id: string; evidence?: { messageCount: number; speakerCount?: number; summaryPreview?: string; summary?: string; speakers?: unknown[]; hasFullEvidence?: boolean } }>;
    };
    const previewEvidence = previewMemoryBody.memories.find((memory) => memory.evidence)?.evidence;
    assert.equal(previewEvidence?.hasFullEvidence, true);
    assert.equal(previewEvidence?.messageCount, 3);
    assert.equal(previewEvidence?.speakerCount, 1);
    assert.equal(typeof previewEvidence?.summaryPreview, "string");
    assert.equal(previewEvidence?.summary, undefined);
    assert.equal(previewEvidence?.speakers, undefined);

    const memoryDetail = await fetch(`${baseUrl}/api/memories/${previewMemoryBody.memories.find((memory) => memory.evidence)!.id}`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(memoryDetail.status, 200);
    const memoryDetailBody = await memoryDetail.json() as { evidence?: { summary?: string; speakers?: unknown[] } };
    assert.equal(typeof memoryDetailBody.evidence?.summary, "string");
    assert.equal(Array.isArray(memoryDetailBody.evidence?.speakers), true);

    const invalidBulkMemory = await fetch(`${baseUrl}/api/memories/bulk`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "archive", ids: [memoryBody.memories[0]!.id] }),
    });
    assert.equal(invalidBulkMemory.status, 400);

    const bulkDisableMemories = await fetch(`${baseUrl}/api/memories/bulk`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", ids: [memoryBody.memories[0]!.id, "missing"] }),
    });
    assert.equal(bulkDisableMemories.status, 200);
    const bulkDisableBody = await bulkDisableMemories.json() as {
      processedCount: number;
      skippedCount: number;
      processed: Array<{ id: string; memory?: { id: string; enabled: boolean; subjectLabel?: { label: string } } }>;
      skipped: Array<{ id: string; error: string }>;
    };
    assert.equal(bulkDisableBody.processedCount, 1);
    assert.equal(bulkDisableBody.skippedCount, 1);
    assert.equal(bulkDisableBody.processed[0]?.memory?.enabled, false);
    assert.equal(bulkDisableBody.skipped[0]?.error, "not_found");

    const bulkDeleteMemories = await fetch(`${baseUrl}/api/memories/bulk`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids: [memoryBody.memories[1]!.id] }),
    });
    assert.equal(bulkDeleteMemories.status, 200);
    const bulkDeleteBody = await bulkDeleteMemories.json() as { processedCount: number; skippedCount: number };
    assert.equal(bulkDeleteBody.processedCount, 1);
    assert.equal(bulkDeleteBody.skippedCount, 0);

    const lightCandidates = await fetch(`${baseUrl}/api/memory-candidates?groupId=67890&page=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(lightCandidates.status, 200);
    assert.equal(listGroupMembersCalls, listCallsBeforeLightPages);

    const previewCandidates = await fetch(`${baseUrl}/api/memory-candidates?groupId=67890&page=1&pageSize=10&evidence=preview`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(previewCandidates.status, 200);
    const previewCandidateBody = await previewCandidates.json() as { candidates: Array<{ id: string; evidence?: { hasFullEvidence?: boolean; summary?: string; summaryPreview?: string } }> };
    const previewCandidate = previewCandidateBody.candidates.find((candidate) => candidate.evidence);
    assert.equal(previewCandidate?.evidence?.hasFullEvidence, true);
    assert.equal(typeof previewCandidate?.evidence?.summaryPreview, "string");
    assert.equal(previewCandidate?.evidence?.summary, undefined);

    const candidateDetail = await fetch(`${baseUrl}/api/memory-candidates/${previewCandidate!.id}`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(candidateDetail.status, 200);
    const candidateDetailBody = await candidateDetail.json() as { evidence?: { summary?: string; speakers?: unknown[] } };
    assert.equal(typeof candidateDetailBody.evidence?.summary, "string");
    assert.equal(Array.isArray(candidateDetailBody.evidence?.speakers), true);

    const memorySearch = await fetch(`${baseUrl}/api/memories?groupId=67890&q=concise&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memorySearchBody = await memorySearch.json() as typeof memoryBody;
    assert.equal(memorySearchBody.pagination.total, 1);
    assert.equal(memorySearchBody.memories[0]?.subjectLabel?.label.includes("QQ 20001"), true);
    assert.equal(memorySearchBody.memories[0]?.evidence?.messageCount, 3);

    const memberProfileMemories = await fetch(`${baseUrl}/api/memories?groupId=67890&subjectUserId=20001&type=member_profile&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(memberProfileMemories.status, 200);
    const memberProfileMemoryBody = await memberProfileMemories.json() as typeof memoryBody;
    assert.equal(memberProfileMemoryBody.pagination.total, 1);
    assert.equal(memberProfileMemoryBody.memories[0]?.title, "Tester preference");
    assert.equal(memberProfileMemoryBody.memories[0]?.subjectUserId, "20001");

    const memoriesAfterBulk = await fetch(`${baseUrl}/api/memories?groupId=67890&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memoriesAfterBulkBody = await memoriesAfterBulk.json() as typeof memoryBody;
    assert.equal(memoriesAfterBulkBody.pagination.total, 2);
    assert.equal(memoriesAfterBulkBody.memories.some((memory) => memory.title === "Latest fact"), false);
    assert.equal(memoriesAfterBulkBody.memories.find((memory) => memory.title === "Another fact")?.enabled, false);

    const profileMemoryId = memorySearchBody.memories[0]!.id;
    const editMemory = await fetch(`${baseUrl}/api/memories/${profileMemoryId}`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "member_profile",
        subjectUserId: "30002",
        title: "Edited preference",
        content: "Edited content.",
        confidence: "0.81",
        enabled: false,
      }),
    });
    assert.equal(editMemory.status, 200);
    const edited = await editMemory.json() as { subjectUserId?: string; title: string; content: string; confidence: number; enabled: boolean; subjectLabel?: { label: string } };
    assert.equal(edited.subjectUserId, "30002");
    assert.equal(edited.title, "Edited preference");
    assert.equal(edited.content, "Edited content.");
    assert.equal(edited.confidence, 0.81);
    assert.equal(edited.enabled, false);
    assert.equal(edited.subjectLabel?.label.includes("测试备注"), true);

    const disabledProfileMemories = await fetch(`${baseUrl}/api/memories?groupId=67890&type=member_profile&enabled=false&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(disabledProfileMemories.status, 200);
    const disabledProfileBody = await disabledProfileMemories.json() as typeof memoryBody;
    assert.equal(disabledProfileBody.pagination.total, 1);
    assert.equal(disabledProfileBody.memories[0]?.id, profileMemoryId);

    const enabledProfileMemories = await fetch(`${baseUrl}/api/memories?groupId=67890&type=member_profile&enabled=true&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(enabledProfileMemories.status, 200);
    const enabledProfileBody = await enabledProfileMemories.json() as typeof memoryBody;
    assert.equal(enabledProfileBody.pagination.total, 0);

    const invalidateIdentity = await fetch(`${baseUrl}/api/groups/67890/members/30002/identity`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["新人"], note: "测试备注二" }),
    });
    assert.equal(invalidateIdentity.status, 200);
    const callsBeforeLightLabel = listGroupMembersCalls;
    const lightLabelMemories = await fetch(`${baseUrl}/api/memories?groupId=67890&type=member_profile&enabled=false&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(lightLabelMemories.status, 200);
    const lightLabelBody = await lightLabelMemories.json() as typeof memoryBody;
    assert.equal(lightLabelBody.memories[0]?.subjectLabel?.label.includes("测试备注二"), true);
    assert.equal(listGroupMembersCalls, callsBeforeLightLabel);

    const callsBeforeConcurrentProfileLoads = listGroupMembersCalls;
    const [concurrentMembers, concurrentMemories, concurrentCandidates] = await Promise.all([
      fetch(`${baseUrl}/api/groups/67890/members`, { headers: { Cookie: cookie ?? "" } }),
      fetch(`${baseUrl}/api/memories?groupId=67890&page=1&pageSize=1`, { headers: { Cookie: cookie ?? "" } }),
      fetch(`${baseUrl}/api/memory-candidates?groupId=67890&page=1&pageSize=1`, { headers: { Cookie: cookie ?? "" } }),
    ]);
    assert.equal(concurrentMembers.status, 200);
    assert.equal(concurrentMemories.status, 200);
    assert.equal(concurrentCandidates.status, 200);
    assert.equal(listGroupMembersCalls, callsBeforeConcurrentProfileLoads);

    const convertMemory = await fetch(`${baseUrl}/api/memories/${profileMemoryId}`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group_fact", subjectUserId: "30002", enabled: true }),
    });
    assert.equal(convertMemory.status, 200);
    const converted = await convertMemory.json() as { type: string; subjectUserId?: string; enabled: boolean };
    assert.equal(converted.type, "group_fact");
    assert.equal(converted.subjectUserId, undefined);
    assert.equal(converted.enabled, true);

    const pagedCandidates = await fetch(`${baseUrl}/api/memory-candidates?groupId=67890&page=1&pageSize=1&q=late-night`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(pagedCandidates.status, 200);
    const candidatePageBody = await pagedCandidates.json() as { candidates: Array<{ title: string }>; pagination: { total: number; pageSize: number } };
    assert.equal(candidatePageBody.pagination.total, 1);
    assert.equal(candidatePageBody.pagination.pageSize, 1);
    assert.equal(candidatePageBody.candidates[0]?.title, "Unknown member profile");

    const bulkApprove = await fetch(`${baseUrl}/api/memory-candidates/bulk-approve`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [orphanCandidate.id, batchFactCandidate.id, "missing"] }),
    });
    assert.equal(bulkApprove.status, 200);
    const bulkApproveBody = await bulkApprove.json() as {
      approvedCount: number;
      alreadyApprovedCount: number;
      skippedCount: number;
      errorCount: number;
      approved: Array<{ candidate: { id: string; status: string } }>;
      alreadyApproved: Array<{ id: string; candidate: { id: string; status: string } }>;
      skipped: Array<{ id: string; error: string }>;
      errors: Array<{ id: string; error: string }>;
    };
    assert.equal(bulkApproveBody.approvedCount, 1);
    assert.equal(bulkApproveBody.alreadyApprovedCount, 0);
    assert.equal(bulkApproveBody.skippedCount, 2);
    assert.equal(bulkApproveBody.errorCount, 0);
    assert.equal(bulkApproveBody.approved[0]?.candidate.id, batchFactCandidate.id);
    assert.equal(bulkApproveBody.skipped.some((item) => item.id === orphanCandidate.id && item.error === "member_profile_requires_subject_user_id"), true);
    assert.equal(bulkApproveBody.skipped.some((item) => item.id === "missing" && item.error === "not_found"), true);

    const repeatedBulkApprove = await fetch(`${baseUrl}/api/memory-candidates/bulk-approve`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [batchFactCandidate.id] }),
    });
    assert.equal(repeatedBulkApprove.status, 200);
    const repeatedBulkApproveBody = await repeatedBulkApprove.json() as {
      approvedCount: number;
      alreadyApprovedCount: number;
      skippedCount: number;
      alreadyApproved: Array<{ id: string }>;
    };
    assert.equal(repeatedBulkApproveBody.approvedCount, 0);
    assert.equal(repeatedBulkApproveBody.alreadyApprovedCount, 1);
    assert.equal(repeatedBulkApproveBody.skippedCount, 0);
    assert.equal(repeatedBulkApproveBody.alreadyApproved[0]?.id, batchFactCandidate.id);

    const concurrentBulkCandidate = await candidateStore.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "Concurrent bulk fact",
      content: "Concurrent bulk approval must create only one long-term memory.",
      confidence: 0.91,
    });
    const [concurrentBulkA, concurrentBulkB] = await Promise.all([
      fetch(`${baseUrl}/api/memory-candidates/bulk-approve`, {
        method: "POST",
        headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [concurrentBulkCandidate.id] }),
      }),
      fetch(`${baseUrl}/api/memory-candidates/bulk-approve`, {
        method: "POST",
        headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [concurrentBulkCandidate.id] }),
      }),
    ]);
    assert.equal(concurrentBulkA.status, 200);
    assert.equal(concurrentBulkB.status, 200);
    const concurrentBulkBodies = await Promise.all([
      concurrentBulkA.json() as Promise<{ approvedCount: number; alreadyApprovedCount: number }>,
      concurrentBulkB.json() as Promise<{ approvedCount: number; alreadyApprovedCount: number }>,
    ]);
    assert.equal(concurrentBulkBodies.reduce((sum, item) => sum + item.approvedCount, 0) >= 1, true);
    const concurrentBulkMemories = await groupMemoryStore.list("67890");
    assert.equal(concurrentBulkMemories.filter((memory) => memory.title === "Concurrent bulk fact").length, 1);

    const knowledgeSearch = await fetch(`${baseUrl}/api/knowledge?groupId=67890&q=发票&page=1&pageSize=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(knowledgeSearch.status, 200);
    const knowledgeSearchBody = await knowledgeSearch.json() as { entries: Array<{ id: string; title: string }>; pagination: { total: number; pageSize: number } };
    assert.equal(knowledgeSearchBody.pagination.total, 1);
    assert.equal(knowledgeSearchBody.pagination.pageSize, 1);
    assert.equal(knowledgeSearchBody.entries[0]?.title, "报销流程");

    const updateKnowledge = await fetch(`${baseUrl}/api/knowledge/${knowledgeEntry.id}`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "报销流程新版", question: "报销怎么走", answer: "先贴发票，再找管理员登记。", keywords: ["报销", "管理员"], enabled: false }),
    });
    assert.equal(updateKnowledge.status, 200);
    const updatedKnowledge = await updateKnowledge.json() as { title: string; enabled: boolean; keywords: string[] };
    assert.equal(updatedKnowledge.title, "报销流程新版");
    assert.equal(updatedKnowledge.enabled, false);
    assert.deepEqual(updatedKnowledge.keywords, ["报销", "管理员"]);

    const knowledgeImportPreview = await fetch(`${baseUrl}/api/knowledge/import/preview`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", text: "问：怎么导入历史聊天？\n答：先预览清洗，再审核入库。" }),
    });
    assert.equal(knowledgeImportPreview.status, 200);
    const knowledgeImportPreviewBody = await knowledgeImportPreview.json() as { candidates: Array<{ question: string; answer: string }> };
    assert.equal(knowledgeImportPreviewBody.candidates.length, 1);
    const knowledgeImportApply = await fetch(`${baseUrl}/api/knowledge/import/apply`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", candidates: knowledgeImportPreviewBody.candidates }),
    });
    assert.equal(knowledgeImportApply.status, 201);
    const knowledgeImportApplyBody = await knowledgeImportApply.json() as { createdCount: number; skippedCount: number };
    assert.equal(knowledgeImportApplyBody.createdCount, 1);
    assert.equal(knowledgeImportApplyBody.skippedCount, 0);

    const repeatedKnowledgeImportApply = await fetch(`${baseUrl}/api/knowledge/import/apply`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", candidates: knowledgeImportPreviewBody.candidates }),
    });
    assert.equal(repeatedKnowledgeImportApply.status, 201);
    const repeatedKnowledgeImportApplyBody = await repeatedKnowledgeImportApply.json() as {
      createdCount: number;
      skippedCount: number;
      skipped: Array<{ reason: string; existingId: string }>;
    };
    assert.equal(repeatedKnowledgeImportApplyBody.createdCount, 0);
    assert.equal(repeatedKnowledgeImportApplyBody.skippedCount, 1);
    assert.equal(repeatedKnowledgeImportApplyBody.skipped[0]?.reason, "duplicate_question");

    const knowledgeAfterRepeatedImport = await knowledgeBaseStore.list("67890");
    assert.equal(knowledgeAfterRepeatedImport.length, 3);

    const directApprove = await fetch(`${baseUrl}/api/memory-candidates/${orphanCandidate.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(directApprove.status, 400);

    const approveAsFact = await fetch(`${baseUrl}/api/memory-candidates/${orphanCandidate.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group_fact", subjectUserId: null }),
    });
    assert.equal(approveAsFact.status, 200);

    const deleteIdentity = await fetch(`${baseUrl}/api/groups/67890/members/30002/identity`, {
      method: "DELETE",
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(deleteIdentity.status, 200);
    const deleteIdentityBody = await deleteIdentity.json() as { member?: { userId: string; note?: string; hasManualIdentity: boolean; memoryCount: number } };
    assert.equal(deleteIdentityBody.member?.userId, "30002");
    assert.equal(deleteIdentityBody.member?.note, undefined);
    assert.equal(deleteIdentityBody.member?.hasManualIdentity, false);
    assert.equal(deleteIdentityBody.member?.memoryCount, 0);
    assert.equal((await groupMemoryStore.list("67890")).length, 5);

    const dedupBase = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Dedup base",
      content: "Tester likes concise answers.",
      createdAt: "2026-06-04T10:00:00.000Z",
    });
    const duplicateMemory = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "20001",
      title: "Dedup copy",
      content: "Tester likes concise answers.",
      createdAt: "2026-06-04T10:01:00.000Z",
    });
    const semanticDuplicateMemory = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "30002",
      title: "Short answer preference",
      content: "Tester wants short answers without long explanations.",
      createdAt: "2026-06-04T10:02:00.000Z",
    });
    const semanticBaseMemory = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "30002",
      title: "Concise preference",
      content: "Tester likes concise answers.",
      createdAt: "2026-06-04T10:03:00.000Z",
    });
    const chineseShortReplyBase = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "30003",
      title: "Short reply preference",
      content: "用户喜欢简短回答，不喜欢长篇解释。",
      createdAt: "2026-06-04T10:04:00.000Z",
    });
    const chineseShortReplyDuplicate = await groupMemoryStore.create({
      groupId: "67890",
      type: "member_profile",
      subjectUserId: "30003",
      title: "Concise reply preference",
      content: "用户偏好短回复，希望回答别太啰嗦。",
      createdAt: "2026-06-04T10:05:00.000Z",
    });
    const dedupPreview = await fetch(`${baseUrl}/api/memories/deduplicate/preview`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "20001" }),
    });
    assert.equal(dedupPreview.status, 200);
    const dedupPreviewBody = await dedupPreview.json() as {
      decisions: Array<{ targetId?: string; duplicateId: string; reason?: string }>;
      semanticStats: { called: number; duplicate: number; merge: number; new: number; failed: number };
    };
    assert.equal(dedupPreviewBody.decisions.some((item) => item.targetId === dedupBase.id && item.duplicateId === duplicateMemory.id), true);
    assert.equal(dedupPreviewBody.semanticStats.called, 0);

    const semanticDedupPreview = await fetch(`${baseUrl}/api/memories/deduplicate/preview`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "30002" }),
    });
    assert.equal(semanticDedupPreview.status, 200);
    const semanticDedupPreviewBody = await semanticDedupPreview.json() as {
      decisions: Array<{ targetId?: string; duplicateId: string; reason?: string }>;
      semanticStats: { called: number; duplicate: number; merge: number; new: number; failed: number; skippedDisabled?: number };
    };
    assert.equal(semanticDedupPreviewBody.decisions.some((item) => item.reason?.startsWith("semantic:")), false);
    assert.equal(semanticDedupPreviewBody.semanticStats.called, 0);
    assert.equal(semanticDedupPreviewBody.semanticStats.duplicate, 0);
    assert.equal(semanticDedupPreviewBody.semanticStats.failed, 0);
    assert.equal(semanticJudgeCalls, 0);
    const semanticJudgeCallsBeforeChineseLocalDedup = semanticJudgeCalls;
    const chineseLocalDedupPreview = await fetch(`${baseUrl}/api/memories/deduplicate/preview`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "30003" }),
    });
    assert.equal(chineseLocalDedupPreview.status, 200);
    const chineseLocalDedupPreviewBody = await chineseLocalDedupPreview.json() as {
      decisions: Array<{ targetId?: string; duplicateId: string; similarity: number }>;
      semanticStats: { called: number; duplicate: number; merge: number; new: number; failed: number };
    };
    assert.equal(chineseLocalDedupPreviewBody.decisions.some((item) =>
      item.targetId === chineseShortReplyBase.id &&
      item.duplicateId === chineseShortReplyDuplicate.id &&
      item.similarity >= 0.72), true);
    assert.equal(chineseLocalDedupPreviewBody.semanticStats.called, 0);
    assert.equal(semanticJudgeCalls, semanticJudgeCallsBeforeChineseLocalDedup);

    const globalDedupPreview = await fetch(`${baseUrl}/api/memories/deduplicate/preview`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890" }),
    });
    assert.equal(globalDedupPreview.status, 400);
    assert.deepEqual(await globalDedupPreview.json(), { error: "subject_user_id_required" });

    const exactDuplicateDecision = dedupPreviewBody.decisions.find((item) => item.targetId === dedupBase.id && item.duplicateId === duplicateMemory.id);
    assert.ok(exactDuplicateDecision);
    const dedupApply = await fetch(`${baseUrl}/api/memories/deduplicate/apply`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "20001", decisions: [exactDuplicateDecision] }),
    });
    assert.equal(dedupApply.status, 200);
    const dedupApplyBody = await dedupApply.json() as { appliedCount: number; skippedCount: number };
    assert.equal(dedupApplyBody.appliedCount, 1);
    assert.equal(dedupApplyBody.skippedCount, 0);
    assert.equal((await groupMemoryStore.get(duplicateMemory.id))?.enabled, false);

    const repeatedDedupApply = await fetch(`${baseUrl}/api/memories/deduplicate/apply`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "20001", decisions: [exactDuplicateDecision] }),
    });
    assert.equal(repeatedDedupApply.status, 200);
    const repeatedDedupApplyBody = await repeatedDedupApply.json() as {
      appliedCount: number;
      skippedCount: number;
      skipped: Array<{ duplicateId: string; error: string }>;
    };
    assert.equal(repeatedDedupApplyBody.appliedCount, 0);
    assert.equal(repeatedDedupApplyBody.skippedCount, 1);
    assert.deepEqual(repeatedDedupApplyBody.skipped[0], { duplicateId: duplicateMemory.id, error: "already_disabled" });

    const invalidTargetDedupApply = await fetch(`${baseUrl}/api/memories/deduplicate/apply`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "67890",
        subjectUserId: "20001",
        decisions: [{ action: "merge", targetId: duplicateMemory.id, duplicateId: dedupBase.id }],
      }),
    });
    assert.equal(invalidTargetDedupApply.status, 200);
    const invalidTargetDedupApplyBody = await invalidTargetDedupApply.json() as {
      appliedCount: number;
      skipped: Array<{ duplicateId: string; error: string }>;
    };
    assert.equal(invalidTargetDedupApplyBody.appliedCount, 0);
    assert.deepEqual(invalidTargetDedupApplyBody.skipped[0], { duplicateId: dedupBase.id, error: "target_disabled" });

    const groupAdminLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "99999", password: "group-secret" }),
    });
    assert.equal(groupAdminLogin.status, 200);
    const groupAdminLoginBody = await groupAdminLogin.json() as { session: { csrfToken: string } };
    activeCsrfToken = groupAdminLoginBody.session.csrfToken;
    assert.match(activeCsrfToken, /^[A-Za-z0-9_-]{32,}$/);
    const groupAdminCookie = groupAdminLogin.headers.get("set-cookie");
    assert.ok(groupAdminCookie?.includes("HttpOnly"));

    const groupAdminSession = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminSession.status, 200);
    const groupAdminSessionBody = await groupAdminSession.json() as { role: string; allowedGroupIds: string[]; csrfToken: string };
    activeCsrfToken = groupAdminSessionBody.csrfToken;
    const groupAdminCsrfToken = activeCsrfToken;
    assert.equal(groupAdminSessionBody.role, "group_admin");
    assert.deepEqual(groupAdminSessionBody.allowedGroupIds, ["67890"]);

    const groupAdminSystemSettings = await fetch(`${baseUrl}/api/system-settings`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminSystemSettings.status, 403);

    const groupAdminSkills = await fetch(`${baseUrl}/api/skills`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminSkills.status, 403);

    const groupAdminCommands = await fetch(`${baseUrl}/api/commands`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminCommands.status, 403);

    const groupAdminModelOptions = await fetch(`${baseUrl}/api/model-options`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminModelOptions.status, 200);
    const groupAdminModelOptionsBody = await groupAdminModelOptions.json() as {
      models?: unknown[];
      replyModels: Array<{ id: string; apiKey?: string }>;
    };
    assert.equal(groupAdminModelOptionsBody.models, undefined);
    assert.equal(groupAdminModelOptionsBody.replyModels.some((item) => item.id === "reply-pro"), true);
    assert.equal(groupAdminModelOptionsBody.replyModels.every((item) => item.apiKey === undefined), true);

    lastProfileHealthRefresh = false;
    const groupAdminOverview = await fetch(`${baseUrl}/api/overview?groupId=67890`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminOverview.status, 200);
    const groupAdminOverviewBody = await groupAdminOverview.json() as {
      profileAiHealth?: { detail: string; baseUrl?: string; model?: string };
      modelStatuses?: unknown[];
      abnormalModelStatuses?: unknown[];
      modelStatusSummary?: { total: number; abnormal: number; checkedAt: string };
    };
    assert.equal(groupAdminOverviewBody.profileAiHealth?.detail, "restricted");
    assert.equal(groupAdminOverviewBody.profileAiHealth?.baseUrl, undefined);
    assert.equal(groupAdminOverviewBody.profileAiHealth?.model, undefined);
    assert.deepEqual(groupAdminOverviewBody.modelStatuses, []);
    assert.deepEqual(groupAdminOverviewBody.abnormalModelStatuses, []);
    assert.equal(groupAdminOverviewBody.modelStatusSummary?.total, 0);
    assert.equal(groupAdminOverviewBody.modelStatusSummary?.abnormal, 0);
    assert.match(groupAdminOverviewBody.modelStatusSummary?.checkedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const profileHealthCallsBeforeGroupAdminHealth = profileHealthCalls;
    const groupAdminHealth = await fetch(`${baseUrl}/api/health?refresh=1`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminHealth.status, 200);
    const groupAdminHealthBody = await groupAdminHealth.json() as {
      profileAiHealth?: { detail: string; baseUrl?: string; model?: string };
      modelStatuses?: unknown[];
      abnormalModelStatuses?: unknown[];
      serverStatus?: unknown;
      pid?: number;
    };
    assert.equal(groupAdminHealthBody.profileAiHealth?.detail, "restricted");
    assert.equal(groupAdminHealthBody.profileAiHealth?.baseUrl, undefined);
    assert.equal(groupAdminHealthBody.profileAiHealth?.model, undefined);
    assert.deepEqual(groupAdminHealthBody.modelStatuses, []);
    assert.deepEqual(groupAdminHealthBody.abnormalModelStatuses, []);
    assert.equal(groupAdminHealthBody.serverStatus, undefined);
    assert.equal(groupAdminHealthBody.pid, undefined);
    assert.equal(profileHealthCalls, profileHealthCallsBeforeGroupAdminHealth);
    assert.equal(lastProfileHealthRefresh, false);

    const groupAdminGroupSync = await fetch(`${baseUrl}/api/groups/sync`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(groupAdminGroupSync.status, 403);

    const groupAdminGroupsBeforeHide = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminGroupsBeforeHide.status, 200);
    assert.equal(((await groupAdminGroupsBeforeHide.json()) as { groups: unknown[] }).groups.length, 1);

    const groupAdminAllowedLogs = await fetch(`${baseUrl}/api/logs?groupId=67890`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminAllowedLogs.status, 200);

    const groupAdminForbiddenLogs = await fetch(`${baseUrl}/api/logs?groupId=99999`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminForbiddenLogs.status, 403);

    const groupAdminTasks = await fetch(`${baseUrl}/api/tasks?page=1&pageSize=20`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminTasks.status, 200);
    const groupAdminTasksBody = await groupAdminTasks.json() as { tasks: Array<{ type: string; groupId?: string }>; pagination: { total: number } };
    assert.equal(groupAdminTasksBody.pagination.total, groupAdminTasksBody.tasks.length);
    assert.equal(groupAdminTasksBody.tasks.some((task) => task.groupId === "67890" && task.type === "profile-generate"), true);
    assert.equal(groupAdminTasksBody.tasks.every((task) => task.groupId === "67890"), true);
    assert.equal(groupAdminTasksBody.tasks.some((task) => !task.groupId || task.groupId === "100200300"), false);

    const groupAdminSystemTaskSearch = await fetch(`${baseUrl}/api/tasks?q=probe%20timeout&page=1&pageSize=20`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminSystemTaskSearch.status, 200);
    const groupAdminSystemTaskSearchBody = await groupAdminSystemTaskSearch.json() as { tasks: unknown[]; pagination: { total: number } };
    assert.equal(groupAdminSystemTaskSearchBody.pagination.total, 0);
    assert.deepEqual(groupAdminSystemTaskSearchBody.tasks, []);

    const groupAdminForbiddenTasks = await fetch(`${baseUrl}/api/tasks?groupId=100200300&page=1&pageSize=20`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminForbiddenTasks.status, 403);

    activeCsrfToken = superAdminCsrfToken;
    const groupReminder = await fetch(`${baseUrl}/api/groups/67890/reminders`, {
      method: "POST",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "Hidden group reminder", intervalMinutes: 30 }),
    });
    assert.equal(groupReminder.status, 201);
    const groupReminderBody = await groupReminder.json() as { id: string };
    assert.ok(groupReminderBody.id);

    const hiddenGroupCandidate = await candidateStore.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: "Hidden group candidate",
      content: "This candidate must not be rejected by a stale group-admin session.",
    });

    const hideGroup = await fetch(`${baseUrl}/api/groups/67890/config`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(hideGroup.status, 200);
    activeCsrfToken = groupAdminCsrfToken;

    const groupAdminGroupsAfterHide = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(groupAdminGroupsAfterHide.status, 200);
    assert.equal(((await groupAdminGroupsAfterHide.json()) as { groups: unknown[] }).groups.length, 0);

    const staleGroupConfig = await fetch(`${baseUrl}/api/groups/67890/config`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleGroupConfig.status, 403);

    const staleMemories = await fetch(`${baseUrl}/api/memories?groupId=67890`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleMemories.status, 403);

    const staleProfileRecords = await fetch(`${baseUrl}/api/profile-records?groupId=67890`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleProfileRecords.status, 403);

    const staleTasks = await fetch(`${baseUrl}/api/tasks?page=1&pageSize=20`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleTasks.status, 403);

    const staleProfileRecordItem = await fetch(`${baseUrl}/api/profile-records/${profileRecordIdForPermission}`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleProfileRecordItem.status, 403);

    const staleProfileRecordCreate = await fetch(`${baseUrl}/api/profile-records`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", userId: "20001", type: "overall" }),
    });
    assert.equal(staleProfileRecordCreate.status, 403);

    const staleProfileRecordRegenerate = await fetch(`${baseUrl}/api/profile-records/${profileRecordIdForPermission}`, {
      method: "PUT",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(staleProfileRecordRegenerate.status, 403);

    const staleDedupPreview = await fetch(`${baseUrl}/api/memories/deduplicate/preview`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", subjectUserId: "20001" }),
    });
    assert.equal(staleDedupPreview.status, 403);

    const staleDedupApply = await fetch(`${baseUrl}/api/memories/deduplicate/apply`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", decisions: [] }),
    });
    assert.equal(staleDedupApply.status, 403);

    const staleKnowledgeImportPreview = await fetch(`${baseUrl}/api/knowledge/import/preview`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", text: "问：隐藏群能导入吗\n答：不能" }),
    });
    assert.equal(staleKnowledgeImportPreview.status, 403);

    const staleKnowledgeImportApply = await fetch(`${baseUrl}/api/knowledge/import/apply`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "67890", candidates: [{ title: "隐藏群", question: "能导入吗", answer: "不能", keywords: [] }] }),
    });
    assert.equal(staleKnowledgeImportApply.status, 403);

    const staleKnowledgeUpdate = await fetch(`${baseUrl}/api/knowledge/${knowledgeEntry.id}`, {
      method: "PUT",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "should not update hidden group knowledge" }),
    });
    assert.equal(staleKnowledgeUpdate.status, 403);
    assert.equal((await knowledgeBaseStore.get(knowledgeEntry.id))?.title, "报销流程新版");

    const staleReminders = await fetch(`${baseUrl}/api/groups/67890/reminders`, {
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleReminders.status, 403);

    const staleReminderUpdate = await fetch(`${baseUrl}/api/groups/67890/reminders/${groupReminderBody.id}`, {
      method: "PUT",
      headers: { Cookie: groupAdminCookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "should not update hidden group reminder" }),
    });
    assert.equal(staleReminderUpdate.status, 403);

    const staleReminderDelete = await fetch(`${baseUrl}/api/groups/67890/reminders/${groupReminderBody.id}`, {
      method: "DELETE",
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleReminderDelete.status, 403);

      const staleReject = await fetch(`${baseUrl}/api/memory-candidates/${hiddenGroupCandidate.id}/reject`, {
      method: "POST",
      headers: { Cookie: groupAdminCookie ?? "" },
    });
    assert.equal(staleReject.status, 403);
    assert.equal((await candidateStore.get(hiddenGroupCandidate.id))?.status, "pending");
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("overview global stats count all visible items beyond the recent page", async () => {
  activeCsrfToken = "";
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-overview-"));
  const groupsPath = path.join(dir, "groups.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      groupsPath,
      JSON.stringify({
        superAdminUserIds: ["99999"],
        groups: [
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: [],
          },
        ],
      }),
      "utf8",
    ),
  );

  const groupMemoryStore = new GroupMemoryStore(path.join(dir, "memory.json"));
  const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
  const knowledgeBaseStore = new KnowledgeBaseStore(path.join(dir, "knowledge.json"));
  for (let index = 0; index < 7; index += 1) {
    await groupMemoryStore.create({
      groupId: "67890",
      type: "group_fact",
      title: `Memory ${index}`,
      content: `Memory content ${index}`,
    });
  }
  for (let index = 0; index < 6; index += 1) {
    await candidateStore.addCandidate({
      groupId: "67890",
      type: "group_fact",
      title: `Candidate ${index}`,
      content: `Candidate content ${index}`,
    });
    await knowledgeBaseStore.create({
      groupId: "67890",
      title: `Knowledge ${index}`,
      question: `Question ${index}`,
      answer: `Answer ${index}`,
      keywords: [`k${index}`],
    });
  }

  const service = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: "admin",
    password: "secret",
    sessionSecret: "test-secret",
    groupConfigService: new GroupConfigService(groupsPath),
    groupMemoryStore,
    groupMemoryCandidateService: new GroupMemoryCandidateService(
      candidateStore,
      groupMemoryStore,
      { async extractGroupMemoryCandidates() { return []; } },
    ),
    knowledgeBaseStore,
    adminOperationLogService: new AdminOperationLogService(path.join(dir, "ops.jsonl")),
    async getTransportHealthStatus() {
      return { ok: true, detail: "ok" };
    },
    async getProfileAiHealthStatus() {
      return {
        ok: true,
        detail: "profile ok",
        model: "mimo-v2.5-pro",
        baseUrl: "https://profile.example/v1",
        checkedAt: "2026-06-03T00:00:00.000Z",
        latencyMs: 12,
        cached: false,
      };
    },
  });

  try {
    service.start();
    const rawServer = (service as unknown as { server: { once(event: "listening", listener: () => void): void; address(): AddressInfo | null } }).server;
    await new Promise<void>((resolve) => rawServer.once("listening", resolve));
    const address = rawServer.address();
    assert.ok(address);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { session: { csrfToken: string } };
    activeCsrfToken = loginBody.session.csrfToken;
    const cookie = login.headers.get("set-cookie");

    const overview = await fetch(`${baseUrl}/api/overview`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(overview.status, 200);
    const body = await overview.json() as {
      stats: { groupCount: number; memoryCount: number; pendingCandidateCount: number; knowledgeCount: number };
      recent: { memories: unknown[]; candidates: unknown[]; knowledge: unknown[] };
    };
    assert.equal(body.stats.groupCount, 1);
    assert.equal(body.stats.memoryCount, 7);
    assert.equal(body.stats.pendingCandidateCount, 6);
    assert.equal(body.stats.knowledgeCount, 6);
    assert.equal(body.recent.memories.length, 5);
    assert.equal(body.recent.candidates.length, 5);
    assert.equal(body.recent.knowledge.length, 5);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function formatTestLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
