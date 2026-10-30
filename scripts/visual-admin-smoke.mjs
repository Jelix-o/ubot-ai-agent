import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AdminHttpServer } from "../dist/admin-http-server.js";
import { AudioGenerationService } from "../dist/services/audio-generation-service.js";
import { AdminAuthService } from "../dist/services/admin-auth-service.js";
import { SharedDb } from "../dist/shared/sqlite.js";
import { AdminOperationLogService } from "../dist/services/admin-operation-log-service.js";
import { AdminTaskStore } from "../dist/services/admin-task-store.js";
import { CharacterProfileService } from "../dist/services/character-profile-service.js";
import { GroupConfigService } from "../dist/services/group-config-service.js";
import { GroupMemoryStore } from "../dist/services/group-memory-store.js";
import { KnowledgeBaseStore } from "../dist/services/knowledge-base-store.js";
import { KnowledgeSourceBindingStore } from "../dist/services/knowledge-source-binding-store.js";
import { MemeLibraryService } from "../dist/services/meme-library-service.js";
import { ImagePreviewArchiveService } from "../dist/services/image-preview-archive-service.js";
import { loadPrivateEnterpriseRanking } from "../dist/services/private-enterprise-ranking.js";
import { SystemSettingsStore } from "../dist/services/system-settings-store.js";
import { ScheduledReminderStore } from "../dist/services/scheduled-reminder-store.js";
import { ScheduledReminderService } from "../dist/services/scheduled-reminder-service.js";
import { V3StateRepository } from "../dist/services/v3-state-repository.js";

const TEST_STATE_KEY = "0".repeat(64);
const GROUP_ID = "866209871";
const USERNAME = "smoke-admin";
const PASSWORD = "smoke-password";
const IMAGE_PREVIEW_SMOKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==",
  "base64",
);
const runBrowserSmoke = process.argv.includes("--browser");
const useLayoutFixture = runBrowserSmoke || process.argv.includes("--layout-fixture");

const root = await mkdtemp(path.join(os.tmpdir(), "ubot-v3-admin-smoke-"));
const visualArtifactDir = process.env.UBOT_VISUAL_ARTIFACT_DIR?.trim()
  ? path.resolve(process.env.UBOT_VISUAL_ARTIFACT_DIR)
  : path.join(root, "visual-admin-smoke");
let server;
let sharedDb;
let audioGenerationService;

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
      replyModelSource: "global",
      replyModelMode: "gpt",
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
  // Browser checks use loopback connections and disposable credentials so
  // layout/save checks run without production data or upstream calls.
  if (useLayoutFixture) {
    await groupConfigService.updateManualIdentity(GROUP_ID, "2458031445", { names: ["外包仔", "外包仙人"], note: "前端开发" });
    const now = new Date().toISOString();
    await settingsStore.update({
      models: [
        ["sol", "Sol", "gpt-6.1-sol", "reply", true],
        ["gpt", "GPT 视觉与复杂问题备用模型（长名称布局验证）", "gpt-test", "reply", true],
        ["ds", "DeepSeek Flash", "deepseek-flash", "reply", true],
        ["disabled", "已停用的备用连接", "disabled-model", "reply", false],
        ["image", "图片生成模型", "image-test", "image", true],
      ].map(([id, name, model, purpose, enabled]) => ({ id, name, shortName: id, model, purpose, enabled, apiKey: "layout-fixture-not-a-real-key", baseUrl: "http://127.0.0.1:63199/v1", createdAt: now, updatedAt: now })),
      selectedModelIds: { reply: "sol", image: "image" },
      replyRouting: { fallbackEnabled: true, fallbackModelIds: ["gpt", "ds"], chatAttemptTimeoutMs: 45000, chatTotalTimeoutMs: 120000, htmlAttemptTimeoutMs: 120000, htmlTotalTimeoutMs: 300000 },
    });
    const auth = new AdminAuthService(sharedDb, { bootstrap: { username: USERNAME, password: PASSWORD } });
    await auth.ensureInitialized();
    const invite = auth.createInvite({ role: "group_admin", groupIds: [GROUP_ID], expiresAt: Date.now() + 60000, actorAccountId: auth.listAccounts()[0].id });
    const accepted = await auth.acceptInvite({ inviteToken: invite.token, username: "layout-operator", password: "layout-password-12" });
    if (accepted.kind !== "authenticated") throw new Error("Layout operator fixture failed.");
  }
  const operations = new AdminOperationLogService(path.join(root, "retired-operations.jsonl"), v3State);
  const characterProfileService = new CharacterProfileService(v3State);
  const memeLibraryService = new MemeLibraryService(path.join(root, "data"), v3State);
  await memeLibraryService.initialize();
  if (runBrowserSmoke) {
    const tag = await memeLibraryService.createTag({ name: "work", description: "工作与摸鱼", keywords: ["work"] });
    await memeLibraryService.uploadAsset({
      name: "预置素材来源验收", scope: "normal_chat", tags: [tag.id], data: IMAGE_PREVIEW_SMOKE_PNG,
      packId: "blue-fat-fish-meme-pack", sourceRef: "0bbf1c546135ad55e6049241922a90fcb5332777",
      sourcePath: "memes/work/smoke.png", sourceLicense: "fixture-only",
    });
    let attempts = 0;
    // Exercise the real task API and UI without downloading remote packs.
    memeLibraryService.importPack = async (packId, progress) => {
      attempts++;
      await progress(50, "素材导入浏览器验收");
      return { packId, imported: 0, skipped: attempts > 1 ? 1 : 0,
        failed: attempts === 1 ? [{ path: "memes/work/smoke.png", error: "fixture_download_failed" }] : [] };
    };
  }
  const imagePreviewStagedRoot = path.join(root, "data", "generated-images");
  const imagePreviewService = new ImagePreviewArchiveService({
    sharedDb,
    rootDir: path.join(root, "data", "generated-image-previews"),
    stagedRoot: imagePreviewStagedRoot,
  });
  const imagePreviewStagedFile = path.join(imagePreviewStagedRoot, "visual-smoke.png");
  await mkdir(imagePreviewStagedRoot, { recursive: true });
  await writeFile(imagePreviewStagedFile, IMAGE_PREVIEW_SMOKE_PNG, { mode: 0o600 });
  await imagePreviewService.archive({
    groupId: GROUP_ID,
    creatorUserId: "20001",
    sourceMessageId: "visual-smoke-image",
    prompt: "后台视觉冒烟使用的私有生图提示词",
    filePath: imagePreviewStagedFile,
    modelId: "image",
    model: "image-test",
    fallbackUsed: false,
    mimeType: "image/png",
    byteSize: IMAGE_PREVIEW_SMOKE_PNG.byteLength,
  });

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

  audioGenerationService = new AudioGenerationService(v3State, path.join(root,"audio-assets"));
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
    scheduledReminderService: new ScheduledReminderService(new ScheduledReminderStore(path.join(root, "retired-reminders.json"), v3State), {}),
    imagePreviewService,
    memeLibraryService,
    audioGenerationService,
    adminOperationLogService: operations,
    async getTransportHealthStatus() { return { ok: true, detail: "smoke transport" }; },
    async listGroupMembers() { return [{ user_id: 2458031445, card: "外包仔", nickname: "原昵称", role: "member" }]; },
  });
  await server.start();
  const raw = server.server;
  let address = raw.address();
  if (!address || typeof address === "string") throw new Error("Admin smoke server did not bind a TCP port.");
  let baseUrl = `http://127.0.0.1:${address.port}`;
  // Match browser Origin checks to the ephemeral listener, including its port.
  server.options.publicBaseUrl = baseUrl;

  if (runBrowserSmoke) {
    for (let attempt = 0; ; attempt++) {
      try { await verifyBrowserExperience(baseUrl, visualArtifactDir); break; }
      catch (error) {
        // Some hosts allocate browser-restricted ports for listen(0). Rebind
        // only for this transport error; assertion failures must still fail.
        if (attempt >= 2 || !String(error).includes("net::ERR_UNSAFE_PORT")) throw error;
        await new Promise((resolve, reject) => raw.close(error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => {
          raw.once("error", reject);
          raw.listen(0, "127.0.0.1", () => { raw.off("error", reject); resolve(); });
        });
        address = raw.address();
        if (!address || typeof address === "string") throw new Error("Admin smoke rebind failed.");
        baseUrl = `http://127.0.0.1:${address.port}`;
        server.options.publicBaseUrl = baseUrl;
      }
    }
  }

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

  const settingsBefore = await getJson(baseUrl, "/api/system-settings", cookie);
  const budgetModel = settingsBefore.models.find(model => model.purpose === "reply") ?? {
    id: "budget-smoke", name: "Budget smoke", shortName: "budget", purpose: "reply",
    model: "local-fixture", baseUrl: "http://127.0.0.1:63199/v1", apiKey: "smoke-not-a-real-key", enabled: true,
  };
  const budgetModels = settingsBefore.models.some(model => model.id === budgetModel.id)
    ? settingsBefore.models.map(model => model.id === budgetModel.id ? { ...model, maxCompletionTokens: 65536 } : model)
    : [...settingsBefore.models, { ...budgetModel, maxCompletionTokens: 65536 }];
  const saveBudget = await requestJson(baseUrl, "/api/system-settings", "PUT", {
    models: budgetModels, expectedRevision: settingsBefore.revision,
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  const savedSettings = await getJson(baseUrl, "/api/system-settings", cookie);
  if (!saveBudget.response.ok || savedSettings.models.find(model => model.id === budgetModel.id)?.maxCompletionTokens !== 65536) {
    throw new Error("Reply token budget 65536 did not round-trip through the admin API.");
  }
  const restoreSettings = await requestJson(baseUrl, "/api/system-settings", "PUT", {
    models: settingsBefore.models, selectedModelIds: settingsBefore.selectedModelIds,
    replyRouting: settingsBefore.replyRouting, expectedRevision: savedSettings.revision,
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (!restoreSettings.response.ok) throw new Error("Reply token budget smoke fixture could not restore its settings.");

  const pages = ["/", "/login", "/analytics", "/groups", "/groups/bulk", "/members", "/memories", "/knowledge", "/html-previews", "/image-previews", "/memes", "/interactions", "/audio", "/tasks", "/audit", "/security", "/health", "/persona", "/commands", "/settings"];
  for (const page of pages) {
    const response = await fetch(`${baseUrl}${page}`, { headers: { Cookie: cookie } });
    if (!response.ok) throw new Error(`Admin page failed: ${page} ${response.status}`);
    const html = await response.text();
    if (!html.includes('id="app"')) throw new Error(`Admin page shell missing: ${page}`);
  }

  const imagePreviewList = await getJson(baseUrl, `/api/image-previews?groupId=${GROUP_ID}`, cookie);
  if (imagePreviewList.pagination?.total !== 1 || imagePreviewList.previews?.[0]?.prompt !== undefined) {
    throw new Error("Image preview list did not keep the full prompt private.");
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
    name: persona.name,
  }, { Cookie: cookie, "X-CSRF-Token": csrf });
  if (!updatePersona.response.ok) throw new Error(`Persona update failed: ${updatePersona.response.status} ${JSON.stringify(updatePersona.data)}`);

  console.log(`ADMIN_SMOKE_OK=${baseUrl}`);
  if (process.argv.includes("--hold")) {
    console.log("ADMIN_SMOKE_HOLD=press Ctrl+C to stop the local fixture");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  await audioGenerationService?.stop();
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

async function verifyBrowserExperience(baseUrl, screenshotDir) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new Error(`Playwright is required for the Admin browser smoke test. Run npm run browser:install. ${error instanceof Error ? error.message : String(error)}`);
  }

  await mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  const desktop = await desktopContext.newPage();
  const browserErrors = [];
  let authenticated = false;
  let expectedAuthRejections = false;
  desktop.on("pageerror", (error) => {
    if (authenticated) browserErrors.push(`pageerror: ${error.message}`);
  });
  desktop.on("console", (message) => {
    if (authenticated && !expectedAuthRejections && message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  try {
    await desktop.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
    await desktop.getByRole("heading", { name: "后台登录" }).waitFor();
    await desktop.screenshot({ path: path.join(screenshotDir, "login-desktop.png"), fullPage: true });

    await desktop.getByLabel("账号").fill(USERNAME);
    await desktop.getByLabel("密码").fill(PASSWORD);
    await Promise.all([
      desktop.waitForURL((url) => url.pathname === "/"),
      desktop.getByRole("button", { name: "登录控制台" }).click(),
    ]);
    // The initial unauthenticated route may intentionally receive a 401 while
    // Vue resolves the login route. From this point forward, errors are real
    // authenticated-console regressions and fail the visual smoke test.
    authenticated = true;
    await desktop.locator(".app-shell").waitFor();
    await desktop.getByText("已配置群", { exact: true }).waitFor();
    await assertNoHorizontalOverflow(desktop, "desktop overview");
    await desktop.screenshot({ path: path.join(screenshotDir, "overview-desktop.png"), fullPage: true });

    await desktop.goto(`${baseUrl}/settings?tab=models`, { waitUntil: "networkidle" });
    await desktop.locator(".models-panel").waitFor();
    await desktop.locator(".model-table").getByText("GPT 视觉与复杂问题备用模型（长名称布局验证）", { exact: true }).waitFor();
    await assertNoHorizontalOverflow(desktop, "desktop settings");
    await desktop.screenshot({ path: path.join(screenshotDir, "settings-desktop.png"), fullPage: true });

    await desktop.goto(`${baseUrl}/settings?tab=models&purpose=image_intent`, { waitUntil: "networkidle" });
    await desktop.getByText("启用图片意图判断", { exact: true }).waitFor();
    await desktop.getByRole("button", { name: "检测原生工具调用", exact: true }).waitFor();
    await assertNoHorizontalOverflow(desktop, "desktop image intent settings");
    await desktop.screenshot({ path: path.join(screenshotDir, "image-intent-settings-desktop.png"), fullPage: true });
    await desktop.goto(`${baseUrl}/settings?tab=models`, { waitUntil: "networkidle" });

    const sibling = await desktopContext.newPage();
    await sibling.goto(`${baseUrl}/settings?tab=models`, { waitUntil: "networkidle" });
    const before = await desktop.evaluate(async () => (await fetch("/api/session")).json());
    const other = await sibling.evaluate(async () => (await fetch("/api/session")).json());
    if (before.csrfToken !== other.csrfToken) throw new Error("Sibling tab rotated CSRF.");
    await sibling.close();

    const timeoutInput = desktop.getByRole("spinbutton", { name: "聊天单次超时（秒）", exact: true });
    await timeoutInput.fill("46");
    sharedDb.db.prepare("UPDATE admin_sessions SET reauth_verified_at = ?, csrf_token_hash = 'legacy-digest'").run(Date.now() - 11 * 60000);
    expectedAuthRejections = true;
    await desktop.getByRole("button", { name: "保存配置", exact: true }).first().click();
    const dialog = desktop.getByRole("dialog", { name: "验证当前密码" });
    await dialog.waitFor();
    if (await timeoutInput.inputValue() !== "46") throw new Error("Step-up lost form contents.");
    await dialog.getByLabel("当前密码").fill("wrong-password");
    await dialog.getByRole("button", { name: "验证并继续" }).click();
    await dialog.getByRole("alert").getByText("当前密码不正确。").waitFor();
    if (await dialog.getByLabel("当前密码").inputValue()) throw new Error("Failed step-up retained password.");
    if (!desktop.url().includes("/settings")) throw new Error("Wrong step-up password logged out the user.");
    await dialog.getByRole("button", { name: "取消操作" }).click();
    await dialog.waitFor({ state: "detached" });
    const stored = JSON.parse(sharedDb.db.prepare("SELECT settings_json FROM v3_system_settings WHERE settings_key = 'default'").get().settings_json);
    if (stored.replyRouting.chatAttemptTimeoutMs !== 45000) throw new Error("Cancelled step-up submitted a write.");
    await desktop.getByRole("button", { name: "保存配置", exact: true }).first().click();
    await dialog.waitFor();
    await dialog.getByLabel("当前密码").fill(PASSWORD);
    const saved = desktop.waitForResponse(response => response.url().endsWith("/api/system-settings") && response.request().method() === "PATCH" && response.status() === 200);
    await dialog.getByRole("button", { name: "验证并继续" }).click();
    await saved;
    await dialog.waitFor({ state: "detached" });
    expectedAuthRejections = false;
    await desktop.reload({ waitUntil: "networkidle" });
    if (await timeoutInput.inputValue() !== "46") throw new Error("Session refresh lost saved form contents.");

    await desktop.setViewportSize({ width: 1440, height: 960 });
    await desktop.goto(`${baseUrl}/image-previews`, { waitUntil: "networkidle" });
    await desktop.getByRole("heading", { name: "生图预览" }).waitFor();
    await desktop.getByRole("button", { name: "打开预览" }).waitFor();
    await assertNoHorizontalOverflow(desktop, "desktop image previews");
    await desktop.screenshot({ path: path.join(screenshotDir, "image-previews-desktop.png"), fullPage: true });
    await desktop.getByRole("button", { name: "打开预览" }).click();
    const imageDialog = desktop.getByRole("dialog", { name: "生图预览" });
    await imageDialog.locator(".image-frame img").waitFor();
    const imageLoaded = await imageDialog.locator(".image-frame img").evaluate((image) => image.naturalWidth > 0);
    if (!imageLoaded) throw new Error("Private image preview did not load its image bytes.");
    const prompt = await imageDialog.locator(".prompt-detail pre").textContent();
    if (prompt !== "后台视觉冒烟使用的私有生图提示词") throw new Error("Image preview detail did not render the retained prompt safely.");
    await desktop.screenshot({ path: path.join(screenshotDir, "image-preview-dialog-desktop.png"), fullPage: true });
    await imageDialog.getByRole("button", { name: "关闭详情" }).click();

    await desktop.goto(`${baseUrl}/groups?tab=capabilities`, { waitUntil: "networkidle" });
    const ambient = desktop.getByRole("checkbox", { name: /^读空气/ });
    const poke = desktop.getByRole("checkbox", { name: /^回戳/ });
    const experience = desktop.getByRole("checkbox", { name: /^群聊体验增强/ });
    const personalReminders = desktop.getByRole("checkbox", { name: /^个人一次性提醒/ });
    if (await ambient.isChecked() || await poke.isChecked()) throw new Error("Group interactions must default off.");
    if (await experience.isChecked() || await personalReminders.isChecked()) throw new Error("New experience controls must default off.");
    await ambient.check();
    await poke.check();
    await experience.check();
    await personalReminders.check();
    await desktop.getByRole("spinbutton", { name: "主动插话冷却（秒）" }).fill("900");
    await desktop.getByRole("spinbutton", { name: "回戳概率（%）" }).fill("40");
    const saveGroup = async () => {
      const saved = desktop.waitForResponse(response => response.url().includes(`/api/groups/${GROUP_ID}/config`) && response.request().method() === "PATCH" && response.ok());
      await desktop.getByRole("button", { name: "保存配置", exact: true }).first().click();
      await saved;
    };
    await saveGroup();
    await desktop.reload({ waitUntil: "networkidle" });
    if (!await ambient.isChecked() || !await poke.isChecked() || await desktop.getByRole("spinbutton", { name: "主动插话冷却（秒）" }).inputValue() !== "900") throw new Error("Interaction controls did not persist.");
    if (!await experience.isChecked() || !await personalReminders.isChecked()) throw new Error("Experience and personal reminder controls did not persist.");
    await assertNoHorizontalOverflow(desktop, "desktop group interactions");
    await desktop.screenshot({ path: path.join(screenshotDir, "group-interactions-desktop.png"), fullPage: true });
    await ambient.uncheck();
    await poke.uncheck();
    await saveGroup();

    await desktop.goto(baseUrl + "/interactions", { waitUntil:"networkidle" });
    await desktop.getByRole("heading",{name:"互动诊断",exact:true}).waitFor();
    await desktop.locator(".conditions").getByText("已关闭",{exact:true}).first().waitFor();
    await assertNoHorizontalOverflow(desktop,"desktop interaction diagnostics");
    await desktop.screenshot({path:path.join(screenshotDir,"interaction-diagnostics-desktop.png"),fullPage:true});
    await desktop.goto(baseUrl + "/audio",{waitUntil:"networkidle"});
    await desktop.getByRole("heading",{name:"音频服务",exact:true}).waitFor();
    if(await desktop.getByRole("checkbox",{name:"启用音频服务",exact:true}).isChecked()) throw new Error("Audio must stay disabled without a credential.");
    await desktop.getByRole("checkbox",{name:"允许偶尔语音",exact:true}).uncheck();
    const savedAudio=desktop.waitForResponse(response=>response.url().endsWith("/api/audio/settings") && response.request().method()==="PUT" && response.ok());
    await desktop.getByRole("button",{name:"保存设置",exact:true}).click();await savedAudio;
    await desktop.reload({waitUntil:"networkidle"});
    if(await desktop.getByRole("checkbox",{name:"允许偶尔语音",exact:true}).isChecked()) throw new Error("Audio settings did not persist.");
    if(!await desktop.getByRole("button",{name:"向当前群发送测试语音",exact:true}).isDisabled()) throw new Error("Audio test must require an enabled service.");
    await assertNoHorizontalOverflow(desktop,"desktop audio settings");
    await desktop.screenshot({path:path.join(screenshotDir,"audio-desktop.png"),fullPage:true});
    await desktop.setViewportSize({width:390,height:844});
    await assertNoHorizontalOverflow(desktop,"mobile audio settings");
    await desktop.screenshot({path:path.join(screenshotDir,"audio-mobile.png"),fullPage:true});
    await desktop.goto(baseUrl + "/interactions",{waitUntil:"networkidle"});
    await desktop.locator(".conditions").waitFor();
    await assertNoHorizontalOverflow(desktop,"mobile interaction diagnostics");
    await desktop.screenshot({path:path.join(screenshotDir,"interaction-diagnostics-mobile.png"),fullPage:true});
    await desktop.setViewportSize({width:1440,height:1000});

    await desktop.goto(baseUrl + "/groups?tab=schedule", { waitUntil: "networkidle" });
    await desktop.getByLabel("定时任务类型").selectOption("model_call");
    const modelSelect = desktop.getByLabel("定时调用模型");
    await modelSelect.selectOption(await modelSelect.locator("option").first().getAttribute("value"));
    await desktop.locator(".reminder-time input").fill("05:59");
    await desktop.getByRole("button", { name:"添加任务", exact:true }).click();
    const modelRow = desktop.locator(".reminder-row").filter({ hasText:"[模型调用]" });
    await modelRow.getByText("05:59 北京时间", { exact:true }).waitFor();
    await modelRow.getByText(/尚未执行/).waitFor();
    await modelRow.getByRole("button", { name:"暂停", exact:true }).click();
    await modelRow.getByRole("button", { name:"启用", exact:true }).waitFor();
    await assertNoHorizontalOverflow(desktop, "scheduled model-call desktop");
    await desktop.screenshot({ path:path.join(screenshotDir, "scheduled-model-call-desktop.png"), fullPage:true });
    await desktop.goto(baseUrl + "/memes", { waitUntil: "networkidle" });
    if (await desktop.getByLabel("选图方式").inputValue() !== "model_tag" || await desktop.getByRole("spinbutton", { name: "发送概率" }).inputValue() !== "60") throw new Error("Meme defaults are incorrect.");
    await desktop.getByText(/单张最大 10 MiB/).waitFor();
    await desktop.getByRole("spinbutton", { name: "发送概率" }).fill("41");
    const savedPolicy = desktop.waitForResponse(response => response.url().endsWith("/api/meme-library/policy") && response.request().method() === "PUT" && response.ok());
    await desktop.getByRole("button", { name: "保存策略", exact: true }).click();
    await savedPolicy;
    await desktop.reload({ waitUntil: "networkidle" });
    if (await desktop.getByRole("spinbutton", { name: "发送概率" }).inputValue() !== "41") throw new Error("Meme policy did not persist.");
    await desktop.locator(".asset-card").filter({ hasText: "预置素材来源验收" }).click();
    await desktop.locator(".asset-editor").getByText("0bbf1c546135ad55e6049241922a90fcb5332777", { exact: true }).waitFor();
    await desktop.locator(".asset-editor").getByText("fixture-only", { exact: true }).waitFor();
    await desktop.getByRole("button", { name: "导入 / 重试", exact: true }).first().click();
    await desktop.getByText("失败文件 1 个", { exact: true }).waitFor();
    await desktop.getByText("失败文件 1 个", { exact: true }).click();
    await desktop.getByText("memes/work/smoke.png：fixture_download_failed", { exact: true }).waitFor();
    await desktop.getByRole("button", { name: "导入 / 重试", exact: true }).first().click();
    await desktop.waitForFunction(() => !document.querySelector(".preset-packs details") && document.querySelector(".preset-packs progress")?.value === 100);
    await assertNoHorizontalOverflow(desktop, "desktop meme library");
    await desktop.screenshot({ path: path.join(screenshotDir, "memes-desktop.png"), fullPage: true });
    await desktop.setViewportSize({ width: 390, height: 844 });
    await desktop.waitForFunction(() => document.querySelector("aside.sidebar")?.getBoundingClientRect().right <= 0);
    await assertNoHorizontalOverflow(desktop, "mobile meme library");
    await desktop.screenshot({ path: path.join(screenshotDir, "memes-mobile.png"), fullPage: true });

    await desktop.setViewportSize({ width: 390, height: 844 });
    await desktop.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await desktop.locator(".app-shell").waitFor();
    await desktop.getByLabel("打开导航").click();
    await desktop.locator("aside.sidebar.open[aria-label='工作区导航']").waitFor();
    await assertNoHorizontalOverflow(desktop, "mobile overview");
    await desktop.screenshot({ path: path.join(screenshotDir, "overview-mobile.png"), fullPage: true });

    if (browserErrors.length > 0) {
      throw new Error(`Admin browser emitted errors: ${browserErrors.join(" | ")}`);
    }
    console.log(`ADMIN_BROWSER_SMOKE_OK=${screenshotDir}`);
  } catch (error) {
    try {
      await desktop.screenshot({ path: path.join(screenshotDir, "failure-desktop.png"), fullPage: true });
    } catch {
      // Preserve the original test failure if the page itself cannot render.
    }
    throw error;
  } finally {
    await desktopContext.close();
    await browser.close();
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
    throw new Error(`${label} has horizontal overflow (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px).`);
  }
}
