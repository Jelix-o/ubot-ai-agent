import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_GROUP_IDS = ["735653114", "1044162764", "866209871"];
const EXPECTED_BATCH_ID = "qq-profile-20260904";
const EXPECTED_RECORDS = 228;

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args.set(key, true);
    else { args.set(key, next); index += 1; }
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value || value === true) throw new Error(`${name} is required`);
  return String(value);
}

function sha256(value) {
  return import("node:crypto").then(({ createHash }) => createHash("sha256").update(value, "utf8").digest("hex"));
}

export async function validateManifest(manifest) {
  const errors = [];
  if (manifest?.batchId !== EXPECTED_BATCH_ID) errors.push(`unexpected batchId: ${manifest?.batchId}`);
  if (!Array.isArray(manifest?.memories) || manifest.memories.length !== EXPECTED_RECORDS) errors.push(`expected ${EXPECTED_RECORDS} records`);
  if (JSON.stringify([...(manifest?.targetGroupIds ?? [])].sort()) !== JSON.stringify([...EXPECTED_GROUP_IDS].sort())) errors.push("target group set mismatch");
  const keys = new Set();
  const ids = new Set();
  const byQq = new Map();
  for (const memory of manifest?.memories ?? []) {
    const key = `${memory.groupId}|${memory.subjectUserId}`;
    if (keys.has(key)) errors.push(`duplicate group/member key: ${key}`);
    keys.add(key);
    if (ids.has(memory.id)) errors.push(`duplicate id: ${memory.id}`);
    ids.add(memory.id);
    if (!EXPECTED_GROUP_IDS.includes(memory.groupId)) errors.push(`unexpected group: ${memory.groupId}`);
    if (!/^\d+$/.test(String(memory.subjectUserId ?? ""))) errors.push(`invalid subject QQ: ${memory.subjectUserId}`);
    if (memory.type !== "member_profile" || memory.source !== "admin" || memory.enabled !== true) errors.push(`invalid memory attributes: ${key}`);
    if (typeof memory.content !== "string" || memory.content.length === 0 || memory.content.length > 1800) errors.push(`invalid content length: ${key}`);
    const actualHash = await sha256(memory.content ?? "");
    if (memory.contentSha256 !== actualHash) errors.push(`content hash mismatch: ${key}`);
    const list = byQq.get(memory.subjectUserId) ?? [];
    list.push(memory);
    byQq.set(memory.subjectUserId, list);
  }
  if (byQq.size !== 76) errors.push(`expected 76 subjects, got ${byQq.size}`);
  for (const [qq, memories] of byQq) {
    if (memories.length !== 3) errors.push(`expected three group copies for ${qq}`);
    if (new Set(memories.map((memory) => memory.contentSha256)).size !== 1) errors.push(`copy hash mismatch for ${qq}`);
  }
  return errors;
}

function parseGroupConfigs(sharedDb) {
  return sharedDb.db.prepare("SELECT group_id, config_json FROM v3_groups WHERE group_id IN (?, ?, ?) ORDER BY group_id")
    .all(...EXPECTED_GROUP_IDS)
    .map((row) => ({ row, config: JSON.parse(row.config_json) }));
}

function preflight(repository, sharedDb, manifest) {
  repository.requireCutover();
  const groups = parseGroupConfigs(sharedDb);
  if (groups.length !== EXPECTED_GROUP_IDS.length) throw new Error(`Expected all target groups, found ${groups.length}`);
  for (const { row, config } of groups) {
    if (config.enabled === false) throw new Error(`Target group is disabled: ${row.group_id}`);
    const disabled = Array.isArray(config.memoryDisabledUserIds) ? config.memoryDisabledUserIds : [];
    if (disabled.length > 0) throw new Error(`Memory privacy opt-out list is non-empty for ${row.group_id}; aborting whole import`);
  }
  const existing = repository.listMemories();
  const incomingIds = new Set(manifest.memories.map((memory) => memory.id));
  const conflicts = existing.filter((memory) => incomingIds.has(memory.id)).filter((memory) => {
    const incoming = manifest.memories.find((item) => item.id === memory.id);
    return !incoming || incoming.groupId !== memory.groupId || incoming.subjectUserId !== memory.subjectUserId || incoming.type !== memory.type;
  });
  if (conflicts.length > 0) throw new Error(`Deterministic ID conflicts detected: ${conflicts.map((memory) => memory.id).join(",")}`);
  const baselineByGroup = Object.fromEntries(EXPECTED_GROUP_IDS.map((groupId) => [groupId, existing.filter((memory) => memory.groupId === groupId).length]));
  return {
    groups: groups.map(({ row, config }) => ({ groupId: row.group_id, groupName: config.groupName ?? "", memoryDisabledCount: 0 })),
    baselineCount: existing.length,
    baselineByGroup,
    preexistingBatchRecords: existing.filter((memory) => incomingIds.has(memory.id)).length,
    preservedMemoryIds: existing.filter((memory) => !incomingIds.has(memory.id)).map((memory) => memory.id).sort(),
  };
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

async function createBackup(sharedDb, backupRoot, operation) {
  const resolvedRoot = path.resolve(backupRoot);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
  const backupDir = path.join(resolvedRoot, `${stamp}-${EXPECTED_BATCH_ID}-${operation}`);
  if (!path.resolve(backupDir).startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Backup directory escaped its root");
  await mkdir(backupDir, { recursive: false, mode: 0o700 });
  const backupPath = path.join(backupDir, "bot-shared.db");
  const integrity = sharedDb.db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
  sharedDb.db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
  return { backupDir, backupPath };
}

function memoryFromManifest(memory, existing, now) {
  return {
    id: memory.id,
    groupId: memory.groupId,
    type: "member_profile",
    subjectUserId: memory.subjectUserId,
    title: memory.title,
    content: memory.content,
    confidence: memory.confidence,
    source: "admin",
    enabled: true,
    createdAt: existing?.createdAt ?? memory.createdAt ?? now,
    updatedAt: now,
  };
}

async function recordOperations(operationLog, manifest, action, detail) {
  for (const groupId of EXPECTED_GROUP_IDS) {
    await operationLog.record({
      groupId,
      operatorUserId: "codex-profile-import",
      action,
      target: manifest.batchId,
      detail,
    });
  }
}

async function loadRuntime(releaseRoot, dbPath, encryptionKey) {
  const distRoot = path.join(path.resolve(releaseRoot), "dist");
  const [{ SharedDb }, { V3StateRepository }, { AdminOperationLogService }] = await Promise.all([
    import(pathToFileURL(path.join(distRoot, "shared/sqlite.js")).href),
    import(pathToFileURL(path.join(distRoot, "services/v3-state-repository.js")).href),
    import(pathToFileURL(path.join(distRoot, "services/admin-operation-log-service.js")).href),
  ]);
  const sharedDb = new SharedDb(path.resolve(dbPath));
  const repository = new V3StateRepository(sharedDb, { stateEncryptionKey: encryptionKey });
  const operationLog = new AdminOperationLogService("unused-v3-operation-log.jsonl", repository);
  return { sharedDb, repository, operationLog };
}

function verifyAfter(repository, manifest, before, rollingBack) {
  const incomingIds = new Set(manifest.memories.map((memory) => memory.id));
  const all = repository.listMemories();
  const batch = all.filter((memory) => incomingIds.has(memory.id));
  const preserved = all.filter((memory) => !incomingIds.has(memory.id)).map((memory) => memory.id).sort();
  if (JSON.stringify(preserved) !== JSON.stringify(before.preservedMemoryIds)) throw new Error("Non-batch memories changed during operation");
  const expectedBatch = rollingBack ? 0 : EXPECTED_RECORDS;
  if (batch.length !== expectedBatch) throw new Error(`Expected ${expectedBatch} batch records, found ${batch.length}`);
  if (!rollingBack) {
    for (const input of manifest.memories) {
      const saved = batch.find((memory) => memory.id === input.id);
      if (!saved || saved.groupId !== input.groupId || saved.subjectUserId !== input.subjectUserId || saved.content !== input.content || saved.enabled !== true) throw new Error(`Post-import mismatch: ${input.id}`);
    }
  }
  return {
    totalMemories: all.length,
    batchRecords: batch.length,
    byGroup: Object.fromEntries(EXPECTED_GROUP_IDS.map((groupId) => [groupId, all.filter((memory) => memory.groupId === groupId).length])),
    preservedRecords: preserved.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(requiredArg(args, "--manifest"));
  const dbPath = path.resolve(requiredArg(args, "--db"));
  const releaseRoot = path.resolve(String(args.get("--release-root") || process.cwd()));
  const envPath = path.resolve(String(args.get("--env") || ".env"));
  const backupRoot = path.resolve(String(args.get("--backup-root") || "/opt/ai-project/release-backups"));
  const execute = args.has("--execute");
  const rollback = args.has("--rollback");
  const dotenvModule = await import(pathToFileURL(path.join(releaseRoot, "node_modules/dotenv/lib/main.js")).href).catch(() => import("dotenv"));
  const dotenv = dotenvModule.default ?? dotenvModule;
  dotenv.config({ path: envPath });
  const encryptionKey = process.env.UBOT_STATE_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required but will not be printed");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestErrors = await validateManifest(manifest);
  if (manifestErrors.length > 0) throw new Error(`Manifest validation failed: ${manifestErrors.join("; ")}`);
  const { sharedDb, repository, operationLog } = await loadRuntime(releaseRoot, dbPath, encryptionKey);
  try {
    const before = preflight(repository, sharedDb, manifest);
    if (!execute) {
      console.log(JSON.stringify({ mode: rollback ? "rollback-dry-run" : "import-dry-run", manifestPath, records: manifest.memories.length, ...before }, null, 2));
      return;
    }
    const backup = await createBackup(sharedDb, backupRoot, rollback ? "rollback" : "import");
    if (rollback) {
      repository.runAtomically(() => {
        for (const memory of manifest.memories) repository.deleteMemory(memory.id);
      });
      await recordOperations(operationLog, manifest, "memory_profile_import_rollback", `removed=${manifest.memories.length}; backup=${backup.backupDir}`);
    } else {
      const now = new Date().toISOString();
      repository.runAtomically(() => {
        for (const input of manifest.memories) repository.saveMemory(memoryFromManifest(input, repository.getMemory(input.id), now));
      });
      await recordOperations(operationLog, manifest, "memory_profile_import", `upserted=${manifest.memories.length}; backup=${backup.backupDir}`);
    }
    const after = verifyAfter(repository, manifest, before, rollback);
    console.log(JSON.stringify({ mode: rollback ? "rollback-execute" : "import-execute", backup, before, after }, null, 2));
  } finally {
    sharedDb.close();
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main().catch((error) => { console.error(error); process.exitCode = 1; });
