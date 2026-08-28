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
    readAdmin("App.vue"),
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
  assert.match(persona, /现实证明时会自然转场/);
  assert.match(groups, /会仙\s*\/\s*huixian/);
  assert.doesNotMatch(groups, /\/api\/skill-options|allowedSkillIds"/);
  assert.match(server, /\/api\/persona\/huixian/);
  assert.doesNotMatch(server, /pathname === "\/api\/skills"/);
  assert.match(profileAsset, /\"id\": \"huixian\"/);
  assert.match(profileAsset, /普通对话中主动解释自己的实现方式/);
  assert.match(profileAsset, /不编造、暗示或承诺可核验的事实/);
});

test("runtime documentation and release packaging do not carry retired personas", async () => {
  const [packageLinux, verifier, deployer, windowsPack, huixian, commands] = await Promise.all([
    readFile(path.join(repoRoot, "scripts", "package-linux-release.sh"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "verify-release-source.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "deploy-linux-release.sh"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "package-win.ps1"), "utf8"),
    readFile(path.join(repoRoot, "assets", "huixian-profile.json"), "utf8"),
    readFile(path.join(repoRoot, "COMMANDS.md"), "utf8"),
  ]);

  assert.match(packageLinux, /assets\/huixian-profile\.json/);
  assert.match(verifier, /assets\/huixian-profile\.json/);
  assert.match(deployer, /assets\/huixian-profile\.json/);
  assert.match(windowsPack, /\"assets\/huixian-profile\.json\"/);
  assert.match(verifier, /\"skills\"/);
  assert.doesNotMatch(packageLinux, /itexpert\.json/);
  assert.doesNotMatch(deployer, /itexpert\.json/);
  assert.match(huixian, /普通对话中主动解释自己的实现方式/);
  assert.match(huixian, /不编造、暗示或承诺可核验的事实/);
  assert.doesNotMatch(commands, /#技能/);
});

test("admin hides compatibility routes and loads a missing member cache explicitly", async () => {
  const [router, shell, members, api, server, adminEntry] = await Promise.all([
    readAdmin("router.ts"),
    readAdmin("App.vue"),
    readAdmin(path.join("views", "MembersView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
    readFile(path.join(repoRoot, "src", "index-admin.ts"), "utf8"),
  ]);

  assert.match(router, /path:\s*"\/skills",\s*redirect:\s*"\/persona"/);
  assert.match(router, /navigation:\s*false/);
  assert.match(shell, /typeof item\.name === "string"/);
  assert.match(shell, /item\.meta\?\.navigation !== false/);
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
    readAdmin("App.vue"),
    readAdmin(path.join("views", "HtmlPreviewsView.vue")),
    readAdmin(path.join("services", "api.ts")),
    readAdmin(path.join("views", "GroupsView.vue")),
    readFile(path.join(repoRoot, "src", "admin-http-server.ts"), "utf8"),
  ]);

  assert.match(router, /path:\s*"\/html-previews"/);
  assert.match(shell, /"html-previews"/);
  assert.match(api, /interface HtmlPreviewMetadata/);
  assert.match(groups, /htmlPreviewEnabled/);
  assert.match(previewView, /\/api\/html-previews/);
  assert.match(previewView, /rel="noopener noreferrer"/);
  assert.match(previewView, /url\.hostname !== "preview\.9958\.uk"/);
  assert.match(server, /handleHtmlPreviews/);
  assert.match(server, /html_preview_delete/);
  assert.match(server, /page\.items\.map\(formatHtmlPreviewForAdmin\)/);
  assert.match(server, /generated HTML/);
});
