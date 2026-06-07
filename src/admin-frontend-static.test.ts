import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminSrc = path.join(repoRoot, "admin", "src");

async function readAdminFile(relativePath: string): Promise<string> {
  return readFile(path.join(adminSrc, relativePath), "utf8");
}

test("admin candidate and memory lists load evidence previews and fetch full source on demand", async () => {
  const [candidateStore, candidatesView, memoriesView] = await Promise.all([
    readAdminFile(path.join("stores", "candidates.ts")),
    readAdminFile(path.join("views", "CandidatesView.vue")),
    readAdminFile(path.join("views", "MemoriesView.vue")),
  ]);

  assert.match(candidateStore, /evidence:\s*"preview"/);
  assert.match(candidatesView, /api<Candidate>\(`\/api\/memory-candidates\/\$\{encodeURIComponent\(item\.id\)\}`\)/);
  assert.match(candidatesView, /Loading full evidence/);
  assert.match(candidatesView, /SearchableSelect/);

  assert.match(memoriesView, /evidence:\s*"preview"/);
  assert.match(memoriesView, /api<Memory>\(`\/api\/memories\/\$\{encodeURIComponent\(item\.id\)\}`\)/);
  assert.match(memoriesView, /Loading full evidence/);
  assert.match(memoriesView, /SearchableSelect/);
  assert.match(memoriesView, /const userId = typeof route\.query\.userId === "string"/);
  assert.match(memoriesView, /if \(userId\) filters\.userId = userId/);
  assert.match(memoriesView, /subjectUserId:\s*filters\.userId/);
});

test("admin member management keeps required member actions available", async () => {
  const membersView = await readAdminFile(path.join("views", "MembersView.vue"));

  assert.match(membersView, /profile\(member,\s*'overall'\)/);
  assert.match(membersView, /profile\(member,\s*'yesterday'\)/);
  assert.match(membersView, /regenerateActiveProfile/);
  assert.match(membersView, /openMemberRecords\(member\)/);
  assert.match(membersView, /viewMemberMemories\(member\)/);
  assert.match(membersView, /startEditNote\(member\)/);
  assert.match(membersView, /deduplicateMemberMemories\(member\)/);
  assert.match(membersView, /toggleMemoryCollection\(member\)/);
  assert.match(membersView, /path:\s*"\/memories"/);
  assert.match(membersView, /query:\s*\{\s*userId:\s*member\.userId,\s*type:\s*"member_profile"/);
});

test("admin skills and command lists use the simplified table surfaces", async () => {
  const [skillsView, commandsView] = await Promise.all([
    readAdminFile(path.join("views", "SkillsView.vue")),
    readAdminFile(path.join("views", "CommandsView.vue")),
  ]);

  assert.match(skillsView, /SkillDefinition/);
  assert.match(skillsView, /ttsConfig/);
  assert.match(skillsView, /整体 TTS 风格提示/);
  assert.match(skillsView, /TTS 音色/);
  assert.match(skillsView, /方言/);
  assert.match(skillsView, /人设腔调/);
  assert.match(skillsView, /基础情绪/);
  assert.match(skillsView, /复合情绪/);
  assert.match(skillsView, /整体语调/);
  assert.match(skillsView, /音色定位/);
  assert.match(skillsView, /语速与节奏/);
  assert.match(skillsView, /情绪状态/);
  assert.match(skillsView, /语音特征/);
  assert.match(skillsView, /哭笑表达/);
  assert.match(skillsView, /type="file"\s+accept="application\/json,\.json"/);
  assert.match(skillsView, /downloadJson/);
  assert.match(skillsView, /grid-template-columns:\s*minmax\(180px,\s*0\.9fr\)\s*minmax\(220px,\s*1fr\)\s*86px\s*96px\s*180px/);
  assert.match(skillsView, /<strong>\{\{\s*skill\.name\s*\}\}<\/strong>/);
  assert.match(skillsView, /<span class="mono">\{\{\s*skill\.id\s*\}\}<\/span>/);
  assert.match(skillsView, /\{\{\s*skill\.temperature\s*\}\}/);
  assert.match(skillsView, /\{\{\s*skill\.maxContextTurns\s*\}\}\s*轮/);
  assert.match(skillsView, /恢复备份/);
  assert.match(skillsView, /复制 Skill/);
  assert.match(skillsView, /\/api\/skills\/backups/);

  const commandTable = commandsView.slice(
    commandsView.indexOf('<div v-else class="command-table">'),
    commandsView.indexOf('<aside class="panel command-editor">'),
  );
  assert.match(commandTable, /command\.title/);
  assert.match(commandTable, /command\.primary/);
  assert.match(commandTable, /command\.aliases/);
  assert.doesNotMatch(commandTable, /command\.help/);
});

test("admin model settings expose existing model id editing without returning api keys", async () => {
  const [settingsView, groupsView] = await Promise.all([
    readAdminFile(path.join("views", "SettingsView.vue")),
    readAdminFile(path.join("views", "GroupsView.vue")),
  ]);

  assert.match(settingsView, /\/api\/system-settings/);
  assert.match(settingsView, /模型配置/);
  assert.match(settingsView, /管理员秘钥/);
  assert.match(settingsView, /memoryDedupSemanticTimeoutMinutes/);
  assert.match(settingsView, /去重模型单次判断超时（分钟）/);
  assert.match(settingsView, /v-model="model\.id"/);
  assert.match(settingsView, /placeholder="reply-pro"/);
  assert.match(settingsView, /modelRowKey\(model\)/);
  assert.doesNotMatch(settingsView, /:key="model\.id"/);
  assert.match(settingsView, /模型类型/);
  assert.match(settingsView, /modelPurposeLabel\(model\.purpose\)/);
  assert.match(settingsView, /保存模型配置/);
  assert.match(settingsView, /模型配置尚未保存/);
  assert.match(settingsView, /保存后才会进入群配置和 #模型 切换列表/);
  assert.match(settingsView, /markModelsDirty/);
  assert.match(settingsView, /activePurpose = shallowRef<SystemModelPurpose>\("reply"\)/);
  assert.match(settingsView, /modelTemplate\(purpose = activePurpose\.value\)/);
  assert.match(settingsView, /const modelPurposeOptions/);
  assert.match(settingsView, /value:\s*"memory"/);
  assert.match(settingsView, /value:\s*"profile"/);
  assert.match(settingsView, /value:\s*"dedup"/);
  assert.match(settingsView, /value:\s*"summary"/);
  assert.match(settingsView, /value:\s*"knowledge"/);
  assert.match(settingsView, /value:\s*"tts"/);
  assert.match(settingsView, /type="password"/);
  assert.match(settingsView, /model\.hasApiKey/);
  assert.match(settingsView, /selectedModelIds/);
  assert.match(settingsView, /检测连接/);
  assert.match(settingsView, /检测全部模型/);
  assert.match(settingsView, /\/api\/models\/test-all/);
  assert.match(settingsView, /\/api\/model-health-history/);
  assert.match(settingsView, /purposeHasFailure/);
  assert.match(settingsView, /modelHealthById/);
  assert.match(settingsView, /button\.failed/);
  assert.match(settingsView, /table-row.*failed/);
  assert.match(settingsView, /\/api\/models\/\$\{encodeURIComponent\(model\.id\)\}\/test/);
  assert.match(settingsView, /\/api\/system-settings\/admin-secret/);
  assert.match(settingsView, /\/api\/system-settings\/group-admin-secret/);

  assert.match(groupsView, /\/api\/model-options/);
  assert.match(groupsView, /v-for="model in replyModels"/);
  assert.match(groupsView, /form\.replyModelMode/);
  assert.match(groupsView, /hasReplyModels = computed/);
  assert.match(groupsView, /reconcileReplyModelSelection/);
  assert.match(groupsView, /:disabled="!hasReplyModels"/);
  assert.match(groupsView, /请先在系统设置启用对话模型/);
  assert.match(groupsView, /系统设置中启用的对话模型会同步进入群内 #模型 切换列表/);
  assert.match(groupsView, /MultiTagSelect/);
  assert.match(groupsView, /v-model="form\.allowedSkillIds"/);
  assert.match(groupsView, /v-model="form\.memoryDisabledUserIds"/);
  assert.match(groupsView, /v-model="form\.defaultVoiceReplyEnabled"/);
  assert.match(groupsView, /默认语音回复/);
});

test("admin knowledge import stays preview-first and uses formatted timestamps", async () => {
  const knowledgeView = await readAdminFile(path.join("views", "KnowledgeView.vue"));

  assert.match(knowledgeView, /formatDateTime/);
  assert.match(knowledgeView, /\/api\/knowledge\/import\/preview/);
  assert.match(knowledgeView, /\/api\/knowledge\/import\/apply/);
  assert.match(knowledgeView, /importCandidates\.value\s*=\s*data\.candidates/);
  assert.match(knowledgeView, /body:\s*JSON\.stringify\(\{\s*groupId:\s*app\.groupId,\s*candidates:\s*importCandidates\.value\s*\}\)/);
  assert.match(knowledgeView, /formatDateTime\(item\.updatedAt\s*\|\|\s*item\.createdAt\)/);
});

test("admin shell and overview keep notification, settings, and formatted overview timestamps", async () => {
  const [appShell, overviewView, routerFile] = await Promise.all([
    readAdminFile("App.vue"),
    readAdminFile(path.join("views", "OverviewView.vue")),
    readAdminFile("router.ts"),
  ]);

  assert.match(appShell, /app\.loadNotifications\(\)/);
  assert.match(appShell, /@click="openNotifications"/);
  assert.match(appShell, /app\.notifications\.pendingCandidateCount/);
  assert.match(appShell, /if \(\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === "k"\)/);
  assert.match(appShell, /\/api\/search/);
  assert.match(appShell, /searchResults/);
  assert.match(appShell, /window\.addEventListener\("keydown", onSearchKeydown\)/);
  assert.match(appShell, /class="popover-backdrop"[\s\S]*@click="closeFloating\(\); mobileNavOpen = false"/);
  assert.match(appShell, /UBot v1\.0\.0/);
  assert.match(appShell, /mobileNavOpen/);
  assert.match(appShell, /class="mobile-menu-btn"/);
  assert.match(appShell, /class="top-popover theme-popover"/);
  assert.match(appShell, /class="top-popover user-popover"/);
  assert.match(appShell, /<AppIcon name="theme"/);
  assert.match(appShell, /tasks:\s*"tasks"/);
  assert.match(appShell, /audit:\s*"audit"/);
  assert.doesNotMatch(appShell, /tasks:\s*"list"[\s\S]*audit:\s*"list"/);
  assert.match(appShell, /async function logout\(\): Promise<void>/);
  assert.match(appShell, /await app\.logout\(\)/);
  assert.match(appShell, /@click\.stop="logout"/);
  assert.match(appShell, /class="content-scroll"/);
  assert.match(appShell, /\.content-scroll\s*\{[\s\S]*overflow:\s*visible;/);
  const topbarBlock = appShell.slice(appShell.indexOf(".topbar {"), appShell.indexOf(".top-title"));
  assert.match(topbarBlock, /background:\s*color-mix\(in oklch,\s*var\(--surface\)\s*94%,\s*transparent\)/);
  assert.match(topbarBlock, /border-radius:\s*0 0 18px 18px/);
  assert.match(topbarBlock, /border:\s*1px solid color-mix\(in oklch,\s*var\(--line\)\s*72%,\s*transparent\)/);
  assert.doesNotMatch(topbarBlock, /background:\s*color-mix\(in oklch,\s*var\(--bg\)/);
  assert.doesNotMatch(topbarBlock, /box-shadow:\s*0 1px 0 var\(--line\)/);
  assert.match(appShell, /\.notify-list\s*\{[\s\S]*max-height:\s*min\(318px,\s*calc\(6 \* 54px\)\);[\s\S]*overflow:\s*auto;/);
  assert.match(appShell, /go\('\/candidates'\)/);
  assert.match(appShell, /@click="router\.push\('\/settings'\)"/);
  assert.match(appShell, /item\.meta\?\.superOnly \|\| app\.role === "super_admin"/);

  assert.match(overviewView, /formatDateTime/);
  assert.match(overviewView, /formatDateTime\(item\.createdAt\)/);
  assert.match(overviewView, /slice\(0,\s*10\)/);
  assert.match(overviewView, /overflow-y:\s*auto/);
  assert.match(overviewView, /modelStatusSummary/);
  assert.match(overviewView, /模型检测/);
  assert.match(overviewView, /to="\/health"/);
  assert.match(routerFile, /title:\s*"系统状态"/);
  assert.match(routerFile, /path:\s*"\/tasks"/);
  assert.match(routerFile, /TasksView\.vue/);
  assert.doesNotMatch(routerFile, new RegExp("path:\\s*\"\\/" + "iter" + "ation" + "\""));
  assert.doesNotMatch(routerFile, new RegExp("Iter" + "ationView\\.vue"));
  assert.match(routerFile, /path:\s*"\/audit"/);
  assert.match(routerFile, /AuditView\.vue/);

  assert.match(routerFile, /path:\s*"\/commands"[\s\S]*path:\s*"\/tasks"[\s\S]*path:\s*"\/audit"[\s\S]*path:\s*"\/health"/);
  assert.match(routerFile, /path:\s*"\/health"[\s\S]*path:\s*"\/settings"/);
  assert.match(routerFile, /name:\s*"settings"[\s\S]*superOnly:\s*true/);
  assert.match(routerFile, /import AppOverviewView from "\.\/views\/OverviewView\.vue"/);
  assert.match(routerFile, /component:\s*AppOverviewView/);
  assert.doesNotMatch(routerFile, /component:\s*\(\)\s*=>\s*import/);

  const adminServer = await readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8");
  assert.match(adminServer, /getServerStatusSnapshot/);
  assert.match(adminServer, /probeSystemModel/);
  assert.match(adminServer, /environmentStatus/);
  assert.match(adminServer, /serverStatus/);
  assert.match(adminServer, /probeType/);
  assert.match(adminServer, /upstreamStatusCode/);
  assert.match(adminServer, /title:\s*`记忆去重/);
  assert.match(adminServer, /title:\s*`批量审核/);
  assert.match(adminServer, /title:\s*`画像生成/);
  assert.match(adminServer, /title:\s*`模型检测/);
  assert.match(adminServer, /isAdminAssetPath/);
  assert.match(adminServer, /asset_not_found/);
});

test("admin system status separates environment and server health", async () => {
  const [healthView, apiTypes] = await Promise.all([
    readAdminFile(path.join("views", "HealthView.vue")),
    readAdminFile(path.join("services", "api.ts")),
  ]);

  assert.match(apiTypes, /interface EnvironmentStatus/);
  assert.match(apiTypes, /interface ServerStatus/);
  assert.match(apiTypes, /interface SystemHealthData/);
  assert.match(apiTypes, /environmentStatus\?:\s*EnvironmentStatus/);
  assert.match(apiTypes, /serverStatus\?:\s*ServerStatus/);
  assert.match(apiTypes, /probeType\?:\s*"chat"\s*\|\s*"tts"/);
  assert.match(apiTypes, /upstreamStatusCode\?:\s*number/);
  assert.match(apiTypes, /failureKind\?:/);
  assert.match(healthView, /environmentStatus/);
  assert.match(healthView, /serverStatus/);
  assert.match(healthView, /data\.value\?\.serverStatus/);
  assert.match(healthView, /server\.hostname/);
  assert.match(healthView, /server\.usedMemory/);
  assert.match(healthView, /server\.loadAverage/);
  assert.match(healthView, /model\.probeType/);
  assert.match(healthView, /model\.upstreamStatusCode/);
  assert.match(healthView, /model\.failureKind/);
  assert.match(healthView, /failureKindLabel/);
});

test("admin profile page keeps public link actions in the list", async () => {
  const profilesView = await readAdminFile(path.join("views", "ProfilesView.vue"));
  const listSection = profilesView.slice(
    profilesView.indexOf('<div v-else class="profile-list">'),
    profilesView.indexOf('<aside class="panel detail-panel sticky-detail-panel">'),
  );
  const detailSection = profilesView.slice(profilesView.indexOf('<aside class="panel detail-panel sticky-detail-panel">'));

  assert.match(listSection, /查看链接/);
  assert.match(listSection, /复制链接/);
  assert.match(listSection, /生成链接/);
  assert.match(listSection, /撤销公开/);
  assert.match(listSection, /v-if="!record\.shareToken"/);
  assert.match(listSection, /openShareUrl\(record\)/);
  assert.match(listSection, /copyShareUrl\(record\)/);
  assert.match(listSection, /updateShareState\(record,\s*true\)/);
  assert.match(listSection, /updateShareState\(record,\s*false\)/);
  assert.doesNotMatch(listSection, /formatDateTime\(record\.generatedAt\)/);
  assert.doesNotMatch(listSection, /来源记忆/);
  assert.doesNotMatch(detailSection, /查看链接/);
  assert.doesNotMatch(detailSection, /复制链接/);
  assert.doesNotMatch(detailSection, /生成链接/);
  assert.doesNotMatch(detailSection, /撤销公开/);
  assert.doesNotMatch(detailSection, /updateShareState\(activeRecord/);
});

test("model probes and tts use provider-specific health requests", async () => {
  const [probeService, ttsService, ttsTest] = await Promise.all([
    readFile(path.join(repoRoot, "src", "services", "model-probe-service.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "services", "tts-service.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "services", "tts-service.test.ts"), "utf8"),
  ]);

  assert.match(probeService, /probeType:\s*"tts"/);
  assert.match(probeService, /upstreamStatusCode/);
  assert.match(probeService, /"api-key":\s*model\.apiKey/);
  assert.match(ttsService, /"api-key":\s*this\.apiKey/);
  assert.doesNotMatch(ttsService, /Authorization:\s*`Bearer/);
  assert.match(ttsTest, /headers\.get\("api-key"\)/);
  assert.match(ttsTest, /headers\.has\("authorization"\)/);
});

test("admin visual smoke covers all routes and key mobile viewports", async () => {
  const smokeScript = await readFile(path.join(repoRoot, "scripts", "visual-admin-smoke.mjs"), "utf8");

  for (const routeName of ["overview", "groups", "members", "candidates", "memories", "profiles", "knowledge", "tasks", "audit", "health", "skills", "commands", "settings"]) {
    assert.match(smokeScript, new RegExp(`\\["${routeName}",`));
  }
  assert.match(smokeScript, /\["overview-mobile",\s*"\/"/);
  assert.match(smokeScript, /\["tasks-detail",\s*"\/tasks"/);
  assert.match(smokeScript, /click:\s*"\.task-row \.row-action"/);
  assert.match(smokeScript, /afterClickScrollTo:\s*"\.task-detail"/);
  assert.match(smokeScript, /\["audit-detail",\s*"\/audit"/);
  assert.match(smokeScript, /click:\s*"\.audit-row \.row-action"/);
  assert.match(smokeScript, /afterClickScrollTo:\s*"\.audit-detail"/);
  assert.match(smokeScript, /\["health-detail",\s*"\/health"/);
  assert.match(smokeScript, /click:\s*"\.history-row \.row-action"/);
  assert.match(smokeScript, /afterClickScrollTo:\s*"\.model-detail"/);
  assert.match(smokeScript, /\["groups-mobile",\s*"\/groups"/);
  assert.match(smokeScript, /\["members-mobile",\s*"\/members"/);
  assert.match(smokeScript, /\["candidates-mobile",\s*"\/candidates"/);
  assert.match(smokeScript, /\["memories-mobile",\s*"\/memories"/);
  assert.doesNotMatch(smokeScript, new RegExp("\\[\"" + "iter" + "ation" + "\","));
  assert.doesNotMatch(smokeScript, new RegExp("\\[\"" + "iter" + "ation" + "-mobile\","));
  assert.match(smokeScript, /\["tasks-mobile",\s*"\/tasks"/);
  assert.match(smokeScript, /\["tasks-mobile-filters",\s*"\/tasks"/);
  assert.match(smokeScript, /\["settings-mobile",\s*"\/settings"/);
});


test("admin planning-console module stays removed", async () => {
  const [apiTypes, appIcon, adminServer, botSource, routerFile, commandsStore] = await Promise.all([
    readAdminFile(path.join("services", "api.ts")),
    readAdminFile(path.join("components", "AppIcon.vue")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "bot.ts"), "utf8"),
    readAdminFile("router.ts"),
    readFile(path.join(repoRoot, "src", "services", "system-settings-store.ts"), "utf8"),
  ]);

  for (const source of [apiTypes, appIcon, adminServer, botSource, routerFile, commandsStore]) {
    assert.doesNotMatch(source, new RegExp("Iter" + "ationFeedback|Iter" + "ationPlan|Self" + "Iter" + "ation"));
    assert.doesNotMatch(source, new RegExp("self-" + "iter" + "ation"));
    assert.doesNotMatch(source, new RegExp("\\/api\\/" + "iter" + "ation"));
    assert.doesNotMatch(source, new RegExp("#" + "\\u8fed\\u4ee3", "u"));
  }
});

test("admin task center exposes task detail records", async () => {
  const tasksView = await readAdminFile(path.join("views", "TasksView.vue"));

  assert.match(tasksView, /q:\s*filters\.q\.trim\(\)/);
  assert.match(tasksView, /v-model="filters\.q"/);
  assert.match(tasksView, /scope:\s*"all"\s+as\s+"current"\s+\|\s+"all"/);
  assert.match(tasksView, /canUseAllGroups = computed/);
  assert.match(tasksView, /currentGroupLabel = computed/);
  assert.match(tasksView, /queryScopeLabel = computed/);
  assert.match(tasksView, /const groupId = filters\.scope === "all" && canUseAllGroups\.value \? undefined : app\.groupId/);
  assert.match(tasksView, /v-model="filters\.scope"/);
  assert.match(tasksView, /<option value="current">当前群<\/option>/);
  assert.match(tasksView, /<option value="all">全部群<\/option>/);
  assert.match(tasksView, /查询范围/);
  assert.match(tasksView, /immediate:\s*true/);
  assert.match(tasksView, /placeholder="任务 ID、标题、操作者、目标或结果"/);
  assert.match(tasksView, /function resetFilters\(\)/);
  assert.match(tasksView, /activeTask = shallowRef<AdminTaskRecord \| null>\(null\)/);
  assert.match(tasksView, /activeTaskResult = computed/);
  assert.match(tasksView, /activeTaskTimeline = computed/);
  assert.match(tasksView, /api<AdminTaskRecord>\(`\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}`\)/);
  assert.match(tasksView, /class="task-detail"/);
  assert.match(tasksView, /基础信息/);
  assert.match(tasksView, /执行时间线/);
  assert.match(tasksView, /执行结果/);
  assert.match(tasksView, /查看详情/);
});

test("admin audit view exposes operation log filters and table", async () => {
  const [auditView, apiTypes] = await Promise.all([
    readAdminFile(path.join("views", "AuditView.vue")),
    readAdminFile(path.join("services", "api.ts")),
  ]);

  assert.match(apiTypes, /interface AdminOperationLogEntry/);
  assert.match(auditView, /\/api\/logs/);
  assert.match(auditView, /groupId/);
  assert.match(auditView, /filters\.scope/);
  assert.match(auditView, /filters\.action/);
  assert.match(auditView, /filters\.limit/);
  assert.match(auditView, /class="audit-table"/);
  assert.match(auditView, /activeEntry = shallowRef<AdminOperationLogEntry \| null>\(null\)/);
  assert.match(auditView, /activeEntryMeta = computed/);
  assert.match(auditView, /class="audit-detail"/);
  assert.match(auditView, /完整详情/);
  assert.match(auditView, /查看详情/);
  assert.match(auditView, /formatDateTime\(entry\.timestamp\)/);
  assert.match(auditView, /actionLabel\(entry\.action\)/);
  assert.match(auditView, /未知操作/);
  assert.match(auditView, /humanizeActionCode/);
  assert.match(auditView, /translateDetailText/);
  assert.match(auditView, /连接失败/);
  assert.match(auditView, /请求失败/);
});

test("admin health view exposes model health history details", async () => {
  const healthView = await readAdminFile(path.join("views", "HealthView.vue"));

  assert.match(healthView, /activeModel = shallowRef<ModelHealthHistoryEntry \| null>\(null\)/);
  assert.match(healthView, /activeModelMeta = computed/);
  assert.match(healthView, /function purposeLabel/);
  assert.match(healthView, /function sourceLabel/);
  assert.match(healthView, /function openModelDetail/);
  assert.match(healthView, /class="model-detail"/);
  assert.match(healthView, /class="history-row"[\s\S]*row-action/);
  assert.match(healthView, /查看详情/);
  assert.match(healthView, /完整详情/);
  assert.match(healthView, /服务地址/);
  assert.match(healthView, /缓存状态/);
});

test("admin group config reloads on group switch and uses selectable config controls", async () => {
  const [groupsView, dateRulePicker] = await Promise.all([
    readAdminFile(path.join("views", "GroupsView.vue")),
    readAdminFile(path.join("components", "DateRulePicker.vue")),
  ]);

  assert.match(groupsView, /watch\(\(\) => app\.groupId,\s*\(\) => \{\s*void load\(\);/);
  assert.match(groupsView, /manualIdentitiesText\.value = JSON\.stringify\(data\.manualIdentities \|\| \[\], null, 2\)/);
  assert.match(groupsView, /<select v-model="form\.currentSkillId" class="select">/);
  assert.match(groupsView, /<MultiTagSelect v-model="form\.allowedSkillIds"/);
  assert.match(groupsView, /<MultiTagSelect v-model="form\.switcherUserIds"/);
  assert.match(groupsView, /<MultiTagSelect v-model="form\.liveChatUserIds"/);
  assert.match(groupsView, /<MultiTagSelect v-model="form\.blacklistedUserIds"/);
  assert.match(groupsView, /<MultiTagSelect v-model="form\.memoryDisabledUserIds"/);
  assert.match(groupsView, /v-model:rule="reminderForm\.dateRule"/);
  assert.match(groupsView, /v-model:weekdays="reminderForm\.weekdays"/);
  assert.match(groupsView, /DateRulePicker/);
  assert.match(groupsView, /form\.dailyReportDateRule/);
  assert.match(groupsView, /form\.holidayCountdownDateRule/);
  assert.match(groupsView, /class="schedule-layout"/);
  assert.match(groupsView, /\/schedule-preview\?days=7/);
  assert.match(groupsView, /schedulePreview/);
  assert.match(groupsView, /未来 7 天执行预览/);
  assert.match(groupsView, /class="date-rule-panel"/);
  assert.match(groupsView, /class="schedule-effect"/);
  assert.match(groupsView, /class="schedule-column schedule-basic"/);
  assert.match(groupsView, /class="schedule-column schedule-abilities"/);
  assert.match(groupsView, /class="schedule-column schedule-rules"/);
  assert.match(groupsView, /class="reminder-table"/);
  assert.match(groupsView, /copyReminder\(reminder\)/);
  assert.match(groupsView, /executionStartTime/);
  assert.match(groupsView, /executionEndTime/);
  assert.match(groupsView, /executionIntervalMinutes/);
  assert.match(groupsView, /执行开始时间/);
  assert.match(groupsView, /执行结束时间/);
  assert.match(dateRulePicker, /全部日期/);
  assert.match(dateRulePicker, /智能工作日/);
  assert.match(dateRulePicker, /智能非工作日/);
  assert.match(dateRulePicker, /跳过法定节假日，包含调休上班日/);
  assert.match(dateRulePicker, /周末和法定节假日，排除调休上班日/);
  assert.match(dateRulePicker, /自定义/);
  assert.match(dateRulePicker, /class="rule-segment"/);
});

test("admin right side detail panels share viewport sticky behavior", async () => {
  const [globalCss, membersView, profilesView, skillsView, commandsView] = await Promise.all([
    readAdminFile(path.join("styles", "global.css")),
    readAdminFile(path.join("views", "MembersView.vue")),
    readAdminFile(path.join("views", "ProfilesView.vue")),
    readAdminFile(path.join("views", "SkillsView.vue")),
    readAdminFile(path.join("views", "CommandsView.vue")),
  ]);

  assert.match(globalCss, /\.sticky-detail-panel\s*\{[\s\S]*position:\s*sticky;[\s\S]*top:\s*var\(--sticky-detail-top\);[\s\S]*max-height:\s*calc\(100dvh - var\(--sticky-detail-top\) - 16px\);/);
  assert.match(membersView, /profile-panel sticky-detail-panel/);
  assert.match(profilesView, /detail-panel sticky-detail-panel/);
  assert.match(skillsView, /class="panel editor-panel"/);
  assert.doesNotMatch(skillsView, /editor-panel sticky-detail-panel/);
  assert.match(commandsView, /command-editor sticky-detail-panel/);
});
