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
  assert.match(persona, /真实私人照片/);
  assert.match(groups, /会仙\s*\/\s*huixian/);
  assert.doesNotMatch(groups, /\/api\/skill-options|allowedSkillIds"/);
  assert.match(server, /\/api\/persona\/huixian/);
  assert.doesNotMatch(server, /pathname === "\/api\/skills"/);
  assert.match(profileAsset, /\"id\": \"huixian\"/);
  assert.match(profileAsset, /没有可发送的真实私人照片/);
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
  assert.match(huixian, /没有可发送的真实私人照片/);
  assert.match(huixian, /线下行程/);
  assert.doesNotMatch(commands, /#技能/);
});
