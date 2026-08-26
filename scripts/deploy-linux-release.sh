#!/usr/bin/env bash
# Deploys one already-built UBot release bundle on Linux.
#
# The archive must come from `npm run package:linux`. Runtime state never enters
# the archive: .env, data, skills and config are persistent paths linked into
# the new release only after a consistent backup has completed.
set -euo pipefail

VERSION="${1:?Usage: deploy-linux-release.sh <version> <bundle.tar.gz> [outbox-ids]}"
BUNDLE="${2:?Usage: deploy-linux-release.sh <version> <bundle.tar.gz> [outbox-ids]}"
OUTBOX_IDS="${3:-}"

case "$VERSION" in
  *[!0-9A-Za-z._-]*|"")
    echo "Invalid release version: $VERSION" >&2
    exit 2
    ;;
esac
if [[ ! -f "$BUNDLE" ]]; then
  echo "Release bundle not found: $BUNDLE" >&2
  exit 2
fi

APP_ROOT="${UBOT_APP_ROOT:-/opt/ai-project}"
RELEASE_ROOT="${UBOT_RELEASE_ROOT:-/opt/ai-project-releases}"
SERVICE_NAME="${UBOT_SERVICE_NAME:-ai-project.service}"
RELEASE_DIR="$RELEASE_ROOT/v$VERSION"
STAGING_DIR="$RELEASE_ROOT/.staging-v$VERSION-$$"
BACKUP_ROOT="$APP_ROOT/release-backups"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP-v$VERSION"
SYSTEMD_ROOT="${UBOT_SYSTEMD_ROOT:-/etc/systemd/system}"
DROPIN_DIR="$SYSTEMD_ROOT/$SERVICE_NAME.d"
CONTROLLED_DROPIN="$DROPIN_DIR/release.conf"
PERSISTENT_CONFIG="$APP_ROOT/config"
PERSISTENT_DATA="$APP_ROOT/data"
PERSISTENT_SKILLS="$APP_ROOT/skills"
PERSISTENT_ENV="$APP_ROOT/.env"
DB_PATH="$PERSISTENT_DATA/shared/bot-shared.db"

old_service_active="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
old_current_link=""
current_is_directory=0
old_controlled_dropin_exists=0
rollback_armed=0

require_command() {
  command -v "$1" >/dev/null || {
    echo "Required command is missing: $1" >&2
    exit 2
  }
}
for command in node npm tar systemctl sudo curl; do
  require_command "$command"
done
sudo -n true

if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
  echo "Release directory already exists: $RELEASE_DIR" >&2
  exit 2
fi
if [[ ! -f "$PERSISTENT_ENV" ]]; then
  echo "Persistent .env is missing: $PERSISTENT_ENV" >&2
  exit 2
fi

mkdir -p "$RELEASE_ROOT" "$BACKUP_DIR" "$PERSISTENT_DATA" "$PERSISTENT_SKILLS"
if [[ -L "$RELEASE_ROOT/current" ]]; then
  old_current_link="$(readlink "$RELEASE_ROOT/current")"
elif [[ -e "$RELEASE_ROOT/current" ]]; then
  # Some legacy installations use a real directory named `current`. The
  # service is selected by a systemd drop-in, so leave that directory alone
  # rather than moving a path another operator may still use.
  current_is_directory=1
  echo "Legacy non-symlink current path detected; systemd drop-in remains the release selector." >&2
fi
if sudo test -f "$CONTROLLED_DROPIN"; then
  sudo cp "$CONTROLLED_DROPIN" "$BACKUP_DIR/release.conf.before"
  old_controlled_dropin_exists=1
fi

rollback() {
  local exit_code="$?"
  if [[ "$rollback_armed" -ne 1 ]]; then
    exit "$exit_code"
  fi
  echo "Deployment failed; restoring prior release selection." >&2
  if [[ "$old_controlled_dropin_exists" -eq 1 ]]; then
    sudo cp "$BACKUP_DIR/release.conf.before" "$CONTROLLED_DROPIN" || true
  else
    sudo rm -f "$CONTROLLED_DROPIN" || true
  fi
  if [[ -n "$old_current_link" ]]; then
    ln -sfn "$old_current_link" "$RELEASE_ROOT/current" || true
  elif [[ "$current_is_directory" -eq 0 ]]; then
    rm -f "$RELEASE_ROOT/current" || true
  fi
  sudo systemctl daemon-reload || true
  if [[ "$old_service_active" == "active" ]]; then
    sudo systemctl start "$SERVICE_NAME" || true
  fi
  exit "$exit_code"
}
trap rollback ERR

# Stop before copying an old release config or taking any backup so that JSON,
# SQLite and skills belong to one consistent point in time.
if [[ "$old_service_active" == "active" ]]; then
  sudo systemctl stop "$SERVICE_NAME"
fi
rollback_armed=1

# Current v2 layouts may still keep groups.json under the release directory.
# Promote it exactly once to persistent state before creating the new symlink.
mkdir -p "$PERSISTENT_CONFIG"
if [[ ! -f "$PERSISTENT_CONFIG/groups.json" ]]; then
  current_working_directory="$(systemctl show "$SERVICE_NAME" --property=WorkingDirectory --value 2>/dev/null || true)"
  if [[ -n "$current_working_directory" && -f "$current_working_directory/config/groups.json" ]]; then
    cp "$current_working_directory/config/groups.json" "$PERSISTENT_CONFIG/groups.json"
  else
    echo "Persistent config/groups.json is missing and no current release copy was found." >&2
    exit 2
  fi
fi

# Keep both a portable persistent-state archive and a point-in-time SQLite copy.
tar -C "$APP_ROOT" -czf "$BACKUP_DIR/persistent-files.tar.gz" \
  .env config data skills
cp "$PERSISTENT_CONFIG/groups.json" "$BACKUP_DIR/groups.json.before"

if [[ -f "$DB_PATH" ]]; then
  DB_PATH="$DB_PATH" BACKUP_DB_PATH="$BACKUP_DIR/bot-shared.db" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH);
try {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
  }
  const escaped = process.env.BACKUP_DB_PATH.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}
NODE
fi

# Explicitly terminalize only caller-approved historical records. They are never
# replayed: a previous QQ send may already have reached the platform.
if [[ -n "$OUTBOX_IDS" ]]; then
  DB_PATH="$DB_PATH" OUTBOX_IDS="$OUTBOX_IDS" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const ids = [...new Set((process.env.OUTBOX_IDS ?? "").split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0))];
if (!ids.length) throw new Error("No valid approved Outbox IDs were provided");
const db = new DatabaseSync(process.env.DB_PATH);
try {
  db.exec("BEGIN IMMEDIATE");
  const placeholders = ids.map(() => "?").join(",");
  const previous = db.prepare(`SELECT id, status, retry_after FROM outbox WHERE id IN (${placeholders})`).all(...ids);
  if (previous.length !== ids.length) {
    throw new Error(`Expected ${ids.length} approved Outbox rows, found ${previous.length}`);
  }
  const result = db.prepare(
    `UPDATE outbox
        SET status = 'failed', retry_after = NULL, updated_at = ?
      WHERE id IN (${placeholders})`,
  ).run(Date.now(), ...ids);
  if (Number(result.changes) !== ids.length) {
    throw new Error(`Expected to quarantine ${ids.length} Outbox rows, changed ${result.changes}`);
  }
  db.exec("COMMIT");
  console.log(JSON.stringify({ quarantinedOutboxIds: ids, previous }));
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  throw error;
} finally {
  db.close();
}
NODE
fi

# No retryable historical delivery is allowed before starting RC.2.
if [[ -f "$DB_PATH" ]]; then
  DB_PATH="$DB_PATH" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
try {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM outbox WHERE status IN ('pending', 'preparing', 'sending') OR (status = 'failed' AND retry_after IS NOT NULL)",
  ).get();
  if (Number(row.count) !== 0) {
    throw new Error(`Retryable Outbox rows remain before deployment: ${row.count}`);
  }
} finally {
  db.close();
}
NODE
fi

mkdir -p "$STAGING_DIR"
tar -xzf "$BUNDLE" -C "$STAGING_DIR"
for required in package.json package-lock.json dist/index.js scripts/start-prod.sh scripts/deploy-linux-release.sh scripts/migrate-participation-mode.mjs; do
  if [[ ! -e "$STAGING_DIR/$required" ]]; then
    echo "Release bundle is missing required path: $required" >&2
    exit 2
  fi
done
bundle_version="$(node -p "require('$STAGING_DIR/package.json').version")"
if [[ "$bundle_version" != "$VERSION" ]]; then
  echo "Bundle version $bundle_version does not match requested version $VERSION" >&2
  exit 2
fi

# The archive contains an already-tested dist build; install only runtime deps.
(
  cd "$STAGING_DIR"
  npm ci --omit=dev --ignore-scripts
)

# Apply the reviewed RC.1 replacement for the legacy source-heavy IT skill.
# The persistent skills directory was already backed up above.
if [[ -f "$STAGING_DIR/managed-skills/itexpert.json" ]]; then
  cp "$STAGING_DIR/managed-skills/itexpert.json" "$PERSISTENT_SKILLS/itexpert.json"
fi

# Runtime state is deliberate persistent storage, never archive content.
rm -rf "$STAGING_DIR/.env" "$STAGING_DIR/data" "$STAGING_DIR/skills" "$STAGING_DIR/config"
ln -s "$PERSISTENT_ENV" "$STAGING_DIR/.env"
ln -s "$PERSISTENT_DATA" "$STAGING_DIR/data"
ln -s "$PERSISTENT_SKILLS" "$STAGING_DIR/skills"
ln -s "$PERSISTENT_CONFIG" "$STAGING_DIR/config"
mv "$STAGING_DIR" "$RELEASE_DIR"

# Fill only missing participation modes after backing up groups.json. Existing
# explicit group settings are preserved; RC.1's approved migration is quiet.
node "$RELEASE_DIR/scripts/migrate-participation-mode.mjs" \
  --groups "$PERSISTENT_CONFIG/groups.json" \
  --mode mentions_only \
  --execute

if [[ -L "$RELEASE_ROOT/current" ]]; then
  ln -sfn "$RELEASE_DIR" "$RELEASE_ROOT/current"
elif [[ -e "$RELEASE_ROOT/current" ]]; then
  printf '%s\n' "$RELEASE_DIR" > "$RELEASE_ROOT/current/ACTIVE_RELEASE"
else
  ln -s "$RELEASE_DIR" "$RELEASE_ROOT/current"
fi
sudo mkdir -p "$DROPIN_DIR"
sudo tee "$CONTROLLED_DROPIN" >/dev/null <<EOF
[Service]
WorkingDirectory=$RELEASE_DIR
ExecStart=
ExecStart=$RELEASE_DIR/scripts/start-prod.sh
EOF
sudo systemctl daemon-reload
sudo systemctl start "$SERVICE_NAME"

sleep 3
if [[ "$(systemctl is-active "$SERVICE_NAME")" != "active" ]]; then
  echo "Service did not become active." >&2
  exit 1
fi

# The Admin health endpoint deliberately requires a session. Its 401 response
# confirms that the service is listening without exposing an unauthenticated API.
health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 http://127.0.0.1:6200/api/health || true)"
if [[ "$health_status" != "401" ]]; then
  echo "Expected protected admin health endpoint to return 401, got $health_status" >&2
  exit 1
fi

# Startup must apply the additive migrations, and all approved legacy Outbox rows
# must remain terminal. Do not require a globally empty queue after startup: a
# newly arrived real message may legitimately create a fresh Outbox entry.
DB_PATH="$DB_PATH" OUTBOX_IDS="$OUTBOX_IDS" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
try {
  const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
  const expected = [1, 2, 3, 4];
  if (JSON.stringify(migrations) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected schema migrations after startup: ${JSON.stringify(migrations)}`);
  }
  const ids = [...new Set((process.env.OUTBOX_IDS ?? "").split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, status, retry_after FROM outbox WHERE id IN (${placeholders})`).all(...ids);
    if (rows.length !== ids.length || rows.some((row) => row.status !== 'failed' || row.retry_after !== null)) {
      throw new Error(`Approved historical Outbox quarantine did not persist: ${JSON.stringify(rows)}`);
    }
  }
} finally {
  db.close();
}
NODE

main_pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value)"
child_count="$(pgrep -P "$main_pid" -f 'node dist/index.js' | wc -l | tr -d ' ')"
if [[ "$child_count" -ne 3 ]]; then
  echo "Expected three UBot child processes, found $child_count" >&2
  exit 1
fi

rollback_armed=0
trap - ERR
printf 'UBot %s deployed successfully. Backup: %s\n' "$VERSION" "$BACKUP_DIR"
