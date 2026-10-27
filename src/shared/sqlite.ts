import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { logWarn } from "../logger.js";

/**
 * SQLite-backed shared state for the multi-process bot.
 *
 * The process boundary is:
 *   [ingress] NapCat reverse WS → dedupe → write `messages` table
 *   [worker]  poll `messages` via `consumers` watermarks → reply → write `outbox`
 *   [admin]   read-only state (metrics, health)
 *
 * All tables live in a single WAL-mode database under `data/shared/bot-shared.db`
 * so each process can open its own connection without network.
 */

export interface IngressMessageRow {
  id: number;
  group_id: string;
  user_id: string;
  self_id: string;
  msg_id: string;
  msg_time: number;
  text: string;
  images_json: string;
  canonical_segments_json: string | null;
  sender_card: string | null;
  sender_nickname: string | null;
  sender_role: string | null;
  reply_to: string | null;
  verified_mention_user_ids_json: string;
  has_at_bot: number;
  is_bot_msg: number;
  created_at: number;
  context_topic_id: string | null;
  context_branch_id: string | null;
  context_route_reason: string | null;
  processable: number;
  drop_reason: string | null;
}

export interface InflightRow {
  key: string;
  task_id: string;
  started_at: number;
  cancel_token: string;
  cancel_requested: number;
  merged_reply: string | null;
}

export interface OutboxRow {
  id: number;
  group_id: string;
  reply_to: string | null;
  kind: string;
  text: string;
  forward_payload_json?: string | null;
  image_preview_id?: string | null;
  auto_recall_after_ms: number | null;
  auto_recall_deadline_ms: number | null;
  status: string;
  retry_after: number | null;
  attempts: number;
  topic_id: string | null;
  branch_id: string | null;
  source_turn_id: number | null;
  turn_id: number | null;
  delivery_id: string | null;
  platform_message_id: string | null;
  sent_at: number | null;
  updated_at: number | null;
  created_at: number;
}

export interface OutboxContext {
  topicId: string;
  branchId: string;
  sourceTurnId?: number;
  turnId?: number;
}

/** Result of atomically associating one generated-image request with Outbox. */
export interface GeneratedImageRequestOutbox {
  outboxId: number;
  /** False means a retry found the original durable delivery row. */
  created: boolean;
}

/**
 * A relative timing policy persisted with an outbox card until its real QQ
 * receipt is acknowledged. Times are measured from that receipt, not enqueue.
 */
export interface OutboxAutoRecallPolicy {
  afterMs: number;
  deadlineMs: number;
}

export type MessageRecallStatus =
  | "pending"
  | "sending"
  | "recalled"
  | "rejected"
  | "outcome_unknown"
  | "expired"
  | "unsupported"
  | "not_sent_expired";

/** Durable, non-content-bearing recall work for a bot-owned QQ message. */
export interface MessageRecallRow {
  id: number;
  outbox_id: number | null;
  group_id: string;
  platform_message_id: string;
  sent_at: number;
  due_at: number;
  deadline_at: number;
  status: MessageRecallStatus;
  attempts: number;
  claimed_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface InsertMessageRecallInput {
  outboxId?: number;
  groupId: string;
  platformMessageId: string;
  sentAtMs: number;
  policy: OutboxAutoRecallPolicy;
}

export interface RecentGroupMessageRow {
  group_id: string;
  user_id: string;
  msg_id: string;
  msg_time: number;
  text: string;
  images_json: string;
}

export interface RecentGroupEvidenceRow {
  role: "member" | "bot";
  message_id: string | null;
  user_id: string | null;
  text: string;
  images_json: string;
  sender_card: string | null;
  sender_nickname: string | null;
  sender_role: string | null;
  occurred_at: number;
}

export interface ParticipationDecisionRow {
  id: number;
  source_row_id: number;
  group_id: string;
  user_id: string;
  action: string;
  reason: string;
  score: number;
  policy_version: string;
  signals_json: string;
  created_at: number;
}

/** A completed, versioned SQLite schema migration. */
export interface SchemaMigrationRow {
  version: number;
  name: string;
  applied_at: number;
}

/**
 * All WorkerApp instances share this scope. A consumer key is a progress
 * cursor, not an execution owner, so it must never partition this lease.
 */
export const DEFAULT_MESSAGE_EXECUTION_SCOPE = "worker:message-handler";
export const MESSAGE_EXECUTION_LEASE_DEFAULT_MS = 120_000;

export interface MessageExecutionLeaseRecord {
  executionScope: string;
  sourceRowId: number;
  status: "running" | "completed";
  leaseToken?: string;
  leaseExpiresAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type MessageExecutionLeaseClaim =
  | {
    state: "claimed";
    lease: MessageExecutionLeaseRecord;
    leaseToken: string;
    /** True when an expired owner was replaced after a restart. */
    reclaimed: boolean;
  }
  | { state: "busy"; lease: MessageExecutionLeaseRecord }
  | { state: "completed"; lease: MessageExecutionLeaseRecord };

/**
 * Non-authoritative copy of the normalized groups.json document.
 *
 * This is deliberately a single snapshot rather than the runtime source of
 * truth. Phase 1 uses it to prove migrations and compare JSON/SQLite state
 * before any reader is switched to SQLite.
 */
export interface GroupConfigShadowSnapshotRow {
  source_key: string;
  snapshot_json: string;
  snapshot_hash: string;
  schema_version: number;
  group_count: number;
  synced_at: number;
}

/**
 * Sanitized, non-authoritative copy of system-settings.json. Secrets and
 * secret hashes are deliberately excluded before a row reaches this table.
 */
export interface SystemSettingsShadowSnapshotRow {
  source_key: string;
  snapshot_json: string;
  snapshot_hash: string;
  schema_version: number;
  synced_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  self_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  msg_time INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  sender_card TEXT,
  sender_nickname TEXT,
  sender_role TEXT,
  reply_to TEXT,
  verified_mention_user_ids_json TEXT NOT NULL DEFAULT '[]',
  has_at_bot INTEGER NOT NULL DEFAULT 0,
  is_bot_msg INTEGER NOT NULL DEFAULT 0,
  processable INTEGER NOT NULL DEFAULT 1,
  drop_reason TEXT,
  created_at INTEGER NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS participation_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_row_id INTEGER NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL NOT NULL,
  policy_version TEXT NOT NULL,
  signals_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participation_decisions_group_created
  ON participation_decisions (group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_topics (
  topic_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_topics_group_updated
  ON conversation_topics (group_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_branches (
  branch_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_turn_id INTEGER,
  head_turn_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_topic
  ON conversation_branches (topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_owner
  ON conversation_branches (group_id, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_turn_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  user_id TEXT,
  content TEXT NOT NULL,
  source_message_id TEXT,
  delivery_id TEXT,
  platform_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_branch
  ON conversation_turns (branch_id, id);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_parent
  ON conversation_turns (parent_turn_id);

CREATE TABLE IF NOT EXISTS conversation_message_context (
  group_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  turn_id INTEGER,
  direction TEXT NOT NULL CHECK (direction IN ('user', 'assistant')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, platform_message_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_message_context_branch
  ON conversation_message_context (branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_message_routes (
  source_row_id INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  route_reason TEXT NOT NULL,
  parent_turn_id INTEGER,
  turn_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_message_routes_group_source
  ON conversation_message_routes (group_id, source_message_id);

CREATE TABLE IF NOT EXISTS conversation_user_active_routes (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversation_context_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumers (
  key TEXT PRIMARY KEY,
  watermark_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consumer_completed_messages (
  consumer_key TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (consumer_key, message_id)
);

CREATE TABLE IF NOT EXISTS inflight (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  cancel_token TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  merged_reply TEXT
);

CREATE TABLE IF NOT EXISTS retracted (
  msg_key TEXT PRIMARY KEY,
  retracted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS msg_lock (
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  lock_owner TEXT NOT NULL,
  locked_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  reply_to TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  forward_payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_after INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  topic_id TEXT,
  branch_id TEXT,
  source_turn_id INTEGER,
  turn_id INTEGER,
  delivery_id TEXT,
  platform_message_id TEXT,
  sent_at INTEGER,
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_messages (
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);
`;

interface SqliteMigration {
  version: number;
  name: string;
  apply(db: DatabaseSync): void;
}

const GROUP_CONFIG_SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS group_config_shadow_snapshots (
  source_key TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  group_count INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
`;

const SYSTEM_SETTINGS_SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS system_settings_shadow_snapshots (
  source_key TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
`;

/**
 * V3 turns SQLite from an ingress ledger plus configuration shadow into the
 * authoritative application store.  The JSON-shaped columns deliberately
 * preserve the established validation contracts while each domain receives a
 * stable primary key, timestamps and indexes for cross-process writes.
 */
const V3_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS v3_groups (
  group_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_system_settings (
  settings_key TEXT PRIMARY KEY CHECK (settings_key = 'default'),
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_system_secrets (
  secret_key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_character_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_character_profiles_one_active
  ON v3_character_profiles (active) WHERE active = 1;
CREATE TABLE IF NOT EXISTS v3_character_profile_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL REFERENCES v3_character_profiles(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_v3_character_profile_revisions_profile
  ON v3_character_profile_revisions (profile_id, changed_at DESC);
CREATE TABLE IF NOT EXISTS v3_capability_policies (
  policy_key TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const V3_CONTENT_AND_SCHEDULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS v3_memories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('member_profile', 'group_fact')),
  subject_user_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_memories_group_updated
  ON v3_memories (group_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_v3_memories_subject
  ON v3_memories (group_id, subject_user_id, enabled);
CREATE TABLE IF NOT EXISTS v3_knowledge_packs (
  group_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_knowledge_entries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_knowledge_group_updated
  ON v3_knowledge_entries (group_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS v3_scheduled_reminders (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  task_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_scheduled_reminders_due
  ON v3_scheduled_reminders (enabled, next_run_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS v3_daily_report_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_daily_report_messages_group_day
  ON v3_daily_report_messages (group_id, day_key, occurred_at);
CREATE TABLE IF NOT EXISTS v3_daily_report_runs (
  group_id TEXT PRIMARY KEY,
  last_sent_day TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_holiday_countdown_runs (
  group_id TEXT PRIMARY KEY,
  last_sent_day TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_state_documents (
  document_type TEXT NOT NULL,
  document_key TEXT NOT NULL,
  document_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_type, document_key)
);
CREATE INDEX IF NOT EXISTS idx_v3_state_documents_type_updated
  ON v3_state_documents (document_type, updated_at DESC);
`;

const V3_ADMIN_AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','group_admin')),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_group_grants (
  account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,group_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_group_grants_group ON admin_group_grants(group_id);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reauth_verified_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip_hash TEXT,
  user_agent_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_account ON admin_sessions(account_id, expires_at);
CREATE TABLE IF NOT EXISTS admin_login_rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,key_hash)
);
CREATE TABLE IF NOT EXISTS admin_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('super_admin','group_admin')),
  group_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES admin_accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  accepted_account_id TEXT REFERENCES admin_accounts(id)
);
CREATE TABLE IF NOT EXISTS admin_auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  action TEXT NOT NULL,
  target_account_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_auth_audit_created ON admin_auth_audit(created_at DESC);
`;

const V3_RETENTION_AND_CUTOVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS v3_state_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_state_imports (
  source_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  importer_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_rollback_archives (
  id TEXT PRIMARY KEY,
  archive_path TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  purged_at INTEGER,
  manifest_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_rollback_archives_expiry
  ON v3_rollback_archives (expires_at, purged_at);
CREATE TABLE IF NOT EXISTS v3_maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
`;

/**
 * A daily report is a durable result, unlike the raw member messages used to
 * render it. Keep the rendered result after raw-message retention removes its
 * inputs so operators still have the report that was actually delivered.
 */
const V3_DAILY_REPORT_OUTPUT_SCHEMA = `
CREATE TABLE IF NOT EXISTS v3_daily_report_outputs (
  group_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, day_key)
);
CREATE INDEX IF NOT EXISTS idx_v3_daily_report_outputs_sent_at
  ON v3_daily_report_outputs (sent_at DESC);
`;

const V3_ADMIN_QQ_BINDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_qq_bindings (
  qq_user_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES admin_accounts(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_qq_bindings_account ON admin_qq_bindings(account_id);
`;

/**
 * Generated static pages deliberately retain only publication metadata. The
 * request, model output and generated HTML stay out of SQLite: HTML is served
 * from the isolated preview origin and user input remains in the message
 * ledger's short retention window only.
 */
const HTML_PREVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS html_previews (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '网页预览',
  content_sha256 TEXT,
  byte_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'published', 'failed', 'expired', 'deleted')),
  lease_token TEXT,
  lease_expires_at INTEGER,
  announcement_outbox_id INTEGER REFERENCES outbox(id),
  announcement_created_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  failed_at INTEGER,
  expires_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (group_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_html_previews_queue
  ON html_previews (status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_html_previews_group_queue
  ON html_previews (group_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_html_previews_expiry
  ON html_previews (expires_at, status);
CREATE INDEX IF NOT EXISTS idx_html_previews_announcement
  ON html_previews (announcement_outbox_id) WHERE announcement_outbox_id IS NOT NULL;
`;

/**
 * Reconciles schemas produced by pre-migration releases. Keep this as the
 * first tracked migration so an existing installation has an auditable
 * baseline before new domain tables are added.
 */
function reconcileLegacyColumns(db: DatabaseSync): void {
  const messageCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  for (const [name, sqlType] of [
    ["sender_card", "TEXT"],
    ["sender_nickname", "TEXT"],
    ["processable", "INTEGER NOT NULL DEFAULT 1"],
    ["drop_reason", "TEXT"],
  ] as const) {
    if (!messageCols.some((col) => col.name === name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${sqlType}`);
    }
  }

  const outboxCols = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  const additions: Array<[string, string]> = [
    ["updated_at", "INTEGER"],
    ["topic_id", "TEXT"],
    ["branch_id", "TEXT"],
    ["source_turn_id", "INTEGER"],
    ["turn_id", "INTEGER"],
    ["delivery_id", "TEXT"],
    ["platform_message_id", "TEXT"],
    ["sent_at", "INTEGER"],
    ["retry_after", "INTEGER"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, sqlType] of additions) {
    if (!outboxCols.some((col) => col.name === name)) {
      db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${sqlType}`);
    }
  }
}

function addOutboxAttemptColumn(db: DatabaseSync): void {
  const outboxCols = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!outboxCols.some((col) => col.name === "attempts")) {
    db.exec("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
}

function addImageEditLineage(db: DatabaseSync): void {
  const additions = {
    outbox: { image_preview_id: "TEXT" },
    image_previews: {
      operation: "TEXT NOT NULL DEFAULT 'generation'",
      reference_count: "INTEGER NOT NULL DEFAULT 0",
      parent_ids_json: "TEXT NOT NULL DEFAULT '[]'",
      output_size: "TEXT NOT NULL DEFAULT '1024x1024'",
      output_message_id: "TEXT",
    },
  };
  for (const [table, columns] of Object.entries(additions)) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_image_previews_output_message ON image_previews(group_id, output_message_id)");
}

function addOutboxForwardPayloadColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "forward_payload_json")) {
    db.exec("ALTER TABLE outbox ADD COLUMN forward_payload_json TEXT");
  }
}

function addDurableMessageRecalls(db: DatabaseSync): void {
  const outboxColumns = new Set(
    (db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!outboxColumns.has("auto_recall_after_ms")) {
    db.exec("ALTER TABLE outbox ADD COLUMN auto_recall_after_ms INTEGER");
  }
  if (!outboxColumns.has("auto_recall_deadline_ms")) {
    db.exec("ALTER TABLE outbox ADD COLUMN auto_recall_deadline_ms INTEGER");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_recalls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id INTEGER REFERENCES outbox(id) ON DELETE SET NULL,
      group_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending', 'sending', 'recalled', 'rejected', 'outcome_unknown',
          'expired', 'unsupported', 'not_sent_expired'
        )),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (outbox_id),
      UNIQUE (group_id, platform_message_id),
      CHECK (due_at <= deadline_at)
    );
    CREATE INDEX IF NOT EXISTS idx_message_recalls_due
      ON message_recalls (status, due_at, id);
    CREATE INDEX IF NOT EXISTS idx_message_recalls_deadline
      ON message_recalls (status, deadline_at, id);
  `);
}

function addVerifiedMentionUserIdsColumn(db: DatabaseSync): void {
  const messageCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!messageCols.some((col) => col.name === "verified_mention_user_ids_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN verified_mention_user_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function addCanonicalMessageSegmentsColumn(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has("canonical_segments_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN canonical_segments_json TEXT");
  }
}

function addImageRequestLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_requests (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_row_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      creator_user_id TEXT NOT NULL,
      request_kind TEXT NOT NULL CHECK (request_kind IN ('generation', 'edit', 'avatar_edit')),
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('command', 'natural')),
      status TEXT NOT NULL CHECK (status IN (
        'accepted', 'submitting', 'generated', 'queued', 'delivered',
        'failed', 'outcome_unknown', 'delivery_unknown'
      )),
      upstream_request_key TEXT NOT NULL UNIQUE,
      staged_file_path TEXT,
      model_id TEXT,
      model TEXT,
      fallback_used INTEGER CHECK (fallback_used IN (0, 1)),
      mime_type TEXT CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
      byte_size INTEGER CHECK (byte_size > 0),
      output_size TEXT,
      image_preview_id TEXT REFERENCES image_previews(id) ON DELETE SET NULL,
      outbox_id INTEGER UNIQUE REFERENCES outbox(id) ON DELETE SET NULL,
      error_code TEXT,
      submitted_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (group_id, source_message_id),
      UNIQUE (source_row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_image_requests_group_created
      ON image_requests (group_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_image_requests_status_updated
      ON image_requests (status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_image_requests_outbox
      ON image_requests (outbox_id) WHERE outbox_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_image_requests_preview
      ON image_requests (image_preview_id) WHERE image_preview_id IS NOT NULL;
  `);
}

/**
 * A retained generated image is private, but it must also stay unavailable
 * until the request ledger and its QQ Outbox row have been committed together.
 * This additive column avoids rebuilding the older status CHECK constraint.
 */
function addImagePreviewPublicationState(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(image_previews)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("publication_state")) {
    db.exec(
      "ALTER TABLE image_previews ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'published' CHECK (publication_state IN ('pending', 'published'))",
    );
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_image_previews_publication_state ON image_previews(publication_state, status, updated_at, id)",
  );
}

/**
 * The image-intent router is deliberately separate from image_requests. It
 * records only the classification boundary for one already-persisted inbound
 * message; prompts, QQ identities, and image references stay in the short
 * lived message ledger and never enter this table.
 */
function addImageIntentRouteLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_intent_routes (
      source_row_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('classifying', 'classified', 'unavailable')),
      action TEXT CHECK (action IN ('chat', 'generate', 'edit', 'avatar_edit', 'clarification')),
      model_id TEXT,
      model TEXT,
      error_code TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      classified_at INTEGER,
      unavailable_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (status = 'classifying'
          AND action IS NULL
          AND error_code IS NULL
          AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND classified_at IS NULL
          AND unavailable_at IS NULL)
        OR
        (status = 'classified'
          AND action IS NOT NULL
          AND error_code IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
          AND classified_at IS NOT NULL
          AND unavailable_at IS NULL)
        OR
        (status = 'unavailable'
          AND action IS NULL
          AND error_code IS NOT NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
          AND classified_at IS NULL
          AND unavailable_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_image_intent_routes_claim
      ON image_intent_routes (status, lease_expires_at, source_row_id);
    CREATE INDEX IF NOT EXISTS idx_image_intent_routes_updated
      ON image_intent_routes (updated_at DESC, source_row_id DESC);
  `);
}

/**
 * Durable ownership for the whole Worker handler, rather than a single
 * feature's sub-step. This is deliberately distinct from consumer progress:
 * concurrent workers may have different cursors but must never invoke a
 * handler for the same source row at the same time.
 */
function addMessageExecutionLeases(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_execution_leases (
      execution_scope TEXT NOT NULL,
      source_row_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
      lease_token TEXT,
      lease_expires_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (execution_scope, source_row_id),
      CHECK (
        (status = 'running'
          AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND completed_at IS NULL)
        OR
        (status = 'completed'
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
          AND completed_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_message_execution_leases_live
      ON message_execution_leases (execution_scope, status, lease_expires_at, source_row_id);
  `);
}

function retireAdminMfa(db: DatabaseSync): void {
  const now = Date.now();
  const sessionColumns = new Set((db.prepare("PRAGMA table_info(admin_sessions)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!sessionColumns.has("reauth_verified_at")) {
    db.exec("ALTER TABLE admin_sessions ADD COLUMN reauth_verified_at INTEGER NOT NULL DEFAULT 0");
  }
  db.prepare("UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?)").run(now);
  db.exec("DROP INDEX IF EXISTS idx_admin_auth_challenges_account");
  db.exec("DROP INDEX IF EXISTS idx_admin_recovery_codes_account");
  db.exec("DROP TABLE IF EXISTS admin_auth_challenges");
  db.exec("DROP TABLE IF EXISTS admin_recovery_codes");
  db.prepare("DELETE FROM admin_login_rate_limits WHERE scope = 'totp' OR scope LIKE 'totp_%' OR scope = 'recovery_login'").run();
  dropColumnIfPresent(db, "admin_accounts", "totp_secret_ciphertext");
  dropColumnIfPresent(db, "admin_accounts", "totp_enabled_at");
  dropColumnIfPresent(db, "admin_accounts", "mfa_last_counter");
  dropColumnIfPresent(db, "admin_sessions", "mfa_verified_at");
}

function addSenderRoleColumn(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("sender_role")) {
    db.exec("ALTER TABLE messages ADD COLUMN sender_role TEXT");
  }
}

function retireVoiceState(db: DatabaseSync): void {
  const now = Date.now();
  // Voice outbox payloads cannot be safely reinterpreted after the sender
  // implementation is retired. Keep sent rows for audit, but terminalize all
  // other states so a later ingress cannot emit a record payload as text.
  db.prepare(
    `UPDATE outbox
        SET status = 'failed', retry_after = NULL, updated_at = ?
      WHERE kind IN ('record', 'airecord') AND status <> 'sent'`,
  ).run(now);
  const settingsRow = db.prepare(
    "SELECT settings_json FROM v3_system_settings WHERE settings_key = 'default'",
  ).get() as { settings_json: string } | undefined;
  if (settingsRow) {
    const settings = parseJsonObject(settingsRow.settings_json, "invalid_v3_system_settings_for_voice_retirement");
    const models = Array.isArray(settings.models) ? settings.models : [];
    const retiredModelIds = models
      .filter((item) => isRecord(item) && item.purpose === "tts")
      .map((item) => String(item.id ?? "").trim())
      .filter(Boolean);
    settings.models = models.filter((item) => !(isRecord(item) && item.purpose === "tts"));
    if (isRecord(settings.selectedModelIds)) delete settings.selectedModelIds.tts;
    if (Array.isArray(settings.commands)) {
      settings.commands = settings.commands.filter((item) => !(
        isRecord(item) && (item.id === "voice" || item.id === "voice_reply" || item.id === "sing")
      ));
    }
    if (Array.isArray(settings.removedDefaultModelIds)) {
      const retired = new Set([...retiredModelIds, "tts", "tts-mimo-v25"]);
      settings.removedDefaultModelIds = settings.removedDefaultModelIds.filter((id) => !retired.has(String(id)));
    }
    db.prepare("UPDATE v3_system_settings SET settings_json = ?, updated_at = ? WHERE settings_key = 'default'")
      .run(JSON.stringify(settings), now);
    const deleteSecret = db.prepare("DELETE FROM v3_system_secrets WHERE secret_key = ?");
    for (const modelId of new Set([...retiredModelIds, "tts", "tts-mimo-v25"])) {
      deleteSecret.run(`model:${modelId}:api_key`);
    }
  }

  const groups = db.prepare("SELECT group_id, config_json FROM v3_groups").all() as Array<{ group_id: string; config_json: string }>;
  const updateGroup = db.prepare("UPDATE v3_groups SET config_json = ?, updated_at = ? WHERE group_id = ?");
  for (const row of groups) {
    const config = parseJsonObject(row.config_json, "invalid_v3_group_config_for_voice_retirement");
    delete config.voiceReplyEnabled;
    delete config.defaultVoiceReplyEnabled;
    updateGroup.run(JSON.stringify(config), now, row.group_id);
  }

  for (const table of ["v3_character_profiles", "v3_character_profile_revisions"] as const) {
    const key = table === "v3_character_profiles" ? "id" : "id";
    const rows = db.prepare(`SELECT ${key} AS row_key, profile_json FROM ${table}`).all() as Array<{ row_key: string | number; profile_json: string }>;
    const update = db.prepare(`UPDATE ${table} SET profile_json = ? WHERE ${key} = ?`);
    for (const row of rows) {
      const profile = parseJsonObject(row.profile_json, "invalid_v3_character_profile_for_voice_retirement");
      delete profile.ttsConfig;
      delete profile.ttsStyleHint;
      update.run(JSON.stringify(profile), row.row_key);
    }
  }

  const policies = db.prepare("SELECT policy_key, policy_json FROM v3_capability_policies").all() as Array<{ policy_key: string; policy_json: string }>;
  const updatePolicy = db.prepare("UPDATE v3_capability_policies SET policy_json = ?, updated_at = ? WHERE policy_key = ?");
  for (const row of policies) {
    const policy = parseJsonObject(row.policy_json, "invalid_v3_capability_policy_for_voice_retirement");
    if (Array.isArray(policy.enabledCapabilities)) {
      policy.enabledCapabilities = policy.enabledCapabilities.filter((value) => value !== "voice" && value !== "singing");
    }
    updatePolicy.run(JSON.stringify(policy), now, row.policy_key);
  }
  db.prepare(
    `DELETE FROM v3_state_documents
      WHERE document_type = 'model-health'
        AND (document_json LIKE '%\"purpose\":\"tts\"%' OR document_json LIKE '%\"probeType\":\"tts\"%')`,
  ).run();
}

function dropColumnIfPresent(db: DatabaseSync, table: "admin_accounts" | "admin_sessions", column: string): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
  if (columns.has(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function parseJsonObject(value: string, errorCode: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // The migration must fail atomically rather than silently discard state.
  }
  throw new Error(errorCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "reconcile-pre-versioned-schema",
    apply: reconcileLegacyColumns,
  },
  {
    version: 2,
    name: "add-group-config-shadow-snapshots",
    apply: (db) => db.exec(GROUP_CONFIG_SHADOW_SCHEMA),
  },
  {
    version: 3,
    name: "add-system-settings-shadow-snapshots",
    apply: (db) => db.exec(SYSTEM_SETTINGS_SHADOW_SCHEMA),
  },
  {
    version: 4,
    name: "add-outbox-delivery-attempts",
    apply: addOutboxAttemptColumn,
  },
  {
    version: 5,
    name: "add-v3-control-and-character-authority",
    apply: (db) => db.exec(V3_CONTROL_SCHEMA),
  },
  {
    version: 6,
    name: "add-v3-content-and-schedule-authority",
    apply: (db) => db.exec(V3_CONTENT_AND_SCHEDULE_SCHEMA),
  },
  {
    version: 7,
    name: "add-v3-admin-account-authentication",
    apply: (db) => db.exec(V3_ADMIN_AUTH_SCHEMA),
  },
  {
    version: 8,
    name: "add-v3-retention-and-cutover-metadata",
    apply: (db) => db.exec(V3_RETENTION_AND_CUTOVER_SCHEMA),
  },
  {
    version: 9,
    name: "add-v3-daily-report-rendered-outputs",
    apply: (db) => db.exec(V3_DAILY_REPORT_OUTPUT_SCHEMA),
  },
  {
    version: 10,
    name: "add-static-html-preview-publications",
    apply: (db) => db.exec(HTML_PREVIEW_SCHEMA),
  },
  {
    version: 11,
    name: "add-admin-qq-account-bindings",
    apply: (db) => db.exec(V3_ADMIN_QQ_BINDING_SCHEMA),
  },
  {
    version: 12,
    name: "persist-verified-message-mention-targets",
    apply: addVerifiedMentionUserIdsColumn,
  },
  {
    version: 13,
    name: "retire-admin-mfa",
    apply: retireAdminMfa,
  },
  {
    version: 14,
    name: "persist-platform-sender-role",
    apply: addSenderRoleColumn,
  },
  {
    version: 15,
    name: "retire-voice-state",
    apply: retireVoiceState,
  },
  {
    version: 16,
    name: "add-knowledge-source-command-bindings",
    apply: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS v3_knowledge_source_bindings (
        source TEXT NOT NULL CHECK (source IN ('private_enterprise_ranking', 'group_faq')),
        group_id TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source, group_id),
        CHECK (
          (source = 'private_enterprise_ranking' AND group_id = '') OR
          (source = 'group_faq' AND length(trim(group_id)) > 0)
        )
      );
    `),
  },
  {
    version: 17,
    name: "admin-analytics-and-bulk-operations",
    apply: (db) => db.exec(`
      CREATE TABLE model_requests (
        id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, group_id TEXT NOT NULL,
        model_id TEXT NOT NULL, purpose TEXT NOT NULL, probe INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX model_requests_time ON model_requests(started_at);
      CREATE INDEX model_requests_group_time ON model_requests(group_id,started_at);
      CREATE TABLE model_daily_usage (
        day TEXT NOT NULL, group_id TEXT NOT NULL, model_id TEXT NOT NULL,
        purpose TEXT NOT NULL, probe INTEGER NOT NULL, aggregate_json TEXT NOT NULL,
        PRIMARY KEY(day,group_id,model_id,purpose,probe)
      );
      CREATE TABLE model_analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE admin_bulk_previews (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL, task_id TEXT
      );
      CREATE TABLE admin_bulk_runs (
        task_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
    `),
  },
  {
    version: 18,
    name: "durable-bulk-target-results",
    apply: (db) => db.exec(`
      CREATE TABLE admin_bulk_results (
        task_id TEXT NOT NULL, target_id TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(task_id,target_id)
      );
    `),
  },
  {
    version: 19,
    name: "add-outbox-forward-payload",
    apply: addOutboxForwardPayloadColumn,
  },
  {
    version: 20,
    name: "add-durable-message-recalls",
    apply: addDurableMessageRecalls,
  },
  {
    version: 21,
    name: "add-conversation-orchestration",
    apply: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_reply_plans (
        source_row_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL, user_id TEXT NOT NULL, resolution_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_state_updates (
        turn_id INTEGER PRIMARY KEY REFERENCES conversation_turns(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL, branch_id TEXT NOT NULL, source_turn_id INTEGER NOT NULL,
        revision INTEGER NOT NULL, update_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_state_updates_group ON conversation_state_updates(group_id);
      CREATE TABLE IF NOT EXISTS conversation_reply_tasks (
        source_row_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        branch_id TEXT NOT NULL REFERENCES conversation_branches(branch_id) ON DELETE CASCADE,
        source_turn_id INTEGER NOT NULL, status TEXT NOT NULL,
        replacement_row_id INTEGER, merged_source_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_reply_tasks_branch ON conversation_reply_tasks(group_id,user_id,branch_id,source_row_id);
    `),
  },
  {
    version: 22,
    name: "add-generated-image-preview-archive",
    apply: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS image_previews (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        prompt TEXT,
        prompt_summary TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        model TEXT NOT NULL,
        fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'expired', 'deleted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        expired_at INTEGER,
        deleted_at INTEGER,
        UNIQUE (group_id, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_image_previews_group_created
        ON image_previews (group_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_image_previews_status_expiry
        ON image_previews (status, expires_at, id);
    `),
  },
  {
    version: 23,
    name: "add-image-edit-lineage-and-delivery",
    apply: addImageEditLineage,
  },
  {
    version: 24,
    name: "persist-canonical-message-segments",
    apply: addCanonicalMessageSegmentsColumn,
  },
  {
    version: 25,
    name: "add-durable-image-request-ledger",
    apply: addImageRequestLedger,
  },
  {
    version: 26,
    name: "stage-image-previews-until-outbox-link",
    apply: addImagePreviewPublicationState,
  },
  {
    version: 27,
    name: "add-image-intent-route-ledger",
    apply: addImageIntentRouteLedger,
  },
  {
    version: 28,
    name: "add-message-execution-leases",
    apply: addMessageExecutionLeases,
  },
];

const MAX_OUTBOX_DELIVERY_ATTEMPTS = 3;
const MAX_MESSAGE_RECALL_ATTEMPTS = 2;
const TERMINAL_MESSAGE_RECALL_STATUSES = new Set<MessageRecallStatus>([
  "recalled",
  "rejected",
  "outcome_unknown",
  "expired",
  "unsupported",
  "not_sent_expired",
]);

export class SharedDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  /**
   * Runs each additive migration exactly once under an IMMEDIATE transaction.
   * The initial CREATE TABLE statements stay as a bootstrap for older installs;
   * every new runtime table must be added through MIGRATIONS from now on.
   */
  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const applied = new Set(
        (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
          .map((row) => row.version),
      );
      const insert = this.db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      );
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) {
          continue;
        }
        migration.apply(this.db);
        insert.run(migration.version, migration.name, Date.now());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may not have been opened if SQLite rejected BEGIN.
      }
      throw error;
    }
  }

  listSchemaMigrations(): SchemaMigrationRow[] {
    return this.db
      .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
      .all() as unknown as SchemaMigrationRow[];
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  getGroupConfigShadowSnapshot(): GroupConfigShadowSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT source_key, snapshot_json, snapshot_hash, schema_version, group_count, synced_at
           FROM group_config_shadow_snapshots
          WHERE source_key = 'groups-json'`,
      )
      .get() as GroupConfigShadowSnapshotRow | undefined;
  }

  saveGroupConfigShadowSnapshot(input: {
    snapshotJson: string;
    snapshotHash: string;
    schemaVersion: number;
    groupCount: number;
    syncedAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO group_config_shadow_snapshots
           (source_key, snapshot_json, snapshot_hash, schema_version, group_count, synced_at)
         VALUES ('groups-json', ?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           snapshot_hash = excluded.snapshot_hash,
           schema_version = excluded.schema_version,
           group_count = excluded.group_count,
           synced_at = excluded.synced_at`,
      )
      .run(
        input.snapshotJson,
        input.snapshotHash,
        input.schemaVersion,
        input.groupCount,
        input.syncedAt ?? Date.now(),
      );
  }

  getSystemSettingsShadowSnapshot(): SystemSettingsShadowSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT source_key, snapshot_json, snapshot_hash, schema_version, synced_at
           FROM system_settings_shadow_snapshots
          WHERE source_key = 'system-settings-json'`,
      )
      .get() as SystemSettingsShadowSnapshotRow | undefined;
  }

  saveSystemSettingsShadowSnapshot(input: {
    snapshotJson: string;
    snapshotHash: string;
    schemaVersion: number;
    syncedAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO system_settings_shadow_snapshots
           (source_key, snapshot_json, snapshot_hash, schema_version, synced_at)
         VALUES ('system-settings-json', ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           snapshot_hash = excluded.snapshot_hash,
           schema_version = excluded.schema_version,
           synced_at = excluded.synced_at`,
      )
      .run(
        input.snapshotJson,
        input.snapshotHash,
        input.schemaVersion,
        input.syncedAt ?? Date.now(),
      );
  }

  /** Stores the current participation decision once per inbound message for audit and shadow-mode analysis. */
  recordParticipationDecision(input: {
    sourceRowId: number;
    groupId: string;
    userId: string;
    action: string;
    reason: string;
    score: number;
    policyVersion: string;
    signals: Record<string, boolean>;
    createdAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO participation_decisions
           (source_row_id, group_id, user_id, action, reason, score, policy_version, signals_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_row_id) DO UPDATE SET
           action = excluded.action,
           reason = excluded.reason,
           score = excluded.score,
           policy_version = excluded.policy_version,
           signals_json = excluded.signals_json,
           created_at = excluded.created_at`,
      )
      .run(
        input.sourceRowId,
        input.groupId,
        input.userId,
        input.action,
        input.reason,
        input.score,
        input.policyVersion,
        JSON.stringify(input.signals),
        input.createdAt ?? Date.now(),
      );
  }

  listParticipationDecisions(options: {
    groupId?: string;
    limit?: number;
  } = {}): ParticipationDecisionRow[] {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    if (options.groupId) {
      return this.db
        .prepare(
          `SELECT id, source_row_id, group_id, user_id, action, reason, score, policy_version, signals_json, created_at
             FROM participation_decisions
            WHERE group_id = ?
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(options.groupId, limit) as unknown as ParticipationDecisionRow[];
    }
    return this.db
      .prepare(
        `SELECT id, source_row_id, group_id, user_id, action, reason, score, policy_version, signals_json, created_at
           FROM participation_decisions
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as ParticipationDecisionRow[];
  }

  /** Returns the immutable routing decision recorded for one inbound message. */
  getParticipationDecision(sourceRowId: number): ParticipationDecisionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_row_id, group_id, user_id, action, reason, score, policy_version, signals_json, created_at
           FROM participation_decisions
          WHERE source_row_id = ?`,
      )
      .get(sourceRowId) as ParticipationDecisionRow | undefined;
  }

  // ---- messages (written by ingress, polled by workers) ----

  /** Idempotent insert keyed on (self_id, group_id, msg_id). Returns row id or 0 when duplicate. */
  insertMessage(row: {
    groupId: string;
    userId: string;
    selfId: string;
    msgId: string;
    msgTime: number;
    text: string;
    imagesJson: string;
    canonicalSegmentsJson?: string;
    senderCard?: string;
    senderNickname?: string;
    senderRole?: string;
    replyTo?: string;
    verifiedMentionUserIds?: string[];
    hasAtBot: boolean;
    isBotMsg: boolean;
    processable?: boolean;
    dropReason?: string;
    createdAt: number;
  }): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages
             (group_id, user_id, self_id, msg_id, msg_time, text, images_json, canonical_segments_json,
              sender_card, sender_nickname, sender_role, reply_to, verified_mention_user_ids_json,
              has_at_bot, is_bot_msg, processable, drop_reason, created_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.groupId,
          row.userId,
          row.selfId,
          row.msgId,
          row.msgTime,
          row.text,
          row.imagesJson,
          normalizeCanonicalSegmentsJson(row.canonicalSegmentsJson),
          normalizeOptionalText(row.senderCard),
          normalizeOptionalText(row.senderNickname),
          normalizeSenderRole(row.senderRole),
          row.replyTo ?? null,
          JSON.stringify(normalizeVerifiedMentionUserIds(row.verifiedMentionUserIds)),
          row.hasAtBot ? 1 : 0,
          row.isBotMsg ? 1 : 0,
          row.processable === false ? 0 : 1,
          row.dropReason ?? null,
          row.createdAt,
          `${row.selfId}:${row.groupId}:${row.msgId}`,
        );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return 0;
      }
      throw error;
    }
  }

  /** Marks an already-ingested event as non-processable without deleting its audit trail. */
  markMessageDropped(messageId: number, reason: string): void {
    this.db
      .prepare("UPDATE messages SET processable = 0, drop_reason = ? WHERE id = ?")
      .run(reason.slice(0, 120), messageId);
  }

  /** Number of messages received within the trailing window; used for the per-group token bucket. */
  countMessagesSince(groupId: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND created_at >= ?")
      .get(groupId, sinceMs) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Raw rows are exposed only to the local atmosphere summarizer. */
  listRecentGroupMessages(groupId: string, sinceMs: number, limit = 200): RecentGroupMessageRow[] {
    return this.db
      .prepare(
        `SELECT group_id, user_id, msg_id, msg_time, text, images_json
           FROM messages
          WHERE group_id = ? AND msg_time >= ? AND is_bot_msg = 0
            AND lower(trim(text)) NOT IN ('#bt', '/bt')
            AND lower(ltrim(text)) NOT LIKE '#bt %'
            AND lower(ltrim(text)) NOT LIKE '/bt %'
            AND NOT EXISTS (SELECT 1 FROM participation_decisions p WHERE p.source_row_id = messages.id AND p.action = 'admin_command')
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(groupId, sinceMs, Math.max(1, Math.min(500, limit)))
      .reverse() as unknown as RecentGroupMessageRow[];
  }

  /** Bounded transcript available before one inbound message. */
  listRecentGroupEvidence(args: {
    groupId: string;
    beforeSourceRowId: number;
    sinceMs: number;
    excludedUserIds?: string[];
    limit?: number;
  }): RecentGroupEvidenceRow[] {
    const source = this.db
      .prepare("SELECT created_at FROM messages WHERE id = ? AND group_id = ?")
      .get(args.beforeSourceRowId, args.groupId) as { created_at: number } | undefined;
    if (!source) return [];

    return this.listGroupTranscriptBefore({
      groupId: args.groupId,
      beforeSourceRowId: args.beforeSourceRowId,
      beforeOccurredAt: source.created_at,
      sinceMs: args.sinceMs,
      excludedUserIds: args.excludedUserIds,
      limit: Math.max(1, Math.min(30, args.limit ?? 30)),
    });
  }

  /** Short group-conversation window anchored to the source row's receipt time. */
  listAmbientGroupContext(args: {
    groupId: string;
    beforeSourceRowId: number;
    lookbackMs: number;
    excludedUserIds?: string[];
    limit?: number;
  }): RecentGroupEvidenceRow[] {
    const source = this.db
      .prepare("SELECT created_at FROM messages WHERE id = ? AND group_id = ?")
      .get(args.beforeSourceRowId, args.groupId) as { created_at: number } | undefined;
    if (!source) return [];

    const requestedLookbackMs = Number.isFinite(args.lookbackMs)
      ? Math.trunc(args.lookbackMs)
      : 10 * 60 * 1_000;
    const lookbackMs = Math.max(1, Math.min(60 * 60 * 1_000, requestedLookbackMs));
    return this.listGroupTranscriptBefore({
      groupId: args.groupId,
      beforeSourceRowId: args.beforeSourceRowId,
      beforeOccurredAt: source.created_at,
      memberBeforeOccurredAt: source.created_at,
      sinceMs: source.created_at - lookbackMs,
      excludedUserIds: args.excludedUserIds,
      limit: Math.max(1, Math.min(200, args.limit ?? 60)),
    });
  }

  private listGroupTranscriptBefore(args: {
    groupId: string;
    beforeSourceRowId: number;
    beforeOccurredAt: number;
    memberBeforeOccurredAt?: number;
    sinceMs: number;
    excludedUserIds?: string[];
    limit: number;
  }): RecentGroupEvidenceRow[] {
    const excludedUserIds = new Set((args.excludedUserIds ?? []).map((value) => value.trim()).filter(Boolean));

    const excluded = [...excludedUserIds];
    const exclusionClause = excluded.length > 0
      ? `AND user_id NOT IN (${excluded.map(() => "?").join(",")})`
      : "";
    const memberTimeUpperBoundClause = args.memberBeforeOccurredAt === undefined
      ? ""
      : "AND created_at <= ?";
    const memberRows = this.db
      .prepare(
        `SELECT 'member' AS role, msg_id AS message_id, user_id, text, images_json, sender_card, sender_nickname,
                created_at AS occurred_at
           FROM messages
          WHERE group_id = ?
            AND id < ?
            AND created_at >= ?
            ${memberTimeUpperBoundClause}
            AND is_bot_msg = 0
            AND (processable = 1 OR drop_reason = 'rate_limited')
            AND (text = '' OR ltrim(text) NOT LIKE '#%')
            AND NOT (lower(trim(text)) = '/bt' OR lower(ltrim(text)) LIKE '/bt %')
            AND NOT EXISTS (
              SELECT 1 FROM participation_decisions p
              WHERE p.source_row_id = messages.id AND p.action = 'admin_command'
            )
            ${exclusionClause}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(
        args.groupId,
        args.beforeSourceRowId,
        args.sinceMs,
        ...(args.memberBeforeOccurredAt === undefined ? [] : [args.memberBeforeOccurredAt]),
        ...excluded,
        args.limit,
      ) as unknown as RecentGroupEvidenceRow[];
    // Bot replies may quote a member verbatim, but outbox records do not carry
    // the quoted speaker's provenance. When any member is excluded, omit bot
    // text rather than risking a reintroduction of opted-out content.
    const botRows = excluded.length === 0
      ? this.db
        .prepare(
          `SELECT 'bot' AS role, platform_message_id AS message_id, NULL AS user_id, text, '[]' AS images_json,
                  NULL AS sender_card, NULL AS sender_nickname, sent_at AS occurred_at
             FROM outbox
            WHERE group_id = ?
              AND status = 'sent'
              AND kind = 'text'
              AND text NOT LIKE '【BT 搜索】%'
              AND sent_at IS NOT NULL
              AND sent_at >= ?
              AND sent_at < ?
            ORDER BY sent_at DESC, id DESC
            LIMIT ?`,
        )
        .all(args.groupId, args.sinceMs, args.beforeOccurredAt, args.limit) as unknown as RecentGroupEvidenceRow[]
      : [];

    return [...memberRows, ...botRows]
      .filter(row => !row.message_id || !this.isRetracted(args.groupId, row.message_id))
      .sort((left, right) => left.occurred_at - right.occurred_at)
      .slice(-args.limit);
  }

  /**
   * Earliest pending message for a consumer key.
   * Ordered by SQLite's autoincrement id. The watermark uses the same order,
   * so timestamp skew cannot make a message disappear between batches.
   */
  pollMessages(key: string, limit: number): IngressMessageRow[] {
    this.ensureConsumer(key);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.group_id, m.user_id, m.self_id, m.msg_id, m.msg_time, m.text,
                m.images_json, m.canonical_segments_json, m.sender_card, m.sender_nickname, m.sender_role, m.reply_to,
                m.verified_mention_user_ids_json,
                m.has_at_bot, m.is_bot_msg, m.processable, m.drop_reason, m.created_at,
                r.topic_id AS context_topic_id,
                r.branch_id AS context_branch_id,
                r.route_reason AS context_route_reason
           FROM messages m
           JOIN consumers c ON c.key = ?
           LEFT JOIN conversation_message_routes r ON r.source_row_id = m.id
           WHERE m.id > MAX(
             c.watermark_id,
             COALESCE((
               SELECT CAST(value AS INTEGER)
                 FROM conversation_context_meta
                WHERE key = 'cutover_message_id'
             ), 0)
           )
             AND NOT EXISTS (
               SELECT 1
                 FROM consumer_completed_messages completed
                WHERE completed.consumer_key = ?
                  AND completed.message_id = m.id
             )
           ORDER BY m.id ASC
           LIMIT ?`,
      )
      .all(key, key, limit) as unknown as IngressMessageRow[];
    return rows;
  }

  /**
   * Claims durable, cross-process ownership of one source row immediately
   * before a ConsumerRunner invokes its handler. A consumer key is excluded
   * from the key on purpose: separate worker processes can keep independent
   * watermarks while still sharing exactly one execution owner.
   *
   * Expired leases are reclaimed rather than discarded so a process crash
   * remains recoverable. Downstream side effects keep their existing durable
   * request/outbox idempotency boundaries.
   */
  claimMessageExecutionLease(input: {
    executionScope?: string;
    sourceRowId: number;
    leaseMs?: number;
    now?: number;
    /**
     * A fresh logical consumer may replay a completed row through its durable
     * feature ledgers. ConsumerRunner uses this only when it never observed a
     * live owner for the row; waiters acknowledge the completed result.
     */
    allowCompletedReplay?: boolean;
  }): MessageExecutionLeaseClaim {
    const executionScope = normalizeMessageExecutionScope(input.executionScope);
    const sourceRowId = requireMessageExecutionSourceRowId(input.sourceRowId);
    const leaseMs = normalizeMessageExecutionLeaseMs(input.leaseMs);
    const now = normalizeMessageExecutionTimestamp(input.now ?? Date.now(), "message_execution_lease_claimed_at_invalid");

    return this.withImmediateTransaction(() => {
      const existing = this.getMessageExecutionLease(executionScope, sourceRowId);
      if (!existing) {
        this.assertMessageExecutionSourceRow(sourceRowId);
        const leaseToken = createMessageExecutionLeaseToken();
        this.db.prepare(
          `INSERT INTO message_execution_leases
             (execution_scope, source_row_id, status, lease_token, lease_expires_at,
              completed_at, created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?, NULL, ?, ?)`,
        ).run(executionScope, sourceRowId, leaseToken, now + leaseMs, now, now);
        const lease = this.getMessageExecutionLease(executionScope, sourceRowId);
        if (!lease) throw new Error("message_execution_lease_claim_readback_failed");
        return { state: "claimed", lease, leaseToken, reclaimed: false };
      }

      if (existing.status === "completed") {
        if (!input.allowCompletedReplay) {
          return { state: "completed", lease: existing };
        }
        const leaseToken = createMessageExecutionLeaseToken();
        const replayed = this.db.prepare(
          `UPDATE message_execution_leases
              SET status = 'running', lease_token = ?, lease_expires_at = ?,
                  completed_at = NULL, updated_at = ?
            WHERE execution_scope = ?
              AND source_row_id = ?
              AND status = 'completed'`,
        ).run(leaseToken, now + leaseMs, now, executionScope, sourceRowId);
        const latest = this.getMessageExecutionLease(executionScope, sourceRowId);
        if (!latest) throw new Error("message_execution_lease_replay_readback_failed");
        if (Number(replayed.changes) === 1) {
          return { state: "claimed", lease: latest, leaseToken, reclaimed: false };
        }
        return latest.status === "completed"
          ? { state: "completed", lease: latest }
          : { state: "busy", lease: latest };
      }
      if ((existing.leaseExpiresAt ?? 0) > now) {
        return { state: "busy", lease: existing };
      }

      const leaseToken = createMessageExecutionLeaseToken();
      const reclaimed = this.db.prepare(
        `UPDATE message_execution_leases
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE execution_scope = ?
            AND source_row_id = ?
            AND status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`,
      ).run(leaseToken, now + leaseMs, now, executionScope, sourceRowId, now);
      const latest = this.getMessageExecutionLease(executionScope, sourceRowId);
      if (!latest) throw new Error("message_execution_lease_reclaim_readback_failed");
      if (Number(reclaimed.changes) === 1) {
        return { state: "claimed", lease: latest, leaseToken, reclaimed: true };
      }
      return latest.status === "completed"
        ? { state: "completed", lease: latest }
        : { state: "busy", lease: latest };
    });
  }

  getMessageExecutionLease(
    executionScope: string,
    sourceRowId: number,
  ): MessageExecutionLeaseRecord | undefined {
    const scope = normalizeMessageExecutionScope(executionScope);
    if (!isMessageExecutionSourceRowId(sourceRowId)) return undefined;
    const row = this.db.prepare(
      `SELECT execution_scope, source_row_id, status, lease_token, lease_expires_at,
              completed_at, created_at, updated_at
         FROM message_execution_leases
        WHERE execution_scope = ? AND source_row_id = ?`,
    ).get(scope, sourceRowId) as {
      execution_scope: string;
      source_row_id: number;
      status: "running" | "completed";
      lease_token: string | null;
      lease_expires_at: number | null;
      completed_at: number | null;
      created_at: number;
      updated_at: number;
    } | undefined;
    return row ? messageExecutionLeaseFromRow(row) : undefined;
  }

  /** Extends a current lease; an expired owner can never resurrect itself. */
  renewMessageExecutionLease(input: {
    executionScope?: string;
    sourceRowId: number;
    leaseToken: string;
    leaseMs?: number;
    now?: number;
  }): boolean {
    const executionScope = normalizeMessageExecutionScope(input.executionScope);
    const sourceRowId = requireMessageExecutionSourceRowId(input.sourceRowId);
    const leaseToken = requireMessageExecutionLeaseToken(input.leaseToken);
    const leaseMs = normalizeMessageExecutionLeaseMs(input.leaseMs);
    const now = normalizeMessageExecutionTimestamp(input.now ?? Date.now(), "message_execution_lease_renewed_at_invalid");
    const result = this.db.prepare(
      `UPDATE message_execution_leases
          SET lease_expires_at = ?, updated_at = ?
        WHERE execution_scope = ?
          AND source_row_id = ?
          AND status = 'running'
          AND lease_token = ?
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
    ).run(now + leaseMs, now, executionScope, sourceRowId, leaseToken, now);
    return Number(result.changes) === 1;
  }

  /** Releases only the current owner after a recoverable handler failure. */
  releaseMessageExecutionLease(input: {
    executionScope?: string;
    sourceRowId: number;
    leaseToken: string;
  }): boolean {
    const executionScope = normalizeMessageExecutionScope(input.executionScope);
    const sourceRowId = requireMessageExecutionSourceRowId(input.sourceRowId);
    const leaseToken = requireMessageExecutionLeaseToken(input.leaseToken);
    const result = this.db.prepare(
      `DELETE FROM message_execution_leases
        WHERE execution_scope = ?
          AND source_row_id = ?
          AND status = 'running'
          AND lease_token = ?`,
    ).run(executionScope, sourceRowId, leaseToken);
    return Number(result.changes) === 1;
  }

  /**
   * Atomically fences the execution owner and advances this consumer's local
   * checkpoint. A replaced owner cannot acknowledge a row reclaimed by
   * another worker between external work and `done()`. The current token may
   * still finish after its nominal deadline if no replacement claimed it,
   * which avoids turning a temporarily paused process into a duplicate retry.
   */
  completeConsumerMessageWithExecutionLease(input: {
    consumerKey: string;
    executionScope?: string;
    sourceRowId: number;
    leaseToken: string;
    completedAt?: number;
  }): boolean {
    const consumerKey = requireMessageExecutionConsumerKey(input.consumerKey);
    const executionScope = normalizeMessageExecutionScope(input.executionScope);
    const sourceRowId = requireMessageExecutionSourceRowId(input.sourceRowId);
    const leaseToken = requireMessageExecutionLeaseToken(input.leaseToken);
    const completedAt = normalizeMessageExecutionTimestamp(
      input.completedAt ?? Date.now(),
      "message_execution_lease_completed_at_invalid",
    );
    return this.withImmediateTransaction(() => {
      const completed = this.db.prepare(
        `UPDATE message_execution_leases
            SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE execution_scope = ?
            AND source_row_id = ?
            AND status = 'running'
            AND lease_token = ?`,
      ).run(completedAt, completedAt, executionScope, sourceRowId, leaseToken);
      if (Number(completed.changes) !== 1) return false;
      this.completeConsumerMessageInTransaction(consumerKey, sourceRowId, completedAt);
      return true;
    });
  }

  /** Used by archive recovery to avoid deleting a live worker's pending bytes. */
  hasLiveMessageExecutionLeaseForSource(input: {
    executionScope?: string;
    groupId: string;
    sourceMessageId: string;
    now?: number;
  }): boolean {
    const executionScope = normalizeMessageExecutionScope(input.executionScope);
    const groupId = requireMessageExecutionIdentifier(input.groupId, "message_execution_lease_group_id_invalid");
    const sourceMessageId = requireMessageExecutionIdentifier(
      input.sourceMessageId,
      "message_execution_lease_source_message_id_invalid",
    );
    const now = normalizeMessageExecutionTimestamp(input.now ?? Date.now(), "message_execution_lease_checked_at_invalid");
    return Boolean(this.db.prepare(
      `SELECT 1 AS ok
         FROM messages message
         JOIN message_execution_leases lease
           ON lease.source_row_id = message.id
          AND lease.execution_scope = ?
        WHERE message.group_id = ?
          AND message.msg_id = ?
          AND lease.status = 'running'
          AND lease.lease_expires_at IS NOT NULL
          AND lease.lease_expires_at > ?
        LIMIT 1`,
    ).get(executionScope, groupId, sourceMessageId, now));
  }

  /** Advances the watermark but never backwards (a retried old message must not re-deliver newer ones). */
  advanceWatermark(key: string, messageId: number): void {
    this.db
      .prepare("UPDATE consumers SET watermark_id = MAX(watermark_id, ?) WHERE key = ?")
      .run(messageId, key);
  }

  /**
   * Marks one message complete and advances only across the contiguous prefix.
   * This lets different branch keys finish out of order without skipping an
   * earlier task that still has to survive a worker restart.
   */
  completeConsumerMessage(key: string, messageId: number, completedAt = Date.now()): void {
    this.withImmediateTransaction(() => {
      this.completeConsumerMessageInTransaction(key, messageId, completedAt);
    });
  }

  isConsumerMessageCompleted(key: string, messageId: number): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS ok FROM consumer_completed_messages WHERE consumer_key = ? AND message_id = ?")
        .get(key, messageId),
    );
  }

  /**
   * 清表兜底（生产事故根因之一）：messages 被外部清空/重建后，水位可能指向
   * 不存在的 id。worker 启动时调用，水位超过当前最大 id 则重置为 0，避免
   * "水位错乱 → 每条消息异常处理 → 乱回复"。
   */
  resetWatermarkIfStale(key: string): void {
    const maxId = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages").get() as { n: number };
    const watermark = this.db.prepare("SELECT watermark_id FROM consumers WHERE key = ?").get(key) as { watermark_id: number } | undefined;
    if (watermark && watermark.watermark_id > maxId.n) {
      this.db.prepare("UPDATE consumers SET watermark_id = 0 WHERE key = ?").run(key);
      logWarn("Consumer watermark reset because messages were cleared.", {
        key,
        oldWatermark: watermark.watermark_id,
        maxMessageId: maxId.n,
      });
    }
  }

  private completeConsumerMessageInTransaction(key: string, messageId: number, completedAt: number): void {
    this.ensureConsumer(key);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO consumer_completed_messages
           (consumer_key, message_id, completed_at)
         VALUES (?, ?, ?)`,
      )
      .run(key, messageId, completedAt);

    const consumer = this.db
      .prepare("SELECT watermark_id FROM consumers WHERE key = ?")
      .get(key) as { watermark_id: number };
    const cutover = this.db
      .prepare(
        `SELECT CAST(value AS INTEGER) AS cutover_id
           FROM conversation_context_meta
          WHERE key = 'cutover_message_id'`,
      )
      .get() as { cutover_id: number } | undefined;
    // Rows at or before the context cutover remain in `messages` for audit,
    // but they are no longer part of the consumable sequence. Start the
    // contiguous-completion walk at the same effective boundary as polling.
    let watermark = Math.max(consumer.watermark_id, cutover?.cutover_id ?? 0);
    while (true) {
      const nextMessage = this.db
        .prepare("SELECT id FROM messages WHERE id > ? ORDER BY id ASC LIMIT 1")
        .get(watermark) as { id: number } | undefined;
      if (!nextMessage) {
        break;
      }
      const completed = this.db
        .prepare(
          `SELECT 1 AS ok FROM consumer_completed_messages
            WHERE consumer_key = ? AND message_id = ?`,
        )
        .get(key, nextMessage.id) as { ok: number } | undefined;
      if (!completed) {
        break;
      }
      watermark = nextMessage.id;
    }

    this.db.prepare("UPDATE consumers SET watermark_id = ? WHERE key = ?").run(watermark, key);
    this.db
      .prepare("DELETE FROM consumer_completed_messages WHERE consumer_key = ? AND message_id <= ?")
      .run(key, watermark);
  }

  private assertMessageExecutionSourceRow(sourceRowId: number): void {
    const row = this.db.prepare("SELECT id FROM messages WHERE id = ?").get(sourceRowId) as { id: number } | undefined;
    if (!row) throw new Error("message_execution_lease_source_row_not_found");
  }

  private ensureConsumer(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO consumers (key, watermark_id) VALUES (?, 0)").run(key);
  }

  // ---- retracted (recall) ----

  markRetracted(groupId: string, msgId: string, nowMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO retracted (msg_key, retracted_at) VALUES (?, ?)")
      .run(`${groupId}:${msgId}`, nowMs);
    this.db.prepare("UPDATE image_previews SET status = 'deleted', prompt = NULL, prompt_summary = '', deleted_at = ?, updated_at = ? WHERE group_id = ? AND output_message_id = ? AND status = 'available'")
      .run(nowMs, nowMs, groupId, msgId);
  }

  isRetracted(groupId: string, msgId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM retracted WHERE msg_key = ?")
      .get(`${groupId}:${msgId}`) as { found: number } | undefined;
    return Boolean(row);
  }

  pruneRetracted(beforeMs: number): void {
    this.db.prepare("DELETE FROM retracted WHERE retracted_at < ?").run(beforeMs);
  }

  // ---- in-flight registry (per key) ----

  registerInflight(key: string, taskId: string, startedAtMs: number, cancelToken: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inflight (key, task_id, started_at, cancel_token, cancel_requested, merged_reply)
         VALUES (?, ?, ?, ?, 0, NULL)`,
      )
      .run(key, taskId, startedAtMs, cancelToken);
  }

  getInflight(key: string): InflightRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM inflight WHERE key = ?")
      .get(key) as InflightRow | undefined;
    return row;
  }

  requestCancel(key: string): void {
    this.db
      .prepare("UPDATE inflight SET cancel_requested = 1 WHERE key = ?")
      .run(key);
  }

  clearInflight(key: string, taskId?: string): void {
    if (taskId) {
      this.db.prepare("DELETE FROM inflight WHERE key = ? AND task_id = ?").run(key, taskId);
      return;
    }
    this.db.prepare("DELETE FROM inflight WHERE key = ?").run(key);
  }

  // ---- outbox (worker → emitter) ----

  enqueueOutbox(
    groupId: string,
    replyTo: string | null,
    text: string,
    kind = "text",
    context?: OutboxContext,
    forwardPayloadJson?: string,
    autoRecall?: OutboxAutoRecallPolicy,
    imagePreviewId?: string,
  ): number {
    if (imagePreviewId && (kind !== "generated_image" || !this.db.prepare(
      "SELECT id FROM image_previews WHERE id = ? AND group_id = ? AND status = 'available' AND publication_state = 'published' AND expires_at > ?",
    ).get(imagePreviewId, groupId, Date.now()))) throw new Error("image_preview_delivery_invalid");
    const status = context && context.turnId === undefined ? "preparing" : "pending";
    const recallPolicy = normalizeOutboxAutoRecallPolicy(autoRecall);
    const result = this.db
      .prepare(
        `INSERT INTO outbox
           (group_id, reply_to, kind, text, status, topic_id, branch_id,
            source_turn_id, turn_id, created_at, forward_payload_json,
            auto_recall_after_ms, auto_recall_deadline_ms, image_preview_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        replyTo,
        kind,
        text,
        status,
        context?.topicId ?? null,
        context?.branchId ?? null,
        context?.sourceTurnId ?? null,
        context?.turnId ?? null,
        Date.now(),
        forwardPayloadJson ?? null,
        recallPolicy?.afterMs ?? null,
        recallPolicy?.deadlineMs ?? null,
        imagePreviewId ?? null,
      );
    const id = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE outbox SET delivery_id = ? WHERE id = ?").run(`outbox:${id}`, id);
    return id;
  }

  /**
   * Creates the generated-image Outbox row and binds it to an already staged
   * image-request ledger record in one transaction. A retry returns the
   * original row rather than creating another QQ delivery.
   */
  enqueueGeneratedImageOutboxForRequest(input: {
    requestId: string;
    groupId: string;
    imagePath: string;
    imagePreviewId: string;
    context?: OutboxContext;
    now?: number;
  }): GeneratedImageRequestOutbox {
    const requestId = input.requestId.trim();
    const groupId = input.groupId.trim();
    const imagePath = input.imagePath.trim();
    const imagePreviewId = input.imagePreviewId.trim();
    const now = normalizeEpochMs(input.now ?? Date.now(), "generated image outbox created_at");
    if (!/^imgreq_[a-f0-9-]{36}$/.test(requestId)) throw new Error("image_request_id_invalid");
    if (!groupId || groupId.length > 160) throw new Error("image_request_group_id_invalid");
    if (!imagePath || imagePath.length > 4_096) throw new Error("image_request_staged_path_invalid");
    if (!/^[A-Za-z0-9_-]{43}$/.test(imagePreviewId)) throw new Error("image_request_preview_id_invalid");

    return this.withImmediateTransaction(() => {
      const request = this.db.prepare(
        `SELECT id, group_id, source_message_id, status, image_preview_id, outbox_id
           FROM image_requests WHERE id = ?`,
      ).get(requestId) as {
        id: string;
        group_id: string;
        source_message_id: string;
        status: string;
        image_preview_id: string | null;
        outbox_id: number | null;
      } | undefined;
      if (!request) throw new Error("image_request_not_found");
      if (request.group_id !== groupId) throw new Error("image_request_group_mismatch");
      if (["queued", "delivered", "delivery_unknown"].includes(request.status)) {
        if (request.outbox_id === null) throw new Error("image_request_outbox_missing");
        if (request.image_preview_id !== imagePreviewId) throw new Error("image_request_preview_conflict");
        const outbox = this.db.prepare("SELECT group_id FROM outbox WHERE id = ?").get(request.outbox_id) as { group_id: string } | undefined;
        if (!outbox || outbox.group_id !== groupId) throw new Error("image_request_outbox_missing");
        return { outboxId: request.outbox_id, created: false };
      }
      if (request.status !== "generated") throw new Error("image_request_not_generated");
      if (request.image_preview_id && request.image_preview_id !== imagePreviewId) {
        throw new Error("image_request_preview_conflict");
      }
      const preview = this.db.prepare(
        `SELECT group_id, source_message_id, publication_state
           FROM image_previews
          WHERE id = ? AND status = 'available' AND expires_at > ?`,
      ).get(imagePreviewId, now) as { group_id: string; source_message_id: string; publication_state: string } | undefined;
      if (!preview || preview.group_id !== groupId || preview.source_message_id !== request.source_message_id) {
        throw new Error("image_request_preview_invalid");
      }
      if (preview.publication_state !== "pending") {
        throw new Error("image_request_preview_not_pending");
      }

      const status = input.context && input.context.turnId === undefined ? "preparing" : "pending";
      const inserted = this.db.prepare(
        `INSERT INTO outbox
           (group_id, reply_to, kind, text, status, topic_id, branch_id,
            source_turn_id, turn_id, created_at, image_preview_id)
         VALUES (?, NULL, 'generated_image', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        groupId,
        imagePath,
        status,
        input.context?.topicId ?? null,
        input.context?.branchId ?? null,
        input.context?.sourceTurnId ?? null,
        input.context?.turnId ?? null,
        now,
        imagePreviewId,
      );
      const outboxId = Number(inserted.lastInsertRowid);
      this.db.prepare("UPDATE outbox SET delivery_id = ? WHERE id = ?").run(`outbox:${outboxId}`, outboxId);
      const linked = this.db.prepare(
        `UPDATE image_requests
            SET status = 'queued', image_preview_id = ?, outbox_id = ?, updated_at = ?, error_code = NULL
          WHERE id = ? AND status = 'generated' AND (image_preview_id IS NULL OR image_preview_id = ?) AND outbox_id IS NULL`,
      ).run(imagePreviewId, outboxId, now, requestId, imagePreviewId);
      if (Number(linked.changes) !== 1) throw new Error("image_request_outbox_link_failed");
      const published = this.db.prepare(
        `UPDATE image_previews
            SET publication_state = 'published', updated_at = ?
          WHERE id = ? AND group_id = ? AND status = 'available' AND publication_state = 'pending'`,
      ).run(now, imagePreviewId, groupId);
      if (Number(published.changes) !== 1) throw new Error("image_request_preview_publish_failed");
      return { outboxId, created: true };
    });
  }

  /**
   * Atomically claims pending rows for delivery: each row is flipped to
   * 'sending' before the network call, so a crash/retry can never double-send
   * the same outbox row (plan §6 red line: duplicate_reply_rate must be 0).
   * 'sending' rows older than one minute are quarantined as terminal failures:
   * delivery is ambiguous after a sender crash, so retrying would risk a QQ
   * duplicate. Operators can inspect and decide whether a new message is safe.
   */
  claimOutbox(limit: number, nowMs = Date.now()): OutboxRow[] {
    this.recoverStaleSendingOutbox(nowMs);
    return this.withImmediateTransaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM outbox
             WHERE status = 'pending'
                OR (status = 'failed' AND retry_after IS NOT NULL AND retry_after <= ?)
             ORDER BY id ASC LIMIT ?`,
        )
        .all(nowMs, limit) as Array<{ id: number }>;
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE outbox
              SET status = 'sending', updated_at = ?, attempts = attempts + 1
            WHERE id IN (${placeholders})
              AND (status = 'pending'
                OR (status = 'failed' AND retry_after IS NOT NULL AND retry_after <= ?))`,
        )
        .run(nowMs, ...ids, nowMs);
      return this.db
        .prepare(`SELECT * FROM outbox WHERE id IN (${placeholders}) AND status = 'sending' ORDER BY id`)
        .all(...ids) as unknown as OutboxRow[];
    });
  }

  /**
   * A stalled `sending` record is delivery-ambiguous: QQ may already have
   * received it, so it must never be sent again automatically. Turn it into a
   * terminal failed record for operator review instead of leaving the queue
   * permanently wedged.
   */
  recoverStaleSendingOutbox(nowMs = Date.now(), staleAfterMs = 60_000): number {
    const cutoff = nowMs - Math.max(1_000, staleAfterMs);
    return this.withImmediateTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE outbox
              SET status = 'failed', retry_after = NULL, updated_at = ?
            WHERE status = 'sending'
              AND updated_at IS NOT NULL
              AND updated_at <= ?`,
        )
        .run(nowMs, cutoff);
      this.markImageRequestDeliveryUnknownForTerminalOutbox(nowMs);
      return Number(result.changes);
    });
  }

  markOutboxSent(id: number): void {
    const now = Date.now();
    this.db
      .prepare("UPDATE outbox SET status = 'sent', retry_after = NULL, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  /**
   * Atomically stores the real platform id and makes it available as a reply
   * anchor. A recall task is created only when the sender confirms it sent the
   * actual forward card; an explicit text fallback must never inherit it.
   */
  ackOutboxDelivery(
    id: number,
    platformMessageId: string,
    sentAtMs = Date.now(),
    options: { actualForward?: boolean } = {},
  ): void {
    const normalizedMessageId = platformMessageId.trim();
    if (!normalizedMessageId) {
      throw new Error("platformMessageId must not be empty");
    }
    this.withImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
      if (!row) {
        throw new Error(`Outbox row ${id} does not exist`);
      }
      if (row.platform_message_id && row.platform_message_id !== normalizedMessageId) {
        throw new Error(`Outbox row ${id} was already acknowledged with a different platform message id`);
      }
      const sentAt = row.sent_at ?? sentAtMs;
      this.db
        .prepare(
          `UPDATE outbox
              SET status = 'sent', retry_after = NULL, platform_message_id = ?, sent_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(normalizedMessageId, sentAt, sentAtMs, id);
      if (row.image_preview_id) this.db.prepare(
        "UPDATE image_previews SET output_message_id = ?, updated_at = ? WHERE id = ? AND group_id = ? AND (output_message_id IS NULL OR output_message_id = ?)",
      ).run(normalizedMessageId, sentAtMs, row.image_preview_id, row.group_id, normalizedMessageId);
      if (row.image_preview_id && this.isRetracted(row.group_id, normalizedMessageId)) {
        this.db.prepare("UPDATE image_previews SET status = 'deleted', prompt = NULL, prompt_summary = '', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'available'")
          .run(sentAtMs, sentAtMs, row.image_preview_id);
      }
      this.db.prepare(
        `UPDATE image_requests
            SET status = 'delivered', error_code = NULL,
                completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE outbox_id = ? AND status IN ('queued', 'delivery_unknown')`,
      ).run(sentAtMs, sentAtMs, row.id);
      this.db
        .prepare("INSERT OR REPLACE INTO bot_messages (group_id, msg_id, sent_at) VALUES (?, ?, ?)")
        .run(row.group_id, normalizedMessageId, sentAt);
      if (
        options.actualForward === true &&
        row.kind === "forward" &&
        row.auto_recall_after_ms !== null &&
        row.auto_recall_deadline_ms !== null
      ) {
        this.insertMessageRecall({
          outboxId: row.id,
          groupId: row.group_id,
          platformMessageId: normalizedMessageId,
          sentAtMs: sentAt,
          policy: {
            afterMs: row.auto_recall_after_ms,
            deadlineMs: row.auto_recall_deadline_ms,
          },
        });
      }
      this.syncOutboxConversationContext(
        { ...row, platform_message_id: normalizedMessageId, sent_at: sentAt },
        sentAt,
      );
    });
  }

  /**
   * Persists a recall for a legacy/direct sender after that sender obtains the
   * real QQ receipt. The group/message uniqueness makes repeated receipt
   * handling idempotent.
   */
  scheduleDirectMessageRecall(
    groupId: string,
    platformMessageId: string,
    policy: OutboxAutoRecallPolicy,
    sentAtMs = Date.now(),
  ): MessageRecallRow {
    const normalizedGroupId = groupId.trim();
    const normalizedMessageId = platformMessageId.trim();
    if (!normalizedGroupId) {
      throw new Error("groupId must not be empty");
    }
    if (!normalizedMessageId) {
      throw new Error("platformMessageId must not be empty");
    }
    const normalizedPolicy = normalizeOutboxAutoRecallPolicy(policy);
    if (!normalizedPolicy) {
      throw new Error("A message recall policy is required");
    }
    return this.withImmediateTransaction(() => this.insertMessageRecall({
      groupId: normalizedGroupId,
      platformMessageId: normalizedMessageId,
      sentAtMs,
      policy: normalizedPolicy,
    }));
  }

  /**
   * Attaches the causal context after enqueue. If delivery already completed,
   * the real QQ id is exposed as an anchor in the same transaction.
   */
  attachOutboxContext(deliveryId: string, context: OutboxContext): void {
    this.attachOutboxContexts([deliveryId], context);
  }

  /** Attaches every multipart row and exposes them for sending in one transaction. */
  attachOutboxContexts(deliveryIds: string[], context: OutboxContext): void {
    const normalizedIds = [...new Set(deliveryIds.map((id) => id.trim()).filter(Boolean))];
    if (normalizedIds.length === 0) {
      return;
    }
    if (context.turnId === undefined) {
      throw new Error("A persisted assistant turn is required before outbox delivery");
    }
    this.withImmediateTransaction(() => {
      for (const normalizedDeliveryId of normalizedIds) {
        this.attachOneOutboxContext(normalizedDeliveryId, context);
      }
    });
  }

  private attachOneOutboxContext(normalizedDeliveryId: string, context: OutboxContext): void {
    const row = this.findOutboxByDeliveryId(normalizedDeliveryId);
    if (!row) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} does not exist`);
    }
    if (
      (row.topic_id && row.topic_id !== context.topicId) ||
      (row.branch_id && row.branch_id !== context.branchId) ||
      (row.turn_id !== null && context.turnId !== undefined && row.turn_id !== context.turnId)
    ) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} is already attached to a different conversation route`);
    }
    const canonicalDeliveryId = `outbox:${row.id}`;
    if (row.delivery_id && row.delivery_id !== normalizedDeliveryId && row.delivery_id !== canonicalDeliveryId) {
      throw new Error(`Outbox delivery ${normalizedDeliveryId} does not match its stored delivery id`);
    }
    this.db
      .prepare(
        `UPDATE outbox
            SET delivery_id = COALESCE(delivery_id, ?),
                topic_id = COALESCE(topic_id, ?),
                branch_id = COALESCE(branch_id, ?),
                turn_id = COALESCE(turn_id, ?),
                status = CASE WHEN status = 'preparing' THEN 'pending' ELSE status END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        canonicalDeliveryId,
        context.topicId,
        context.branchId,
        context.turnId ?? null,
        Date.now(),
        row.id,
      );
    const attached = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(row.id) as unknown as OutboxRow;
    this.syncOutboxConversationContext(attached, attached.sent_at ?? Date.now());
  }

  markOutboxFailed(id: number, retryAfterMs: number | null = 2_000): void {
    const now = Date.now();
    this.withImmediateTransaction(() => {
      if (retryAfterMs === null) {
        this.db
          .prepare("UPDATE outbox SET status = 'failed', retry_after = NULL, updated_at = ? WHERE id = ?")
          .run(now, id);
      } else {
        const retryAfter = now + Math.max(1_000, retryAfterMs);
        this.db
          .prepare(
            `UPDATE outbox
                SET status = 'failed',
                    retry_after = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(MAX_OUTBOX_DELIVERY_ATTEMPTS, retryAfter, now, id);
      }
      this.markImageRequestDeliveryUnknownForTerminalOutbox(now, id);
    });
  }

  // ---- durable bot-message recalls ----

  /**
   * Claims due recall work before the platform deadline. A claimant owns the
   * row until it records a terminal result or an explicit not-sent retry.
   */
  claimDueMessageRecalls(limit: number, nowMs = Date.now()): MessageRecallRow[] {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return [];
    }
    const now = normalizeEpochMs(nowMs, "nowMs");
    return this.withImmediateTransaction(() => {
      this.expireMessageRecallsInTransaction(now);
      const candidates = this.db
        .prepare(
          `SELECT id FROM message_recalls
             WHERE status = 'pending'
               AND due_at <= ?
               AND deadline_at >= ?
             ORDER BY due_at ASC, id ASC
             LIMIT ?`,
        )
        .all(now, now, normalizedLimit) as Array<{ id: number }>;
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE message_recalls
              SET status = 'sending', attempts = attempts + 1,
                  claimed_at = ?, updated_at = ?
            WHERE id IN (${placeholders})
              AND status = 'pending'
              AND due_at <= ?
              AND deadline_at >= ?`,
        )
        .run(now, now, ...ids, now, now);
      return this.db
        .prepare(
          `SELECT * FROM message_recalls
             WHERE id IN (${placeholders}) AND status = 'sending'
             ORDER BY due_at ASC, id ASC`,
        )
        .all(...ids) as unknown as MessageRecallRow[];
    });
  }

  /** Marks pending work past its safety deadline as terminal without sending it. */
  expireMessageRecalls(nowMs = Date.now()): number {
    const now = normalizeEpochMs(nowMs, "nowMs");
    return this.withImmediateTransaction(() => this.expireMessageRecallsInTransaction(now));
  }

  /**
   * A recall action left in-flight across a process crash is ambiguous. Never
   * replay it automatically because it may already have recalled the card.
   */
  recoverStaleSendingMessageRecalls(nowMs = Date.now(), staleAfterMs = 30_000): number {
    const now = normalizeEpochMs(nowMs, "nowMs");
    const cutoff = now - normalizeNonNegativeDurationMs(staleAfterMs, "staleAfterMs");
    const result = this.db
      .prepare(
        `UPDATE message_recalls
            SET status = 'outcome_unknown', completed_at = COALESCE(completed_at, ?),
                updated_at = ?
          WHERE status = 'sending'
            AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .run(now, now, cutoff);
    return Number(result.changes);
  }

  /** Completes a claimed recall with a definite platform outcome. */
  markMessageRecallTerminal(
    id: number,
    status: Exclude<MessageRecallStatus, "pending" | "sending">,
    nowMs = Date.now(),
  ): boolean {
    if (!TERMINAL_MESSAGE_RECALL_STATUSES.has(status)) {
      throw new Error(`Unsupported terminal recall status: ${status}`);
    }
    const now = normalizeEpochMs(nowMs, "nowMs");
    const result = this.db
      .prepare(
        `UPDATE message_recalls
            SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE id = ? AND status = 'sending'`,
      )
      .run(status, now, now, id);
    return Number(result.changes) === 1;
  }

  /**
   * Requeues a definitely unsent action exactly once. A second unsent result,
   * or a retry target after the deadline, is terminalized instead.
   */
  rescheduleMessageRecallAfterNotSent(id: number, retryAtMs: number, nowMs = Date.now()): boolean {
    const now = normalizeEpochMs(nowMs, "nowMs");
    const requestedRetryAt = normalizeEpochMs(retryAtMs, "retryAtMs");
    return this.withImmediateTransaction(() => {
      const row = this.db
        .prepare("SELECT * FROM message_recalls WHERE id = ?")
        .get(id) as MessageRecallRow | undefined;
      if (!row || row.status !== "sending") {
        return false;
      }
      const retryAt = Math.max(now, requestedRetryAt);
      if (now > row.deadline_at || retryAt > row.deadline_at) {
        this.terminalizeMessageRecallInTransaction(id, "expired", now);
        return false;
      }
      if (row.attempts >= MAX_MESSAGE_RECALL_ATTEMPTS) {
        this.terminalizeMessageRecallInTransaction(id, "not_sent_expired", now);
        return false;
      }
      const result = this.db
        .prepare(
          `UPDATE message_recalls
              SET status = 'pending', due_at = ?, claimed_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'sending'`,
        )
        .run(retryAt, now, id);
      return Number(result.changes) === 1;
    });
  }

  /**
   * Records a recall notification received from QQ. Matching jobs become
   * definitively recalled, whether another operator or this process performed it.
   */
  markMessageRecallObserved(groupId: string, platformMessageId: string, nowMs = Date.now()): number {
    const normalizedGroupId = groupId.trim();
    const normalizedMessageId = platformMessageId.trim();
    if (!normalizedGroupId || !normalizedMessageId) {
      return 0;
    }
    const now = normalizeEpochMs(nowMs, "nowMs");
    const result = this.db
      .prepare(
        `UPDATE message_recalls
            SET status = 'recalled', completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE group_id = ? AND platform_message_id = ?
            AND status <> 'recalled'`,
      )
      .run(now, now, normalizedGroupId, normalizedMessageId);
    return Number(result.changes);
  }

  /** Deletes finished audit rows after the normal bot-message retention period. */
  pruneTerminalMessageRecalls(beforeMs: number): number {
    const before = normalizeEpochMs(beforeMs, "beforeMs");
    const result = this.db
      .prepare(
        `DELETE FROM message_recalls
          WHERE status IN ('recalled', 'rejected', 'outcome_unknown', 'expired', 'unsupported', 'not_sent_expired')
            AND completed_at IS NOT NULL
            AND completed_at < ?`,
      )
      .run(before);
    return Number(result.changes);
  }

  getMessageRecall(id: number): MessageRecallRow | undefined {
    return this.db
      .prepare("SELECT * FROM message_recalls WHERE id = ?")
      .get(id) as MessageRecallRow | undefined;
  }

  private insertMessageRecall(input: InsertMessageRecallInput): MessageRecallRow {
    const normalizedPolicy = normalizeOutboxAutoRecallPolicy(input.policy);
    if (!normalizedPolicy) {
      throw new Error("A message recall policy is required");
    }
    const sentAt = normalizeEpochMs(input.sentAtMs, "sentAtMs");
    const dueAt = addEpochMs(sentAt, normalizedPolicy.afterMs, "auto recall due time");
    const deadlineAt = addEpochMs(sentAt, normalizedPolicy.deadlineMs, "auto recall deadline");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO message_recalls
           (outbox_id, group_id, platform_message_id, sent_at, due_at, deadline_at,
            status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        input.outboxId ?? null,
        input.groupId,
        input.platformMessageId,
        sentAt,
        dueAt,
        deadlineAt,
        now,
        now,
      );
    if (input.outboxId !== undefined) {
      this.db
        .prepare(
          `UPDATE message_recalls
              SET outbox_id = COALESCE(outbox_id, ?)
            WHERE group_id = ? AND platform_message_id = ?`,
        )
        .run(input.outboxId, input.groupId, input.platformMessageId);
    }
    const row = this.db
      .prepare("SELECT * FROM message_recalls WHERE group_id = ? AND platform_message_id = ?")
      .get(input.groupId, input.platformMessageId) as MessageRecallRow | undefined;
    if (!row) {
      throw new Error("Unable to persist message recall");
    }
    return row;
  }

  private expireMessageRecallsInTransaction(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE message_recalls
            SET status = 'expired', completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE status = 'pending' AND deadline_at < ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  private terminalizeMessageRecallInTransaction(
    id: number,
    status: Exclude<MessageRecallStatus, "pending" | "sending">,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE message_recalls
            SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE id = ? AND status = 'sending'`,
      )
      .run(status, now, now, id);
    return Number(result.changes) === 1;
  }

  /** Removes worker-only drafts that have never become visible to the emitter. */
  discardPreparingOutbox(deliveryIds: string[]): number {
    const ids = [...new Set(deliveryIds.map(parseOutboxDeliveryId).filter((id): id is number => id !== undefined))];
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM outbox WHERE id IN (${placeholders}) AND status = 'preparing'`)
      .run(...ids);
    return Number(result.changes);
  }

  /** Removes drafts left by a crashed attempt of this exact routed user turn. */
  discardPreparingOutboxForSource(
    topicId: string,
    branchId: string,
    sourceTurnId: number,
  ): number {
    const result = this.db
      .prepare(
        `DELETE FROM outbox
          WHERE status = 'preparing'
            AND topic_id = ?
            AND branch_id = ?
            AND source_turn_id = ?`,
      )
      .run(topicId, branchId, sourceTurnId);
    return Number(result.changes);
  }

  // ---- bot self messages (used to filter self-referencing chains) ----

  recordBotMessage(groupId: string, msgId: string, sentAtMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO bot_messages (group_id, msg_id, sent_at) VALUES (?, ?, ?)")
      .run(groupId, msgId, sentAtMs);
  }

  /**
   * Confirms that a reply anchor is one of this bot's acknowledged messages.
   * A bare OneBot reply segment is not trusted because it can quote any group
   * member, including a message that has no relationship to the bot.
   */
  isKnownBotMessage(groupId: string, msgId: string | null | undefined): boolean {
    const normalizedGroupId = groupId.trim();
    const normalizedMessageId = msgId?.trim();
    if (!normalizedGroupId || !normalizedMessageId) {
      return false;
    }
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM bot_messages WHERE group_id = ? AND msg_id = ? LIMIT 1")
        .get(normalizedGroupId, normalizedMessageId),
    );
  }

  pruneBotMessages(beforeMs: number): void {
    this.db.prepare("DELETE FROM bot_messages WHERE sent_at < ?").run(beforeMs);
  }

  private findOutboxByDeliveryId(deliveryId: string): OutboxRow | undefined {
    const direct = this.db.prepare("SELECT * FROM outbox WHERE delivery_id = ?").get(deliveryId) as OutboxRow | undefined;
    if (direct) {
      return direct;
    }
    const match = /^outbox:(\d+)$/.exec(deliveryId);
    if (!match) {
      return undefined;
    }
    return this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(Number(match[1])) as OutboxRow | undefined;
  }

  private syncOutboxConversationContext(row: OutboxRow, createdAt: number): void {
    if (!row.topic_id || !row.branch_id || !row.platform_message_id) {
      return;
    }
    const existingContext = this.db
      .prepare(
        `SELECT topic_id, branch_id, turn_id
           FROM conversation_message_context
          WHERE group_id = ? AND platform_message_id = ?`,
      )
      .get(row.group_id, row.platform_message_id) as {
        topic_id: string;
        branch_id: string;
        turn_id: number | null;
      } | undefined;
    if (
      existingContext &&
      (existingContext.topic_id !== row.topic_id ||
        existingContext.branch_id !== row.branch_id ||
        (existingContext.turn_id !== null && row.turn_id !== null && existingContext.turn_id !== row.turn_id))
    ) {
      throw new Error("Platform message id is already bound to a different conversation route");
    }
    this.db
      .prepare(
        `INSERT INTO conversation_message_context
           (group_id, platform_message_id, topic_id, branch_id, turn_id, direction, created_at)
         VALUES (?, ?, ?, ?, ?, 'assistant', ?)
         ON CONFLICT(group_id, platform_message_id) DO UPDATE SET
           topic_id = excluded.topic_id,
           branch_id = excluded.branch_id,
           turn_id = COALESCE(conversation_message_context.turn_id, excluded.turn_id),
           direction = excluded.direction`,
      )
      .run(row.group_id, row.platform_message_id, row.topic_id, row.branch_id, row.turn_id, createdAt);
    if (row.turn_id !== null) {
      this.db
        .prepare(
          `UPDATE conversation_turns
              SET platform_message_id = COALESCE(platform_message_id, ?),
                  delivery_id = COALESCE(delivery_id, ?)
            WHERE id = ? AND topic_id = ? AND branch_id = ?`,
        )
        .run(row.platform_message_id, row.delivery_id, row.turn_id, row.topic_id, row.branch_id);
    }
  }

  /**
   * A terminal QQ send failure is delivery-ambiguous for a generated image.
   * Keep that fact on the ledger so replay cannot enqueue another card; a late
   * verified receipt may still promote it to delivered.
   */
  private markImageRequestDeliveryUnknownForTerminalOutbox(now: number, outboxId?: number): void {
    const byId = outboxId === undefined ? "" : "AND outbox_id = ?";
    this.db.prepare(
      `UPDATE image_requests
          SET status = 'delivery_unknown', error_code = COALESCE(error_code, 'delivery_unknown'),
              completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE status = 'queued'
          ${byId}
          AND EXISTS (
            SELECT 1 FROM outbox
             WHERE outbox.id = image_requests.outbox_id
               AND outbox.status = 'failed'
               AND outbox.retry_after IS NULL
          )`,
    ).run(now, now, ...(outboxId === undefined ? [] : [outboxId]));
  }

  private withImmediateTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseOutboxDeliveryId(value: string): number | undefined {
  const match = /^outbox:(\d+)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function messageExecutionLeaseFromRow(row: {
  execution_scope: string;
  source_row_id: number;
  status: "running" | "completed";
  lease_token: string | null;
  lease_expires_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}): MessageExecutionLeaseRecord {
  return {
    executionScope: row.execution_scope,
    sourceRowId: row.source_row_id,
    status: row.status,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMessageExecutionScope(value: string | undefined): string {
  const scope = value === undefined ? DEFAULT_MESSAGE_EXECUTION_SCOPE : value.trim();
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/.test(scope)) {
    throw new Error("message_execution_lease_scope_invalid");
  }
  return scope;
}

function isMessageExecutionSourceRowId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function requireMessageExecutionSourceRowId(value: number): number {
  if (!isMessageExecutionSourceRowId(value)) {
    throw new Error("message_execution_lease_source_row_id_invalid");
  }
  return value;
}

function normalizeMessageExecutionLeaseMs(value: number | undefined): number {
  if (value === undefined) return MESSAGE_EXECUTION_LEASE_DEFAULT_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 60_000) {
    throw new Error("message_execution_lease_duration_invalid");
  }
  return value;
}

function normalizeMessageExecutionTimestamp(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(errorCode);
  }
  return value;
}

function requireMessageExecutionLeaseToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw new Error("message_execution_lease_token_invalid");
  }
  return token;
}

function createMessageExecutionLeaseToken(): string {
  return randomBytes(24).toString("base64url");
}

function requireMessageExecutionConsumerKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256) {
    throw new Error("message_execution_lease_consumer_key_invalid");
  }
  return key;
}

function requireMessageExecutionIdentifier(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(errorCode);
  }
  return normalized;
}

function normalizeOutboxAutoRecallPolicy(
  policy: OutboxAutoRecallPolicy | undefined,
): OutboxAutoRecallPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  const afterMs = normalizeDurationMs(policy.afterMs, "autoRecall.afterMs");
  const deadlineMs = normalizeDurationMs(policy.deadlineMs, "autoRecall.deadlineMs");
  if (deadlineMs < afterMs) {
    throw new Error("autoRecall.deadlineMs must be greater than or equal to autoRecall.afterMs");
  }
  return { afterMs, deadlineMs };
}

function normalizeDurationMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer duration`);
  }
  return value;
}

function normalizeNonNegativeDurationMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer duration`);
  }
  return value;
}

function normalizeEpochMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function addEpochMs(baseMs: number, offsetMs: number, name: string): number {
  const result = baseMs + offsetMs;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${name} exceeds the safe integer range`);
  }
  return result;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeCanonicalSegmentsJson(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return Array.isArray(parsed) && parsed.length <= 64 ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeSenderRole(value: string | undefined): "owner" | "admin" | "member" | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "owner" || normalized === "admin" || normalized === "member" ? normalized : null;
}

function normalizeVerifiedMentionUserIds(values: string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter((value) => /^\d{5,12}$/.test(value)),
  )];
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/** Opens the shared DB at the conventional location under a `data/shared` directory. */
export function openSharedDb(dataDir: string): SharedDb {
  return new SharedDb(`${dataDir}${dataDir.endsWith("/") || dataDir.endsWith("\\") ? "" : "/"}shared/bot-shared.db`);
}
