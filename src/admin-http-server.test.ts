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

    const overview = await fetch(`${baseUrl}/api/overview?groupId=67890`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { groupId?: string; stats: { groupCount: number; memoryCount: number; pendingCandidateCount: number; knowledgeCount: number } };
    assert.equal(overviewBody.groupId, "67890");
    assert.equal(overviewBody.stats.groupCount, 1);
    assert.equal(overviewBody.stats.memoryCount, 3);
    assert.equal(overviewBody.stats.pendingCandidateCount, 1);
    assert.equal(overviewBody.stats.knowledgeCount, 2);

    const unauthorizedMembers = await fetch(`${baseUrl}/api/groups/67890/members`);
    assert.equal(unauthorizedMembers.status, 401);

    const members = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(members.status, 200);
    const memberBody = await members.json() as { members: Array<{ userId: string; displayName: string; memoryCount: number; pendingCandidateCount: number }> };
    assert.equal(memberBody.members.some((member) => member.userId === "20001" && member.displayName === "TesterCard" && member.memoryCount === 1), true);
    assert.equal(listGroupMembersCalls, 1);

    const cachedMembers = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(cachedMembers.status, 200);
    assert.equal(listGroupMembersCalls, 1);

    const refreshedMembers = await fetch(`${baseUrl}/api/groups/67890/members?refresh=1`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(refreshedMembers.status, 200);
    assert.equal(listGroupMembersCalls, 2);

    const updateIdentity = await fetch(`${baseUrl}/api/groups/67890/members/30002/identity`, {
      method: "PUT",
      headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["新人"], note: "测试备注" }),
    });
    assert.equal(updateIdentity.status, 200);
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
    assert.equal(listGroupMembersCalls, 3);

    const memories = await fetch(`${baseUrl}/api/memories?groupId=67890&page=1&pageSize=2`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memoryBody = await memories.json() as { memories: Array<{ id: string; title: string; type: string; subjectUserId?: string; content: string; confidence: number; enabled: boolean; evidence?: { messageCount: number }; subjectLabel?: { label: string } }>; pagination: { page: number; pageSize: number; total: number; totalPages: number } };
    assert.equal(memoryBody.pagination.total, 3);
    assert.equal(memoryBody.memories.length, 2);
    assert.equal(memoryBody.memories[0]?.title, "Another fact");
    assert.equal(memoryBody.memories[1]?.title, "Latest fact");

    const memorySearch = await fetch(`${baseUrl}/api/memories?groupId=67890&q=concise&page=1&pageSize=10`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memorySearchBody = await memorySearch.json() as typeof memoryBody;
    assert.equal(memorySearchBody.pagination.total, 1);
    assert.equal(memorySearchBody.memories[0]?.subjectLabel?.label.includes("TesterCard / QQ 20001"), true);
    assert.equal(memorySearchBody.memories[0]?.evidence?.messageCount, 3);

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
    const edited = await editMemory.json() as { subjectUserId?: string; title: string; content: string; confidence: number; enabled: boolean };
    assert.equal(edited.subjectUserId, "30002");
    assert.equal(edited.title, "Edited preference");
    assert.equal(edited.content, "Edited content.");
    assert.equal(edited.confidence, 0.81);
    assert.equal(edited.enabled, false);

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
    assert.equal((await groupMemoryStore.list("67890")).length, 4);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
