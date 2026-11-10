import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminRoot = path.join(repoRoot, "admin", "src");

async function readAdmin(relativePath: string): Promise<string> {
  return readFile(path.join(adminRoot, relativePath), "utf8");
}

test("admin presents a single memory workspace without candidate routes", async () => {
  const [router, shell, overview, memories, appStore, api] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin(path.join("components", "ConsoleShell.vue")),
    readAdmin(path.join("views", "OverviewView.vue")),
    readAdmin(path.join("views", "MemoriesView.vue")),
    readAdmin(path.join("stores", "app.ts")),
    readAdmin(path.join("services", "api.ts")),
  ]);

  assert.doesNotMatch(router, /CandidatesView|path:\s*"\/candidates"/);
  assert.match(router, /title:\s*"记忆"/);
  assert.doesNotMatch(shell, /候选记忆|pendingCandidateCount|loadNotifications|\/candidates/);
  assert.doesNotMatch(overview, /候选|pendingCandidateCount/);
  assert.match(memories, /新增记忆/);
  assert.match(memories, /\/api\/memories/);
  assert.match(memories, /async function createMemory/);
  assert.doesNotMatch(appStore, /NotificationData|notifications|loadNotifications/);
  assert.doesNotMatch(api, /CandidateListResponse|pendingCandidateCount|type:\s*"candidate"/);
});

test("admin uses a full-bleed pearl console shell without a device frame", async () => {
  const [shell, tokens, layout, materials, components, instruments, login, entry] = await Promise.all([
    readAdmin(path.join("components", "ConsoleShell.vue")),
    readAdmin(path.join("styles", "tokens.css")),
    readAdmin(path.join("styles", "layout.css")),
    readAdmin(path.join("styles", "materials.css")),
    readAdmin(path.join("styles", "components.css")),
    readAdmin(path.join("styles", "instruments.css")),
    readAdmin(path.join("views", "LoginView.vue")),
    readAdmin("main.ts"),
  ]);

  assert.match(shell, /console-stage/);
  assert.match(shell, /console-shell/);
  assert.match(shell, /console-rail/);
  assert.match(shell, /group-picker/);
  assert.match(shell, /command-trigger/);
  assert.match(shell, /m-rail/);
  assert.match(shell, /m-pill/);
  assert.match(shell, /m-float/);
  assert.doesNotMatch(shell, /class="app-shell"/);
  assert.match(tokens, /--blue:\s*#236de9/);
  assert.match(tokens, /--lime:\s*#82dd2d/);
  assert.match(tokens, /Copyright \(c\) 2026 wbr664393425-lgtm/);
  assert.match(layout, /Full-bleed console layout/);
  assert.match(layout, /\.console-shell/);
  assert.match(layout, /@media \(max-width: 820px\)/);
  assert.doesNotMatch(layout, /\.app-frame|\.stage\s*\{/);
  assert.match(materials, /Pearl Glass materials/);
  assert.match(materials, /\.m-rail/);
  assert.match(materials, /\.m-pill/);
  assert.match(materials, /\.m-float/);
  assert.match(materials, /\.m-surface/);
  assert.match(materials, /\.m-groove/);
  assert.match(components, /Controls and compound UI primitives/);
  assert.match(instruments, /Dense operational instruments/);
  assert.match(login, /login-shell/);
  assert.match(login, /login-brief/);
  assert.doesNotMatch(login, /background:\s*#000/);
  assert.match(entry, /styles\/materials\.css/);
  assert.match(entry, /styles\/components\.css/);
  assert.match(entry, /styles\/instruments\.css/);
  assert.match(entry, /styles\/layout\.css/);
  assert.match(entry, /styles\/pages\.css/);
});

test("admin exposes a dedicated tool-capable image intent model configuration", async () => {
  const [settings, api, health, analytics] = await Promise.all([
    readAdmin(path.join("views", "SettingsView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readAdmin(path.join("views", "HealthView.vue")),
    readAdmin(path.join("views", "AnalyticsView.vue")),
  ]);

  assert.match(api, /image_intent/);
  assert.match(api, /toolCalling\?: boolean/);
  assert.match(settings, /请求判别/);
  assert.match(settings, /支持原生工具调用/);
  assert.match(settings, /isUsableImageIntentModel/);
  assert.match(health, /请求判别模型/);
  assert.match(health, /请求判别工具调用/);
  assert.match(analytics, /image_intent:"请求判别"/);
});

test("admin exposes a dedicated Huixian persona editor instead of a skills marketplace", async () => {
  const [router, persona, groups, server, profileAsset] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin(path.join("views", "PersonaView.vue")),
    readAdmin(path.join("views", "GroupsView.vue")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
    readFile(path.join(repoRoot, "assets", "huixian-profile.json"), "utf8"),
  ]);

  assert.match(router, /PersonaView/);
  assert.match(router, /path:\s*"\/persona"/);
  assert.match(router, /path:\s*"\/skills",\s*redirect:\s*"\/persona"/);
  assert.match(persona, /\/api\/persona\/huixian/);
  assert.match(persona, /唯一运行时人格/);
  assert.match(persona, /正事认真处理/);
  assert.match(groups, /currentReplyModelLabel/);
  assert.match(groups, /configTabs/);
  assert.doesNotMatch(groups, /\/api\/skill-options|allowedSkillIds"/);
  assert.match(server, /\/api\/persona\/huixian/);
  assert.doesNotMatch(server, /pathname === "\/api\/skills"/);
  assert.match(profileAsset, /\"id\": \"huixian\"/);
  assert.match(profileAsset, /普通对话中主动解释自己的实现方式/);
  assert.match(profileAsset, /不编造身体、位置、照片、线下经历或已完成的操作/);
});

test("group settings separate ambient replies, selected-member participation, poke probability, and mute scope", async () => {
  const groups = await readAdmin(path.join("views", "GroupsView.vue"));

  assert.match(groups, /读空气（主动接话）/);
  assert.match(groups, /不影响 @、引用、关键词或指定成员低频参与/);
  assert.match(groups, /低频参与成员/);
  assert.match(groups, /被戳后回戳概率（%）/);
  assert.match(groups, /0% 表示永不回戳，不影响读空气、指定成员低频参与或普通回复/);
  assert.match(groups, /只保留已启用的日报、节日倒计时和管理员普通定时提醒/);
  assert.match(groups, /已静音，以上群消息触发项均暂停；仅排程保留/);
});

test("runtime documentation and release packaging do not carry retired personas", async () => {
  const [packageLinux, verifier, deployer, windowsPack, huixian, commands] = await Promise.all([
    readFile(path.join(repoRoot, "scripts", "package-linux-release.sh"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "verify-release-source.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "deploy-linux-release.sh"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "package-win.ps1"), "utf8"),
    readFile(path.join(repoRoot, "assets", "huixian-profile.json"), "utf8"),
    readFile(path.join(repoRoot, "README.md"), "utf8"),
  ]);

  assert.match(packageLinux, /assets\/huixian-profile\.json/);
  assert.match(verifier, /assets\/huixian-profile\.json/);
  assert.match(deployer, /assets\/huixian-profile\.json/);
  assert.match(windowsPack, /\"assets\/huixian-profile\.json\"/);
  assert.match(verifier, /\"skills\"/);
  assert.doesNotMatch(packageLinux, /itexpert\.json/);
  assert.doesNotMatch(deployer, /itexpert\.json/);
  assert.match(huixian, /普通对话中主动解释自己的实现方式/);
  assert.match(huixian, /不编造身体、位置、照片、线下经历或已完成的操作/);
  assert.doesNotMatch(commands, /#技能/);
});

test("admin hides compatibility routes and loads a missing member cache explicitly", async () => {
  const [router, shell, members, api, server, adminEntry] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin(path.join("components", "ConsoleShell.vue")),
    readAdmin(path.join("views", "MembersView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "index-admin.ts"), "utf8"),
  ]);

  assert.match(router, /path:\s*"\/skills",\s*redirect:\s*"\/persona"/);
  assert.match(router, /navigation:\s*false/);
  assert.match(shell, /routes\.filter/);
  assert.match(shell, /item\.name !== "login"/);
  assert.match(shell, /item\.meta\.navigation !== false/);
  assert.match(api, /interface MemberListResponse/);
  assert.match(members, /cacheStatus === "unloaded"/);
  assert.match(members, /\/members\/refresh/);
  assert.match(members, /napcat_members_unavailable/);
  assert.match(members, /useRefreshEvents/);
  assert.match(server, /cacheStatus: "cached" \| "refreshed" \| "unloaded"/);
  assert.match(server, /napcat_members_unavailable/);
  assert.match(adminEntry, /listGroupMembersStrict/);
});

test("admin manages HTML preview metadata without embedding generated page content", async () => {
  const [router, shell, previewView, api, groups, server] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin(path.join("workspaces.ts")),
    readAdmin(path.join("views", "HtmlPreviewsView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readAdmin(path.join("views", "GroupsView.vue")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
  ]);

  assert.match(router, /path:\s*"\/html-previews"/);
  assert.match(shell, /"html-previews"/);
  assert.match(api, /interface HtmlPreviewMetadata/);
  assert.match(groups, /htmlPreviewEnabled/);
  assert.match(groups, /ambientGroupContextEnabled/);
  assert.match(groups, /naturalImageRequestsEnabled/);
  assert.match(groups, /自然语言生图与改图/);
  assert.match(groups, /短时群聊语境/);
  assert.doesNotMatch(groups, /imageGenerationEnabled|图片生成/);
  assert.match(previewView, /\/api\/html-previews/);
  assert.match(previewView, /rel="noopener noreferrer"/);
  assert.match(previewView, /url\.hostname !== "preview\.9958\.uk"/);
  assert.match(server, /handleHtmlPreviews/);
  assert.match(server, /html_preview_delete/);
  assert.match(server, /page\.items\.map\(formatHtmlPreviewForAdmin\)/);
  assert.match(server, /generated HTML/);
});

test("group settings keep automatic reply mechanisms distinct and explain strict mute", async () => {
  const groups = await readAdmin(path.join("views", "GroupsView.vue"));

  assert.match(groups, /读空气（主动接话）/);
  assert.match(groups, /关闭后，不再根据普通群聊主动接话；不影响 @、引用、关键词或指定成员低频参与。/);
  assert.match(groups, /指定成员低频参与与读空气独立；关闭读空气后，已配置成员仍可低频参与。/);
  assert.match(groups, /戳一戳回戳/);
  assert.match(groups, /被戳后回戳概率（%）/);
  assert.match(groups, /0% 表示永不回戳，不影响读空气、指定成员低频参与或普通回复。/);
  assert.match(groups, /静音后只保留已启用的日报、节日倒计时和管理员普通定时提醒；授权管理员发送精确 #说话 恢复。/);
  assert.match(groups, /已静音，以上群消息触发项均暂停；仅排程保留。/);
  assert.match(groups, /<fieldset class="automation-settings wide">/);
  assert.match(groups, /<fieldset class="poke-settings">/);
  assert.doesNotMatch(groups, /{ key: "ambientReplyEnabled", label: "读空气"/);
  assert.doesNotMatch(groups, /{ key: "pokeReplyEnabled", label: "回戳"/);
});

test("admin exposes private generated-image previews beside HTML previews", async () => {
  const [router, workspaces, view, api] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin("workspaces.ts"),
    readAdmin(path.join("views", "ImagePreviewsView.vue")),
    readAdmin(path.join("services", "api.ts")),
  ]);

  assert.match(router, /path:\s*"\/image-previews"/);
  assert.match(router, /name:\s*"image-previews"/);
  assert.match(workspaces, /"html-previews",\s*"image-previews"/);
  assert.match(api, /interface ImagePreviewListItem/);
  assert.match(api, /interface ImagePreviewDetail/);
  assert.match(view, /\/api\/image-previews/);
  assert.match(view, /\/preview/);
  assert.match(view, /完整提示词/);
  assert.match(view, /promptSummary/);
});

test("admin exposes a super-admin-only meme library with authenticated image previews", async () => {
  const [router, shell, view, api, server, adminEntry] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin(path.join("workspaces.ts")),
    readAdmin(path.join("views", "MemeLibraryView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "index-admin.ts"), "utf8"),
  ]);

  assert.match(router, /path:\s*"\/memes"/);
  assert.match(router, /name:\s*"memes"/);
  assert.match(router, /superOnly:\s*true/);
  assert.match(shell, /"memes"/);
  assert.match(view, /\/api\/meme-library/);
  assert.match(view, /\/preview/);
  assert.match(view, /image\/png,image\/jpeg,image\/gif,image\/webp/);
  assert.match(view, /normalizeKeywords/);
  assert.match(view, /触发关键词/);
  assert.match(view, /普通对话素材至少选择一个标签/);
  assert.match(api, /interface MemeLibraryPolicy/);
  assert.match(api, /keywords:\s*string\[\]/);
  assert.match(api, /interface MemeAsset/);
  assert.match(server, /handleMemeLibrary/);
  assert.match(server, /requireRecentSuperAdminReauth/);
  assert.match(server, /meme_library_asset_upload/);
  assert.match(adminEntry, /new MemeLibraryService\(config\.dataDir, v3State\)/);
});
