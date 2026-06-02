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
      new GroupMemoryCandidateStore(path.join(dir, "candidates.json")),
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
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
