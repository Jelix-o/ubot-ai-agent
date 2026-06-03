import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpServer } from "./admin-http-server.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import { GroupMemoryCandidateStore } from "./services/group-memory-candidate-store.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import type { NapcatGroupMember } from "./types.js";

test("admin http server protects APIs and serves authenticated dashboard data", async () => {
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
  let listGroupMembersCalls = 0;
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
      {
        async extractGroupMemoryCandidates() {
          return [];
        },
      },
    ),
    knowledgeBaseStore,
    adminOperationLogService: new AdminOperationLogService(path.join(dir, "ops.jsonl")),
    async getTransportHealthStatus() {
      return { ok: true, detail: "ok" };
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
    assert.equal(loginPageText.includes('href="/admin.css"'), true);
    assert.equal(loginPageText.includes('src="/admin-login.js"'), true);

    const adminCss = await fetch(`${baseUrl}/admin.css`);
    assert.equal(adminCss.status, 200);
    assert.equal(adminCss.headers.get("content-type")?.includes("text/css"), true);
    const adminCssText = await adminCss.text();
    assert.equal(adminCssText.includes(".app-shell"), true);
    assert.equal(adminCssText.includes(".filter-summary"), true);
    assert.equal(adminCssText.includes(".detail-block"), true);

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

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie?.includes("HttpOnly"));

    const groups = await fetch(`${baseUrl}/api/groups`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(groups.status, 200);
    assert.equal(((await groups.json()) as { groups: unknown[] }).groups.length, 1);

    const dashboardPage = await fetch(`${baseUrl}/`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(dashboardPage.status, 200);
    assert.equal((await dashboardPage.text()).includes('src="/admin-app.js"'), true);

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
    assert.doesNotThrow(() => new Function(adminAppJsText));

    const overview = await fetch(`${baseUrl}/api/overview?groupId=67890`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as {
      groupId?: string;
      stats: { groupCount: number; memoryCount: number; pendingCandidateCount: number; knowledgeCount: number };
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
    assert.equal(overviewBody.recent?.candidates.some((candidate) => candidate.id === orphanCandidate.id), true);
    assert.equal(overviewBody.recent?.candidates.some((candidate) => candidate.id === batchFactCandidate.id), true);
    assert.equal(overviewBody.recent?.memories[0]?.title, "Another fact");
    assert.equal(overviewBody.recent?.knowledge.some((entry) => entry.id === knowledgeEntry.id), true);

    const unauthorizedMembers = await fetch(`${baseUrl}/api/groups/67890/members`);
    assert.equal(unauthorizedMembers.status, 401);

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
      skippedCount: number;
      approved: Array<{ candidate: { id: string; status: string } }>;
      skipped: Array<{ id: string; error: string }>;
    };
    assert.equal(bulkApproveBody.approvedCount, 1);
    assert.equal(bulkApproveBody.skippedCount, 2);
    assert.equal(bulkApproveBody.approved[0]?.candidate.id, batchFactCandidate.id);
    assert.equal(bulkApproveBody.skipped.some((item) => item.id === orphanCandidate.id && item.error === "member_profile_requires_subject_user_id"), true);
    assert.equal(bulkApproveBody.skipped.some((item) => item.id === "missing" && item.error === "not_found"), true);

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
    assert.equal((await groupMemoryStore.list("67890")).length, 4);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
