import { pathToFileURL } from "node:url";

const releaseRoot = process.env.RELEASE_ROOT || "/opt/ai-project-releases/current";
const dbPath = process.env.DB_PATH || "/opt/ai-project/data/shared/bot-shared.db";

const { SharedDb } = await import(pathToFileURL(`${releaseRoot}/dist/shared/sqlite.js`).href);
const { V3StateRepository } = await import(pathToFileURL(`${releaseRoot}/dist/services/v3-state-repository.js`).href);
const { SystemSettingsStore } = await import(pathToFileURL(`${releaseRoot}/dist/services/system-settings-store.js`).href);
const { default: dotenv } = await import(pathToFileURL(`${releaseRoot}/node_modules/dotenv/lib/main.js`).href);

dotenv.config({ path: "/opt/ai-project/.env" });
const db = new SharedDb(dbPath);
const repo = new V3StateRepository(db, { stateEncryptionKey: process.env.UBOT_STATE_ENCRYPTION_KEY });
const store = new SystemSettingsStore("unused.json", [], undefined, repo);
const settings = await store.getInternal();

const geminiKey = "sk-a65d68650c2664e2141ccb1bb3d31051d3b4cf2549d131591bdafd49cb072afa";
const modelsInput = settings.models.map((m) => {
  if (m.id === "gemini") {
    return { ...m, apiKey: geminiKey, enabled: true };
  }
  return m;
});

await store.update({
  models: modelsInput,
  selectedModelIds: {
    ...settings.selectedModelIds,
    reply: "gemini",
  },
});

const groups = ["735653114", "1044162764", "866209871"];
for (const gid of groups) {
  const row = db.db.prepare("SELECT config_json FROM v3_groups WHERE group_id = ?").get(gid);
  if (row) {
    const cfg = JSON.parse(row.config_json);
    cfg.replyModelMode = "gemini";
    db.db.prepare("UPDATE v3_groups SET config_json = ?, updated_at = ? WHERE group_id = ?")
      .run(JSON.stringify(cfg), new Date().toISOString(), gid);
    console.log(`Updated group ${gid} replyModelMode to gemini`);
  }
}

const after = await store.getInternal();
const geminiModel = after.models.find((m) => m.id === "gemini");
console.log("Gemini hasKey:", geminiModel?.hasApiKey, "key length:", geminiModel?.apiKey?.length, "selected:", after.selectedModelIds);

db.close();
