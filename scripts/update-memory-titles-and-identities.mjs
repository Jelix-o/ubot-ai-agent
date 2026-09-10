import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseRoot = process.env.RELEASE_ROOT || "/opt/ai-project-releases/current";
const dbPath = process.env.DB_PATH || "/opt/ai-project/data/shared/bot-shared.db";

const { SharedDb } = await import(pathToFileURL(`${releaseRoot}/dist/shared/sqlite.js`).href);
const db = new SharedDb(path.resolve(dbPath));

// 1. Load manualIdentities from 1044162764
const row1044 = db.db.prepare("SELECT config_json FROM v3_groups WHERE group_id = '1044162764'").get();
const cfg1044 = JSON.parse(row1044.config_json);
const manualIdentities = cfg1044.manualIdentities || [];

const aliasByQq = new Map();
for (const item of manualIdentities) {
  for (const uid of item.userIds || []) {
    if (uid && !aliasByQq.has(uid)) {
      aliasByQq.set(uid, item.names[0]);
    }
  }
}

// 2. Load nicknames from review-index.csv if available
let csvNicknames = new Map();
try {
  const csvText = await readFile("/tmp/review-index.csv", "utf8");
  for (const line of csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).slice(1)) {
    const parts = line.split(",");
    if (parts[0] && parts[1]) csvNicknames.set(parts[0], parts[1]);
  }
} catch {
  // if not found, fallback to aliasByQq or existing
}

// 3. Update titles in v3_memories
const memories = db.db.prepare("SELECT id, subject_user_id, title FROM v3_memories WHERE id LIKE 'qqp-%'").all();
console.log(`Found ${memories.length} batch memories to update.`);

let updatedCount = 0;
const updateStmt = db.db.prepare("UPDATE v3_memories SET title = ? WHERE id = ?");

db.db.exec("BEGIN IMMEDIATE");
for (const m of memories) {
  const qq = m.subject_user_id;
  const name = aliasByQq.get(qq) || csvNicknames.get(qq) || qq;
  const newTitle = `QQ群聊画像：${name}（截至 2026-09-04）`;
  updateStmt.run(newTitle, m.id);
  updatedCount += 1;
}
db.db.exec("COMMIT");
console.log(`Updated ${updatedCount} memory titles.`);

// 4. Sync manualIdentities to group 735653114 if currently empty
const row735 = db.db.prepare("SELECT config_json FROM v3_groups WHERE group_id = '735653114'").get();
if (row735) {
  const cfg735 = JSON.parse(row735.config_json);
  if (!cfg735.manualIdentities || cfg735.manualIdentities.length === 0) {
    cfg735.manualIdentities = manualIdentities;
    db.db.prepare("UPDATE v3_groups SET config_json = ?, updated_at = ? WHERE group_id = '735653114'")
      .run(JSON.stringify(cfg735), new Date().toISOString());
    console.log(`Synced ${manualIdentities.length} manualIdentities to group 735653114.`);
  } else {
    console.log(`Group 735653114 already has ${cfg735.manualIdentities.length} manualIdentities.`);
  }
}

// 5. Verify sample
const sample = db.db.prepare("SELECT id, group_id, subject_user_id, title FROM v3_memories WHERE subject_user_id = '289513186'").all();
console.log("Sample 289513186 memories:", JSON.stringify(sample, null, 2));

db.close();
