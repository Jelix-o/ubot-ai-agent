#!/usr/bin/env node
/*
 * One-way V3 state cutover.
 *
 * JSON is only read here while every runtime process is stopped.  A successful
 * run writes the SQLite cutover marker, archives retired data encrypted for
 * seven days, and removes the legacy runtime files so a new binary cannot
 * silently fall back to a stale JSON authority.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IMPORTER_VERSION = "3.0.8";
const EXPLICIT_MEMORY_SOURCES = new Set(["admin", "explicit_command", "explicit_request"]);
const DEFAULT_V3_ENABLED_CAPABILITIES = [
  "conversation", "explicit_memory", "knowledge", "scheduled_reminders",
  "daily_reports", "holiday_countdown", "realtime_lookup", "voice", "singing",
  "html_preview",
];
const DEFAULT_V3_PROVIDER_CAPABILITIES = {
  openai: ["chat", "vision", "streaming", "reasoningEffort", "requestTimeout"],
  // Claude uses the official Messages SDK boundary. It supports vision and a
  // request timeout, but V3 does not send OpenAI-only streaming/reasoning
  // request features to it.
  anthropic: ["chat", "vision", "requestTimeout"],
};
const HUIXIAN_RELEASE_PROFILE_REVISION = "immersive-natural-v3.0.3";
const HUIXIAN_RELEASE_PROFILE_CHANGED_BY = "release:3.0.3:huixian-immersive";

const args = parseArgs(process.argv.slice(2));
const appRoot = path.resolve(args.appRoot ?? process.env.UBOT_APP_ROOT ?? process.cwd());
dotenv.config({ path: path.join(appRoot, ".env"), override: false });
const dataDir = path.resolve(args.dataDir ?? path.join(appRoot, "data"));
const configDir = path.resolve(path.join(appRoot, "config"));
const dbPath = path.join(dataDir, "shared", "bot-shared.db");
const rollbackDir = path.join(dataDir, "v3-rollback");
const huixianProfilePath = path.resolve(
  process.env.UBOT_HUIXIAN_PROFILE_PATH ?? path.join(appRoot, "assets", "huixian-profile.json"),
);

if (args.maintenance) {
  await runMaintenance();
} else {
  await runCutover();
}

async function runCutover() {
  // A maintenance release must be able to apply additive SQLite migrations
  // after the one-way cutover. This branch intentionally runs before legacy
  // source discovery so an already-cut-over installation never touches JSON
  // again, even when retired files happen to remain on disk.
  if (args.allowExistingCutover) {
    const cutoverState = inspectCutoverState();
    if (cutoverState === "v3") {
      await runExistingCutoverUpgrade();
      return;
    }
    if (cutoverState !== "absent") {
      throw new Error(`Unexpected V3 cutover marker: ${cutoverState}`);
    }
  }

  const sources = await collectLegacySources();
  const report = await buildPreflightReport(sources);
  if (!args.execute) {
    writeReport(report);
    return;
  }

  const encryptionKey = requireStateEncryptionKey();
  if (report.outboxBlockingRows > 0) {
    throw new Error(`Refusing V3 cutover: ${report.outboxBlockingRows} outbox row(s) are not terminal.`);
  }
  if (!report.huixianProfileAvailable) {
    throw new Error(`V3 Huixian profile asset is missing: ${huixianProfilePath}`);
  }
  if (!existsSync(dbPath)) {
    throw new Error(`Shared SQLite database is missing: ${dbPath}`);
  }

  const { SharedDb } = await loadCompiledStateModules();
  const { V3StateRepository, StateCipher } = await loadCompiledRepositoryModules();
  const sharedDb = new SharedDb(dbPath);
  const repository = new V3StateRepository(sharedDb, { stateEncryptionKey: encryptionKey });
  let archive;
  let archiveRecorded = false;
  try {
    if (repository.isCutover()) {
      throw new Error("V3 state cutover is already complete; JSON import is intentionally unavailable.");
    }

    const now = Date.now();
    archive = await createEncryptedRollbackArchive({ sources, cipher: new StateCipher(encryptionKey), now });
    const parsed = await parseLegacySources(sources);
    const huixianProfile = await loadReleaseHuixianProfile();

    const importReport = repository.runAtomically(() => importAllState({
      repository,
      sharedDb,
      parsed,
      sources,
      huixianProfile,
      archive,
      now,
    }));
    // The retention row is committed by the import transaction. From here,
    // the hourly maintenance job owns this archive's seven-day cleanup.
    archiveRecorded = true;

    await removeLegacyRuntimeFiles(sources);
    writeReport({
      ...report,
      mode: "execute",
      archive: archive.publicManifest,
      imported: importReport,
      cutover: "complete",
    });
  } catch (error) {
    // Parsing or importing can fail after the encrypted archive is written
    // but before its retention row commits. Remove only this run's untracked
    // paths so they cannot outlive the seven-day retention boundary.
    if (archive && !archiveRecorded) {
      await removeUntrackedRollbackArchive(archive);
    }
    throw error;
  } finally {
    sharedDb.close();
  }
}

async function runExistingCutoverUpgrade() {
  if (!args.execute) {
    writeReport({
      mode: "existing-cutover-upgrade-dry-run",
      appRoot,
      dataDir,
      dbPath,
      huixianProfileRevision: {
        target: HUIXIAN_RELEASE_PROFILE_REVISION,
        path: huixianProfilePath,
        available: existsSync(huixianProfilePath),
      },
      note: "The V3 cutover marker is present. Run with --execute to apply additive SQLite migrations without reading legacy JSON.",
    });
    return;
  }
  if (!existsSync(dbPath)) {
    throw new Error(`Shared SQLite database is missing: ${dbPath}`);
  }

  const encryptionKey = requireStateEncryptionKey();
  // This is release-owned packaged input, not a former runtime JSON source.
  // Validate it before opening a write transaction so a bad bundle cannot
  // leave a partially updated cut-over store.
  const huixianProfile = await loadReleaseHuixianProfile();
  const { SharedDb } = await loadCompiledStateModules();
  const { V3StateRepository } = await loadCompiledRepositoryModules();
  const sharedDb = new SharedDb(dbPath);
  const repository = new V3StateRepository(sharedDb, { stateEncryptionKey: encryptionKey });
  try {
    repository.requireCutover();
    const now = Date.now();
    const upgrade = repository.runAtomically(() => ({
      retiredQqAdministration: repository.retireLegacyQqAdministration(),
      huixianProfileRevision: repository.applyHuixianReleaseProfile({
        revision: HUIXIAN_RELEASE_PROFILE_REVISION,
        profile: huixianProfile,
        changedBy: HUIXIAN_RELEASE_PROFILE_CHANGED_BY,
      }),
      htmlPreviewCapability: enableHtmlPreviewCapability(repository, now),
    }));
    writeReport({
      mode: "existing-cutover-upgrade",
      appRoot,
      dataDir,
      dbPath,
      migrationVersions: sharedDb.listSchemaMigrations().map((migration) => migration.version),
      cutover: "already-complete",
      legacyJson: "not-read",
      ...upgrade,
    });
  } finally {
    sharedDb.close();
  }
}

/**
 * Existing V3 installations already have a persistent capability policy.
 * Additive releases must make the new feature explicit in that authority;
 * otherwise the policy's intentional deny-by-default behavior would leave
 * every group unable to use the new command after migration 10 succeeds.
 */
function enableHtmlPreviewCapability(repository, now) {
  const policy = repository.getCapabilityPolicy();
  if (!policy) {
    // RC/early-V3 installations that wrote the cutover marker before the
    // persistent policy table existed need a single repair before runtime can
    // start. This is deliberately limited to a missing row: a malformed row
    // still fails closed, and a valid narrowed policy remains narrowed except
    // for the newly shipped explicit html_preview capability.
    repository.saveCapabilityPolicy(defaultV3CapabilityPolicy(now), now);
    return { changed: true, initialized: true };
  }
  if (policy.enabledCapabilities.includes("html_preview")) {
    return { changed: false };
  }
  repository.saveCapabilityPolicy({
    ...policy,
    enabledCapabilities: [...policy.enabledCapabilities, "html_preview"],
    updatedAt: new Date(now).toISOString(),
  }, now);
  return { changed: true };
}

function defaultV3CapabilityPolicy(now) {
  return {
    version: 1,
    enabledCapabilities: [...DEFAULT_V3_ENABLED_CAPABILITIES],
    providerCapabilities: structuredClone(DEFAULT_V3_PROVIDER_CAPABILITIES),
    updatedAt: new Date(now).toISOString(),
  };
}

async function runMaintenance() {
  if (!args.execute) {
    writeReport({
      mode: "maintenance-dry-run",
      appRoot,
      dataDir,
      retentionDays: 7,
      note: "Run with --maintenance --execute from a V3 release to remove expired raw data and rollback archives.",
    });
    return;
  }
  const encryptionKey = requireStateEncryptionKey();
  const { SharedDb } = await loadCompiledStateModules();
  const { V3StateRepository } = await loadCompiledRepositoryModules();
  const sharedDb = new SharedDb(dbPath);
  const repository = new V3StateRepository(sharedDb, { stateEncryptionKey: encryptionKey });
  try {
    repository.requireCutover();
    const now = Date.now();
    const raw = repository.pruneRawMessageRetention(now - RETENTION_MS);
    const expired = repository.listExpiredRollbackArchives(now);
    const purged = [];
    for (const archive of expired) {
      const manifest = archive.manifest && typeof archive.manifest === "object" ? archive.manifest : {};
      const paths = [archive.archivePath, ...(Array.isArray(manifest.relatedPaths) ? manifest.relatedPaths : [])]
        .filter((value) => typeof value === "string")
        .map((value) => path.resolve(value));
      for (const archivePath of paths) {
        ensurePathWithin(dataDir, archivePath);
        await rm(archivePath, { force: true });
      }
      repository.markRollbackArchivePurged(archive.id, now);
      purged.push(archive.id);
    }
    const htmlPreviews = await cleanupHtmlPreviews(sharedDb, now);
    repository.recordMaintenanceRun("v3-retention", {
      raw,
      purgedRollbackArchives: purged.length,
      htmlPreviews,
    }, now);
    writeReport({ mode: "maintenance-execute", raw, purgedRollbackArchives: purged, htmlPreviews });
  } finally {
    sharedDb.close();
  }
}

/**
 * Preview publication metadata is authoritative in SQLite, while its static
 * files live in the persistent data tree. Keep this dependency here rather
 * than teaching the generic repository about filesystem ownership.
 */
async function cleanupHtmlPreviews(sharedDb, now) {
  const configuredRoot = process.env.HTML_PREVIEW_ROOT?.trim();
  const previewRoot = path.resolve(configuredRoot || path.join(dataDir, "generated-pages"));
  const relative = path.relative(dataDir, previewRoot);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("HTML_PREVIEW_ROOT must remain under the persistent data directory for maintenance.");
  }
  const publicBaseUrl = process.env.HTML_PREVIEW_PUBLIC_BASE_URL?.trim() || "https://preview.9958.uk";
  const { HtmlPreviewService } = await loadCompiledHtmlPreviewModules();
  const service = new HtmlPreviewService({
    sharedDb,
    rootDir: previewRoot,
    publicBaseUrl,
  });
  return service.cleanup(now);
}

async function buildPreflightReport(sources) {
  let outboxBlockingRows = 0;
  let migrationVersions = [];
  if (existsSync(dbPath)) {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      outboxBlockingRows = countBlockingOutboxRows(database);
      migrationVersions = tableExists(database, "schema_migrations")
        ? database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version)
        : [];
    } finally {
      database.close();
    }
  }
  const sourceSummary = sources.map((source) => ({
    key: source.key,
    path: path.relative(appRoot, source.path).replaceAll("\\", "/"),
    exists: source.exists,
    bytes: source.bytes,
    sha256: source.sha256,
  }));
  return {
    mode: "dry-run",
    appRoot,
    dataDir,
    dbPath,
    migrationVersions,
    expectedMigrationVersionsOnExecute: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    outboxBlockingRows,
    huixianProfilePath,
    huixianProfileAvailable: existsSync(huixianProfilePath),
    sources: sourceSummary,
    explicitMemorySources: [...EXPLICIT_MEMORY_SOURCES],
    rollbackRetentionDays: 7,
  };
}

function importAllState({ repository, sharedDb, parsed, sources, huixianProfile, archive, now }) {
  const result = {
    groups: 0,
    settings: false,
    explicitMemories: 0,
    excludedMemories: 0,
    knowledgePacks: 0,
    knowledgeEntries: 0,
    scheduledReminders: 0,
    dailyReportMessages: 0,
    expiredDailyReportMessages: 0,
    invalidDailyReportMessages: 0,
    retiredProfileTasks: 0,
    holidayRuns: 0,
    documents: 0,
    initialRawRetention: {
      messages: 0,
      reportMessages: 0,
      userTurns: 0,
    },
    shortTermConversationCutoverMessageId: 0,
    characterProfile: "huixian",
  };

  const groups = normalizeGroupsFile(parsed.get("groups"));
  repository.saveGroups(groups, now);
  result.groups = groups.groups.length;
  const knownKnowledgePackGroupIds = new Set();
  const ensureKnowledgePack = (groupId) => {
    const normalized = String(groupId ?? "").trim();
    if (!normalized || knownKnowledgePackGroupIds.has(normalized)) return;
    repository.ensureKnowledgePack(normalized, now);
    knownKnowledgePackGroupIds.add(normalized);
    result.knowledgePacks += 1;
  };
  for (const group of groups.groups) {
    ensureKnowledgePack(group?.groupId);
  }

  const settings = parsed.get("system-settings");
  if (settings && typeof settings === "object") {
    repository.saveSystemSettings(settings, now);
    result.settings = true;
  }

  const memories = Array.isArray(parsed.get("group-memory")?.memories)
    ? parsed.get("group-memory").memories
    : [];
  const insertMemory = sharedDb.db.prepare(
    `INSERT INTO v3_memories
       (id, group_id, type, subject_user_id, title, content, confidence, source, enabled, evidence_json, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       group_id = excluded.group_id, type = excluded.type, subject_user_id = excluded.subject_user_id,
       title = excluded.title, content = excluded.content, confidence = excluded.confidence,
       source = excluded.source, enabled = excluded.enabled, evidence_json = excluded.evidence_json,
       superseded_by = excluded.superseded_by, updated_at = excluded.updated_at`,
  );
  for (const memory of memories) {
    const source = String(memory?.source ?? "").trim();
    if (!EXPLICIT_MEMORY_SOURCES.has(source)) {
      result.excludedMemories += 1;
      continue;
    }
    const id = String(memory?.id ?? "").trim();
    const groupId = String(memory?.groupId ?? "").trim();
    const title = String(memory?.title ?? "").trim();
    const content = String(memory?.content ?? "").trim();
    if (!id || !groupId || !title || !content) {
      continue;
    }
    insertMemory.run(
      id,
      groupId,
      memory?.type === "member_profile" ? "member_profile" : "group_fact",
      memory?.subjectUserId ? String(memory.subjectUserId) : null,
      title.slice(0, 80),
      content.slice(0, 1800),
      clampNumber(memory?.confidence, 0, 1, 0.7),
      source,
      memory?.enabled === false ? 0 : 1,
      memory?.evidence ? JSON.stringify(memory.evidence) : null,
      memory?.supersededBy ? String(memory.supersededBy).slice(0, 80) : null,
      toMs(memory?.createdAt, now),
      toMs(memory?.updatedAt, now),
    );
    result.explicitMemories += 1;
  }

  const knowledgeEntries = Array.isArray(parsed.get("knowledge-base")?.entries)
    ? parsed.get("knowledge-base").entries
    : [];
  const insertKnowledge = sharedDb.db.prepare(
    `INSERT INTO v3_knowledge_entries
       (id, group_id, title, question, answer, keywords_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       group_id = excluded.group_id, title = excluded.title, question = excluded.question,
       answer = excluded.answer, keywords_json = excluded.keywords_json, enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  );
  for (const entry of knowledgeEntries) {
    const id = String(entry?.id ?? "").trim();
    const groupId = String(entry?.groupId ?? "").trim();
    if (!id || !groupId) continue;
    ensureKnowledgePack(groupId);
    insertKnowledge.run(
      id,
      groupId,
      String(entry?.title ?? "").trim().slice(0, 100),
      String(entry?.question ?? "").trim().slice(0, 300),
      String(entry?.answer ?? "").trim().slice(0, 1200),
      JSON.stringify(Array.isArray(entry?.keywords) ? entry.keywords : []),
      entry?.enabled === false ? 0 : 1,
      toMs(entry?.createdAt, now),
      toMs(entry?.updatedAt, now),
    );
    result.knowledgeEntries += 1;
  }

  const reminderTasks = Object.values(parsed.get("scheduled-reminders")?.tasks ?? {});
  const insertReminder = sharedDb.db.prepare(
    `INSERT INTO v3_scheduled_reminders (id, group_id, task_json, enabled, next_run_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, task_json = excluded.task_json,
       enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
  );
  for (const task of reminderTasks) {
    const id = String(task?.id ?? "").trim();
    const groupId = String(task?.groupId ?? "").trim();
    if (!id || !groupId) continue;
    insertReminder.run(id, groupId, JSON.stringify(task), task?.enabled === false ? 0 : 1, toMs(task?.nextRunAt, now), now);
    result.scheduledReminders += 1;
  }

  const dailyReport = parsed.get("daily-report");
  const rawMessageCutoff = now - RETENTION_MS;
  const insertDailyMessage = sharedDb.db.prepare(
    `INSERT INTO v3_daily_report_messages (group_id, day_key, user_id, user_name, text, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [dayKey, groupsByDay] of Object.entries(dailyReport?.days ?? {})) {
    for (const [groupId, messages] of Object.entries(groupsByDay ?? {})) {
      for (const message of Array.isArray(messages) ? messages : []) {
        const occurredAt = parseTimestamp(message?.timestamp);
        // A legacy report input is still raw member content.  Do not grant it a
        // new seven-day lifetime merely because the V3 cutover happened today.
        if (occurredAt === undefined) {
          result.invalidDailyReportMessages += 1;
          continue;
        }
        // Legacy daily-report records contain raw member content. Clamp a
        // future source timestamp to this import's receipt time so it cannot
        // extend the seven-day V3 retention window.
        const retainedOccurredAt = Math.min(occurredAt, now);
        if (retainedOccurredAt <= rawMessageCutoff) {
          result.expiredDailyReportMessages += 1;
          continue;
        }
        insertDailyMessage.run(
          String(groupId),
          String(dayKey),
          String(message?.userId ?? ""),
          String(message?.userName ?? message?.userId ?? "").slice(0, 60),
          String(message?.text ?? "").slice(0, 300),
          retainedOccurredAt,
        );
        result.dailyReportMessages += 1;
      }
    }
  }
  const upsertDailyRun = sharedDb.db.prepare(
    `INSERT INTO v3_daily_report_runs (group_id, last_sent_day, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at`,
  );
  for (const [groupId, dayKey] of Object.entries(dailyReport?.lastSentDateByGroup ?? {})) {
    upsertDailyRun.run(String(groupId), String(dayKey), now);
  }

  const holiday = parsed.get("holiday-countdown");
  const upsertHoliday = sharedDb.db.prepare(
    `INSERT INTO v3_holiday_countdown_runs (group_id, last_sent_day, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at`,
  );
  for (const [groupId, dayKey] of Object.entries(holiday?.lastSentDateByGroup ?? {})) {
    upsertHoliday.run(String(groupId), String(dayKey), now);
    result.holidayRuns += 1;
  }

  for (const task of Array.isArray(parsed.get("admin-tasks")?.tasks) ? parsed.get("admin-tasks").tasks : []) {
    const id = String(task?.id ?? "").trim();
    if (!id) continue;
    // Profile generation is a retired V3 capability. Its source record remains
    // encrypted in the rollback archive, but must never become a runnable V3
    // task or be surfaced by the retained task center.
    if (task?.type === "profile-generate") {
      result.retiredProfileTasks += 1;
      continue;
    }
    repository.saveDocument("admin-task", id, task, now);
    result.documents += 1;
  }
  for (const [id, status] of Object.entries(parsed.get("model-health-history")?.models ?? {})) {
    const key = String(id).trim();
    if (!key || !status || typeof status !== "object") continue;
    repository.saveDocument("model-health", key, status, now);
    result.documents += 1;
  }
  const operationLog = parsed.get("admin-operations");
  if (typeof operationLog === "string") {
    for (const [index, line] of operationLog.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && typeof entry === "object") {
          repository.saveDocument("admin-operation", `legacy-${String(index).padStart(8, "0")}`, entry, now + index);
          result.documents += 1;
        }
      } catch {
        // Legacy operation logs were append-only diagnostics. Invalid lines
        // remain in the encrypted archive but must not block V3 cutover.
      }
    }
  }
  const atmosphere = parsed.get("atmosphere");
  if (atmosphere !== undefined) {
    repository.saveDocument("atmosphere", "default", atmosphere, now);
    result.documents += 1;
  }

  repository.saveHuixianProfile(huixianProfile, "v3-migration");
  repository.saveCapabilityPolicy(defaultV3CapabilityPolicy(now), now);

  for (const source of sources) {
    if (source.exists) {
      repository.recordImport({
        sourceKey: source.key,
        sha256: source.sha256,
        rowCount: countImportedRows(source.key, parsed.get(source.key), result),
        importerVersion: IMPORTER_VERSION,
        importedAt: now,
      });
    }
  }
  repository.recordRollbackArchive({
    id: archive.id,
    archivePath: archive.bundlePath,
    archiveSha256: archive.bundleSha256,
    createdAt: now,
    expiresAt: now + RETENTION_MS,
    manifest: archive.manifest,
  });

  // Existing RC conversation tables share the authoritative database, but
  // they are legacy conversations just like conversations.json/topics.json.
  // The encrypted pre-cutover database archive remains the only rollback
  // record; V3 must begin with no routable old context or pending old drafts.
  result.shortTermConversationCutoverMessageId = repository.cutoverShortTermConversation();

  // The maintenance timer is a safety net, not the first opportunity to
  // enforce V3 retention. Existing ingress rows predate this one-shot
  // migration, so prune them in the same transaction before the marker makes
  // SQLite the only runtime authority.
  result.initialRawRetention = repository.pruneRawMessageRetention(now - RETENTION_MS);
  repository.recordMaintenanceRun("v3-initial-retention", result.initialRawRetention, now);
  repository.markCutover(now);
  return result;
}

async function collectLegacySources() {
  const baseSources = [
    ["groups", path.join(configDir, "groups.json"), "json"],
    ["system-settings", path.join(dataDir, "system-settings.json"), "json"],
    ["group-memory", path.join(dataDir, "group-memory.json"), "json"],
    ["knowledge-base", path.join(dataDir, "knowledge-base.json"), "json"],
    ["scheduled-reminders", path.join(dataDir, "scheduled-reminders.json"), "json"],
    ["daily-report", path.join(dataDir, "daily-report-store.json"), "json"],
    ["holiday-countdown", path.join(dataDir, "holiday-countdown-store.json"), "json"],
    ["admin-tasks", path.join(dataDir, "admin-tasks.json"), "json"],
    ["model-health-history", path.join(dataDir, "model-health-history.json"), "json"],
    ["admin-operations", path.join(dataDir, "admin-operations.jsonl"), "text"],
    ["group-memory-candidates", path.join(dataDir, "group-memory-candidates.json"), "json"],
    ["daily-profile-review", path.join(dataDir, "daily-profile-review.json"), "json"],
    ["profile-records", path.join(dataDir, "profile-records.json"), "json"],
    ["conversations", path.join(dataDir, "conversations.json"), "json"],
    ["atmosphere", path.join(dataDir, "shared", "atmosphere.json"), "json"],
    ["topics", path.join(dataDir, "shared", "topics.json"), "json"],
  ];
  const sources = [];
  for (const [key, filePath, kind] of baseSources) {
    sources.push(await describeSource({ key, path: filePath, kind }));
  }
  const skillsDir = path.join(appRoot, "skills");
  for (const filePath of await collectFiles(skillsDir)) {
    const relative = path.relative(skillsDir, filePath).replaceAll("\\", "/");
    sources.push(await describeSource({ key: `legacy-skill:${relative}`, path: filePath, kind: "binary" }));
  }
  return sources;
}

async function describeSource(source) {
  if (!existsSync(source.path)) {
    return { ...source, exists: false, bytes: 0, sha256: "" };
  }
  const body = await readFile(source.path);
  return { ...source, exists: true, bytes: body.length, sha256: sha256(body) };
}

async function parseLegacySources(sources) {
  const parsed = new Map();
  for (const source of sources) {
    if (!source.exists || source.kind === "binary") continue;
    const body = await readFile(source.path, "utf8");
    if (source.kind === "json") {
      try {
        parsed.set(source.key, JSON.parse(stripBom(body)));
      } catch (error) {
        throw new Error(`Invalid legacy JSON in ${source.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      parsed.set(source.key, body);
    }
  }
  return parsed;
}

async function createEncryptedRollbackArchive({ sources, cipher, now }) {
  await mkdir(rollbackDir, { recursive: true, mode: 0o700 });
  await chmod(rollbackDir, 0o700);
  const id = `v3-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const bundlePath = path.join(rollbackDir, `${id}.legacy.enc`);
  const dbPathEncrypted = path.join(rollbackDir, `${id}.precutover-db.enc`);
  const dbVacuumPath = path.join(rollbackDir, `.${id}.precutover.db`);
  try {
    const files = [];
    for (const source of sources.filter((item) => item.exists)) {
      files.push({
        key: source.key,
        path: path.relative(appRoot, source.path).replaceAll("\\", "/"),
        sha256: source.sha256,
        body: (await readFile(source.path)).toString("base64"),
      });
    }
    const bundle = JSON.stringify({ version: 1, createdAt: new Date(now).toISOString(), files });
    await writeRestricted(bundlePath, cipher.encrypt("rollback-legacy-bundle", bundle));

    const database = new DatabaseSync(dbPath);
    try {
      database.exec(`VACUUM INTO '${escapeSqlString(dbVacuumPath)}'`);
    } finally {
      database.close();
    }
    try {
      const databaseBody = await readFile(dbVacuumPath);
      await writeRestricted(dbPathEncrypted, cipher.encrypt("rollback-precutover-db", databaseBody.toString("base64")));
    } finally {
      await rm(dbVacuumPath, { force: true });
    }
    const manifest = {
      version: 1,
      relatedPaths: [dbPathEncrypted],
      sourceFiles: files.map(({ key, path: sourcePath, sha256: sourceSha256 }) => ({ key, path: sourcePath, sha256: sourceSha256 })),
      expiresAt: new Date(now + RETENTION_MS).toISOString(),
    };
    return {
      id,
      bundlePath,
      bundleSha256: sha256(await readFile(bundlePath)),
      manifest,
      publicManifest: {
        id,
        path: path.relative(appRoot, bundlePath).replaceAll("\\", "/"),
        expiresAt: manifest.expiresAt,
        sourceFileCount: files.length,
      },
    };
  } catch (error) {
    await removeArchivePaths([bundlePath, dbPathEncrypted, dbVacuumPath]);
    throw error;
  }
}

async function removeUntrackedRollbackArchive(archive) {
  const manifest = archive.manifest && typeof archive.manifest === "object" ? archive.manifest : {};
  const relatedPaths = Array.isArray(manifest.relatedPaths) ? manifest.relatedPaths : [];
  await removeArchivePaths([archive.bundlePath, ...relatedPaths]);
}

async function removeArchivePaths(paths) {
  for (const value of new Set(paths.filter((candidate) => typeof candidate === "string"))) {
    const archivePath = path.resolve(value);
    ensurePathWithin(rollbackDir, archivePath);
    await rm(archivePath, { force: true });
  }
}

async function removeLegacyRuntimeFiles(sources) {
  for (const source of sources.filter((item) => item.exists && !item.key.startsWith("legacy-skill:"))) {
    ensurePathWithin(appRoot, source.path);
    await rm(source.path, { force: true });
  }
  const skillsDir = path.join(appRoot, "skills");
  if (existsSync(skillsDir)) {
    ensurePathWithin(appRoot, skillsDir);
    await rm(skillsDir, { recursive: true, force: true });
  }
}

function normalizeGroupsFile(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.groups)) {
    return { groups: [] };
  }
  // QQ-number admin lists are retained only inside the encrypted rollback
  // archive. They must not cross the V3 cutover into live SQLite state.
  return {
    groups: value.groups.map((group) => {
      if (!group || typeof group !== "object") return group;
      const { switcherUserIds: _retiredQqAdmins, ...safeGroup } = group;
      return safeGroup;
    }),
  };
}

function isHuixianProfile(value) {
  return value && typeof value === "object" && value.id === "huixian" && typeof value.name === "string" &&
    typeof value.systemPrompt === "string" && Array.isArray(value.styleRules) && Array.isArray(value.knowledge);
}

async function loadReleaseHuixianProfile() {
  if (!existsSync(huixianProfilePath)) {
    throw new Error(`V3 Huixian profile asset is missing: ${huixianProfilePath}`);
  }
  const profile = await readJson(huixianProfilePath);
  if (!isHuixianProfile(profile)) {
    throw new Error("assets/huixian-profile.json must define the single huixian character profile.");
  }
  const { normalizeHuixianCharacterProfile } = await loadCompiledProfileModules();
  try {
    return normalizeHuixianCharacterProfile(profile);
  } catch (error) {
    throw new Error(`Invalid Huixian profile asset: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function countImportedRows(sourceKey, value, result) {
  if (sourceKey === "groups") return result.groups;
  if (sourceKey === "group-memory") return result.explicitMemories;
  if (sourceKey === "knowledge-base") return result.knowledgeEntries;
  if (sourceKey === "scheduled-reminders") return result.scheduledReminders;
  if (sourceKey === "daily-report") return result.dailyReportMessages;
  if (sourceKey === "holiday-countdown") return result.holidayRuns;
  if (sourceKey === "admin-tasks") {
    const total = Array.isArray(value?.tasks) ? value.tasks.length : 0;
    return Math.max(0, total - result.retiredProfileTasks);
  }
  if (sourceKey === "system-settings") return result.settings ? 1 : 0;
  return value === undefined ? 0 : 1;
}

function countBlockingOutboxRows(database) {
  if (!tableExists(database, "outbox")) return 0;
  const columns = new Set(database.prepare("PRAGMA table_info(outbox)").all().map((row) => row.name));
  if (!columns.has("status")) return Number(database.prepare("SELECT COUNT(*) AS n FROM outbox").get().n ?? 0);
  return Number(database.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' OR status = 'sending' OR (status = 'failed' AND retry_after IS NOT NULL)",
  ).get().n ?? 0);
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function inspectCutoverState() {
  if (!existsSync(dbPath)) return "absent";
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!tableExists(database, "v3_state_meta")) return "absent";
    const row = database.prepare(
      "SELECT meta_value FROM v3_state_meta WHERE meta_key = 'state_cutover'",
    ).get();
    return typeof row?.meta_value === "string" ? row.meta_value : "absent";
  } finally {
    database.close();
  }
}

function toMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function writeRestricted(targetPath, body) {
  await writeFile(targetPath, body, { encoding: "utf8", mode: 0o600 });
  await chmod(targetPath, 0o600);
}

async function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(child));
    } else if (entry.isFile()) {
      result.push(child);
    }
  }
  return result;
}

function ensurePathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (path.resolve(candidate) === path.resolve(root)) {
      throw new Error(`Refusing broad destructive path: ${candidate}`);
    }
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes V3 state root: ${candidate}`);
    }
  }
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function requireStateEncryptionKey() {
  const key = process.env.UBOT_STATE_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required for V3 state migration.");
  return key;
}

async function readJson(filePath) {
  return JSON.parse(stripBom(await readFile(filePath, "utf8")));
}

async function loadCompiledStateModules() {
  try {
    return await import(new URL("../dist/shared/sqlite.js", import.meta.url));
  } catch (error) {
    throw new Error(`V3 migration requires a built release (dist/shared/sqlite.js): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadCompiledRepositoryModules() {
  try {
    return await import(new URL("../dist/services/v3-state-repository.js", import.meta.url));
  } catch (error) {
    throw new Error(`V3 migration requires a built release (dist/services/v3-state-repository.js): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadCompiledProfileModules() {
  try {
    return await import(new URL("../dist/services/skill-service.js", import.meta.url));
  } catch (error) {
    throw new Error(`V3 migration requires a built release (dist/services/skill-service.js): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadCompiledHtmlPreviewModules() {
  try {
    return await import(new URL("../dist/services/html-preview-service.js", import.meta.url));
  } catch (error) {
    throw new Error(`V3 maintenance requires a built release (dist/services/html-preview-service.js): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeReport(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = { execute: false, maintenance: false, allowExistingCutover: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") parsed.execute = true;
    else if (arg === "--maintenance") parsed.maintenance = true;
    else if (arg === "--allow-existing-cutover") parsed.allowExistingCutover = true;
    else if (arg === "--app-root") parsed.appRoot = argv[++index];
    else if (arg === "--data-dir") parsed.dataDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/migrate-v3-state.mjs [--app-root <path>] [--data-dir <path>] [--execute] [--allow-existing-cutover]\n" +
        "       node scripts/migrate-v3-state.mjs --maintenance --execute\n" +
        "The default cutover is a read-only preflight. --allow-existing-cutover upgrades an already cut-over SQLite database without reading legacy JSON. Stop all UBot services and drain retryable outbox rows before the first --execute.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
