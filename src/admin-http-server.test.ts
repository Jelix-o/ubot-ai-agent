import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpServer } from "./admin-http-server.js";
import { SharedDb } from "./shared/sqlite.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { CharacterProfileService } from "./services/character-profile-service.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { V3StateRepository } from "./services/v3-state-repository.js";
import type { CharacterProfile } from "./types.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Auth = { cookie: string; csrf: string; session: { userId: string; username: string; role: string; allowedGroupIds: string[] } };

const huixian: CharacterProfile = {
  id: "huixian",
  name: "会仙",
  systemPrompt: "会仙是原创成年女性虚拟聊天伙伴，不伪造真人照片或线下经历。",
  styleRules: ["自然、诚实、有边界。"],
  knowledge: ["没有真实私人照片。"],
  temperature: 0.8,
  maxContextTurns: 24,
};

async function startFixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-v3-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
  repository.markCutover();
  repository.saveGroups({
    superAdminUserIds: ["99999"],
    groups: [
      {
        groupId: "67890",
        groupName: "已授权群",
        currentSkillId: "retired-persona",
        allowedSkillIds: ["retired-persona"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
      },
      {
        groupId: "100200",
        groupName: "未授权群",
        currentSkillId: "huixian",
        allowedSkillIds: ["huixian"],
        switcherUserIds: [],
        liveChatUserIds: [],
      },
    ],
  });

  const groupConfigService = new GroupConfigService(path.join(dir, "groups.json"), undefined, repository);
  const memories = new GroupMemoryStore(path.join(dir, "memory.json"), repository);
  const knowledge = new KnowledgeBaseStore(path.join(dir, "knowledge.json"), repository);
  const operations = new AdminOperationLogService(path.join(dir, "operations.jsonl"), repository);
  const settings = new SystemSettingsStore(path.join(dir, "settings.json"), [], undefined, repository);
  const characterProfileService = new CharacterProfileService(repository, { bootstrapProfile: huixian });
  await characterProfileService.ensureHuixianProfile("test-bootstrap");
  await memories.create({
    groupId: "67890",
    type: "member_profile",
    subjectUserId: "20001",
    title: "明确偏好",
    content: "用户喜欢先看结论。",
    source: "explicit_request",
  });

  const server = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: "admin",
    password: "secret-password",
    stateEncryptionKey: TEST_STATE_KEY,
    sharedDb: db,
    groupConfigService,
    groupMemoryStore: memories,
    knowledgeBaseStore: knowledge,
    characterProfileService,
    systemSettingsStore: settings,
    adminOperationLogService: operations,
    async getTransportHealthStatus() { return { ok: true, detail: "ok" }; },
  });
  server.start();
  const rawServer = (server as unknown as {
    server: { once(event: "listening", listener: () => void): void; address(): AddressInfo | null };
  }).server;
  await new Promise<void>((resolve) => rawServer.once("listening", resolve));
  const address = rawServer.address();
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    server.close();
    db.close();
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { baseUrl, memories, operations };
}

async function request(baseUrl: string, pathname: string, options: RequestInit = {}): Promise<Response> {
  // The server intentionally accepts a missing Origin only for loopback test
  // hosts. Production requests use the configured HTTPS Origin check.
  return fetch(`${baseUrl}${pathname}`, options);
}

async function login(baseUrl: string, username = "admin", password = "secret-password"): Promise<Auth> {
  const passwordResponse = await request(baseUrl, "/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(passwordResponse.status, 200);
  const challenge = await passwordResponse.json() as {
    status: string;
    enrollmentToken: string;
    totpSecret: string;
  };
  assert.equal(challenge.status, "totp_enrollment_required");
  const enrollmentResponse = await request(baseUrl, "/api/auth/totp/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enrollmentToken: challenge.enrollmentToken,
      code: makeTotp(challenge.totpSecret),
    }),
  });
  assert.equal(enrollmentResponse.status, 200);
  const enrolled = await enrollmentResponse.json() as { ok: boolean; session: Auth["session"] & { csrfToken: string } };
  assert.equal(enrolled.ok, true);
  const cookie = enrollmentResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const sessionResponse = await request(baseUrl, "/api/session", { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as Auth["session"] & { csrfToken: string };
  return { cookie, csrf: session.csrfToken, session };
}

test("V3 admin uses SQLite TOTP authentication and retires legacy routes", async (t) => {
  const { baseUrl, memories, operations } = await startFixture(t);
  const legacyLogin = await request(baseUrl, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  assert.equal(legacyLogin.status, 410);

  const auth = await login(baseUrl);
  assert.equal(auth.session.role, "super_admin");
  assert.equal(auth.session.username, "admin");

  const group = await request(baseUrl, "/api/groups/67890/config", { headers: { Cookie: auth.cookie } });
  assert.equal(group.status, 200);
  const groupData = await group.json() as { currentSkillId: string; allowedSkillIds: string[]; switcherUserIds: string[] };
  assert.equal(groupData.currentSkillId, "huixian");
  assert.deepEqual(groupData.allowedSkillIds, ["huixian"]);
  assert.deepEqual(groupData.switcherUserIds, []);

  const retiredQqAdminConfig = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ switcherUserIds: ["77777"] }),
  });
  assert.equal(retiredQqAdminConfig.status, 410);

  const overview = await request(baseUrl, "/api/overview?groupId=67890", { headers: { Cookie: auth.cookie } });
  assert.equal(overview.status, 200);
  const overviewData = await overview.json() as { stats: Record<string, unknown>; recent: Record<string, unknown> };
  assert.equal(overviewData.stats.memoryCount, 1);
  assert.equal(Object.hasOwn(overviewData.stats, "pendingCandidateCount"), false);
  assert.equal(Object.hasOwn(overviewData.recent, "candidates"), false);

  const missingCsrf = await request(baseUrl, "/api/memories", {
    method: "POST",
    headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: "67890", type: "group_fact", title: "群规则", content: "先给结论。" }),
  });
  assert.equal(missingCsrf.status, 403);

  const invalidOrigin = await fetch(`${baseUrl}/api/memories`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify({ groupId: "67890", type: "group_fact", title: "群规则", content: "先给结论。" }),
  });
  assert.equal(invalidOrigin.status, 403);

  const create = await request(baseUrl, "/api/memories", {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      groupId: "67890",
      type: "group_fact",
      title: "群规则",
      content: "重要问题先给上下文。",
      source: "admin",
    }),
  });
  assert.equal(create.status, 201);
  const created = await create.json() as { id: string; source: string; type: string };
  assert.equal(created.source, "admin");
  assert.equal(created.type, "group_fact");
  assert.equal((await memories.list("67890")).length, 2);
  assert.equal((await operations.list({ groupId: "67890" })).some((entry) => entry.action === "memory_create" && entry.target === created.id), true);

  for (const pathname of ["/api/memory-candidates?groupId=67890", "/api/profile-records", "/api/system-settings/admin-secret"]) {
    const response = await request(baseUrl, pathname, { headers: { Cookie: auth.cookie } });
    assert.equal(response.status, 410, pathname);
  }
  const genericSkills = await request(baseUrl, "/api/skills", { headers: { Cookie: auth.cookie } });
  assert.equal(genericSkills.status, 404);

  const persona = await request(baseUrl, "/api/persona/huixian", { headers: { Cookie: auth.cookie } });
  assert.equal(persona.status, 200);
  assert.equal((await persona.json() as { id: string }).id, "huixian");

  const retiredSettings = await request(baseUrl, "/api/system-settings", {
    method: "PUT",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ memoryCandidateConfidenceThreshold: 80 }),
  });
  assert.equal(retiredSettings.status, 410);
});

test("recovery authentication requires fresh TOTP enrollment and never sets a session cookie", async (t) => {
  const { baseUrl } = await startFixture(t);
  const password = await request(baseUrl, "/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  const challenge = await password.json() as { enrollmentToken: string; totpSecret: string };
  const enrolled = await request(baseUrl, "/api/auth/totp/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentToken: challenge.enrollmentToken, code: makeTotp(challenge.totpSecret) }),
  });
  const initial = await enrolled.json() as { recoveryCodes: string[] };
  const oldCookie = enrolled.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(oldCookie);
  assert.equal(initial.recoveryCodes.length, 10);

  const recovery = await request(baseUrl, "/api/auth/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "secret-password",
      recoveryCode: initial.recoveryCodes[0],
    }),
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.headers.get("set-cookie"), null);
  const reset = await recovery.json() as { status: string; enrollmentToken: string; totpSecret: string };
  assert.equal(reset.status, "totp_enrollment_required");
  assert.equal((await request(baseUrl, "/api/session", { headers: { Cookie: oldCookie } })).status, 401);

  const reEnrolled = await request(baseUrl, "/api/auth/totp/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentToken: reset.enrollmentToken, code: makeTotp(reset.totpSecret) }),
  });
  assert.equal(reEnrolled.status, 200);
  assert.ok(reEnrolled.headers.get("set-cookie"));
});

test("group administrators are limited to authorized groups and operational features", async (t) => {
  const { baseUrl } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const inviteResponse = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json() as { token: string };

  const accepted = await request(baseUrl, "/api/auth/invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken: invite.token, username: "operator", password: "operator-password" }),
  });
  assert.equal(accepted.status, 200);
  const enrollment = await accepted.json() as { status: string; enrollmentToken: string; totpSecret: string };
  assert.equal(enrollment.status, "totp_enrollment_required");
  const enrolled = await request(baseUrl, "/api/auth/totp/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentToken: enrollment.enrollmentToken, code: makeTotp(enrollment.totpSecret) }),
  });
  assert.equal(enrolled.status, 200);
  const cookie = enrolled.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const sessionResponse = await request(baseUrl, "/api/session", { headers: { Cookie: cookie } });
  const groupAdminSession = await sessionResponse.json() as { csrfToken: string; role: string; allowedGroupIds: string[] };
  assert.equal(groupAdminSession.role, "group_admin");
  assert.deepEqual(groupAdminSession.allowedGroupIds, ["67890"]);

  const crossGroup = await request(baseUrl, "/api/groups/100200/config", { headers: { Cookie: cookie } });
  assert.equal(crossGroup.status, 403);
  const systemSettings = await request(baseUrl, "/api/system-settings", { headers: { Cookie: cookie } });
  assert.equal(systemSettings.status, 403);
  const accountList = await request(baseUrl, "/api/admin-accounts", { headers: { Cookie: cookie } });
  assert.equal(accountList.status, 403);
  const diagnostics = await request(baseUrl, "/api/health", { headers: { Cookie: cookie } });
  assert.equal(diagnostics.status, 403);

  const createMemory = await request(baseUrl, "/api/memories", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": groupAdminSession.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: "67890", type: "group_fact", title: "运营事实", content: "管理员明确保存。" }),
  });
  assert.equal(createMemory.status, 201);

  const forbiddenConfig = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: cookie, "X-CSRF-Token": groupAdminSession.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ switcherUserIds: ["77777"] }),
  });
  assert.equal(forbiddenConfig.status, 403);

  const optOut = await request(baseUrl, "/api/groups/67890/members/20001/privacy-opt-out", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": groupAdminSession.csrfToken, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(optOut.status, 200);
  const restore = await request(baseUrl, "/api/groups/67890/members/20001/privacy-opt-out", {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": groupAdminSession.csrfToken },
  });
  assert.equal(restore.status, 403);
});

function makeTotp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const text = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid_test_totp_secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(now / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}
