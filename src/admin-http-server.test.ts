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
  });
  await groupMemoryStore.create({
    groupId: "67890",
    type: "group_fact",
    title: "Latest fact",
    content: "Latest memory should be shown first.",
    createdAt: "2026-06-02T10:00:00.000Z",
  });
  const candidateStore = new GroupMemoryCandidateStore(path.join(dir, "candidates.json"));
  const orphanCandidate = await candidateStore.addCandidate({
    groupId: "67890",
    type: "member_profile",
    title: "Unknown member profile",
    content: "Someone likes late-night chats.",
  });
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
    knowledgeBaseStore: new KnowledgeBaseStore(path.join(dir, "knowledge.json")),
    adminOperationLogService: new AdminOperationLogService(path.join(dir, "ops.jsonl")),
    async getTransportHealthStatus() {
      return { ok: true, detail: "ok" };
    },
    async listGroupMembers(): Promise<NapcatGroupMember[]> {
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

    const unauthorizedMembers = await fetch(`${baseUrl}/api/groups/67890/members`);
    assert.equal(unauthorizedMembers.status, 401);

    const members = await fetch(`${baseUrl}/api/groups/67890/members`, {
      headers: { Cookie: cookie ?? "" },
    });
    assert.equal(members.status, 200);
    const memberBody = await members.json() as { members: Array<{ userId: string; displayName: string; memoryCount: number; pendingCandidateCount: number }> };
    assert.equal(memberBody.members.some((member) => member.userId === "20001" && member.displayName === "TesterCard" && member.memoryCount === 1), true);

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

    const memories = await fetch(`${baseUrl}/api/memories?groupId=67890`, {
      headers: { Cookie: cookie ?? "" },
    });
    const memoryBody = await memories.json() as { memories: Array<{ title: string; subjectLabel?: { label: string } }> };
    assert.equal(memoryBody.memories[0]?.title, "Latest fact");
    assert.equal(memoryBody.memories[1]?.subjectLabel?.label.includes("TesterCard / QQ 20001"), true);

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
    assert.equal((await groupMemoryStore.list("67890")).length, 3);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
