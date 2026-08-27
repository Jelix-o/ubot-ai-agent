import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AdminHttpServer } from "../dist/admin-http-server.js";
import { SharedDb } from "../dist/shared/sqlite.js";
import { AdminOperationLogService } from "../dist/services/admin-operation-log-service.js";
import { AdminTaskStore } from "../dist/services/admin-task-store.js";
import { CharacterProfileService } from "../dist/services/character-profile-service.js";
import { GroupConfigService } from "../dist/services/group-config-service.js";
import { GroupMemoryStore } from "../dist/services/group-memory-store.js";
import { KnowledgeBaseStore } from "../dist/services/knowledge-base-store.js";
import { SystemSettingsStore } from "../dist/services/system-settings-store.js";
import { V3StateRepository } from "../dist/services/v3-state-repository.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GROUP_ID = "866209871";
const USERNAME = "smoke-admin";
const PASSWORD = "smoke-password";

const root = await mkdtemp(path.join(os.tmpdir(), "ubot-v3-admin-smoke-"));
let server;
let sharedDb;

try {
  sharedDb = new SharedDb(path.join(root, "data", "shared", "bot-shared.db"));
  const v3State = new V3StateRepository(sharedDb, { stateEncryptionKey: TEST_STATE_KEY });
  const profile = JSON.parse(await readFile(new URL("../assets/huixian-profile.json", import.meta.url), "utf8"));

  v3State.saveGroups({
    superAdminUserIds: ["99999"],
    groups: [{
      groupId: GROUP_ID,
      groupName: "UBot Test Group",
      enabled: true,
      currentSkillId: "huixian",
      allowedSkillIds: ["huixian"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      participationMode: "mentions_only",
    }],
  });
  await v3State.saveHuixianProfile(profile, "visual-admin-smoke");
  v3State.saveCapabilityPolicy({
    version: 1,
    enabledCapabilities: [
      "conversation", "explicit_memory", "knowledge", "scheduled_reminders",
      "daily_reports", "holiday_countdown", "realtime_lookup", "voice", "singing",
    ],
    providerCapabilities: {
      openai: ["chat", "vision", "streaming"],
      anthropic: ["chat", "vision", "streaming"],
    },
    updatedAt: new Date().toISOString(),
  });
  v3State.markCutover();

  const groupConfigService = new GroupConfigService(path.join(root, "retired-groups.json"), undefined, v3State);
  const memoryStore = new GroupMemoryStore(path.join(root, "retired-memory.json"), v3State);
  const knowledgeBaseStore = new KnowledgeBaseStore(path.join(root, "retired-knowledge.json"), v3State);
  const taskStore = new AdminTaskStore(path.join(root, "retired-tasks.json"), v3State);
  const settingsStore = new SystemSettingsStore(path.join(root, "retired-settings.json"), [], undefined, v3State);
  const operations = new AdminOperationLogService(path.join(root, "retired-operations.jsonl"), v3State);
  const characterProfileService = new CharacterProfileService(v3State);

  await memoryStore.create({
    groupId: GROUP_ID,
    type: "member_profile",
    subjectUserId: "20001",
    title: "回复偏好",
    content: "成员明确表示喜欢先看结论。",
    source: "explicit_request",
  });
  await taskStore.run({
    type: "memory-dedup",
    title: "记忆去重 20001",
    groupId: GROUP_ID,
    subjectUserId: "20001",
    operatorUserId: "99999",
  }, async () => ({ appliedCount: 0 }));

  server = new AdminHttpServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    username: USERNAME,
    password: PASSWORD,
    stateEncryptionKey: TEST_STATE_KEY,
    sharedDb,
    groupConfigService,
    groupMemoryStore: memoryStore,
    knowledgeBaseStore,
    characterProfileService,
    systemSettingsStore: settingsStore,
    adminTaskStore: taskStore,
    adminOperationLogService: operations,
    async getTransportHealthStatus() { return { ok: true, detail: "smoke transport" }; },
  });
  server.start();
  const raw = server.server;
  await waitForListening(raw);
  const address = raw.address();
  if (!address || typeof address === "string") throw new Error("Admin smoke server did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const enrollment = await postJson(baseUrl, "/api/auth/password", {
    username: USERNAME,
    password: PASSWORD,
  });
  if (enrollment.response.status !== 200 || enrollment.data.status !== "totp_enrollment_required") {
    throw new Error(`V3 password step did not require TOTP enrollment: ${enrollment.response.status} ${JSON.stringify(enrollment.data)}`);
  }
  if (typeof enrollment.data.enrollmentToken !== "string" || typeof enrollment.data.totpSecret !== "string") {
    throw new Error("V3 enrollment response omitted its one-time challenge.");
  }

  const completed = await postJson(baseUrl, "/api/auth/totp/enroll", {
    enrollmentToken: enrollment.data.enrollmentToken,
    code: makeTotp(enrollment.data.totpSecret),
  });
  if (!completed.response.ok || completed.data.ok !== true || !Array.isArray(completed.data.recoveryCodes)) {
    throw new Error(`V3 TOTP enrollment failed: ${completed.response.status} ${JSON.stringify(completed.data)}`);
  }
  const cookie = completed.response.headers.get("set-cookie")?.split(";")[0];
  const csrf = completed.data.session?.csrfToken;
  if (!cookie || typeof csrf !== "string") throw new Error("V3 enrollment did not issue an opaque session and CSRF token.");

  const pages = ["/", "/login", "/groups", "/members", "/memories", "/knowledge", "/tasks", "/audit", "/health", "/persona", "/commands", "/settings"];
  for (const page of pages) {
    const response = await fetch(`${baseUrl}${page}`, { headers: { Cookie: cookie } });
    if (!response.ok) throw new Error(`Admin page failed: ${page} ${response.status}`);
    const html = await response.text();
    if (!html.includes('id="app"')) throw new Error(`Admin page shell missing: ${page}`);
  }

  const overview = await getJson(baseUrl, `/api/overview?groupId=${GROUP_ID}`, cookie);
  if (overview.stats.pendingCandidateCount !== undefined || overview.recent.candidates !== undefined) {
    throw new Error("Overview still exposes retired candidate data.");
  }
  if (overview.stats.memoryCount !== 1) throw new Error(`Unexpected V3 memory count: ${JSON.stringify(overview.stats)}`);

  const candidateResponse = await fetch(`${baseUrl}/api/memory-candidates?groupId=${GROUP_ID}`, { headers: { Cookie: cookie } });
  if (candidateResponse.status !== 410) throw new Error(`Retired candidate API should be 410, got ${candidateResponse.status}`);
  const legacyLoginResponse = await fetch(`${baseUrl}/api/login`, { method: "POST" });
  if (legacyLoginResponse.status !== 410) throw new Error(`Legacy login API should be 410, got ${legacyLoginResponse.status}`);
  const legacyProfileResponse = await fetch(`${baseUrl}/api/profile-records`, { headers: { Cookie: cookie } });
  if (legacyProfileResponse.status !== 410) throw new Error(`Retired profile API should be 410, got ${legacyProfileResponse.status}`);

  const persona = await getJson(baseUrl, "/api/persona/huixian", cookie);
  if (persona.id !== "huixian" || !/真人照片/.test(persona.systemPrompt)) {
    throw new Error(`Persona payload is incomplete: ${JSON.stringify(persona)}`);
  }

  const createMemory = await postJson(baseUrl, "/api/memories", {
    groupId: GROUP_ID,
    type: "group_fact",
    title: "群内约定",
    content: "提出技术问题时先给上下文。",
    source: "admin",
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (createMemory.response.status !== 201) {
    throw new Error(`V3 memory create failed: ${createMemory.response.status} ${JSON.stringify(createMemory.data)}`);
  }

  const createKnowledge = await postJson(baseUrl, "/api/knowledge", {
    groupId: GROUP_ID,
    title: "发布约定",
    question: "发布前要做什么？",
    answer: "先验证完整测试和 SHA-256。",
    keywords: ["发布", "SHA"],
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (createKnowledge.response.status !== 201 || !v3State.getKnowledgePack(GROUP_ID)?.enabled) {
    throw new Error(`V3 knowledge pack write failed: ${createKnowledge.response.status} ${JSON.stringify(createKnowledge.data)}`);
  }

  const updatePersona = await requestJson(baseUrl, "/api/persona/huixian", "PUT", {
    ...persona,
    name: "会仙·虚拟聊天伙伴",
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (!updatePersona.response.ok) throw new Error(`Persona update failed: ${updatePersona.response.status} ${JSON.stringify(updatePersona.data)}`);

  console.log(`ADMIN_SMOKE_OK=${baseUrl}`);
} finally {
  server?.close();
  sharedDb?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function getJson(baseUrl, pathname, cookie) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { Cookie: cookie } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function postJson(baseUrl, pathname, body, headers = {}) {
  return requestJson(baseUrl, pathname, "POST", body, headers);
}

async function requestJson(baseUrl, pathname, method, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Admin smoke server did not start within 10 seconds.")), 10_000);
    server.once("listening", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function makeTotp(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const text = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of text) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid_totp_secret");
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
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
