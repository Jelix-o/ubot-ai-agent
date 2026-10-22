import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpServer, resolveTrustedClientIp } from "./admin-http-server.js";
import { SharedDb } from "./shared/sqlite.js";
import { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import { AdminTaskStore } from "./services/admin-task-store.js";
import { CharacterProfileService } from "./services/character-profile-service.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { GroupMemoryStore } from "./services/group-memory-store.js";
import { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { KnowledgeSourceBindingStore } from "./services/knowledge-source-binding-store.js";
import { MemeLibraryService } from "./services/meme-library-service.js";
import { ModelTelemetryStore } from "./services/model-telemetry.js";
import { loadPrivateEnterpriseRanking } from "./services/private-enterprise-ranking.js";
import { SystemSettingsStore } from "./services/system-settings-store.js";
import { V3StateRepository } from "./services/v3-state-repository.js";
import type { CharacterProfile, NapcatGroupMember } from "./types.js";

const TEST_STATE_KEY = "0".repeat(64);

type Auth = { cookie: string; csrf: string; session: { userId: string; username: string; role: string; allowedGroupIds: string[] } };

type HtmlPreviewTestItem = {
  id: string;
  groupId: string;
  creatorUserId: string;
  title: string;
  previewUrl: string;
  status: "pending" | "published" | "failed" | "expired" | "deleted";
  createdAt: string;
  expiresAt: string;
  byteSize: number;
  /** Deliberately present in the fake to prove the API filters it out. */
  html: string;
};

type HtmlPreviewTestService = {
  listPage(args: {
    groupId?: string;
    visibleGroupIds?: string[];
    page?: number;
    pageSize?: number;
    status?: string;
  }): Promise<{ items: HtmlPreviewTestItem[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>;
  get(id: string): Promise<HtmlPreviewTestItem | undefined>;
  remove(id: string): Promise<boolean>;
};

type ImagePreviewTestItem = {
  id: string;
  groupId: string;
  creatorUserId: string;
  promptSummary: string;
  prompt: string;
  modelId: string;
  model: string;
  fallbackUsed: boolean;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  status: "available" | "expired" | "deleted";
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  /** Deliberately present in the fake to prove the API filters it out. */
  sourceMessageId: string;
};

type ImagePreviewTestService = {
  listPage(args: {
    groupId?: string;
    visibleGroupIds?: string[];
    page?: number;
    pageSize?: number;
    status?: string;
  }): Promise<{ items: Omit<ImagePreviewTestItem, "prompt">[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>;
  get(id: string): Promise<Omit<ImagePreviewTestItem, "prompt"> | undefined>;
  getDetail(id: string): Promise<ImagePreviewTestItem | undefined>;
  loadImage(id: string): Promise<{ data: Buffer; mimeType: ImagePreviewTestItem["mimeType"]; byteSize: number } | undefined>;
  remove(id: string): Promise<boolean>;
};

const IMAGE_PREVIEW_TEST_DATA = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0000004010100e7a3255b0000000049454e44ae426082", "hex");

function redactImagePreview(item: ImagePreviewTestItem): Omit<ImagePreviewTestItem, "prompt"> {
  const { prompt: _prompt, ...metadata } = item;
  return metadata;
}

function createImagePreviewTestService(): ImagePreviewTestService {
  let items: ImagePreviewTestItem[] = [
    {
      id: "image-allowed",
      groupId: "67890",
      creatorUserId: "20001",
      promptSummary: "一只戴棕色蝴蝶结的鹈鹕骑自行车穿过街巷",
      prompt: "一只戴棕色蝴蝶结的鹈鹕骑自行车穿过街巷，侧面视角，2D 动画风格。",
      modelId: "image-primary",
      model: "gpt-image-1",
      fallbackUsed: false,
      mimeType: "image/png",
      byteSize: IMAGE_PREVIEW_TEST_DATA.byteLength,
      status: "available",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
      sourceMessageId: "source-image-allowed",
    },
    {
      id: "image-forbidden",
      groupId: "100200",
      creatorUserId: "20002",
      promptSummary: "未授权群的生图提示词摘要",
      prompt: "未授权群的完整生图提示词。",
      modelId: "image-fallback",
      model: "gpt-image-1",
      fallbackUsed: true,
      mimeType: "image/webp",
      byteSize: 2048,
      status: "available",
      createdAt: "2026-01-02T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      sourceMessageId: "source-image-forbidden",
    },
  ];

  return {
    async listPage(args) {
      const filtered = items.filter((item) => (
        (!args.groupId || item.groupId === args.groupId) &&
        (!args.visibleGroupIds || args.visibleGroupIds.includes(item.groupId)) &&
        (!args.status || item.status === args.status)
      ));
      const pageSize = args.pageSize ?? 20;
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(Math.max(1, args.page ?? 1), totalPages);
      return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize).map(redactImagePreview),
        pagination: { page, pageSize, total: filtered.length, totalPages },
      };
    },
    async get(id) {
      const item = items.find((candidate) => candidate.id === id);
      return item ? redactImagePreview(item) : undefined;
    },
    async getDetail(id) {
      return items.find((candidate) => candidate.id === id);
    },
    async loadImage(id) {
      const item = items.find((candidate) => candidate.id === id);
      return item?.status === "available"
        ? { data: IMAGE_PREVIEW_TEST_DATA, mimeType: item.mimeType, byteSize: IMAGE_PREVIEW_TEST_DATA.byteLength }
        : undefined;
    },
    async remove(id) {
      const index = items.findIndex((candidate) => candidate.id === id);
      if (index < 0 || items[index]!.status === "deleted") return false;
      const previous = items[index]!;
      items[index] = {
        ...previous,
        prompt: "",
        promptSummary: "",
        status: "deleted",
        deletedAt: "2026-01-03T00:00:00.000Z",
      };
      return true;
    },
  };
}

function createHtmlPreviewTestService(): HtmlPreviewTestService {
  let items: HtmlPreviewTestItem[] = [
    {
      id: "preview-allowed",
      groupId: "67890",
      creatorUserId: "20001",
      title: "已授权页面",
      previewUrl: "https://preview.9958.uk/p/abcdefghijklmnopqrstuvwx_0123456789ABCDEF/",
      status: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
      byteSize: 1024,
      html: "<script>throw new Error('must never leave the service')</script>",
    },
    {
      id: "preview-forbidden",
      groupId: "100200",
      creatorUserId: "20002",
      title: "未授权页面",
      previewUrl: "https://preview.9958.uk/p/zyxwvutsrqponmlkjihgfe_9876543210FEDCBA/",
      status: "published",
      createdAt: "2026-01-02T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      byteSize: 2048,
      html: "<main>private</main>",
    },
  ];

  return {
    async listPage(args) {
      const filtered = items.filter((item) => (
        (!args.groupId || item.groupId === args.groupId) &&
        (!args.visibleGroupIds || args.visibleGroupIds.includes(item.groupId)) &&
        (!args.status || item.status === args.status)
      ));
      const pageSize = args.pageSize ?? 20;
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(Math.max(1, args.page ?? 1), totalPages);
      return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        pagination: { page, pageSize, total: filtered.length, totalPages },
      };
    },
    async get(id) {
      return items.find((item) => item.id === id);
    },
    async remove(id) {
      const previousLength = items.length;
      items = items.filter((item) => item.id !== id);
      return items.length !== previousLength;
    },
  };
}

const huixian: CharacterProfile = {
  id: "huixian",
  name: "会仙",
  systemPrompt: "会仙自然聊天，不主动谈身份标签，不编造现实可核验的事实。",
  styleRules: ["自然、诚实、有边界。"],
  knowledge: ["现实证明类话题自然转场，不承诺事实。"],
  temperature: 0.8,
  maxContextTurns: 24,
};

async function startFixture(
  t: test.TestContext,
  options: {
    listGroupMembers?: (groupId: string) => Promise<NapcatGroupMember[]>;
    htmlPreviewService?: HtmlPreviewTestService;
    imagePreviewService?: ImagePreviewTestService;
  } = {},
) {
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
  const tasks = new AdminTaskStore(path.join(dir, "tasks.json"), repository);
  const memeLibraryService = new MemeLibraryService(dir, repository);
  const settings = new SystemSettingsStore(path.join(dir, "settings.json"), [], undefined, repository);
  const characterProfileService = new CharacterProfileService(repository, { bootstrapProfile: huixian });
  const htmlPreviewService = options.htmlPreviewService ?? createHtmlPreviewTestService();
  const imagePreviewService = options.imagePreviewService ?? createImagePreviewTestService();
  await characterProfileService.ensureHuixianProfile("test-bootstrap");
  await memeLibraryService.initialize();
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
    knowledgeSourceBindingStore: new KnowledgeSourceBindingStore(repository),
    privateEnterpriseRanking: loadPrivateEnterpriseRanking(),
    characterProfileService,
    systemSettingsStore: settings,
    adminTaskStore: tasks,
    htmlPreviewService,
    imagePreviewService,
    memeLibraryService,
    adminOperationLogService: operations,
    async getTransportHealthStatus() { return { ok: true, detail: "ok" }; },
    ...(options.listGroupMembers ? { listGroupMembers: options.listGroupMembers } : {}),
  });
  const rawServer = (server as unknown as { server: Server }).server;
  let baseUrl = "";
  // Windows can assign a port forbidden by fetch (for example, 10080).
  // Rebind the fixture only for that error; real HTTP failures still fail.
  for (;;) {
    await server.start();
    const address = rawServer.address() as AddressInfo | null;
    assert.ok(address);
    baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(`${baseUrl}/api/health`);
      break;
    } catch (error) {
      if (!(error instanceof TypeError) || !(error.cause instanceof Error) || error.cause.message !== "bad port") throw error;
      await new Promise<void>((resolve, reject) => rawServer.close(error => error ? reject(error) : resolve()));
    }
  }
  t.after(() => {
    server.close();
    db.close();
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { baseUrl, db, memories, operations, tasks, htmlPreviewService, imagePreviewService, memeLibraryService };
}

function createStartupOnlyServer(port: number, ensureInitialized: () => Promise<void>): AdminHttpServer {
  return new AdminHttpServer({
    host: "127.0.0.1",
    port,
    publicBaseUrl: "http://127.0.0.1",
    authService: { ensureInitialized } as never,
  } as never);
}

function requestForClientIp(
  remoteAddress: string | undefined,
  xRealIp?: string | string[],
): Pick<import("node:http").IncomingMessage, "headers" | "socket"> {
  return {
    headers: xRealIp === undefined ? {} : { "x-real-ip": xRealIp },
    socket: { remoteAddress },
  } as unknown as Pick<import("node:http").IncomingMessage, "headers" | "socket">;
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
  const payload = await passwordResponse.json() as {
    ok: boolean;
    status: string;
    session: Auth["session"] & { csrfToken: string };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "authenticated");
  assert.equal(payload.session.username, username);
  assert.ok(payload.session.csrfToken);
  const cookie = passwordResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  // GET /api/session rotates CSRF on purpose; keep the rotated token for writes.
  const sessionResponse = await request(baseUrl, "/api/session", { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as Auth["session"] & { csrfToken: string };
  return { cookie, csrf: session.csrfToken, session };
}

async function acceptInviteAsAdmin(
  baseUrl: string,
  inviteToken: string,
  username: string,
  password = "operator-password-12",
): Promise<Auth> {
  const accepted = await request(baseUrl, "/api/auth/invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken, username, password }),
  });
  assert.equal(accepted.status, 201);
  const payload = await accepted.json() as {
    ok: boolean;
    status: string;
    session: Auth["session"] & { csrfToken: string };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "authenticated");
  const cookie = accepted.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const sessionResponse = await request(baseUrl, "/api/session", { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as Auth["session"] & { csrfToken: string };
  return { cookie, csrf: session.csrfToken, session };
}

async function reauth(baseUrl: string, auth: Auth, password = "secret-password"): Promise<Response> {
  return request(baseUrl, "/api/auth/reauth", {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

test("Admin startup rejects bootstrap failures before opening the listener", async () => {
  const server = createStartupOnlyServer(0, async () => {
    throw new Error("bootstrap_failed_for_test");
  });

  await assert.rejects(server.start(), /bootstrap_failed_for_test/);
  const raw = (server as unknown as { server: Server }).server;
  assert.equal(raw.listening, false);
});

test("Admin startup rejects an occupied port", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())));
  const address = blocker.address() as AddressInfo;
  const server = createStartupOnlyServer(address.port, async () => undefined);

  await assert.rejects(server.start(), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
    return true;
  });
});

test("Admin trusts a valid X-Real-IP only from its loopback reverse proxy", () => {
  assert.equal(resolveTrustedClientIp(requestForClientIp("127.0.0.1", "203.0.113.7")), "203.0.113.7");
  assert.equal(resolveTrustedClientIp(requestForClientIp("::ffff:127.0.0.1", "2001:db8::7")), "2001:db8::7");
  assert.equal(resolveTrustedClientIp(requestForClientIp("127.0.0.1", "not-an-ip")), "127.0.0.1");
  assert.equal(resolveTrustedClientIp(requestForClientIp("198.51.100.20", "203.0.113.7")), "198.51.100.20");
  assert.equal(resolveTrustedClientIp(requestForClientIp("127.0.0.1", ["203.0.113.7", "198.51.100.20"])), "127.0.0.1");
});

test("HTTP loopback sessions avoid the Secure-only __Host cookie prefix", async (t) => {
  const { baseUrl } = await startFixture(t);
  const response = await request(baseUrl, "/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^ubot_admin_session=/);
  assert.doesNotMatch(cookie, /__Host-/);
  assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
});

test("V3 admin uses SQLite password authentication and retires legacy routes", async (t) => {
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

  const retiredRoastModeConfig = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ roastModeUserIds: ["77777"] }),
  });
  assert.equal(retiredRoastModeConfig.status, 410);
  assert.equal((await retiredRoastModeConfig.json() as { error: string }).error, "roast_mode_retired");

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

test("V3 admin password login is immediate and TOTP/recovery routes are retired", async (t) => {
  const { baseUrl } = await startFixture(t);

  for (const pathname of [
    "/api/auth/totp",
    "/api/auth/totp/enroll",
    "/api/auth/totp/reset",
    "/api/auth/recovery",
    "/api/auth/recovery-codes",
  ]) {
    const response = await request(baseUrl, pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000", recoveryCode: "unused" }),
    });
    assert.equal(response.status, 404, pathname);
  }

  const invalid = await request(baseUrl, "/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong-password!" }),
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json() as { error: string }).error, "invalid_credentials");

  const auth = await login(baseUrl);
  assert.equal(auth.session.role, "super_admin");
  assert.equal(auth.session.username, "admin");

  const logout = await request(baseUrl, "/api/auth/logout", {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf },
  });
  assert.equal(logout.status, 200);
  assert.equal((await request(baseUrl, "/api/session", { headers: { Cookie: auth.cookie } })).status, 401);
});

test("password change requires recent reauth, enforces min length 12, and revokes sibling sessions", async (t) => {
  const { baseUrl, db } = await startFixture(t);
  const first = await login(baseUrl);
  const second = await login(baseUrl);

  db.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ? WHERE id IN (SELECT id FROM admin_sessions WHERE revoked_at IS NULL)")
    .run(Date.now() - 15 * 60 * 1_000);

  const staleHeaders = { Cookie: first.cookie, "X-CSRF-Token": first.csrf, "Content-Type": "application/json" };
  const denied = await request(baseUrl, "/api/auth/password/change", {
    method: "POST",
    headers: staleHeaders,
    body: JSON.stringify({ currentPassword: "secret-password", nextPassword: "next-secret-password-12" }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: string }).error, "recent_reauth_required");

  const badReauth = await reauth(baseUrl, first, "wrong-password!");
  assert.equal(badReauth.status, 401);

  const goodReauth = await reauth(baseUrl, first, "secret-password");
  assert.equal(goodReauth.status, 200);

  const shortPassword = await request(baseUrl, "/api/auth/password/change", {
    method: "POST",
    headers: staleHeaders,
    body: JSON.stringify({ currentPassword: "secret-password", nextPassword: "too-short" }),
  });
  assert.equal(shortPassword.status, 400);
  assert.equal((await shortPassword.json() as { error?: string }).error, "invalid_password");

  const changed = await request(baseUrl, "/api/auth/password/change", {
    method: "POST",
    headers: staleHeaders,
    body: JSON.stringify({ currentPassword: "secret-password", nextPassword: "next-secret-password-12" }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ok: true });

  assert.equal((await request(baseUrl, "/api/session", { headers: { Cookie: second.cookie } })).status, 401);
  assert.equal((await request(baseUrl, "/api/session", { headers: { Cookie: first.cookie } })).status, 200);

  const oldPassword = await request(baseUrl, "/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await login(baseUrl, "admin", "next-secret-password-12");
  assert.equal(newPassword.session.username, "admin");
});

test("knowledge binding APIs enforce role, group scope, conflict validation and reload", async (t) => {
  const { baseUrl } = await startFixture(t);
  const root = await login(baseUrl);
  const headers = (auth: Auth) => ({ Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" });
  const put = (auth: Auth, body: unknown) => request(baseUrl, "/api/knowledge/bindings", {
    method: "PUT", headers: headers(auth), body: JSON.stringify(body),
  });
  const get = (auth: Auth, groupId: string) => request(baseUrl, "/api/knowledge/bindings?groupId=" + groupId, { headers: headers(auth) });
  const defaults = await get(root, "67890");
  assert.deepEqual(await defaults.json(), { rankingCommand: "#民营企业排名", groupFaqCommand: "#群知识库" });
  const invite = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST", headers: headers(root),
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  assert.equal(invite.status, 201);
  const member = await acceptInviteAsAdmin(baseUrl, (await invite.json() as { token: string }).token, "knowledge-editor");
  assert.equal((await get(member, "100200")).status, 403);
  assert.equal((await put(member, { source: "group_faq", groupId: "100200", command: "#私有" })).status, 403);
  assert.equal((await put(member, { source: "private_enterprise_ranking", command: "#榜单" })).status, 403);
  assert.equal((await put(member, { source: "group_faq", groupId: "67890", command: "#本群资料" })).status, 200);
  assert.equal((await put(member, { source: "group_faq", groupId: "67890", command: "#本群资料" })).status, 200);
  assert.equal((await (await get(root, "67890")).json()).groupFaqCommand, "#本群资料");
  assert.equal((await (await get(root, "100200")).json()).groupFaqCommand, "#群知识库");

  assert.equal((await put(root, { source: "private_enterprise_ranking", command: "#本群资料" })).status, 409);
  assert.equal((await put(root, { source: "private_enterprise_ranking", command: "#企业榜" })).status, 200);
  assert.equal((await (await get(member, "67890")).json()).rankingCommand, "#企业榜");
  for (const command of ["#知识库", "#知识库查询", "#知识", "#企业榜"]) {
    assert.equal((await put(member, { source: "group_faq", groupId: "67890", command })).status, 409, command);
  }
  for (const command of ["榜单", "#", "#a b", "#a!"]) {
    assert.equal((await put(member, { source: "group_faq", groupId: "67890", command })).status, 400, command);
  }
  assert.equal((await request(baseUrl, "/api/knowledge/bindings", {
    method: "PUT", headers: { Cookie: root.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "private_enterprise_ranking", command: "#新榜" }),
  })).status, 403, "CSRF remains enforced");
  const commands = await (await request(baseUrl, "/api/commands", { headers: headers(root) })).json() as { commands: Array<{ primary: string }> };
  commands.commands[0]!.primary = "#企业榜";
  assert.equal((await request(baseUrl, "/api/commands", {
    method: "PUT", headers: headers(root), body: JSON.stringify(commands),
  })).status, 409, "system commands cannot take knowledge bindings");
});

test("BT command can be renamed and disabled through the admin API and rejects namespace collisions", async (t) => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const before = await (await request(baseUrl, "/api/commands", { headers })).json() as { revision: string; commands: Array<{ id: string; primary: string; aliases: string[]; enabled: boolean }> };
  const bt = before.commands.find(command => command.id === "bt_search")!;
  assert.equal(bt.primary, "#bt");
  assert.deepEqual(bt.aliases, ["/bt"]);
  const put = (command: unknown) => request(baseUrl, "/api/commands", { method: "PUT", headers, body: JSON.stringify({ commands: [command], expectedRevision: before.revision }) });
  assert.equal((await put({ ...bt, primary: "#模型" })).status, 409);
  assert.equal((await put({ ...bt, primary: "#资源", aliases: ["/搜索"], enabled: false })).status, 200);
  const after = await (await request(baseUrl, "/api/commands", { headers })).json() as typeof before;
  assert.equal(after.commands.find(command => command.id === "bt_search")?.enabled, false);
  assert.equal(after.commands.find(command => command.id === "bt_search")?.primary, "#资源");
  assert.deepEqual(after.commands.filter(command => command.id !== "bt_search"), before.commands.filter(command => command.id !== "bt_search"));
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
  const groupAdmin = await acceptInviteAsAdmin(baseUrl, invite.token, "operator");
  assert.equal(groupAdmin.session.role, "group_admin");
  assert.deepEqual(groupAdmin.session.allowedGroupIds, ["67890"]);
  const cookie = groupAdmin.cookie;
  const groupCsrf = groupAdmin.csrf;

  const crossGroup = await request(baseUrl, "/api/groups/100200/config", { headers: { Cookie: cookie } });
  assert.equal(crossGroup.status, 403);
  const crossGroupMemberRefresh = await request(baseUrl, "/api/groups/100200/members/refresh", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(crossGroupMemberRefresh.status, 403);
  const systemSettings = await request(baseUrl, "/api/system-settings", { headers: { Cookie: cookie } });
  assert.equal(systemSettings.status, 403);
  for (const patch of [{ replyModelMode: "gpt" }, { replyModelSource: "global" }]) {
    const denied = await request(baseUrl, "/api/groups/67890/config", { method: "PUT", headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    assert.equal(denied.status, 403, "direct requests cannot change group model policy");
  }
  const accountList = await request(baseUrl, "/api/admin-accounts", { headers: { Cookie: cookie } });
  assert.equal(accountList.status, 403);
  const diagnostics = await request(baseUrl, "/api/health", { headers: { Cookie: cookie } });
  assert.equal(diagnostics.status, 403);
  const memeLibrary = await request(baseUrl, "/api/meme-library", { headers: { Cookie: cookie } });
  assert.equal(memeLibrary.status, 403);
  const memePreview = await request(baseUrl, "/api/meme-library/assets/blacklisted-at-meme-seed/preview", { headers: { Cookie: cookie } });
  assert.equal(memePreview.status, 403);

  const createMemory = await request(baseUrl, "/api/memories", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: "67890", type: "group_fact", title: "运营事实", content: "管理员明确保存。" }),
  });
  assert.equal(createMemory.status, 201);

  const forbiddenConfig = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" },
    body: JSON.stringify({ switcherUserIds: ["77777"] }),
  });
  assert.equal(forbiddenConfig.status, 403);

  const ambientContextUpdate = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" },
    body: JSON.stringify({ ambientGroupContextEnabled: false }),
  });
  assert.equal(ambientContextUpdate.status, 200);
  assert.equal(
    (await ambientContextUpdate.json() as { ambientGroupContextEnabled?: boolean }).ambientGroupContextEnabled,
    false,
  );

  const optOut = await request(baseUrl, "/api/groups/67890/members/20001/privacy-opt-out", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(optOut.status, 200);
  const restore = await request(baseUrl, "/api/groups/67890/members/20001/privacy-opt-out", {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": groupCsrf },
  });
  assert.equal(restore.status, 403);
});

test("command permissions expose server floors, persist changes and reject stale or lowered policy", async (t) => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const before = await (await request(baseUrl, "/api/commands", { headers })).json() as { revision: string; commands: Array<{ id: string; permission: string; minimumPermission: string }> };
  const image = before.commands.find(command => command.id === "image_generation")!;
  assert.equal(image.permission, "member"); assert.equal(image.minimumPermission, "member");
  assert.equal(before.commands.find(command => command.id === "model")?.minimumPermission, "super_admin");
  const put = (commands: unknown[], expectedRevision = before.revision) => request(baseUrl, "/api/commands", { method: "PUT", headers, body: JSON.stringify({ commands, expectedRevision }) });
  for (const [id, permission] of [["model", "group_admin"], ["mute", "member"], ["image_generation", "invalid"]]) {
    assert.equal((await put([{ ...before.commands.find(command => command.id === id), permission }])).status, 400);
  }
  const saved = await put([{ ...image, permission: "group_admin" }]);
  assert.equal(saved.status, 200);
  const after = await saved.json() as typeof before;
  assert.equal(after.commands.find(command => command.id === image.id)?.permission, "group_admin");
  assert.equal((await put([{ ...image, permission: "super_admin" }])).status, 409);
  assert.equal((await put([{ ...image, permission: "member" }], after.revision)).status, 200);
});

test("configuration APIs reject retired Gemini IDs and upstream aliases before saving", async (t) => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const settings = await (await request(baseUrl, "/api/system-settings", { headers })).json() as { revision: string };
  for (const patch of [
    { models: [{ id: "gemini", model: "gemini-3" }] },
    { models: [{ id: "custom-alias", model: "google/gemini-3" }] },
    { selectedModelIds: { summary: "gemini-38-flash" } },
    { replyRouting: { fallbackModelIds: ["gemini"] } },
  ]) {
    const rejected = await request(baseUrl, "/api/system-settings", { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: settings.revision, patch }) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { error: string }).error, "model_retired");
  }
  const group = await (await request(baseUrl, "/api/groups/67890/config", { headers })).json() as { revision: string };
  const rejected = await request(baseUrl, "/api/groups/67890/config", { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: group.revision, patch: { replyModelMode: "gemini" } }) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as { error: string }).error, "model_retired");
  const after = await (await request(baseUrl, "/api/system-settings", { headers })).json() as { revision: string };
  assert.equal(after.revision, settings.revision);
});

test("model policy requires current revisions even through legacy PUT and supports restoring global inheritance", async (t) => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const settings = await (await request(baseUrl, "/api/system-settings", { headers })).json() as { revision: string; replyRouting: Record<string, unknown> };
  const policy = { models: ["sol", "gpt", "ds"].map(id => ({ id, purpose: "reply", name: id, shortName: id, model: id, baseUrl: "https://test.invalid", apiKey: "test", enabled: true })), selectedModelIds: { reply: "sol" }, replyRouting: { ...settings.replyRouting, fallbackModelIds: ["gpt", "ds"] } };
  const putSettings = (body: unknown) => request(baseUrl, "/api/system-settings", { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal((await putSettings(policy)).status, 409);
  assert.equal((await putSettings({ ...policy, expectedRevision: settings.revision })).status, 200);
  const getGroup = async () => (await (await request(baseUrl, "/api/groups/67890/config", { headers })).json()) as { revision: string; replyModelSource: string; replyModelMode: string };
  const putGroup = (body: unknown) => request(baseUrl, "/api/groups/67890/config", { method: "PUT", headers, body: JSON.stringify(body) });
  const before = await getGroup();
  assert.equal((await putGroup({ replyModelSource: "global" })).status, 409);
  assert.equal((await putGroup({ expectedRevision: before.revision, replyModelMode: "ds", replyModelSource: "override" })).status, 200);
  assert.equal((await putGroup({ expectedRevision: before.revision, replyModelSource: "global" })).status, 409);
  const override = await getGroup();
  assert.equal(override.replyModelSource, "override"); assert.equal(override.replyModelMode, "ds");
  assert.equal((await putGroup({ expectedRevision: override.revision, replyModelSource: "global" })).status, 200);
  assert.equal((await getGroup()).replyModelSource, "global");
});

test("2026 ranking API is authenticated, paginated and strictly read-only", async (t) => {
  const { baseUrl } = await startFixture(t);
  const endpoint = "/api/knowledge/rankings/2026";
  assert.equal((await request(baseUrl, endpoint)).status, 401);

  const superAdmin = await login(baseUrl);
  const inviteResponse = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  assert.equal(inviteResponse.status, 201);
  const groupAdmin = await acceptInviteAsAdmin(baseUrl, (await inviteResponse.json() as { token: string }).token, "ranking-reader");

  const page = await request(baseUrl, `${endpoint}?province=%E6%B5%99%E6%B1%9F%E7%9C%81&page=2&pageSize=50`, {
    headers: { Cookie: groupAdmin.cookie },
  });
  assert.equal(page.status, 200);
  const data = await page.json() as {
    items: Array<{ rank: number; name: string }>;
    pagination: { total: number; page: number; pageSize: number };
    metadata: { cityCoverage: number; cityReady: boolean; rowsSha256: string };
  };
  assert.equal(data.pagination.total, 104);
  assert.equal(data.pagination.page, 2);
  assert.equal(data.items.length, 50);
  assert.equal(data.metadata.cityCoverage, 0);
  assert.equal(data.metadata.cityReady, false);
  assert.match(data.metadata.rowsSha256, /^[a-f0-9]{64}$/);

  const search = await request(baseUrl, `${endpoint}?q=${encodeURIComponent("京东集团")}`, { headers: { Cookie: superAdmin.cookie } });
  assert.deepEqual((await search.json() as { items: Array<{ rank: number }> }).items.map((entry) => entry.rank), [1]);
  const rankSearch = await request(baseUrl, `${endpoint}?q=${encodeURIComponent("第2名")}`, { headers: { Cookie: superAdmin.cookie } });
  assert.deepEqual((await rankSearch.json() as { items: Array<{ rank: number }> }).items.map((entry) => entry.rank), [2]);
  const numericRankSearch = await request(baseUrl, `${endpoint}?q=2`, { headers: { Cookie: superAdmin.cookie } });
  assert.deepEqual((await numericRankSearch.json() as { items: Array<{ rank: number }> }).items.map((entry) => entry.rank), [2]);
  const pendingCity = await request(baseUrl, `${endpoint}?city=${encodeURIComponent("杭州市")}`, { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(pendingCity.status, 409);
  assert.equal((await pendingCity.json() as { error: string }).error, "headquarters_not_verified");
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const write = await request(baseUrl, endpoint, {
      method,
      headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(write.status, 405, method);
  }
});

test("super admin can bind and unbind an account QQ identity after recent reauth", async (t) => {
  const { baseUrl } = await startFixture(t);
  const unauthenticated = await request(baseUrl, "/api/admin-accounts/missing/qq-binding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qqUserId: "1569671790" }),
  });
  assert.equal(unauthenticated.status, 401);

  const auth = await login(baseUrl);
  const accountsResponse = await request(baseUrl, "/api/admin-accounts", { headers: { Cookie: auth.cookie } });
  const account = (await accountsResponse.json() as { accounts: Array<{ id: string; qqUserId?: string }> }).accounts[0];
  assert.ok(account);

  const invalid = await request(baseUrl, `/api/admin-accounts/${encodeURIComponent(account.id)}/qq-binding`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ qqUserId: "invalid" }),
  });
  assert.equal(invalid.status, 400);

  const bound = await request(baseUrl, `/api/admin-accounts/${encodeURIComponent(account.id)}/qq-binding`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ qqUserId: "1569671790" }),
  });
  assert.equal(bound.status, 200);
  assert.equal((await bound.json() as { accounts: Array<{ qqUserId?: string }> }).accounts[0]?.qqUserId, "1569671790");

  const removed = await request(baseUrl, `/api/admin-accounts/${encodeURIComponent(account.id)}/qq-binding`, {
    method: "DELETE",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf },
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { accounts: Array<{ qqUserId?: string }> }).accounts[0]?.qqUserId, undefined);
});

test("HTML preview admin endpoints expose metadata only, enforce group scope, CSRF, and audit deletion", async (t) => {
  const { baseUrl, operations } = await startFixture(t);
  const superAdmin = await login(baseUrl);

  const list = await request(baseUrl, "/api/html-previews?groupId=67890", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(list.status, 200);
  const listData = await list.json() as {
    previews: Array<Record<string, unknown>>;
    pagination: { total: number };
  };
  assert.equal(listData.pagination.total, 1);
  assert.deepEqual(Object.keys(listData.previews[0]!).sort(), [
    "byteSize",
    "createdAt",
    "creatorUserId",
    "expiresAt",
    "groupId",
    "id",
    "previewUrl",
    "status",
    "title",
  ]);
  assert.equal(Object.hasOwn(listData.previews[0]!, "html"), false);
  assert.equal(listData.previews[0]?.title, "已授权页面");

  const missingCsrf = await request(baseUrl, "/api/html-previews/preview-allowed", {
    method: "DELETE",
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const deleted = await request(baseUrl, "/api/html-previews/preview-allowed", {
    method: "DELETE",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal((await operations.list({ groupId: "67890" })).some((entry) => (
    entry.action === "html_preview_delete" && entry.target === "preview-allowed"
  )), true);

  const afterDelete = await request(baseUrl, "/api/html-previews?groupId=67890", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal((await afterDelete.json() as { pagination: { total: number } }).pagination.total, 0);
});

test("image preview APIs keep prompts private by default, serve private bytes, and clear prompt data on deletion", async (t) => {
  const { baseUrl, operations } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const prompt = "一只戴棕色蝴蝶结的鹈鹕骑自行车穿过街巷，侧面视角，2D 动画风格。";
  const summary = "一只戴棕色蝴蝶结的鹈鹕骑自行车穿过街巷";

  const list = await request(baseUrl, "/api/image-previews?groupId=67890", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(list.status, 200);
  const listData = await list.json() as {
    previews: Array<Record<string, unknown>>;
    pagination: { total: number };
  };
  assert.equal(listData.pagination.total, 1);
  assert.deepEqual(Object.keys(listData.previews[0]!).sort(), [
    "byteSize",
    "createdAt",
    "creatorUserId",
    "expiresAt",
    "fallbackUsed",
    "groupId",
    "id",
    "mimeType",
    "model",
    "modelId",
    "promptSummary",
    "status",
  ]);
  assert.equal(listData.previews[0]?.promptSummary, summary);
  assert.equal(Object.hasOwn(listData.previews[0]!, "prompt"), false);
  assert.equal(Object.hasOwn(listData.previews[0]!, "sourceMessageId"), false);

  const detail = await request(baseUrl, "/api/image-previews/image-allowed", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { preview: { prompt: string } }).preview.prompt, prompt);

  const image = await request(baseUrl, "/api/image-previews/image-allowed/preview", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), IMAGE_PREVIEW_TEST_DATA);

  const missingCsrf = await request(baseUrl, "/api/image-previews/image-allowed", {
    method: "DELETE",
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const deleted = await request(baseUrl, "/api/image-previews/image-allowed", {
    method: "DELETE",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  const audit = await operations.list({ groupId: "67890" });
  const entry = audit.find((candidate) => candidate.action === "image_preview_delete" && candidate.target === "image-allowed");
  assert.ok(entry);
  assert.equal(JSON.stringify(entry).includes(prompt), false);
  assert.equal(JSON.stringify(entry).includes(summary), false);

  const afterDeleteDetail = await request(baseUrl, "/api/image-previews/image-allowed", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(afterDeleteDetail.status, 404);
  const afterDeleteImage = await request(baseUrl, "/api/image-previews/image-allowed/preview", {
    headers: { Cookie: superAdmin.cookie },
  });
  assert.equal(afterDeleteImage.status, 404);
});

test("group administrators cannot access image previews outside their grants and bulk previews omit prompt text", async (t) => {
  const { baseUrl, operations } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const inviteResponse = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  const invite = await inviteResponse.json() as { token: string };
  const groupAdmin = await acceptInviteAsAdmin(baseUrl, invite.token, "image-preview-operator");
  const headers = { Cookie: groupAdmin.cookie, "X-CSRF-Token": groupAdmin.csrf, "Content-Type": "application/json" };

  const allowedList = await request(baseUrl, "/api/image-previews?groupId=67890", { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(allowedList.status, 200);
  assert.equal((await allowedList.json() as { pagination: { total: number } }).pagination.total, 1);
  const crossGroupList = await request(baseUrl, "/api/image-previews?groupId=100200", { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(crossGroupList.status, 403);
  const crossGroupDetail = await request(baseUrl, "/api/image-previews/image-forbidden", { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(crossGroupDetail.status, 403);
  const crossGroupImage = await request(baseUrl, "/api/image-previews/image-forbidden/preview", { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(crossGroupImage.status, 403);
  const crossGroupDelete = await request(baseUrl, "/api/image-previews/image-forbidden", { method: "DELETE", headers });
  assert.equal(crossGroupDelete.status, 403);

  const previewResponse = await request(baseUrl, "/api/bulk-operations/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ resource: "image-previews", action: "delete", groupId: "67890", ids: ["image-allowed"] }),
  });
  assert.equal(previewResponse.status, 200);
  const previewText = await previewResponse.text();
  assert.equal(previewText.includes("一只戴棕色蝴蝶结"), false);
  const preview = JSON.parse(previewText) as { id: string; targets: Array<{ label: string; before: { status: string }; after: { deleted: boolean } }> };
  assert.equal(preview.targets.length, 1);
  assert.equal(preview.targets[0]?.label, "image-allowed");
  assert.deepEqual(preview.targets[0]?.before, { status: "available" });
  assert.deepEqual(preview.targets[0]?.after, { deleted: true });

  const execution = await request(baseUrl, "/api/bulk-operations/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ previewId: preview.id }),
  });
  assert.equal(execution.status, 202);
  const { taskId } = await execution.json() as { taskId: string };
  let task: { status: string; result?: { items?: Array<{ id: string; status: string }> } } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}`, { headers: { Cookie: groupAdmin.cookie } });
    assert.equal(response.status, 200);
    task = await response.json() as typeof task;
    if (task && !["queued", "running"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task?.status, "succeeded");
  assert.deepEqual(task?.result?.items?.map((item) => [item.id, item.status]), [["image-allowed", "succeeded"]]);
  const audit = await operations.list({ groupId: "67890" });
  const bulkAudit = audit.find((entry) => entry.action === "bulk_image-previews_delete" && entry.target === "image-allowed");
  assert.ok(bulkAudit);
  assert.equal(JSON.stringify(bulkAudit).includes("一只戴棕色蝴蝶结"), false);
});

test("meme library APIs restrict reads and previews to super admins, require recent reauth for changes, and audit uploads", async (t) => {
  const { baseUrl, db, operations } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const sessionHeaders = { Cookie: superAdmin.cookie };
  const writeHeaders = { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" };

  const library = await request(baseUrl, "/api/meme-library", { headers: sessionHeaders });
  assert.equal(library.status, 200);
  const initial = await library.json() as {
    policy: { enabled: boolean; probabilityPercent: number; cooldownSeconds: number };
    assets: Array<{ id: string; scope: string; protected: boolean }>;
  };
  assert.deepEqual(initial.policy, { enabled: true, probabilityPercent: 30, cooldownSeconds: 600 });
  const seed = initial.assets.find((asset) => asset.scope === "blacklisted_at");
  assert.ok(seed);
  assert.equal(seed.protected, true);

  const preview = await request(baseUrl, `/api/meme-library/assets/${encodeURIComponent(seed.id)}/preview`, { headers: sessionHeaders });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.ok((await preview.arrayBuffer()).byteLength > 100);

  const protectedDelete = await request(baseUrl, `/api/meme-library/assets/${encodeURIComponent(seed.id)}`, {
    method: "DELETE",
    headers: writeHeaders,
  });
  assert.equal(protectedDelete.status, 403);
  assert.equal((await protectedDelete.json() as { error: string }).error, "meme_asset_protected");

  const protectedUpdate = await request(baseUrl, `/api/meme-library/assets/${encodeURIComponent(seed.id)}`, {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(protectedUpdate.status, 403);
  assert.equal((await protectedUpdate.json() as { error: string }).error, "meme_asset_protected");

  const tagResponse = await request(baseUrl, "/api/meme-library/tags", {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ name: "吐槽", description: "适合调侃和无语时", keywords: ["  吐槽  ", "无语", "吐槽"] }),
  });
  assert.equal(tagResponse.status, 201);
  const tag = await tagResponse.json() as { id: string; name: string; keywords: string[] };
  assert.equal(tag.name, "吐槽");
  assert.deepEqual(tag.keywords, ["吐槽", "无语"]);

  const missingKeywords = await request(baseUrl, "/api/meme-library/tags", {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ name: "缺关键词" }),
  });
  assert.equal(missingKeywords.status, 400);
  assert.equal((await missingKeywords.json() as { error: string }).error, "meme_tag_keywords_required");

  const emptyKeywords = await request(baseUrl, `/api/meme-library/tags/${encodeURIComponent(tag.id)}`, {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ keywords: ["  "] }),
  });
  assert.equal(emptyKeywords.status, 400);
  assert.equal((await emptyKeywords.json() as { error: string }).error, "meme_tag_keywords_required");

  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");
  const uploadPath = `/api/meme-library/assets?name=${encodeURIComponent("测试表情")}&scope=normal_chat&enabled=1&tag=${encodeURIComponent(tag.id)}`;
  const uploadHeaders = { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "image/png" };

  const missingUploadCsrf = await request(baseUrl, uploadPath, {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "Content-Type": "image/png" },
    body: image,
  });
  assert.equal(missingUploadCsrf.status, 403);
  assert.equal((await missingUploadCsrf.json() as { error: string }).error, "csrf_required");

  const hostileUploadOrigin = await request(baseUrl, uploadPath, {
    method: "POST",
    headers: { ...uploadHeaders, Origin: "https://untrusted.example" },
    body: image,
  });
  assert.equal(hostileUploadOrigin.status, 403);
  assert.equal((await hostileUploadOrigin.json() as { error: string }).error, "invalid_origin");

  const uploadedResponse = await request(
    baseUrl,
    uploadPath,
    {
      method: "POST",
      headers: uploadHeaders,
      body: image,
    },
  );
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json() as { id: string; scope: string; tags: string[]; mimeType: string };
  assert.equal(uploaded.scope, "normal_chat");
  assert.deepEqual(uploaded.tags, [tag.id]);
  assert.equal(uploaded.mimeType, "image/png");

  const missingAssetTags = await request(
    baseUrl,
    `/api/meme-library/assets?name=${encodeURIComponent("无标签")}&scope=normal_chat`,
    { method: "POST", headers: uploadHeaders, body: image },
  );
  assert.equal(missingAssetTags.status, 400);
  assert.equal((await missingAssetTags.json() as { error: string }).error, "meme_asset_tags_required");

  const inUseTag = await request(baseUrl, `/api/meme-library/tags/${encodeURIComponent(tag.id)}`, {
    method: "DELETE",
    headers: writeHeaders,
  });
  assert.equal(inUseTag.status, 409);
  assert.equal((await inUseTag.json() as { error: string }).error, "meme_tag_in_use");

  const uploadedPreview = await request(baseUrl, `/api/meme-library/assets/${encodeURIComponent(uploaded.id)}/preview`, { headers: sessionHeaders });
  assert.equal(uploadedPreview.status, 200);
  assert.equal(uploadedPreview.headers.get("content-type"), "image/png");

  const invalidUpload = await request(
    baseUrl,
    `/api/meme-library/assets?name=${encodeURIComponent("伪装图片")}&scope=blacklisted_at`,
    {
      method: "POST",
      headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "image/png" },
      body: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8"),
    },
  );
  assert.equal(invalidUpload.status, 400);
  assert.equal((await invalidUpload.json() as { error: string }).error, "meme_image_type_invalid");

  const tooLargeUpload = await request(
    baseUrl,
    `/api/meme-library/assets?name=${encodeURIComponent("过大图片")}&scope=blacklisted_at`,
    {
      method: "POST",
      headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "image/png" },
      body: Buffer.alloc(5 * 1024 * 1024 + 1),
    },
  );
  assert.equal(tooLargeUpload.status, 413);
  assert.equal((await tooLargeUpload.json() as { error: string }).error, "meme_image_size_invalid");

  assert.equal((await operations.list({ groupId: "system" })).some((entry) => (
    entry.action === "meme_library_asset_upload" && entry.target === uploaded.id
  )), true);

  db.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ?").run(Date.now() - 11 * 60 * 1_000);
  const stalePolicy = await request(baseUrl, "/api/meme-library/policy", {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(stalePolicy.status, 403);
  assert.equal((await stalePolicy.json() as { error: string }).error, "recent_reauth_required");

  const staleUpload = await request(baseUrl, uploadPath, {
    method: "POST",
    headers: uploadHeaders,
    body: image,
  });
  assert.equal(staleUpload.status, 403);
  assert.equal((await staleUpload.json() as { error: string }).error, "recent_reauth_required");

  const reauthResponse = await reauth(baseUrl, superAdmin, "secret-password");
  assert.equal(reauthResponse.status, 200);

  const restoredPolicy = await request(baseUrl, "/api/meme-library/policy", {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(restoredPolicy.status, 200);

  assert.equal((await request(baseUrl, "/api/meme-library", { headers: sessionHeaders })).status, 200);
});

test("group administrators cannot list or delete HTML previews outside their grants", async (t) => {
  const { baseUrl } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const inviteResponse = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  const invite = await inviteResponse.json() as { token: string };
  const groupAdmin = await acceptInviteAsAdmin(baseUrl, invite.token, "preview-operator");
  const cookie = groupAdmin.cookie;

  const allowedList = await request(baseUrl, "/api/html-previews?groupId=67890", { headers: { Cookie: cookie } });
  assert.equal(allowedList.status, 200);
  assert.equal((await allowedList.json() as { pagination: { total: number } }).pagination.total, 1);

  const crossGroupList = await request(baseUrl, "/api/html-previews?groupId=100200", { headers: { Cookie: cookie } });
  assert.equal(crossGroupList.status, 403);

  const crossGroupDelete = await request(baseUrl, "/api/html-previews/preview-forbidden", {
    method: "DELETE",
    headers: { Cookie: cookie, "X-CSRF-Token": groupAdmin.csrf },
  });
  assert.equal(crossGroupDelete.status, 403);
});

test("member identity API replaces names and keeps the primary after reload and platform refresh", async t => {
  const { baseUrl } = await startFixture(t, { async listGroupMembers() { return [{ user_id: 2458031445, card: "外包仔", nickname: "平台旧昵称", role: "member" }]; } });
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const refresh = () => request(baseUrl, "/api/groups/67890/members/refresh", { method: "POST", headers, body: "{}" });
  await refresh();
  for (const names of [["外包仔", "外包仙人"], ["外包仙人"], ["外包仙人", "外包仔"], ["外包仙人"]]) {
    const response = await request(baseUrl, "/api/groups/67890/members/2458031445/identity", { method: "PUT", headers, body: JSON.stringify({ names, note: "独立备注" }) });
    assert.equal(response.status, 200);
    const saved = await response.json() as { member: { displayName: string; aliases: string[] } };
    assert.equal(saved.member.displayName, names[0]);
    assert.deepEqual(saved.member.aliases, names);
    await refresh();
    const loaded = await (await request(baseUrl, "/api/groups/67890/members", { headers })).json() as { members: Array<{ userId: string; displayName: string; aliases: string[]; note: string }> };
    const member = loaded.members.find(member => member.userId === "2458031445")!;
    assert.equal(member.displayName, names[0]);
    assert.deepEqual(member.aliases, names);
    assert.equal(member.note, "独立备注");
  }
});

test("member directory stays cache-only until refresh, then returns a cached NapCat snapshot", async (t) => {
  let upstreamCalls = 0;
  const { baseUrl } = await startFixture(t, {
    async listGroupMembers(groupId) {
      assert.equal(groupId, "67890");
      upstreamCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 12));
      return [
        { user_id: 20002, nickname: "Operator", card: "值班同学", role: "member" },
        { user_id: 20003, nickname: "Another", role: "admin" },
      ];
    },
  });
  const auth = await login(baseUrl);

  const initial = await request(baseUrl, "/api/groups/67890/members", { headers: { Cookie: auth.cookie } });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    members: [],
    cacheStatus: "unloaded",
    pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 },
  });
  assert.equal(upstreamCalls, 0);

  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const refreshed = await request(baseUrl, "/api/groups/67890/members/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(refreshed.status, 200);
  const refreshedData = await refreshed.json() as { members: Array<{ userId: string; displayName: string }>; cacheStatus: string };
  assert.equal(refreshedData.cacheStatus, "refreshed");
  assert.equal(refreshedData.members.some((member) => member.userId === "20002" && member.displayName === "值班同学"), true);
  assert.equal(upstreamCalls, 1);

  const cached = await request(baseUrl, "/api/groups/67890/members?q=operator", { headers: { Cookie: auth.cookie } });
  assert.equal(cached.status, 200);
  const cachedData = await cached.json() as { members: Array<{ userId: string }>; cacheStatus: string; pagination: { total: number } };
  assert.equal(cachedData.cacheStatus, "cached");
  assert.deepEqual(cachedData.members.map((member) => member.userId), ["20002"]);
  assert.equal(cachedData.pagination.total, 1);
  assert.equal(upstreamCalls, 1);

  const [firstRefresh, secondRefresh] = await Promise.all([
    request(baseUrl, "/api/groups/67890/members/refresh", { method: "POST", headers, body: "{}" }),
    request(baseUrl, "/api/groups/67890/members/refresh", { method: "POST", headers, body: "{}" }),
  ]);
  assert.equal(firstRefresh.status, 200);
  assert.equal(secondRefresh.status, 200);
  assert.equal(upstreamCalls, 2);
});

test("member refresh reports an unavailable NapCat directory without caching an empty result", async (t) => {
  let upstreamCalls = 0;
  const { baseUrl } = await startFixture(t, {
    async listGroupMembers() {
      upstreamCalls += 1;
      throw new Error("ingress is unavailable");
    },
  });
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };

  const refresh = await request(baseUrl, "/api/groups/67890/members/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(refresh.status, 503);
  assert.deepEqual(await refresh.json(), { error: "napcat_members_unavailable" });
  assert.equal(upstreamCalls, 1);

  const afterFailure = await request(baseUrl, "/api/groups/67890/members", { headers: { Cookie: auth.cookie } });
  assert.equal(afterFailure.status, 200);
  const data = await afterFailure.json() as { members: unknown[]; cacheStatus: string };
  assert.deepEqual(data.members, []);
  assert.equal(data.cacheStatus, "unloaded");
});

test("super admin config updates cannot bypass recent reauth for privacy opt-outs", async (t) => {
  const { baseUrl, db } = await startFixture(t);
  const auth = await login(baseUrl);
  const optOut = await request(baseUrl, "/api/groups/67890/members/20001/privacy-opt-out", {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(optOut.status, 200);

  db.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ?").run(Date.now() - 11 * 60 * 1_000);
  const bypass = await request(baseUrl, "/api/groups/67890/config", {
    method: "PUT",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ memoryDisabledUserIds: [] }),
  });
  assert.equal(bypass.status, 403);
  assert.equal((await bypass.json() as { error: string }).error, "recent_reauth_required");

  const group = await request(baseUrl, "/api/groups/67890/config", { headers: { Cookie: auth.cookie } });
  assert.deepEqual((await group.json() as { memoryDisabledUserIds: string[] }).memoryDisabledUserIds, ["20001"]);
});

test("sensitive global writes require recent reauth while their read views remain available", async (t) => {
  const { baseUrl, db } = await startFixture(t);
  const auth = await login(baseUrl);
  db.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ?").run(Date.now() - 11 * 60 * 1_000);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };

  const settings = await request(baseUrl, "/api/system-settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ onlineLookupEnabled: true }),
  });
  assert.equal(settings.status, 403);
  assert.equal((await settings.json() as { error: string }).error, "recent_reauth_required");

  const persona = await request(baseUrl, "/api/persona/huixian", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "会仙", systemPrompt: "updated" }),
  });
  assert.equal(persona.status, 403);
  assert.equal((await persona.json() as { error: string }).error, "recent_reauth_required");

  const commands = await request(baseUrl, "/api/commands", {
    method: "PUT",
    headers,
    body: JSON.stringify({ commands: [] }),
  });
  assert.equal(commands.status, 403);
  assert.equal((await commands.json() as { error: string }).error, "recent_reauth_required");

  assert.equal((await request(baseUrl, "/api/system-settings", { headers: { Cookie: auth.cookie } })).status, 200);
  assert.equal((await request(baseUrl, "/api/persona/huixian", { headers: { Cookie: auth.cookie } })).status, 200);
  assert.equal((await request(baseUrl, "/api/commands", { headers: { Cookie: auth.cookie } })).status, 200);
});

test("group configuration patches require the current revision and return the next revision", async (t) => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const initial = await request(baseUrl, "/api/groups/67890/config", { headers: { Cookie: auth.cookie } });
  const current = await initial.json() as { revision: string; ambientGroupContextEnabled: boolean };
  assert.equal(typeof current.revision, "string");

  const conflict = await request(baseUrl, "/api/groups/67890/config", {
    method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: "stale", patch: { ambientGroupContextEnabled: false } }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "configuration_conflict");

  const update = await request(baseUrl, "/api/groups/67890/config", {
    method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: current.revision, patch: { ambientGroupContextEnabled: !current.ambientGroupContextEnabled } }),
  });
  assert.equal(update.status, 200);
  const saved = await update.json() as { revision: string; ambientGroupContextEnabled: boolean };
  assert.notEqual(saved.revision, current.revision);
  assert.equal(saved.ambientGroupContextEnabled, !current.ambientGroupContextEnabled);
});

test("group configuration API persists daily report counts through 20 and rejects invalid counts", async t => {
  const { baseUrl } = await startFixture(t);
  const auth = await login(baseUrl);
  const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" };
  const read = async () => {
    const response = await request(baseUrl, "/api/groups/67890/config", { headers });
    assert.equal(response.status, 200);
    return await response.json() as { revision: string; dailyReportTopUserCount: number };
  };
  for (const count of [1, 6, 20]) {
    const before = await read();
    const response = await request(baseUrl, "/api/groups/67890/config", {
      method: "PATCH", headers,
      body: JSON.stringify({ expectedRevision: before.revision, patch: { dailyReportTopUserCount: count } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await read()).dailyReportTopUserCount, count);
  }
  const saved = await read();
  for (const count of [0, -1, 21, 1.5, null, "invalid"]) {
    const response = await request(baseUrl, "/api/groups/67890/config", {
      method: "PATCH", headers,
      body: JSON.stringify({ expectedRevision: saved.revision, patch: { dailyReportTopUserCount: count } }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_group_config");
    assert.deepEqual(await read(), saved);
  }
});

test("bulk APIs enforce group scope and return an asynchronous task with item results", async (t) => {
  const { baseUrl, memories } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const invite = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  const admin = await acceptInviteAsAdmin(baseUrl, (await invite.json() as { token: string }).token, "bulk-operator");
  const memory = await memories.create({ groupId: "67890", type: "group_fact", title: "批量目标", content: "用于批量任务测试。", source: "admin" });
  const headers = { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf, "Content-Type": "application/json" };

  const forbidden = await request(baseUrl, "/api/bulk-operations/preview", {
    method: "POST", headers,
    body: JSON.stringify({ resource: "memories", action: "disable", groupId: "100200", ids: [memory.id] }),
  });
  assert.equal(forbidden.status, 403);

  const previewResponse = await request(baseUrl, "/api/bulk-operations/preview", {
    method: "POST", headers,
    body: JSON.stringify({ resource: "memories", action: "disable", groupId: "67890", ids: [memory.id] }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as { id: string; targets: Array<{ before: unknown; after: unknown }> };
  assert.equal(preview.targets.length, 1);

  const execution = await request(baseUrl, "/api/bulk-operations/apply", {
    method: "POST", headers,
    body: JSON.stringify({ previewId: preview.id }),
  });
  assert.equal(execution.status, 202);
  const { taskId } = await execution.json() as { taskId: string };
  let task: { status: string; result?: { items?: Array<{ id: string; status: string }> } } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}`, { headers: { Cookie: admin.cookie } });
    assert.equal(response.status, 200);
    task = await response.json() as typeof task;
    if (task && !["queued", "running"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task?.status, "succeeded");
  assert.deepEqual(task?.result?.items?.map((item) => [item.id, item.status]), [[memory.id, "succeeded"]]);
});

test("analytics endpoints restrict group administrators to authorized group usage", async (t) => {
  const { baseUrl, db } = await startFixture(t);
  const superAdmin = await login(baseUrl);
  const telemetry = new ModelTelemetryStore(db);
  const startedAt = Date.now() - 500;
  const base = { modelId: "reply-a", model: "provider-model", purpose: "reply", probe: false, startedAt, durationMs: 42, status: "succeeded" as const, inputTokens: 3, outputTokens: 2, totalTokens: 5, images: 0, actualAmount: null, currency: null };
  telemetry.record({ ...base, id: "allowed-request", operationId: "op-1", groupId: "67890" });
  telemetry.record({ ...base, id: "other-group-request", operationId: "op-2", groupId: "100200" });
  telemetry.record({ ...base, id: "global-request", operationId: "op-3", groupId: "" });
  telemetry.record({ ...base, id: "probe-request", operationId: "op-4", groupId: "67890", probe: true });

  const invite = await request(baseUrl, "/api/admin-accounts/invites", {
    method: "POST",
    headers: { Cookie: superAdmin.cookie, "X-CSRF-Token": superAdmin.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "group_admin", groupIds: ["67890"], expiresHours: 1 }),
  });
  const admin = await acceptInviteAsAdmin(baseUrl, (await invite.json() as { token: string }).token, "analytics-reader");
  const from = new Date(startedAt - 1_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const adminReport = await request(baseUrl, `/api/analytics/summary?${query}`, { headers: { Cookie: admin.cookie } });
  assert.equal(adminReport.status, 200);
  const restricted = await adminReport.json() as { summary: { calls: number } };
  assert.equal(restricted.summary.calls, 1);
  const adminDetails = await request(baseUrl, `/api/analytics/requests?${query}`, { headers: { Cookie: admin.cookie } });
  const records = await adminDetails.json() as { items: Array<{ id: string }> };
  assert.deepEqual(records.items.map((item) => item.id), ["allowed-request"]);

  const superReport = await request(baseUrl, `/api/analytics/summary?${query}`, { headers: { Cookie: superAdmin.cookie } });
  assert.equal((await superReport.json() as { summary: { calls: number } }).summary.calls, 3);
  const outside = await request(baseUrl, `/api/analytics/summary?${query}&groupId=100200`, { headers: { Cookie: admin.cookie } });
  assert.equal(outside.status, 403);
});
