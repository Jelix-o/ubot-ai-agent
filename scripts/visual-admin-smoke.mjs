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
import { KnowledgeSourceBindingStore } from "../dist/services/knowledge-source-binding-store.js";
import { MemeLibraryService } from "../dist/services/meme-library-service.js";
import { loadPrivateEnterpriseRanking } from "../dist/services/private-enterprise-ranking.js";
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
      "daily_reports", "holiday_countdown", "realtime_lookup", "html_preview", "image_generation",
    ],
    providerCapabilities: {
      openai: ["chat", "vision", "streaming", "reasoningEffort", "requestTimeout", "imageGeneration"],
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
  const memeLibraryService = new MemeLibraryService(path.join(root, "data"), v3State);
  await memeLibraryService.initialize();

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
    knowledgeSourceBindingStore: new KnowledgeSourceBindingStore(v3State),
    privateEnterpriseRanking: loadPrivateEnterpriseRanking(),
    characterProfileService,
    systemSettingsStore: settingsStore,
    adminTaskStore: taskStore,
    memeLibraryService,
    adminOperationLogService: operations,
    async getTransportHealthStatus() { return { ok: true, detail: "smoke transport" }; },
  });
  server.start();
  const raw = server.server;
  await waitForListening(raw);
  const address = raw.address();
  if (!address || typeof address === "string") throw new Error("Admin smoke server did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await postJson(baseUrl, "/api/auth/password", {
    username: USERNAME,
    password: PASSWORD,
  });
  if (login.response.status !== 200 || login.data.ok !== true || login.data.status !== "authenticated") {
    throw new Error(`V3 password login failed: ${login.response.status} ${JSON.stringify(login.data)}`);
  }
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  const csrf = login.data.session?.csrfToken;
  if (!cookie || typeof csrf !== "string") throw new Error("V3 password login did not issue an opaque session and CSRF token.");

  const pages = ["/", "/login", "/groups", "/members", "/memories", "/knowledge", "/memes", "/tasks", "/audit", "/health", "/persona", "/commands", "/settings"];
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

  const ranking = await getJson(baseUrl, "/api/knowledge/rankings/2026?pageSize=1", cookie);
  const sourceBindings = await getJson(baseUrl, `/api/knowledge/bindings?groupId=${GROUP_ID}`, cookie);
  if (sourceBindings.rankingCommand !== "#民营企业排名" || sourceBindings.groupFaqCommand !== "#群知识库") {
    throw new Error("Knowledge source defaults are incorrect.");
  }
  const bindingSave = await requestJson(baseUrl, "/api/knowledge/bindings", "PUT", {
    source: "group_faq", groupId: GROUP_ID, command: "#发布规范",
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (!bindingSave.response.ok || (await getJson(baseUrl, `/api/knowledge/bindings?groupId=${GROUP_ID}`, cookie)).groupFaqCommand !== "#发布规范") {
    throw new Error("Knowledge source binding save/reload failed.");
  }
  if (ranking.pagination?.total !== 500 || ranking.items?.[0]?.name !== "京东集团" || ranking.metadata?.cityReady !== false) {
    throw new Error(`2026 ranking is unavailable: ${JSON.stringify(ranking)}`);
  }
  const zhejiang = await getJson(baseUrl, `/api/knowledge/rankings/2026?province=${encodeURIComponent("浙江省")}&pageSize=1`, cookie);
  if (zhejiang.pagination?.total !== 104) throw new Error(`Incorrect Zhejiang ranking count: ${JSON.stringify(zhejiang.pagination)}`);
  const city = await fetch(`${baseUrl}/api/knowledge/rankings/2026?city=${encodeURIComponent("杭州市")}`, { headers: { Cookie: cookie } });
  if (city.status !== 409) throw new Error(`Unverified headquarters city should return 409, got ${city.status}`);

  const memes = await getJson(baseUrl, "/api/meme-library", cookie);
  if (!Array.isArray(memes.assets) || !memes.assets.some((asset) => asset.id === "blacklisted-at-meme-seed" && asset.protected === true)) {
    throw new Error(`Meme library seed is unavailable: ${JSON.stringify(memes)}`);
  }

  const memeTag = await postJson(baseUrl, "/api/meme-library/tags", {
    name: "冒烟关键词",
    description: "验证本地关键词触发配置",
    keywords: ["  天气  ", "惊讶"],
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (memeTag.response.status !== 201 || !Array.isArray(memeTag.data.keywords) || !memeTag.data.keywords.includes("天气")) {
    throw new Error(`Meme tag keyword create failed: ${memeTag.response.status} ${JSON.stringify(memeTag.data)}`);
  }

  const candidateResponse = await fetch(`${baseUrl}/api/memory-candidates?groupId=${GROUP_ID}`, { headers: { Cookie: cookie } });
  if (candidateResponse.status !== 410) throw new Error(`Retired candidate API should be 410, got ${candidateResponse.status}`);
  const legacyLoginResponse = await fetch(`${baseUrl}/api/login`, { method: "POST" });
  if (legacyLoginResponse.status !== 410) throw new Error(`Legacy login API should be 410, got ${legacyLoginResponse.status}`);
  const legacyProfileResponse = await fetch(`${baseUrl}/api/profile-records`, { headers: { Cookie: cookie } });
  if (legacyProfileResponse.status !== 410) throw new Error(`Retired profile API should be 410, got ${legacyProfileResponse.status}`);

  const totpResponse = await fetch(`${baseUrl}/api/auth/totp/enroll`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ enrollmentToken: "unused", code: "000000" }),
  });
  if (totpResponse.status !== 404) throw new Error(`TOTP enrollment route should be 404, got ${totpResponse.status}`);

  const persona = await getJson(baseUrl, "/api/persona/huixian", cookie);
  if (persona.id !== "huixian" || !/普通对话中主动解释自己的实现方式/.test(persona.systemPrompt)) {
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
    name: "会仙",
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
