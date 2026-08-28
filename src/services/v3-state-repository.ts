import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import type { GroupBotConfig, GroupsConfigFile, SkillDefinition, SystemSettings } from "../types.js";
import type { GroupMemory, KnowledgeBaseEntry, KnowledgePack, ScheduledReminderTask } from "../types.js";
import type { SharedDb } from "../shared/sqlite.js";
import { validateV3CapabilityPolicy } from "./capability-policy-service.js";

const CIPHER_VERSION = "v1";
const STATE_CUTOVER_META_KEY = "state_cutover";
const STATE_CUTOVER_VERSION = "v3";
const HUIXIAN_RELEASE_PROFILE_REVISION_META_KEY = "huixian_release_profile_revision";

export interface V3CapabilityPolicy {
  version: number;
  enabledCapabilities: string[];
  providerCapabilities?: Record<string, string[]>;
  updatedAt: string;
}

export interface V3RollbackArchive {
  id: string;
  archivePath: string;
  archiveSha256: string;
  createdAt: number;
  expiresAt: number;
  manifest: unknown;
}

export interface V3DailyReportMessage {
  groupId: string;
  dayKey: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

/** A rendered daily report retained after the raw source messages expire. */
export interface V3DailyReportOutput {
  groupId: string;
  dayKey: string;
  renderedText: string;
  sentAt: string;
}

/**
 * A release-owned profile change is deliberately distinct from an admin edit.
 * The marker lets a deployment make a one-time corrective revision without
 * overwriting the active profile on every subsequent restart or redeploy.
 */
export interface HuixianReleaseProfileRevisionInput {
  revision: string;
  profile: SkillDefinition;
  changedBy: string;
  /** A later release must explicitly name the revision it is allowed to replace. */
  replaceRevision?: string;
  now?: number;
}

export interface HuixianReleaseProfileRevisionResult {
  applied: boolean;
  /** The revision currently recorded as the release-owned profile baseline. */
  revision: string;
  previousRevision?: string;
}

interface V3MemoryRow {
  id: string;
  group_id: string;
  type: string;
  subject_user_id: string | null;
  title: string;
  content: string;
  confidence: number;
  source: string;
  enabled: number;
  evidence_json: string | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

interface V3KnowledgeRow {
  id: string;
  group_id: string;
  title: string;
  question: string;
  answer: string;
  keywords_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface V3KnowledgePackRow {
  group_id: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface V3DailyMessageRow {
  group_id: string;
  day_key: string;
  user_id: string;
  user_name: string;
  text: string;
  occurred_at: number;
}

interface V3DailyReportOutputRow {
  group_id: string;
  day_key: string;
  rendered_text: string;
  sent_at: number;
}

export interface V3StateRepositoryOptions {
  /** Required when encrypted state is read or written after the V3 cutover. */
  stateEncryptionKey?: string;
}

/**
 * The V3 state boundary.  JSON is intentionally never read here: callers use
 * this repository after the one-shot migrator has recorded the cutover marker.
 *
 * We retain document payloads for mature feature settings where the existing
 * validation model is already comprehensive, while high-content domains have
 * dedicated tables.  This gives SQLite transactional ownership without an
 * unsafe, broad schema rewrite of every legacy setting at once.
 */
export class V3StateRepository {
  private readonly cipher?: StateCipher;
  private transactionDepth = 0;

  constructor(
    readonly sharedDb: SharedDb,
    options: V3StateRepositoryOptions = {},
  ) {
    this.cipher = options.stateEncryptionKey
      ? new StateCipher(options.stateEncryptionKey)
      : undefined;
  }

  isCutover(): boolean {
    return this.getMeta(STATE_CUTOVER_META_KEY) === STATE_CUTOVER_VERSION;
  }

  requireCutover(): void {
    if (!this.isCutover()) {
      throw new Error("v3_state_cutover_required");
    }
    if (!this.cipher) {
      throw new Error("UBOT_STATE_ENCRYPTION_KEY is required after the V3 state cutover.");
    }
  }

  markCutover(now = Date.now()): void {
    this.setMeta(STATE_CUTOVER_META_KEY, STATE_CUTOVER_VERSION, now);
  }

  /**
   * V3 deliberately starts a new short-term conversation epoch. RC records
   * already in the shared SQLite ledger are as retired as conversations.json:
   * they stay only in the encrypted pre-cutover database archive and must not
   * be routable by the V3 worker after the state marker is committed.
   */
  cutoverShortTermConversation(cutoverMessageId?: number): number {
    return this.withImmediateTransaction(() => {
      const row = this.sharedDb.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages").get() as { id: number };
      const cutover = cutoverMessageId ?? row.id;
      this.sharedDb.db.prepare(
        `UPDATE outbox
            SET status = CASE WHEN status = 'sent' THEN status ELSE 'cancelled' END,
                retry_after = NULL, topic_id = NULL, branch_id = NULL,
                source_turn_id = NULL, turn_id = NULL, updated_at = ?`,
      ).run(Date.now());
      this.sharedDb.db.exec(`
        DELETE FROM conversation_message_routes;
        DELETE FROM conversation_message_context;
        DELETE FROM conversation_user_active_routes;
        DELETE FROM conversation_turns;
        DELETE FROM conversation_branches;
        DELETE FROM conversation_topics;
        DELETE FROM inflight;
        DELETE FROM bot_messages;
        DELETE FROM consumer_completed_messages;
      `);
      this.sharedDb.db.prepare(
        `INSERT INTO conversation_context_meta (key, value)
         VALUES ('cutover_message_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(cutover));
      return cutover;
    });
  }

  clearCutoverForTest(): void {
    this.sharedDb.db.prepare("DELETE FROM v3_state_meta WHERE meta_key = ?").run(STATE_CUTOVER_META_KEY);
  }

  getMeta(key: string): string | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT meta_value FROM v3_state_meta WHERE meta_key = ?")
      .get(key) as { meta_value: string } | undefined;
    return row?.meta_value;
  }

  setMeta(key: string, value: string, now = Date.now()): void {
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_state_meta (meta_key, meta_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  getGroups(): GroupsConfigFile {
    const rows = this.sharedDb.db
      .prepare("SELECT config_json FROM v3_groups ORDER BY group_id")
      .all() as Array<{ config_json: string }>;
    return {
      groups: rows.flatMap((row) => {
        const parsed = parseJson<GroupBotConfig>(row.config_json);
        return parsed ? [retireLegacyQqAdminFields(parsed)] : [];
      }),
    };
  }

  saveGroups(input: GroupsConfigFile, now = Date.now()): void {
    const groups = (input.groups ?? []).map((group) => retireLegacyQqAdminFields(group));
    this.withImmediateTransaction(() => {
      const knownIds = new Set(groups.map((group) => String(group.groupId).trim()).filter(Boolean));
      if (knownIds.size === 0) {
        this.sharedDb.db.exec("DELETE FROM v3_groups");
      } else {
        const placeholders = [...knownIds].map(() => "?").join(", ");
        this.sharedDb.db.prepare(`DELETE FROM v3_groups WHERE group_id NOT IN (${placeholders})`).run(...knownIds);
      }
      const upsert = this.sharedDb.db.prepare(
        `INSERT INTO v3_groups (group_id, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      );
      for (const group of groups) {
        const groupId = String(group.groupId).trim();
        if (groupId) {
          upsert.run(groupId, JSON.stringify(group), now);
        }
      }
      // QQ-number super-admins were a V1/V2 authorization mechanism. V3
      // admin authority is held only by SQLite accounts and group grants.
      this.deleteDocument("group-control", "default");
    });
  }

  getGroup(groupId: string): GroupBotConfig | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT config_json FROM v3_groups WHERE group_id = ?")
      .get(groupId) as { config_json: string } | undefined;
    const group = row ? parseJson<GroupBotConfig>(row.config_json) : undefined;
    return group ? retireLegacyQqAdminFields(group) : undefined;
  }

  saveGroup(group: GroupBotConfig, now = Date.now()): void {
    const safeGroup = retireLegacyQqAdminFields(group);
    const groupId = String(safeGroup.groupId).trim();
    if (!groupId) throw new Error("invalid_v3_group_id");
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_groups (group_id, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      )
      .run(groupId, JSON.stringify(safeGroup), now);
  }

  /**
   * Removes authority from legacy QQ-number admin fields without consulting
   * any JSON source. This is used by an additive upgrade on installations
   * that had already completed the one-way V3 cutover before this retirement.
   */
  retireLegacyQqAdministration(now = Date.now()): { groupsCleared: number; controlRemoved: boolean } {
    return this.withImmediateTransaction(() => {
      const rows = this.sharedDb.db.prepare(
        "SELECT group_id, config_json FROM v3_groups ORDER BY group_id",
      ).all() as Array<{ group_id: string; config_json: string }>;
      const update = this.sharedDb.db.prepare(
        "UPDATE v3_groups SET config_json = ?, updated_at = ? WHERE group_id = ?",
      );
      let groupsCleared = 0;
      for (const row of rows) {
        const group = parseJson<GroupBotConfig>(row.config_json);
        if (!group || !Array.isArray(group.switcherUserIds) || group.switcherUserIds.length === 0) {
          continue;
        }
        update.run(JSON.stringify(retireLegacyQqAdminFields(group)), now, row.group_id);
        groupsCleared += 1;
      }
      const controlRemoved = this.deleteDocument("group-control", "default");
      return { groupsCleared, controlRemoved };
    });
  }

  getSystemSettings<T extends SystemSettings = SystemSettings>(): T | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT settings_json FROM v3_system_settings WHERE settings_key = 'default'")
      .get() as { settings_json: string } | undefined;
    const settings = row ? parseJson<T>(row.settings_json) : undefined;
    if (!settings) return undefined;
    return this.rehydrateSystemSettingsSecrets(settings);
  }

  saveSystemSettings(settings: SystemSettings, now = Date.now()): void {
    const safe = removeRetiredSystemSettingsFields(settings);
    const secrets: Array<[string, string]> = [];
    // Shared admin and group-admin credentials are deliberately not a V3
    // runtime secret.  The migrator places their legacy JSON in the encrypted
    // seven-day rollback archive; keeping a second copy here would leave a
    // retired login path available to a future accidental caller.
    safe.models = safe.models.map((model) => {
      if (model.apiKey) {
        secrets.push([`model:${model.id}:api_key`, model.apiKey]);
        const { apiKey: _apiKey, ...withoutKey } = model;
        return { ...withoutKey, hasApiKey: true };
      }
      return model;
    });

    if (secrets.length > 0 && !this.cipher) {
      throw new Error("UBOT_STATE_ENCRYPTION_KEY is required to store V3 secrets.");
    }

    this.withImmediateTransaction(() => {
      this.sharedDb.db
        .prepare(
          `INSERT INTO v3_system_settings (settings_key, settings_json, updated_at)
           VALUES ('default', ?, ?)
           ON CONFLICT(settings_key) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(safe), now);
      this.sharedDb.db.prepare(
        "DELETE FROM v3_system_secrets WHERE secret_key IN ('legacy_admin_secret_hash', 'legacy_group_admin_secret_hash')",
      ).run();
      const saveSecret = this.sharedDb.db.prepare(
        `INSERT INTO v3_system_secrets (secret_key, ciphertext, key_version, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(secret_key) DO UPDATE SET ciphertext = excluded.ciphertext, key_version = excluded.key_version, updated_at = excluded.updated_at`,
      );
      for (const [key, value] of secrets) {
        saveSecret.run(key, this.encryptSecret(key, value), now);
      }
    });
  }

  getDocument<T>(documentType: string, documentKey: string, fallback: T): T {
    const row = this.sharedDb.db
      .prepare("SELECT document_json FROM v3_state_documents WHERE document_type = ? AND document_key = ?")
      .get(documentType, documentKey) as { document_json: string } | undefined;
    return row ? parseJson<T>(row.document_json) ?? structuredClone(fallback) : structuredClone(fallback);
  }

  saveDocument(documentType: string, documentKey: string, value: unknown, now = Date.now()): void {
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_state_documents (document_type, document_key, document_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(document_type, document_key) DO UPDATE SET
           document_json = excluded.document_json,
           updated_at = excluded.updated_at`,
      )
      .run(documentType, documentKey, JSON.stringify(value), now);
  }

  /**
   * Atomically changes a document-backed compatibility domain. This is used
   * for small retained operational documents while avoiding read/modify/write
   * races between the worker and admin processes.
   */
  updateDocument<T>(
    documentType: string,
    documentKey: string,
    fallback: T,
    update: (current: T) => T,
    now = Date.now(),
  ): T {
    return this.withImmediateTransaction(() => {
      const current = this.getDocument(documentType, documentKey, fallback);
      const next = update(structuredClone(current));
      this.saveDocument(documentType, documentKey, next, now);
      return structuredClone(next);
    });
  }

  deleteDocument(documentType: string, documentKey: string): boolean {
    const result = this.sharedDb.db
      .prepare("DELETE FROM v3_state_documents WHERE document_type = ? AND document_key = ?")
      .run(documentType, documentKey);
    return result.changes > 0;
  }

  listDocuments<T>(documentType: string): Array<{ key: string; value: T; updatedAt: number }> {
    return (this.sharedDb.db
      .prepare(
        `SELECT document_key, document_json, updated_at
           FROM v3_state_documents
          WHERE document_type = ?
          ORDER BY document_key`,
      )
      .all(documentType) as Array<{ document_key: string; document_json: string; updated_at: number }>)
      .flatMap((row) => {
        const value = parseJson<T>(row.document_json);
        return value === undefined ? [] : [{ key: row.document_key, value, updatedAt: row.updated_at }];
      });
  }

  getHuixianProfile(): Promise<SkillDefinition | undefined> {
    const row = this.sharedDb.db
      .prepare("SELECT profile_json FROM v3_character_profiles WHERE id = 'huixian' AND active = 1")
      .get() as { profile_json: string } | undefined;
    return Promise.resolve(row ? parseJson<SkillDefinition>(row.profile_json) : undefined);
  }

  async saveHuixianProfile(profile: SkillDefinition, changedBy = "system"): Promise<SkillDefinition> {
    if (profile.id !== "huixian") {
      throw new Error("v3_only_huixian_profile_supported");
    }
    const saved = structuredClone(profile) as SkillDefinition;
    const now = Date.now();
    this.withImmediateTransaction(() => {
      this.writeHuixianProfile(saved, changedBy, now);
    });
    return saved;
  }

  /**
   * Applies a packaged persona revision once. A different existing release
   * marker is preserved unless the caller names it explicitly, preventing an
   * accidental rollback from replacing a newer production persona.
   */
  applyHuixianReleaseProfile(
    input: HuixianReleaseProfileRevisionInput,
  ): HuixianReleaseProfileRevisionResult {
    const revision = normalizeReleaseProfileRevision(input.revision);
    const replaceRevision = input.replaceRevision === undefined
      ? undefined
      : normalizeReleaseProfileRevision(input.replaceRevision);
    if (input.profile.id !== "huixian") {
      throw new Error("v3_only_huixian_profile_supported");
    }
    const changedBy = String(input.changedBy ?? "").trim();
    if (!changedBy) {
      throw new Error("v3_huixian_release_changed_by_required");
    }
    const profile = structuredClone(input.profile) as SkillDefinition;
    const now = input.now ?? Date.now();

    return this.withImmediateTransaction(() => {
      const previousRevision = this.getMeta(HUIXIAN_RELEASE_PROFILE_REVISION_META_KEY);
      if (previousRevision === revision) {
        return { applied: false, revision };
      }
      if (previousRevision && previousRevision !== replaceRevision) {
        return { applied: false, revision: previousRevision, previousRevision };
      }

      this.writeHuixianProfile(profile, changedBy, now);
      this.setMeta(HUIXIAN_RELEASE_PROFILE_REVISION_META_KEY, revision, now);
      return { applied: true, revision, ...(previousRevision ? { previousRevision } : {}) };
    });
  }

  getCapabilityPolicy(): V3CapabilityPolicy | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT policy_json FROM v3_capability_policies WHERE policy_key = 'default'")
      .get() as { policy_json: string } | undefined;
    const policy = row ? parseJson<V3CapabilityPolicy>(row.policy_json) : undefined;
    if (policy !== undefined) {
      validateV3CapabilityPolicy(policy);
    }
    return policy;
  }

  saveCapabilityPolicy(policy: V3CapabilityPolicy, now = Date.now()): void {
    validateV3CapabilityPolicy(policy);
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_capability_policies (policy_key, policy_json, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(policy_key) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(policy), now);
  }

  listMemories(groupId?: string): GroupMemory[] {
    const rows = (groupId
      ? this.sharedDb.db.prepare(
        `SELECT id, group_id, type, subject_user_id, title, content, confidence, source,
                enabled, evidence_json, superseded_by, created_at, updated_at
           FROM v3_memories WHERE group_id = ? ORDER BY updated_at DESC, id DESC`,
      ).all(groupId)
      : this.sharedDb.db.prepare(
        `SELECT id, group_id, type, subject_user_id, title, content, confidence, source,
                enabled, evidence_json, superseded_by, created_at, updated_at
           FROM v3_memories ORDER BY updated_at DESC, id DESC`,
      ).all()) as unknown as Array<V3MemoryRow>;
    return rows.flatMap((row) => memoryFromRow(row) ? [memoryFromRow(row)!] : []);
  }

  getMemory(id: string): GroupMemory | undefined {
    const row = this.sharedDb.db.prepare(
      `SELECT id, group_id, type, subject_user_id, title, content, confidence, source,
              enabled, evidence_json, superseded_by, created_at, updated_at
         FROM v3_memories WHERE id = ?`,
    ).get(id) as V3MemoryRow | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  saveMemory(memory: GroupMemory): void {
    this.sharedDb.db.prepare(
      `INSERT INTO v3_memories
         (id, group_id, type, subject_user_id, title, content, confidence, source, enabled,
          evidence_json, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         group_id = excluded.group_id, type = excluded.type, subject_user_id = excluded.subject_user_id,
         title = excluded.title, content = excluded.content, confidence = excluded.confidence,
         source = excluded.source, enabled = excluded.enabled, evidence_json = excluded.evidence_json,
         superseded_by = excluded.superseded_by, updated_at = excluded.updated_at`,
    ).run(
      memory.id,
      memory.groupId,
      memory.type,
      memory.subjectUserId ?? null,
      memory.title,
      memory.content,
      memory.confidence,
      memory.source,
      memory.enabled ? 1 : 0,
      memory.evidence ? JSON.stringify(memory.evidence) : null,
      memory.supersededBy ?? null,
      toMs(memory.createdAt),
      toMs(memory.updatedAt),
    );
  }

  deleteMemory(id: string): boolean {
    return Number(this.sharedDb.db.prepare("DELETE FROM v3_memories WHERE id = ?").run(id).changes) > 0;
  }

  deleteMemories(ids: readonly string[]): number {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return 0;
    const placeholders = unique.map(() => "?").join(", ");
    return Number(this.sharedDb.db.prepare(`DELETE FROM v3_memories WHERE id IN (${placeholders})`).run(...unique).changes);
  }

  /**
   * Knowledge entries live in a durable, group-scoped pack.  The pack is the
   * policy boundary for retrieval while individual entries remain editable by
   * the existing FAQ APIs.
   */
  getKnowledgePack(groupId: string): KnowledgePack | undefined {
    const row = this.sharedDb.db
      .prepare(
        `SELECT group_id, enabled, created_at, updated_at
           FROM v3_knowledge_packs
          WHERE group_id = ?`,
      )
      .get(groupId.trim()) as V3KnowledgePackRow | undefined;
    return row ? knowledgePackFromRow(row) : undefined;
  }

  listKnowledgePacks(): KnowledgePack[] {
    return (this.sharedDb.db
      .prepare(
        `SELECT group_id, enabled, created_at, updated_at
           FROM v3_knowledge_packs
          ORDER BY group_id`,
      )
      .all() as unknown as Array<V3KnowledgePackRow>)
      .map(knowledgePackFromRow);
  }

  saveKnowledgePack(pack: KnowledgePack): KnowledgePack {
    const groupId = pack.groupId.trim();
    if (!groupId) throw new Error("invalid_v3_knowledge_pack_group_id");
    const createdAt = toMs(pack.createdAt);
    const updatedAt = Math.max(createdAt, toMs(pack.updatedAt));
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_knowledge_packs (group_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(groupId, pack.enabled ? 1 : 0, createdAt, updatedAt);
    return this.getKnowledgePack(groupId)!;
  }

  /** Idempotently provisions the default pack for a migrated or newly used group. */
  ensureKnowledgePack(groupId: string, now = Date.now()): KnowledgePack {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) throw new Error("invalid_v3_knowledge_pack_group_id");
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_knowledge_packs (group_id, enabled, created_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(group_id) DO NOTHING`,
      )
      .run(normalizedGroupId, now, now);
    return this.getKnowledgePack(normalizedGroupId)!;
  }

  isKnowledgePackEnabled(groupId: string): boolean {
    return this.getKnowledgePack(groupId)?.enabled === true;
  }

  listKnowledge(groupId?: string): KnowledgeBaseEntry[] {
    const rows = (groupId
      ? this.sharedDb.db.prepare(
        `SELECT id, group_id, title, question, answer, keywords_json, enabled, created_at, updated_at
           FROM v3_knowledge_entries WHERE group_id = ? ORDER BY updated_at DESC, id DESC`,
      ).all(groupId)
      : this.sharedDb.db.prepare(
        `SELECT id, group_id, title, question, answer, keywords_json, enabled, created_at, updated_at
           FROM v3_knowledge_entries ORDER BY updated_at DESC, id DESC`,
      ).all()) as unknown as Array<V3KnowledgeRow>;
    return rows.flatMap((row) => knowledgeFromRow(row) ? [knowledgeFromRow(row)!] : []);
  }

  getKnowledge(id: string): KnowledgeBaseEntry | undefined {
    const row = this.sharedDb.db.prepare(
      `SELECT id, group_id, title, question, answer, keywords_json, enabled, created_at, updated_at
         FROM v3_knowledge_entries WHERE id = ?`,
    ).get(id) as V3KnowledgeRow | undefined;
    return row ? knowledgeFromRow(row) : undefined;
  }

  saveKnowledge(entry: KnowledgeBaseEntry): void {
    const groupId = entry.groupId.trim();
    if (!groupId) throw new Error("invalid_v3_knowledge_group_id");
    const updatedAt = toMs(entry.updatedAt);
    this.withImmediateTransaction(() => {
      const existing = this.sharedDb.db
        .prepare("SELECT group_id FROM v3_knowledge_entries WHERE id = ?")
        .get(entry.id) as { group_id: string } | undefined;
      this.ensureKnowledgePack(groupId, updatedAt);
      this.sharedDb.db.prepare(
        `INSERT INTO v3_knowledge_entries
           (id, group_id, title, question, answer, keywords_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, title = excluded.title,
           question = excluded.question, answer = excluded.answer, keywords_json = excluded.keywords_json,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      ).run(
        entry.id,
        groupId,
        entry.title,
        entry.question,
        entry.answer,
        JSON.stringify(entry.keywords),
        entry.enabled ? 1 : 0,
        toMs(entry.createdAt),
        updatedAt,
      );
      this.touchKnowledgePack(groupId, updatedAt);
      if (existing && existing.group_id !== groupId) {
        this.touchKnowledgePack(existing.group_id, updatedAt);
      }
    });
  }

  deleteKnowledge(id: string): boolean {
    return this.withImmediateTransaction(() => {
      const entry = this.sharedDb.db
        .prepare("SELECT group_id FROM v3_knowledge_entries WHERE id = ?")
        .get(id) as { group_id: string } | undefined;
      if (!entry) return false;
      const deleted = Number(this.sharedDb.db.prepare("DELETE FROM v3_knowledge_entries WHERE id = ?").run(id).changes) > 0;
      if (deleted) this.touchKnowledgePack(entry.group_id, Date.now());
      return deleted;
    });
  }

  listScheduledReminders(groupId?: string, includeDisabled = false): ScheduledReminderTask[] {
    const rows = (groupId
      ? this.sharedDb.db.prepare(
        `SELECT task_json FROM v3_scheduled_reminders
          WHERE group_id = ? ${includeDisabled ? "" : "AND enabled = 1"}
          ORDER BY next_run_at, id`,
      ).all(groupId)
      : this.sharedDb.db.prepare(
        `SELECT task_json FROM v3_scheduled_reminders
          ${includeDisabled ? "" : "WHERE enabled = 1"}
          ORDER BY next_run_at, id`,
      ).all()) as Array<{ task_json: string }>;
    return rows.flatMap((row) => parseJson<ScheduledReminderTask>(row.task_json) ? [parseJson<ScheduledReminderTask>(row.task_json)!] : []);
  }

  getScheduledReminder(id: string): ScheduledReminderTask | undefined {
    const row = this.sharedDb.db.prepare("SELECT task_json FROM v3_scheduled_reminders WHERE id = ?").get(id) as { task_json: string } | undefined;
    return row ? parseJson<ScheduledReminderTask>(row.task_json) : undefined;
  }

  saveScheduledReminder(task: ScheduledReminderTask, leaseToken?: string | null, leaseExpiresAt?: number | null): void {
    this.sharedDb.db.prepare(
      `INSERT INTO v3_scheduled_reminders
         (id, group_id, task_json, enabled, next_run_at, lease_token, lease_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, task_json = excluded.task_json,
         enabled = excluded.enabled, next_run_at = excluded.next_run_at, lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at`,
    ).run(
      task.id,
      task.groupId,
      JSON.stringify(task),
      task.enabled ? 1 : 0,
      toMs(task.nextRunAt),
      leaseToken ?? null,
      leaseExpiresAt ?? null,
      Date.now(),
    );
  }

  deleteScheduledReminder(id: string, groupId?: string): boolean {
    const result = groupId
      ? this.sharedDb.db.prepare("DELETE FROM v3_scheduled_reminders WHERE id = ? AND group_id = ?").run(id, groupId)
      : this.sharedDb.db.prepare("DELETE FROM v3_scheduled_reminders WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  claimDueScheduledReminders(now = Date.now(), leaseMs = 120_000): Array<{ task: ScheduledReminderTask; leaseToken: string }> {
    const leaseExpiresAt = now + leaseMs;
    return this.withImmediateTransaction(() => {
      const candidates = this.sharedDb.db.prepare(
        `SELECT id, task_json FROM v3_scheduled_reminders
          WHERE enabled = 1 AND next_run_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at < ?)
          ORDER BY next_run_at, id`,
      ).all(now, now) as Array<{ id: string; task_json: string }>;
      const claim = this.sharedDb.db.prepare(
        `UPDATE v3_scheduled_reminders
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND enabled = 1 AND next_run_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      );
      const claimed: Array<{ task: ScheduledReminderTask; leaseToken: string }> = [];
      for (const candidate of candidates) {
        const task = parseJson<ScheduledReminderTask>(candidate.task_json);
        if (!task) continue;
        const leaseToken = randomBytes(18).toString("base64url");
        if (Number(claim.run(leaseToken, leaseExpiresAt, now, candidate.id, now, now).changes) === 1) {
          claimed.push({ task, leaseToken });
        }
      }
      return claimed;
    });
  }

  finalizeScheduledReminder(task: ScheduledReminderTask, leaseToken: string | undefined): boolean {
    const result = leaseToken
      ? this.sharedDb.db.prepare(
        `UPDATE v3_scheduled_reminders
            SET task_json = ?, enabled = ?, next_run_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND lease_token = ?`,
      ).run(JSON.stringify(task), task.enabled ? 1 : 0, toMs(task.nextRunAt), Date.now(), task.id, leaseToken)
      : this.sharedDb.db.prepare(
        `UPDATE v3_scheduled_reminders
            SET task_json = ?, enabled = ?, next_run_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify(task), task.enabled ? 1 : 0, toMs(task.nextRunAt), Date.now(), task.id);
    return Number(result.changes) === 1;
  }

  releaseScheduledReminderLease(id: string, leaseToken: string): void {
    this.sharedDb.db.prepare(
      "UPDATE v3_scheduled_reminders SET lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?",
    ).run(Date.now(), id, leaseToken);
  }

  appendDailyReportMessage(record: V3DailyReportMessage): void {
    // Daily-report input is raw member content. Its timestamp must not be
    // allowed to lie in the future and extend the seven-day retention window.
    const occurredAt = Math.min(toMs(record.timestamp), Date.now());
    this.sharedDb.db.prepare(
      `INSERT INTO v3_daily_report_messages (group_id, day_key, user_id, user_name, text, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(record.groupId, record.dayKey, record.userId, record.userName, record.text, occurredAt);
  }

  getDailyReportMessages(groupId: string, dayKey: string): V3DailyReportMessage[] {
    return (this.sharedDb.db.prepare(
      `SELECT group_id, day_key, user_id, user_name, text, occurred_at
         FROM v3_daily_report_messages WHERE group_id = ? AND day_key = ? ORDER BY occurred_at, id`,
    ).all(groupId, dayKey) as unknown as Array<V3DailyMessageRow>).map((row) => ({
      groupId: row.group_id,
      dayKey: row.day_key,
      userId: row.user_id,
      userName: row.user_name,
      text: row.text,
      timestamp: new Date(row.occurred_at).toISOString(),
    }));
  }

  getDailyReportLastSent(groupId: string): string | undefined {
    const row = this.sharedDb.db.prepare("SELECT last_sent_day FROM v3_daily_report_runs WHERE group_id = ?").get(groupId) as { last_sent_day: string } | undefined;
    return row?.last_sent_day;
  }

  getDailyReportOutput(groupId: string, dayKey: string): V3DailyReportOutput | undefined {
    const row = this.sharedDb.db.prepare(
      `SELECT group_id, day_key, rendered_text, sent_at
         FROM v3_daily_report_outputs WHERE group_id = ? AND day_key = ?`,
    ).get(groupId, dayKey) as V3DailyReportOutputRow | undefined;
    return row
      ? {
          groupId: row.group_id,
          dayKey: row.day_key,
          renderedText: row.rendered_text,
          sentAt: new Date(row.sent_at).toISOString(),
        }
      : undefined;
  }

  saveDailyReportOutput(output: V3DailyReportOutput): void {
    if (!output.renderedText.trim()) {
      throw new Error("v3_daily_report_output_empty");
    }
    this.sharedDb.db.prepare(
      `INSERT INTO v3_daily_report_outputs (group_id, day_key, rendered_text, sent_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, day_key) DO UPDATE SET
         rendered_text = excluded.rendered_text,
         sent_at = excluded.sent_at`,
    ).run(output.groupId, output.dayKey, output.renderedText, toMs(output.sentAt));
  }

  markDailyReportSent(
    groupId: string,
    dayKey: string,
    now = Date.now(),
    renderedText?: string,
  ): void {
    this.withImmediateTransaction(() => {
      this.sharedDb.db.prepare(
        `INSERT INTO v3_daily_report_runs (group_id, last_sent_day, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at`,
      ).run(groupId, dayKey, now);
      if (renderedText !== undefined) {
        this.saveDailyReportOutput({
          groupId,
          dayKey,
          renderedText,
          sentAt: new Date(now).toISOString(),
        });
      }
    });
  }

  clearDailyReportMessages(): void {
    this.sharedDb.db.exec("DELETE FROM v3_daily_report_messages");
  }

  getHolidayCountdownLastSent(groupId: string): string | undefined {
    const row = this.sharedDb.db.prepare("SELECT last_sent_day FROM v3_holiday_countdown_runs WHERE group_id = ?").get(groupId) as { last_sent_day: string } | undefined;
    return row?.last_sent_day;
  }

  markHolidayCountdownSent(groupId: string, dayKey: string, now = Date.now()): void {
    this.sharedDb.db.prepare(
      `INSERT INTO v3_holiday_countdown_runs (group_id, last_sent_day, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET last_sent_day = excluded.last_sent_day, updated_at = excluded.updated_at`,
    ).run(groupId, dayKey, now);
  }

  recordImport(input: { sourceKey: string; sha256: string; rowCount: number; importerVersion: string; importedAt?: number }): void {
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_state_imports (source_key, source_sha256, row_count, imported_at, importer_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           source_sha256 = excluded.source_sha256,
           row_count = excluded.row_count,
           imported_at = excluded.imported_at,
           importer_version = excluded.importer_version`,
      )
      .run(input.sourceKey, input.sha256, input.rowCount, input.importedAt ?? Date.now(), input.importerVersion);
  }

  getImport(sourceKey: string): { sourceSha256: string; rowCount: number; importedAt: number; importerVersion: string } | undefined {
    const row = this.sharedDb.db
      .prepare(
        `SELECT source_sha256, row_count, imported_at, importer_version
           FROM v3_state_imports WHERE source_key = ?`,
      )
      .get(sourceKey) as {
        source_sha256: string;
        row_count: number;
        imported_at: number;
        importer_version: string;
      } | undefined;
    return row && {
      sourceSha256: row.source_sha256,
      rowCount: row.row_count,
      importedAt: row.imported_at,
      importerVersion: row.importer_version,
    };
  }

  recordRollbackArchive(archive: V3RollbackArchive): void {
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_rollback_archives
           (id, archive_path, archive_sha256, created_at, expires_at, manifest_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           archive_path = excluded.archive_path,
           archive_sha256 = excluded.archive_sha256,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           manifest_json = excluded.manifest_json,
           purged_at = NULL`,
      )
      .run(
        archive.id,
        archive.archivePath,
        archive.archiveSha256,
        archive.createdAt,
        archive.expiresAt,
        JSON.stringify(archive.manifest),
      );
  }

  listExpiredRollbackArchives(now = Date.now()): V3RollbackArchive[] {
    return (this.sharedDb.db
      .prepare(
        `SELECT id, archive_path, archive_sha256, created_at, expires_at, manifest_json
           FROM v3_rollback_archives
          WHERE expires_at <= ? AND purged_at IS NULL`,
      )
      .all(now) as Array<{
        id: string;
        archive_path: string;
        archive_sha256: string;
        created_at: number;
        expires_at: number;
        manifest_json: string;
      }>)
      .map((row) => ({
        id: row.id,
        archivePath: row.archive_path,
        archiveSha256: row.archive_sha256,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        manifest: parseJson(row.manifest_json) ?? {},
      }));
  }

  markRollbackArchivePurged(id: string, now = Date.now()): void {
    this.sharedDb.db.prepare("UPDATE v3_rollback_archives SET purged_at = ? WHERE id = ?").run(now, id);
  }

  pruneRawMessageRetention(beforeMs: number): { messages: number; reportMessages: number; userTurns: number } {
    return this.withImmediateTransaction(() => {
      const reportMessages = this.sharedDb.db
        .prepare("DELETE FROM v3_daily_report_messages WHERE occurred_at <= ?")
        .run(beforeMs).changes;
      // Raw ingress content is retained from receipt time, not from the
      // externally supplied OneBot event timestamp. This prevents a future
      // source timestamp from extending the seven-day retention window.
      const sourceRows = this.sharedDb.db
        .prepare("SELECT id, group_id, msg_id FROM messages WHERE created_at <= ?")
        .all(beforeMs) as Array<{ id: number; group_id: string; msg_id: string }>;
      let routedUserTurns = 0;
      if (sourceRows.length > 0) {
        const placeholders = sourceRows.map(() => "?").join(", ");
        // Topic labels are derived directly from the first inbound message.
        // Keep the route structure for causal consistency, but remove those
        // lexical fragments as soon as the source message reaches retention.
        this.sharedDb.db
          .prepare(
            `UPDATE conversation_topics
                SET title = '[expired]', keywords_json = '[]'
              WHERE topic_id IN (
                SELECT DISTINCT topic_id FROM conversation_message_routes
                 WHERE source_row_id IN (${placeholders})
              )`,
          )
          .run(...sourceRows.map((row) => row.id));
        // A context write may happen later than the source event (for example
        // after a worker retry).  Clear those exact inbound anchors by source
        // identity rather than relying only on their own created_at value.
        const clearContext = this.sharedDb.db.prepare(
          "DELETE FROM conversation_message_context WHERE group_id = ? AND platform_message_id = ?",
        );
        for (const source of sourceRows) {
          clearContext.run(source.group_id, source.msg_id);
        }
        routedUserTurns = Number(this.sharedDb.db
          .prepare(
            `UPDATE conversation_turns
                SET content = '[expired]', source_message_id = NULL, platform_message_id = NULL, delivery_id = NULL
              WHERE role = 'user'
                AND id IN (
                  SELECT turn_id FROM conversation_message_routes
                   WHERE source_row_id IN (${placeholders})
                )
                AND (content <> '[expired]' OR source_message_id IS NOT NULL OR platform_message_id IS NOT NULL OR delivery_id IS NOT NULL)`,
          )
          .run(...sourceRows.map((row) => row.id)).changes);
        this.sharedDb.db.prepare(`DELETE FROM participation_decisions WHERE source_row_id IN (${placeholders})`).run(...sourceRows.map((row) => row.id));
        this.sharedDb.db.prepare(`DELETE FROM conversation_message_routes WHERE source_row_id IN (${placeholders})`).run(...sourceRows.map((row) => row.id));
      }
      const messages = this.sharedDb.db.prepare("DELETE FROM messages WHERE created_at <= ?").run(beforeMs).changes;
      // Reply routing must not retain old QQ message identifiers after the
      // underlying raw ingress row has expired.  This applies to assistant
      // anchors as well: references older than the retention window cannot be
      // safely used for a new reply route.
      this.sharedDb.db
        .prepare("DELETE FROM conversation_message_context WHERE created_at <= ?")
        .run(beforeMs);
      this.sharedDb.db.prepare("DELETE FROM bot_messages WHERE sent_at <= ?").run(beforeMs);
      const timeExpiredUserTurns = this.sharedDb.db
        .prepare(
          `UPDATE conversation_turns
              SET content = '[expired]', source_message_id = NULL, platform_message_id = NULL, delivery_id = NULL
            WHERE role = 'user'
              AND created_at <= ?
              AND (content <> '[expired]' OR source_message_id IS NOT NULL OR platform_message_id IS NOT NULL OR delivery_id IS NOT NULL)`,
        )
        .run(beforeMs).changes;
      return {
        messages: Number(messages),
        reportMessages: Number(reportMessages),
        userTurns: routedUserTurns + Number(timeExpiredUserTurns),
      };
    });
  }

  recordMaintenanceRun(taskName: string, detail: unknown, now = Date.now()): void {
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_maintenance_runs (task_name, started_at, completed_at, detail_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(taskName, now, now, JSON.stringify(detail));
  }

  /** Lets the one-shot migrator make all domain imports visible atomically. */
  runAtomically<T>(callback: () => T): T {
    return this.withImmediateTransaction(callback);
  }

  private rehydrateSystemSettingsSecrets<T extends SystemSettings>(settings: T): T {
    const hydrated = removeRetiredSystemSettingsFields(settings);
    hydrated.models = hydrated.models.map((model) => {
      const apiKey = this.decryptSecret(`model:${model.id}:api_key`);
      return apiKey ? { ...model, apiKey, hasApiKey: true } : model;
    });
    return hydrated as T;
  }

  private encryptSecret(purpose: string, value: string): string {
    if (!this.cipher) throw new Error("UBOT_STATE_ENCRYPTION_KEY is required to encrypt state.");
    return this.cipher.encrypt(purpose, value);
  }

  private decryptSecret(purpose: string): string | undefined {
    const row = this.sharedDb.db
      .prepare("SELECT ciphertext FROM v3_system_secrets WHERE secret_key = ?")
      .get(purpose) as { ciphertext: string } | undefined;
    if (!row) return undefined;
    if (!this.cipher) {
      throw new Error("UBOT_STATE_ENCRYPTION_KEY is required to read encrypted V3 state.");
    }
    return this.cipher.decrypt(purpose, row.ciphertext);
  }

  private touchKnowledgePack(groupId: string, now: number): void {
    this.sharedDb.db
      .prepare("UPDATE v3_knowledge_packs SET updated_at = ? WHERE group_id = ?")
      .run(now, groupId);
  }

  private writeHuixianProfile(profile: SkillDefinition, changedBy: string, now: number): void {
    this.sharedDb.db.prepare("UPDATE v3_character_profiles SET active = 0 WHERE active = 1 AND id <> 'huixian'").run();
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_character_profiles (id, name, profile_json, active, updated_at)
         VALUES ('huixian', ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, profile_json = excluded.profile_json, active = 1, updated_at = excluded.updated_at`,
      )
      .run(profile.name, JSON.stringify(profile), now);
    this.sharedDb.db
      .prepare(
        `INSERT INTO v3_character_profile_revisions (profile_id, profile_json, changed_at, changed_by)
         VALUES ('huixian', ?, ?, ?)`,
      )
      .run(JSON.stringify(profile), now, changedBy);
  }

  private withImmediateTransaction<T>(callback: () => T): T {
    if (this.transactionDepth > 0) {
      return callback();
    }
    this.sharedDb.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.sharedDb.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.sharedDb.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function normalizeReleaseProfileRevision(value: unknown): string {
  const revision = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(revision)) {
    throw new Error("invalid_v3_huixian_release_revision");
  }
  return revision;
}

/**
 * V3 deliberately has no shared-password, profile, candidate-memory, or
 * automatic-memory configuration.  Settings may still arrive from the
 * one-shot legacy importer, so enforce that boundary here as well as in the
 * HTTP API.  This keeps direct repository callers from reintroducing a
 * retired runtime switch through a JSON payload.
 */
function removeRetiredSystemSettingsFields<T extends SystemSettings>(settings: T): T {
  const safe = structuredClone(settings) as T & Record<string, unknown>;
  // The QQ-number administration command is not a V3 capability. Remove an
  // imported command record as well as the authorization fields so a future
  // runtime cannot accidentally make it configurable again.
  safe.commands = safe.commands.filter((command) => command.id !== "admin");
  for (const key of [
    "adminSecret",
    "groupAdminSecret",
    "adminSecretHash",
    "groupAdminSecretHash",
    "adminSecretConfigured",
    "groupAdminSecretConfigured",
    "profileSummaryMaxChars",
    "profileShortSummaryMaxChars",
    "dailyProfileReviewEnabled",
    "dailyProfileReviewTime",
    "memoryDedupEnabled",
    "memoryDedupTime",
    "memoryDedupSemanticTimeoutMinutes",
    "memoryCandidateConfidenceThreshold",
    "memoryAutoApproveConfidenceThreshold",
    "memoryUnattendedModeEnabled",
  ]) {
    delete safe[key];
  }
  const tokenCostControl = safe.tokenCostControl;
  if (tokenCostControl && typeof tokenCostControl === "object") {
    const controls = tokenCostControl as unknown as Record<string, unknown>;
    delete controls.memoryCandidateExtractionEnabled;
    delete controls.memoryCandidateNormalizationEnabled;
    delete controls.memorySemanticDedupEnabled;
    delete controls.dailyProfileReviewAiEnabled;
  }
  return safe;
}

/**
 * QQ-number administrators were deliberately replaced by authenticated V3
 * admin accounts. Keep the legacy shape so older JSON can be archived or
 * read before cutover, but never persist it as live V3 authorization state.
 */
function retireLegacyQqAdminFields(group: GroupBotConfig): GroupBotConfig {
  return {
    ...group,
    switcherUserIds: [],
  };
}

/** AES-256-GCM with a purpose-specific HKDF-derived key. */
export class StateCipher {
  private readonly masterKey: Buffer;

  constructor(encodedKey: string) {
    const normalized = encodedKey.trim();
    const decoded = /^[A-Fa-f0-9]{64}$/.test(normalized)
      ? Buffer.from(normalized, "hex")
      : Buffer.from(normalized, "base64url");
    if (
      decoded.length !== 32 ||
      (!/^[A-Fa-f0-9]{64}$/.test(normalized) && !/^[A-Za-z0-9_-]+={0,2}$/.test(normalized))
    ) {
      throw new Error("UBOT_STATE_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64url.");
    }
    this.masterKey = decoded;
  }

  encrypt(purpose: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.deriveKey(purpose), iv);
    cipher.setAAD(Buffer.from(`ubot-v3:${purpose}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [CIPHER_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(purpose: string, encoded: string): string {
    const [version, ivText, tagText, ciphertextText, extra] = encoded.split(".");
    if (version !== CIPHER_VERSION || !ivText || !tagText || !ciphertextText || extra) {
      throw new Error("invalid_v3_encrypted_state");
    }
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const ciphertext = Buffer.from(ciphertextText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid_v3_encrypted_state");
    const decipher = createDecipheriv("aes-256-gcm", this.deriveKey(purpose), iv);
    decipher.setAAD(Buffer.from(`ubot-v3:${purpose}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  fingerprint(): string {
    return createHash("sha256").update(this.masterKey).digest("hex").slice(0, 16);
  }

  private deriveKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync(
      "sha256",
      this.masterKey,
      Buffer.from("ubot-v3-state", "utf8"),
      Buffer.from(`purpose:${purpose}`, "utf8"),
      32,
    ));
  }
}

function parseJson<T = unknown>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function memoryFromRow(row: V3MemoryRow): GroupMemory | undefined {
  if (row.type !== "member_profile" && row.type !== "group_fact") return undefined;
  const evidence = row.evidence_json ? parseJson<GroupMemory["evidence"]>(row.evidence_json) : undefined;
  return {
    id: row.id,
    groupId: row.group_id,
    type: row.type,
    ...(row.subject_user_id ? { subjectUserId: row.subject_user_id } : {}),
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    source: row.source,
    enabled: row.enabled !== 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(evidence ? { evidence } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

function knowledgeFromRow(row: V3KnowledgeRow): KnowledgeBaseEntry | undefined {
  const keywords = parseJson<unknown>(row.keywords_json);
  if (!Array.isArray(keywords)) return undefined;
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    question: row.question,
    answer: row.answer,
    keywords: keywords.filter((keyword): keyword is string => typeof keyword === "string"),
    enabled: row.enabled !== 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function knowledgePackFromRow(row: V3KnowledgePackRow): KnowledgePack {
  return {
    groupId: row.group_id,
    enabled: row.enabled !== 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
