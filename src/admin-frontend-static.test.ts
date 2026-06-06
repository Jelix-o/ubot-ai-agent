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
  assert.match(settingsView, /v-model="model\.id"/);
  assert.match(settingsView, /placeholder="reply-pro"/);
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
  assert.match(settingsView, /\/api\/models\/\$\{encodeURIComponent\(model\.id\)\}\/test/);
  assert.match(settingsView, /\/api\/system-settings\/admin-secret/);
  assert.match(settingsView, /\/api\/system-settings\/group-admin-secret/);

  assert.match(groupsView, /\/api\/model-options/);
  assert.match(groupsView, /v-for="model in replyModels"/);
  assert.match(groupsView, /form\.replyModelMode/);
  assert.match(groupsView, /MultiTagSelect/);
  assert.match(groupsView, /v-model="form\.allowedSkillIds"/);
  assert.match(groupsView, /v-model="form\.memoryDisabledUserIds"/);
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
  assert.match(appShell, /UBot v4\.6\.0/);
  assert.match(appShell, /mobileNavOpen/);
  assert.match(appShell, /class="mobile-menu-btn"/);
  assert.match(appShell, /class="top-popover theme-popover"/);
  assert.match(appShell, /class="top-popover user-popover"/);
  assert.match(appShell, /<AppIcon name="theme"/);
  assert.match(appShell, /@click="app\.logout\(\)"/);
  assert.match(appShell, /class="content-scroll"/);
  assert.match(appShell, /\.content-scroll\s*\{[\s\S]*overflow:\s*visible;/);
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

  assert.match(routerFile, /path:\s*"\/tasks"[\s\S]*path:\s*"\/skills"/);
  assert.match(routerFile, /path:\s*"\/health"[\s\S]*path:\s*"\/settings"/);
  assert.match(routerFile, /name:\s*"settings"[\s\S]*superOnly:\s*true/);
  assert.match(routerFile, /component:\s*\(\)\s*=>\s*import\("\.\/views\/OverviewView\.vue"\)/);

  const adminServer = await readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8");
  assert.match(adminServer, /title:\s*`记忆去重/);
  assert.match(adminServer, /title:\s*`批量审核/);
  assert.match(adminServer, /title:\s*`画像生成/);
  assert.match(adminServer, /title:\s*`模型检测/);
});

test("admin visual smoke covers all routes and key mobile viewports", async () => {
  const smokeScript = await readFile(path.join(repoRoot, "scripts", "visual-admin-smoke.mjs"), "utf8");

  for (const routeName of ["overview", "groups", "members", "candidates", "memories", "profiles", "knowledge", "tasks", "health", "skills", "commands", "settings"]) {
    assert.match(smokeScript, new RegExp(`\\["${routeName}",`));
  }
  assert.match(smokeScript, /\["overview-mobile",\s*"\/"/);
  assert.match(smokeScript, /\["groups-mobile",\s*"\/groups"/);
  assert.match(smokeScript, /\["members-mobile",\s*"\/members"/);
  assert.match(smokeScript, /\["candidates-mobile",\s*"\/candidates"/);
  assert.match(smokeScript, /\["memories-mobile",\s*"\/memories"/);
  assert.match(smokeScript, /\["settings-mobile",\s*"\/settings"/);
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
