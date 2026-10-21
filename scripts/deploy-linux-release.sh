#!/usr/bin/env bash
# Deploy one verified UBot V3 release on Linux.
#
# This script deliberately performs a one-way state cutover. It backs up the
# old persistent state before migration, but never restores a database or
# replays QQ messages automatically after the V3 migration has completed.
set -euo pipefail
umask 077

# A root deployment must not inherit a caller-controlled command search path
# or temporary directory.  Node is added explicitly after its verified runtime
# has been installed below.
SYSTEM_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
PATH="$SYSTEM_PATH"
TMPDIR="/tmp"
export PATH TMPDIR
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS

DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-linux-release.sh <version> <bundle.tar.gz> [bundle.tar.gz.sha256]

The archive and manifest must be the matching downloaded GitHub Release assets.
The deployer verifies their SHA-256 manifest locally before extracting anything.

Optional environment:
  UBOT_LEGACY_SERVICE=ai-project.service
  UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json
  UBOT_NAPCAT_REVERSE_URL=ws://172.21.0.1:6199/onebot/ws
  UBOT_NAPCAT_CONTAINER=napcat
  UBOT_NODE22_VERSION=22.22.1

The target must be able to reach api.github.com and the public release asset
URL (HTTPS_PROXY is honored by curl when a proxy is required).

The preview host is installed separately from bot.9958.uk. This release never
replaces the active bot vhost or other existing Nginx sites.
USAGE
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

# The runtime is deliberately root-owned and isolated from the host-wide Node
# installation. The deployer also owns sensitive file permissions, so running
# it through sudo is an explicit part of the production contract.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run the production deployer as root, for example: sudo bash scripts/deploy-linux-release.sh ..." >&2
  exit 2
fi

VERSION="$1"
BUNDLE="$2"
CHECKSUM_FILE="${3:-$BUNDLE.sha256}"
BUNDLE_SOURCE="$BUNDLE"
CHECKSUM_SOURCE="$CHECKSUM_FILE"
BUNDLE_STAGING_DIR=""
BUNDLE_STAGED_PATH=""
CHECKSUM_STAGED_PATH=""

case "$VERSION" in
  *[!0-9A-Za-z._-]*|"")
    echo "Invalid release version." >&2
    exit 2
    ;;
esac

if [[ -L "$BUNDLE" || ! -f "$BUNDLE" || -L "$CHECKSUM_FILE" || ! -f "$CHECKSUM_FILE" ]]; then
  echo "Downloaded GitHub Release bundle or its SHA-256 manifest is missing." >&2
  exit 2
fi
if [[ "$(basename "$BUNDLE")" != "ubot-$VERSION-linux.tar.gz" ]]; then
  echo "Bundle must retain the matching GitHub Release asset name: ubot-$VERSION-linux.tar.gz" >&2
  exit 2
fi

APP_ROOT="/opt/ai-project"
RELEASE_ROOT="/opt/ai-project-releases"
NODE22_VERSION="${UBOT_NODE22_VERSION:-22.22.1}"
NODE_RUNTIME_ROOT="/opt/ubot-runtime"
NODE_RUNTIME_LINK="$NODE_RUNTIME_ROOT/node22"
NODE_RUNTIME_INSTALLER="$DEPLOY_SCRIPT_DIR/install-node22-runtime.sh"
NODE_BIN="$NODE_RUNTIME_LINK/bin/node"
NPM_BIN="$NODE_RUNTIME_LINK/bin/npm"
SYSTEMD_ROOT="/etc/systemd/system"
LEGACY_SERVICE="${UBOT_LEGACY_SERVICE:-ai-project.service}"
RELEASE_DIR="$RELEASE_ROOT/v$VERSION"
STAGING_DIR=""
CURRENT_LINK="$RELEASE_ROOT/current"
PERSISTENT_ENV="$APP_ROOT/.env"
PERSISTENT_DATA="$APP_ROOT/data"
BT_RUNTIME_ROOT="$APP_ROOT/bt-runtime"
BT_RUNTIME_PYTHON="$BT_RUNTIME_ROOT/venv/bin/python"
BT_RUNTIME_BROWSERS="$BT_RUNTIME_ROOT/browsers"
BT_STATE_ROOT="$PERSISTENT_DATA/bt"
DB_PATH="$PERSISTENT_DATA/shared/bot-shared.db"
ROLLBACK_DIR="$PERSISTENT_DATA/v3-rollback"
SKILLS_DIR="$APP_ROOT/skills"
BACKUP_ROOT="$APP_ROOT/release-backups"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR=""
NAPCAT_CONFIG="${UBOT_NAPCAT_CONFIG:-/opt/napcat/config/onebot11_428881701.json}"
NAPCAT_REVERSE_URL="${UBOT_NAPCAT_REVERSE_URL:-ws://172.21.0.1:6199/onebot/ws}"
NAPCAT_URL_PATH="network.websocketClients.0.url"
NAPCAT_CONFIG_STAGING=""
NAPCAT_CONTAINER="${UBOT_NAPCAT_CONTAINER:-napcat}"
NAPCAT_RESTART_TIMEOUT_SECONDS=60
GITHUB_RELEASE_REPOSITORY="Jelix-o/ubot-ai-agent"
# These targets are intentionally not configurable: accepting an arbitrary
# /etc/nginx path would let a deployment environment variable overwrite an
# unrelated production vhost. Only this isolated preview site is release-owned.
PREVIEW_NGINX_CONFIG="/etc/nginx/sites-available/preview-9958"
PREVIEW_NGINX_INCLUDE="/etc/nginx/ubot-preview-static.conf"
PREVIEW_NGINX_ENABLED_LINK="/etc/nginx/sites-enabled/preview-9958"
BOT_NGINX_CONFIG="/etc/nginx/sites-available/bot-9958"
BOT_NGINX_ENABLED_LINK="/etc/nginx/sites-enabled/bot-9958"
BOT_CERTIFICATE="/etc/ssl/cloudflare/bot.9958.uk.pem"
BOT_CERTIFICATE_KEY="/etc/ssl/cloudflare/bot.9958.uk.key"
PREVIEW_CERTIFICATE="/etc/ssl/cloudflare/preview.9958.uk.pem"
PREVIEW_CERTIFICATE_KEY="/etc/ssl/cloudflare/preview.9958.uk.key"
PREVIEW_ROOT=""
PREVIEW_ROOT_PAGES=""
LEGACY_PREVIEW_ROOT=""
REQUIRED_PREVIEW_ROOT="/var/lib/ubot-preview"
RUNTIME_USER="ubot"
RUNTIME_GROUP="ubot"
CLOUDFLARE_ORIGIN_CONFIG="/etc/nginx/conf.d/ubot-cloudflare-origin.conf"
CLOUDFLARE_REALIP_CONFIG="/etc/nginx/ubot-cloudflare-realip.conf"
CLOUDFLARE_ORIGIN_READY_MARKER="/etc/nginx/ubot-cloudflare-origin.ready"
INGRESS_READ_API_HEALTH_URL="http://127.0.0.1:6198/read/health"
ADMIN_HEALTH_URL="http://127.0.0.1:6200/api/health"
HEALTH_CHECK_ATTEMPTS=30
INGRESS_READ_API_TOKEN=""
RUNTIME_IDENTITY_MANIFEST=""
PREVIEW_ROOT_EXISTED_BEFORE=0
PREVIEW_RELOCATED=0
RUNTIME_SERVICES=(ubot-ingress.service ubot-worker.service ubot-admin.service)
SERVICE_RESTART_COUNTS=()
MAINTENANCE_SERVICE="ubot-maintenance.service"
MAINTENANCE_TIMER="ubot-maintenance.timer"
CLOUDFLARE_ALLOWLIST_SERVICE="ubot-cloudflare-allowlist.service"
CLOUDFLARE_ALLOWLIST_TIMER="ubot-cloudflare-allowlist.timer"
ENABLEMENT_UNITS=(ubot.target ubot-maintenance.timer ubot-cloudflare-allowlist.timer)
UNIT_WAS_ENABLED=()
BT_RUNTIME_PRESENT=0

if [[ -n "${UBOT_APP_ROOT:-}" && "$UBOT_APP_ROOT" != "$APP_ROOT" ]] ||
   [[ -n "${UBOT_RELEASE_ROOT:-}" && "$UBOT_RELEASE_ROOT" != "$RELEASE_ROOT" ]] ||
   [[ -n "${UBOT_NODE_RUNTIME_ROOT:-}" && "$UBOT_NODE_RUNTIME_ROOT" != "$NODE_RUNTIME_ROOT" ]] ||
   [[ -n "${UBOT_SYSTEMD_ROOT:-}" && "$UBOT_SYSTEMD_ROOT" != "$SYSTEMD_ROOT" ]]; then
  echo "Application, release, Node runtime, and systemd root paths are fixed in the hardened production topology." >&2
  exit 2
fi

# These are the only legacy runtime files that the one-way state migration can
# remove after it commits the SQLite cutover marker. Keep this list aligned
# with collectLegacySources() in migrate-v3-state.mjs.
LEGACY_SOURCE_PATHS=(
  "$APP_ROOT/config/groups.json"
  "$PERSISTENT_DATA/system-settings.json"
  "$PERSISTENT_DATA/group-memory.json"
  "$PERSISTENT_DATA/knowledge-base.json"
  "$PERSISTENT_DATA/scheduled-reminders.json"
  "$PERSISTENT_DATA/daily-report-store.json"
  "$PERSISTENT_DATA/holiday-countdown-store.json"
  "$PERSISTENT_DATA/admin-tasks.json"
  "$PERSISTENT_DATA/model-health-history.json"
  "$PERSISTENT_DATA/admin-operations.jsonl"
  "$PERSISTENT_DATA/group-memory-candidates.json"
  "$PERSISTENT_DATA/daily-profile-review.json"
  "$PERSISTENT_DATA/profile-records.json"
  "$PERSISTENT_DATA/conversations.json"
  "$PERSISTENT_DATA/shared/atmosphere.json"
  "$PERSISTENT_DATA/shared/topics.json"
)

UNIT_FILES=(
  ubot-ingress.service
  ubot-worker.service
  ubot-admin.service
  ubot.target
  ubot-maintenance.service
  ubot-maintenance.timer
  ubot-cloudflare-allowlist.service
  ubot-cloudflare-allowlist.timer
)

old_current_target=""
old_legacy_active=0
old_target_active=0
old_napcat_active=0
old_maintenance_timer_active=0
old_maintenance_service_active=0
old_cloudflare_timer_active=0
old_cloudflare_service_active=0
existing_cutover_before_deploy=0
cutover_may_have_started=0
rollback_armed=0
napcat_restart_attempted=0
maintenance_writer_quiesced=0
cloudflare_updater_quiesced=0
cloudflare_updater_masked=0
cloudflare_updater_resume_blocked=0

require_command() {
  command -v "$1" >/dev/null || {
    echo "Required command is missing: $1" >&2
    exit 2
  }
}

fail_bootstrap_safety_check() {
  echo "Deployment bootstrap safety check failed: $1" >&2
  exit 2
}

assert_root_controlled_source_tree() {
  local source_tree="$1"
  local label="$2"
  local current metadata mode unsafe_entry unsafe_link
  if [[ -L "$source_tree" || ! -d "$source_tree" ]]; then
    fail_bootstrap_safety_check "$label must be a real directory: $source_tree"
  fi
  current="$source_tree"
  while :; do
    if [[ -L "$current" || ! -e "$current" ]]; then
      fail_bootstrap_safety_check "$label ancestor must be a real existing path: $current"
    fi
    metadata="$(stat -c '%u:%g:%a' "$current")"
    if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
      fail_bootstrap_safety_check "$label ancestor must be owned by root:root: $current"
    fi
    mode=$((8#${metadata##*:}))
    if (( (mode & 18) != 0 )); then
      fail_bootstrap_safety_check "$label ancestor must not be writable by group or other users: $current"
    fi
    if [[ "$current" == "/" ]]; then
      break
    fi
    current="$(dirname "$current")"
  done
  unsafe_entry="$(find "$source_tree" -xdev \( -type f -o -type d \) \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)"
  if [[ -n "$unsafe_entry" ]]; then
    fail_bootstrap_safety_check "$label contains non-root-controlled content: $unsafe_entry"
  fi
  unsafe_link="$(find "$source_tree" -xdev -type l -print -quit)"
  if [[ -n "$unsafe_link" ]]; then
    fail_bootstrap_safety_check "$label must not contain symbolic links: $unsafe_link"
  fi
}

for command in tar sha256sum systemctl sudo curl install mv readlink ln nginx mktemp dirname basename find docker sleep stat sed openssl grep getent useradd chown chmod cp id rmdir env passwd awk; do
  require_command "$command"
done
sudo -n true

# Do not bootstrap a root deployment from an old, mutable `current` release.
# Resolve the actual script path first so invoking a trusted release through
# the `current` symlink still checks the immutable versioned release tree.
DEPLOY_SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
DEPLOY_SCRIPT_DIR="$(dirname "$DEPLOY_SCRIPT_PATH")"
NODE_RUNTIME_INSTALLER="$DEPLOY_SCRIPT_DIR/install-node22-runtime.sh"
assert_root_controlled_source_tree "$DEPLOY_SCRIPT_DIR" "Deployment helper source"

if [[ ! -f "$NODE_RUNTIME_INSTALLER" ]]; then
  echo "Node 22 runtime installer is missing from the release." >&2
  exit 2
fi
bash "$NODE_RUNTIME_INSTALLER" "$NODE22_VERSION"
if [[ ! -x "$NODE_BIN" || ! -x "$NPM_BIN" ]] || [[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" != "22" ]]; then
  echo "The application-scoped Node 22 runtime is unavailable or invalid." >&2
  exit 2
fi
PATH="$NODE_RUNTIME_LINK/bin:$SYSTEM_PATH"
export PATH
for command in node npm; do
  require_command "$command"
done

case "$NAPCAT_CONTAINER" in
  [!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*|"")
    echo "UBOT_NAPCAT_CONTAINER must be a Docker container name." >&2
    exit 2
    ;;
esac

fail_cutover_preflight() {
  echo "Pre-cutover access check failed: $1" >&2
  exit 2
}

cleanup_staged_release_inputs() {
  # Only remove the two files this root process created in its own 0700
  # directory. Never recursively remove an operator-provided path.
  if [[ -z "$BUNDLE_STAGING_DIR" || ! -d "$BUNDLE_STAGING_DIR" ]]; then
    return 0
  fi
  rm -f -- "$BUNDLE_STAGED_PATH" "$CHECKSUM_STAGED_PATH" || true
  rmdir -- "$BUNDLE_STAGING_DIR" 2>/dev/null || true
}

stage_release_inputs() {
  local staged_bundle_name
  if [[ -L "$BUNDLE_SOURCE" || ! -f "$BUNDLE_SOURCE" ||
        -L "$CHECKSUM_SOURCE" || ! -f "$CHECKSUM_SOURCE" ]]; then
    fail_cutover_preflight "Release bundle and SHA-256 manifest must be regular files, not symbolic links."
  fi

  staged_bundle_name="$(basename "$BUNDLE_SOURCE")"
  BUNDLE_STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.incoming-v${VERSION}.XXXXXX")"
  BUNDLE_STAGED_PATH="$BUNDLE_STAGING_DIR/$staged_bundle_name"
  CHECKSUM_STAGED_PATH="$BUNDLE_STAGING_DIR/manifest.sha256"

  # Copy with no dereference so a source path swapped for a symlink between
  # validation and copy is preserved as a symlink and rejected below. From
  # this point onward every hash, provenance, structure, and extraction check
  # reads the root-owned snapshot instead of the mutable download path.
  if ! cp --no-dereference -- "$BUNDLE_SOURCE" "$BUNDLE_STAGED_PATH" ||
     ! cp --no-dereference -- "$CHECKSUM_SOURCE" "$CHECKSUM_STAGED_PATH"; then
    cleanup_staged_release_inputs
    fail_cutover_preflight "Could not snapshot the downloaded GitHub Release assets."
  fi
  if [[ -L "$BUNDLE_STAGED_PATH" || ! -f "$BUNDLE_STAGED_PATH" ||
        -L "$CHECKSUM_STAGED_PATH" || ! -f "$CHECKSUM_STAGED_PATH" ]]; then
    cleanup_staged_release_inputs
    fail_cutover_preflight "Release asset snapshot contains a symbolic link or non-regular file."
  fi
  chown root:root -- "$BUNDLE_STAGED_PATH" "$CHECKSUM_STAGED_PATH"
  chmod 0600 -- "$BUNDLE_STAGED_PATH" "$CHECKSUM_STAGED_PATH"
  BUNDLE="$BUNDLE_STAGED_PATH"
  CHECKSUM_FILE="$CHECKSUM_STAGED_PATH"
}

require_safe_absolute_path() {
  local value="$1"
  local label="$2"
  local required_prefix="$3"
  if [[ ! "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$value" == *"//"* ]] ||
     [[ "$value" == *"/./"* ]] || [[ "$value" == *"/../"* ]] || [[ "$value" == */.. ]]; then
    fail_cutover_preflight "$label must be a normalized absolute path containing only safe path characters."
  fi
  if [[ "$value" != "$required_prefix"* ]] || [[ "$value" == "$required_prefix" ]]; then
    fail_cutover_preflight "$label must stay under $required_prefix"
  fi
}

validate_preview_nginx_paths() {
  if [[ "$PREVIEW_NGINX_CONFIG" != "/etc/nginx/sites-available/preview-9958" ]] ||
     [[ "$PREVIEW_NGINX_INCLUDE" != "/etc/nginx/ubot-preview-static.conf" ]] ||
     [[ "$PREVIEW_NGINX_ENABLED_LINK" != "/etc/nginx/sites-enabled/preview-9958" ]]; then
    fail_cutover_preflight "Preview Nginx targets are fixed to the dedicated preview-9958 site."
  fi
  require_safe_absolute_path "$PREVIEW_CERTIFICATE" "Preview Origin certificate" "/etc/ssl/cloudflare/"
  require_safe_absolute_path "$PREVIEW_CERTIFICATE_KEY" "Preview Origin certificate key" "/etc/ssl/cloudflare/"
  if [[ "$PREVIEW_NGINX_CONFIG" == "$PREVIEW_NGINX_INCLUDE" ]] ||
     [[ "$PREVIEW_NGINX_CONFIG" == "$PREVIEW_NGINX_ENABLED_LINK" ]] ||
     [[ "$PREVIEW_NGINX_INCLUDE" == "$PREVIEW_NGINX_ENABLED_LINK" ]]; then
    fail_cutover_preflight "Preview Nginx vhost, include, and enabled-link paths must be distinct."
  fi
}

require_mutable_directory() {
  local directory="$1"
  local label="$2"
  local probe
  if [[ ! -d "$directory" ]]; then
    fail_cutover_preflight "$label directory is missing: $directory"
  fi
  if [[ ! -w "$directory" || ! -x "$directory" ]]; then
    fail_cutover_preflight "$label directory must be writable and searchable by the deployment user: $directory"
  fi
  if ! probe="$(mktemp "$directory/.ubot-v3-write-check.XXXXXX")"; then
    fail_cutover_preflight "$label directory cannot create an atomic-write probe: $directory"
  fi
  if ! rm -f -- "$probe"; then
    fail_cutover_preflight "$label directory cannot remove its atomic-write probe: $directory"
  fi
}

require_root_or_runtime_owned_directory() {
  local directory="$1"
  local label="$2"
  local owner_id runtime_uid
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    fail_cutover_preflight "$label must be a real directory: $directory"
  fi
  owner_id="$(stat -c '%u' "$directory")"
  runtime_uid="$(id -u "$RUNTIME_USER")"
  if [[ ! "$owner_id" =~ ^[0-9]+$ || ! "$runtime_uid" =~ ^[0-9]+$ ]] ||
     [[ "$owner_id" != "0" && "$owner_id" != "$runtime_uid" ]]; then
    fail_cutover_preflight "$label must be owned by root or the constrained UBot runtime account: $directory"
  fi
}

require_readable_file() {
  local file_path="$1"
  local label="$2"
  if [[ ! -f "$file_path" ]]; then
    fail_cutover_preflight "$label is missing or is not a regular file: $file_path"
  fi
  if [[ ! -r "$file_path" ]]; then
    fail_cutover_preflight "$label must be readable by the deployment user: $file_path"
  fi
}

require_atomically_replaceable_file() {
  local file_path="$1"
  local label="$2"
  local parent
  if [[ -L "$file_path" ]]; then
    fail_cutover_preflight "$label must not be a symbolic link: $file_path"
  fi
  require_readable_file "$file_path" "$label"
  parent="$(dirname "$file_path")"
  require_mutable_directory "$parent" "$label parent"
  # A sticky parent only permits replacing an existing file when the
  # deployment user owns it. configure-v3-network.mjs uses rename(2), so a
  # simple writable-directory test alone is not enough for that layout.
  if [[ -k "$parent" && ! -O "$file_path" ]]; then
    fail_cutover_preflight "$label must be owned by the deployment user when its parent is sticky: $file_path"
  fi
}

require_sudo_mutable_directory() {
  local directory="$1"
  local label="$2"
  if ! sudo -n test -d "$directory" || ! sudo -n test -w "$directory" || ! sudo -n test -x "$directory"; then
    fail_cutover_preflight "$label directory must be writable and searchable through sudo: $directory"
  fi
}

require_sudo_readable_regular_file() {
  local file_path="$1"
  local label="$2"
  if ! sudo -n test -f "$file_path" || ! sudo -n test -r "$file_path"; then
    fail_cutover_preflight "$label is missing, not a regular file, or not readable through sudo: $file_path"
  fi
}

preflight_preview_nginx_targets() {
  local target
  validate_preview_nginx_paths
  for target in "$PREVIEW_NGINX_CONFIG" "$PREVIEW_NGINX_INCLUDE"; do
    if sudo -n test -L "$target"; then
      fail_cutover_preflight "Dedicated preview Nginx file must not be a symlink: $target"
    fi
    if sudo -n test -e "$target" && ! sudo -n test -f "$target"; then
      fail_cutover_preflight "Dedicated preview Nginx target must be a regular file when present: $target"
    fi
  done
  if sudo -n test -e "$PREVIEW_NGINX_ENABLED_LINK" && ! sudo -n test -L "$PREVIEW_NGINX_ENABLED_LINK"; then
    fail_cutover_preflight "Preview Nginx enabled target must be a symlink when present: $PREVIEW_NGINX_ENABLED_LINK"
  fi
  require_sudo_mutable_directory "$(dirname "$PREVIEW_NGINX_CONFIG")" "Preview Nginx vhost"
  require_sudo_mutable_directory "$(dirname "$PREVIEW_NGINX_INCLUDE")" "Preview Nginx static include"
  require_sudo_mutable_directory "$(dirname "$PREVIEW_NGINX_ENABLED_LINK")" "Preview Nginx enabled-link"
}

certificate_covers_hostname() {
  local certificate="$1"
  local hostname="$2"
  local dns_entries
  # `openssl -ext subjectAltName` is presentation output. Extract each DNS
  # field and compare whole names so `bot.9958.uk.evil.example` cannot match
  # the required host by substring. The Origin CA wildcard is intentionally
  # limited to the exact shared zone wildcard.
  if ! dns_entries="$(sudo -n openssl x509 -in "$certificate" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^,[:space:]]+' | sed 's/^DNS://')"; then
    return 1
  fi
  printf '%s\n' "$dns_entries" | grep -Fqx -e "$hostname" -e '*.9958.uk'
}

preflight_origin_certificate() {
  local certificate="$1"
  local certificate_key="$2"
  local hostname="$3"
  local label="$4"
  local cert_public_key key_public_key certificate_metadata key_metadata directory_metadata certificate_mode directory_mode
  local minimum_validity_seconds=604800
  if sudo -n test -L "$certificate" || sudo -n test -L "$certificate_key"; then
    fail_cutover_preflight "$label Origin certificate and key must not be symbolic links."
  fi
  require_sudo_readable_regular_file "$certificate" "$label TLS certificate"
  require_sudo_readable_regular_file "$certificate_key" "$label TLS certificate key"
  certificate_metadata="$(sudo -n stat -c '%u:%g:%a' "$certificate")"
  key_metadata="$(sudo -n stat -c '%u:%g:%a' "$certificate_key")"
  directory_metadata="$(sudo -n stat -c '%u:%g:%a' "$(dirname "$certificate_key")")"
  if [[ ! "$certificate_metadata" =~ ^0:0:[0-7]{3,4}$ ]] ||
     [[ ! "$key_metadata" =~ ^0:0:(600|640)$ ]] || [[ ! "$directory_metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
    fail_cutover_preflight "$label Origin certificate and private key must be root-owned; private keys must be 0600 or 0640 in a root-owned directory."
  fi
  certificate_mode=$((8#${certificate_metadata##*:}))
  directory_mode=$((8#${directory_metadata##*:}))
  if (( (certificate_mode & 18) != 0 )); then
    fail_cutover_preflight "$label Origin certificate file must not be writable by group or other users."
  fi
  if (( (directory_mode & 18) != 0 )); then
    fail_cutover_preflight "$label Origin certificate directory must not be writable by group or other users."
  fi
  if ! sudo -n openssl x509 -in "$certificate" -noout -checkend "$minimum_validity_seconds" >/dev/null 2>&1; then
    fail_cutover_preflight "$label Origin certificate is expired or expires within seven days."
  fi
  if ! certificate_covers_hostname "$certificate" "$hostname"; then
    fail_cutover_preflight "$label TLS certificate does not cover $hostname"
  fi
  if ! cert_public_key="$(sudo -n openssl x509 -in "$certificate" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{ print $1 }')"; then
    fail_cutover_preflight "$label TLS certificate public key could not be read."
  fi
  if ! key_public_key="$(sudo -n openssl pkey -in "$certificate_key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{ print $1 }')"; then
    fail_cutover_preflight "$label TLS certificate key could not be read."
  fi
  if [[ ! "$cert_public_key" =~ ^[a-f0-9]{64}$ ]] || [[ "$cert_public_key" != "$key_public_key" ]]; then
    fail_cutover_preflight "$label TLS certificate and key do not match."
  fi
}

load_preview_settings() {
  local loaded_roots
  if ! loaded_roots="$(PERSISTENT_ENV="$PERSISTENT_ENV" PERSISTENT_DATA="$PERSISTENT_DATA" REQUIRED_PREVIEW_ROOT="$REQUIRED_PREVIEW_ROOT" APP_ROOT="$APP_ROOT" RELEASE_ROOT="$RELEASE_ROOT" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const values = new Map();
for (const raw of fs.readFileSync(process.env.PERSISTENT_ENV, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values.set(match[1], value);
}
const dataRoot = path.resolve(process.env.PERSISTENT_DATA);
const releaseRoot = path.resolve(process.env.RELEASE_ROOT);
const configuredValue = values.get("HTML_PREVIEW_ROOT")?.trim();
function normalizedAbsolute(value, label) {
  if (!path.isAbsolute(value) || value.includes("\0") || value !== path.resolve(value) || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${label} must be a normalized absolute Linux path without traversal`);
  }
  return value;
}
function isStrictChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isWithinOrEqual(root, candidate) {
  return path.resolve(root) === candidate || isStrictChild(path.resolve(root), candidate);
}
const configuredRoot = configuredValue ? normalizedAbsolute(configuredValue, "HTML_PREVIEW_ROOT") : undefined;
const legacyRoot = path.resolve(configuredRoot || path.join(dataRoot, "generated-pages"));
const requiredRoot = normalizedAbsolute(process.env.REQUIRED_PREVIEW_ROOT, "Required HTML preview root");
if (legacyRoot !== requiredRoot && !isStrictChild(dataRoot, legacyRoot)) {
  throw new Error("Existing HTML_PREVIEW_ROOT must be the managed preview root or a child of persistent data");
}
if (isWithinOrEqual(releaseRoot, legacyRoot) || isWithinOrEqual(releaseRoot, requiredRoot)) {
  throw new Error("HTML preview roots must never point into the release directory");
}
const publicBase = values.get("HTML_PREVIEW_PUBLIC_BASE_URL")?.trim() || "https://preview.9958.uk";
const parsed = new URL(publicBase);
if (parsed.origin !== "https://preview.9958.uk" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
  throw new Error("HTML_PREVIEW_PUBLIC_BASE_URL must be exactly https://preview.9958.uk in production");
}
process.stdout.write(`${requiredRoot}\n${legacyRoot}`);
NODE
  )"; then
    fail_cutover_preflight "Could not validate persistent HTML preview settings."
  fi
  PREVIEW_ROOT="$(sed -n '1p' <<< "$loaded_roots")"
  LEGACY_PREVIEW_ROOT="$(sed -n '2p' <<< "$loaded_roots")"
  if [[ -z "$PREVIEW_ROOT" || -z "$LEGACY_PREVIEW_ROOT" ]]; then
    fail_cutover_preflight "Could not parse persistent HTML preview settings."
  fi
  PREVIEW_ROOT_PAGES="$PREVIEW_ROOT/pages"
}

assert_real_preview_directory() {
  local directory="$1"
  local label="$2"
  if [[ -L "$directory" ]]; then
    fail_cutover_preflight "$label must not be a symbolic link: $directory"
  fi
  if [[ -e "$directory" && ! -d "$directory" ]]; then
    fail_cutover_preflight "$label must be a directory when present: $directory"
  fi
  if [[ -d "$directory" ]] && find "$directory" -type l -print -quit | grep -q .; then
    fail_cutover_preflight "$label must not contain symbolic links: $directory"
  fi
}

validate_preview_storage_paths() {
  if [[ -L "$PERSISTENT_DATA" || ! -d "$PERSISTENT_DATA" ]]; then
    fail_cutover_preflight "Persistent data directory must be a real directory: $PERSISTENT_DATA"
  fi
  assert_real_preview_directory "$LEGACY_PREVIEW_ROOT" "Existing HTML preview root"
  assert_real_preview_directory "$PREVIEW_ROOT" "Managed HTML preview root"
  if [[ -e "$PREVIEW_ROOT" ]]; then
    PREVIEW_ROOT_EXISTED_BEFORE=1
  fi
}

prepare_preview_root() {
  assert_real_preview_directory "$PREVIEW_ROOT" "Managed HTML preview root"
  install -d -m 0755 "$PREVIEW_ROOT"
  if [[ ! -w "$PREVIEW_ROOT" ]]; then
    fail_cutover_preflight "HTML preview root must be writable by the deployment process."
  fi
}

ensure_runtime_account() {
  if ! getent group "$RUNTIME_GROUP" >/dev/null; then
    groupadd --system "$RUNTIME_GROUP"
  fi
  if ! getent passwd "$RUNTIME_USER" >/dev/null; then
    useradd --system --gid "$RUNTIME_GROUP" --home-dir /nonexistent --shell /usr/sbin/nologin "$RUNTIME_USER"
  fi
  local account_entry account_name account_uid account_gid account_home account_shell group_entry group_gid group_members lock_status member primary_members
  local -a supplementary_members
  account_entry="$(getent passwd "$RUNTIME_USER")"
  IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell <<< "$account_entry"
  group_entry="$(getent group "$RUNTIME_GROUP")"
  IFS=: read -r _ _ group_gid group_members <<< "$group_entry"
  if [[ "$account_name" != "$RUNTIME_USER" || ! "$account_uid" =~ ^[0-9]+$ || ! "$account_gid" =~ ^[0-9]+$ ||
      ! "$group_gid" =~ ^[0-9]+$ || "$account_uid" -eq 0 || "$account_uid" -ge 1000 ||
      "$account_gid" != "$group_gid" || "$account_home" != "/nonexistent" ||
      ( "$account_shell" != "/usr/sbin/nologin" && "$account_shell" != "/sbin/nologin" ) ]]; then
    fail_cutover_preflight "UBot runtime account must be a non-login system account with /nonexistent home."
  fi
  lock_status="$(passwd -S "$RUNTIME_USER" | awk '{print $2}')"
  if [[ "$lock_status" != "L" && "$lock_status" != "LK" ]]; then
    fail_cutover_preflight "UBot runtime account password must be locked."
  fi
  local runtime_groups
  runtime_groups="$(id -nG "$RUNTIME_USER")"
  for prohibited_group in sudo adm docker lxd; do
    if [[ " $runtime_groups " == *" $prohibited_group "* ]]; then
      fail_cutover_preflight "UBot runtime account must not belong to privileged group: $prohibited_group"
    fi
  done
  # The persistent dotenv is root:ubot 0640. Reject a pre-existing shared
  # group so no other login account can read production credentials through
  # the group ACL, including an account that uses ubot as its primary GID.
  IFS=',' read -r -a supplementary_members <<< "$group_members"
  for member in "${supplementary_members[@]}"; do
    if [[ -n "$member" && "$member" != "$RUNTIME_USER" ]]; then
      fail_cutover_preflight "UBot runtime credential group must not contain another supplementary member."
    fi
  done
  primary_members="$(getent passwd | awk -F: -v gid="$group_gid" '$4 == gid { print $1 }')"
  while IFS= read -r member; do
    if [[ -n "$member" && "$member" != "$RUNTIME_USER" ]]; then
      fail_cutover_preflight "UBot runtime credential group must not be another account's primary group."
    fi
  done <<< "$primary_members"
}

lock_root_controlled_directory() {
  local target="$1"
  local label="$2"
  local create_if_missing="$3"
  local metadata mode
  if [[ -L "$target" ]]; then
    fail_cutover_preflight "$label must not be a symbolic link: $target"
  fi
  if [[ ! -e "$target" ]]; then
    if [[ "$create_if_missing" != "true" ]]; then
      fail_cutover_preflight "$label is missing: $target"
    fi
    install -d -m 0755 "$target"
  fi
  if [[ ! -d "$target" ]]; then
    fail_cutover_preflight "$label must be a directory: $target"
  fi
  chown root:root "$target"
  chmod 0755 "$target"
  metadata="$(stat -c '%u:%g:%a' "$target")"
  if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
    fail_cutover_preflight "$label must be owned by root:root: $target"
  fi
  mode=$((8#${metadata##*:}))
  if (( (mode & 18) != 0 )); then
    fail_cutover_preflight "$label must not be writable by group or other users: $target"
  fi
}

ensure_root_controlled_deployment_roots() {
  require_safe_absolute_path "$APP_ROOT" "Application root" "/opt/"
  require_safe_absolute_path "$RELEASE_ROOT" "Release root" "/opt/"
  require_safe_absolute_path "$NODE_RUNTIME_ROOT" "Node runtime root" "/opt/"
  lock_root_controlled_directory "/opt" "Application runtime ancestor" "false"
  lock_root_controlled_directory "$APP_ROOT" "Application root" "false"
  lock_root_controlled_directory "$RELEASE_ROOT" "Release root" "true"
  lock_root_controlled_directory "$NODE_RUNTIME_ROOT" "Node runtime root" "false"
}

assert_root_controlled_system_path() {
  local target="$1"
  local metadata mode
  while :; do
    if [[ -L "$target" || ! -e "$target" ]]; then
      fail_cutover_preflight "BT runtime external link target must be a real existing path: $target"
    fi
    metadata="$(stat -c '%u:%g:%a' "$target")"
    if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
      fail_cutover_preflight "BT runtime external link target must be owned by root:root: $target"
    fi
    mode=$((8#${metadata##*:}))
    if (( (mode & 18) != 0 )); then
      fail_cutover_preflight "BT runtime external link target must not be writable by group or other users: $target"
    fi
    if [[ "$target" == "/" ]]; then
      break
    fi
    target="$(dirname "$target")"
  done
}

validate_bt_runtime_links() {
  local link_path resolved_target
  while IFS= read -r -d '' link_path; do
    if ! resolved_target="$(readlink -f -- "$link_path")" || [[ ! -e "$resolved_target" ]]; then
      fail_cutover_preflight "BT runtime contains a dangling link: $link_path"
    fi
    if [[ "$resolved_target" == "$BT_RUNTIME_ROOT/"* ]]; then
      continue
    fi
    if [[ "$resolved_target" == /usr/* ]]; then
      assert_root_controlled_system_path "$resolved_target"
      continue
    fi
    fail_cutover_preflight "BT runtime link escapes the controlled runtime or /usr: $link_path"
  done < <(find "$BT_RUNTIME_ROOT" -xdev -type l -print0)
}

harden_bt_runtime() {
  local special_entry unsafe_entry unsafe_link
  if [[ ! -e "$BT_RUNTIME_ROOT" && ! -L "$BT_RUNTIME_ROOT" ]]; then
    return
  fi
  if [[ -L "$BT_RUNTIME_ROOT" || ! -d "$BT_RUNTIME_ROOT" ]]; then
    fail_cutover_preflight "BT runtime must be a real directory when present: $BT_RUNTIME_ROOT"
  fi
  if [[ -L "$BT_RUNTIME_ROOT/venv" || ! -d "$BT_RUNTIME_ROOT/venv" ||
        ! -f "$BT_RUNTIME_PYTHON" || ! -x "$BT_RUNTIME_PYTHON" ||
        -L "$BT_RUNTIME_BROWSERS" || ! -d "$BT_RUNTIME_BROWSERS" ]]; then
    fail_cutover_preflight "BT runtime must contain a real venv, executable Python, and browser directory before it can be hardened."
  fi
  special_entry="$(find "$BT_RUNTIME_ROOT" -xdev \( -type b -o -type c -o -type p -o -type s \) -print -quit)"
  if [[ -n "$special_entry" ]]; then
    fail_cutover_preflight "BT runtime must not contain device, FIFO, or socket entries: $special_entry"
  fi
  validate_bt_runtime_links

  # The worker only reads this dependency tree. Runtime state, cookies, caches,
  # and Chromium XDG files belong under data/bt, which is writable by ubot.
  chown -hR root:root -- "$BT_RUNTIME_ROOT"
  find "$BT_RUNTIME_ROOT" -xdev \( -type f -o -type d \) -exec chmod a+rX,go-w,u-s,g-s {} +
  unsafe_entry="$(find "$BT_RUNTIME_ROOT" -xdev \( -type f -o -type d \) \( ! -user root -o ! -group root -o -perm /022 -o -perm /6000 \) -print -quit)"
  if [[ -n "$unsafe_entry" ]]; then
    fail_cutover_preflight "BT runtime tree contains non-root-controlled or unsafe content: $unsafe_entry"
  fi
  unsafe_link="$(find "$BT_RUNTIME_ROOT" -xdev -type l \( ! -user root -o ! -group root \) -print -quit)"
  if [[ -n "$unsafe_link" ]]; then
    fail_cutover_preflight "BT runtime tree contains a non-root-owned link: $unsafe_link"
  fi
  BT_RUNTIME_PRESENT=1
}

prepare_bt_state_directory() {
  if [[ "$BT_RUNTIME_PRESENT" -ne 1 ]]; then
    return
  fi
  if [[ -L "$BT_STATE_ROOT" ]] || { [[ -e "$BT_STATE_ROOT" ]] && [[ ! -d "$BT_STATE_ROOT" ]]; }; then
    fail_cutover_preflight "BT state root must be a real directory when present: $BT_STATE_ROOT"
  fi
  install -d -m 0700 "$BT_STATE_ROOT"
  chown "$RUNTIME_USER:$RUNTIME_GROUP" "$BT_STATE_ROOT"
  chmod 0700 "$BT_STATE_ROOT"
}

verify_bt_runtime_user_access() {
  if [[ "$BT_RUNTIME_PRESENT" -ne 1 ]]; then
    return
  fi
  for target in "$BT_RUNTIME_ROOT" "$BT_RUNTIME_ROOT/venv" "$BT_RUNTIME_PYTHON" "$BT_RUNTIME_BROWSERS"; do
    if ! sudo -n -u "$RUNTIME_USER" -- test -r "$target" ||
       ! sudo -n -u "$RUNTIME_USER" -- test -x "$target"; then
      fail_cutover_preflight "UBot runtime account cannot read and traverse required BT runtime path: $target"
    fi
  done
  if ! sudo -n -u "$RUNTIME_USER" -- test -w "$BT_STATE_ROOT"; then
    fail_cutover_preflight "UBot runtime account cannot write its BT state directory: $BT_STATE_ROOT"
  fi
}

create_secure_backup_directory() {
  if [[ -L "$BACKUP_ROOT" ]] || { [[ -e "$BACKUP_ROOT" ]] && [[ ! -d "$BACKUP_ROOT" ]]; }; then
    fail_cutover_preflight "Release backup root must be a real directory: $BACKUP_ROOT"
  fi
  install -d -m 0700 "$BACKUP_ROOT"
  chown root:root "$BACKUP_ROOT"
  chmod 0700 "$BACKUP_ROOT"
  BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/${TIMESTAMP}-v${VERSION}.XXXXXX")"
  chmod 0700 "$BACKUP_DIR"
  NAPCAT_CONFIG_STAGING="$BACKUP_DIR/napcat-config.v3.json"
}

backup_external_preview_root() {
  local root="$1"
  local archive_name="$2"
  if [[ "$root" == "$PERSISTENT_DATA"/* || ! -e "$root" ]]; then
    return
  fi
  assert_real_preview_directory "$root" "External HTML preview root"
  tar -C / -czf "$BACKUP_DIR/$archive_name" -- "${root#/}"
  chmod 600 "$BACKUP_DIR/$archive_name"
}

record_runtime_identity() {
  RUNTIME_IDENTITY_MANIFEST="$BACKUP_DIR/runtime-identity.before.json"
  node - "$RUNTIME_IDENTITY_MANIFEST" "$PERSISTENT_DATA" "$PERSISTENT_ENV" "$LEGACY_PREVIEW_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [manifestPath, ...roots] = process.argv.slice(2);
const visited = new Set();
const records = [];

function record(target) {
  const resolved = path.resolve(target);
  if (visited.has(resolved) || !fs.existsSync(resolved)) return;
  const metadata = fs.lstatSync(resolved);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Runtime ownership snapshot refuses symbolic link: ${resolved}`);
  }
  visited.add(resolved);
  records.push({
    path: resolved,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    directory: metadata.isDirectory(),
  });
  if (metadata.isDirectory()) {
    for (const entry of fs.readdirSync(resolved)) record(path.join(resolved, entry));
  }
}

for (const root of roots) record(root);
fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, records }));
fs.chmodSync(manifestPath, 0o600);
NODE
}

restore_runtime_identity() {
  if [[ ! -f "$RUNTIME_IDENTITY_MANIFEST" ]]; then
    return
  fi
  node - "$RUNTIME_IDENTITY_MANIFEST" <<'NODE'
const fs = require("node:fs");
const [manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest?.version !== 1 || !Array.isArray(manifest.records)) {
  throw new Error("Runtime ownership snapshot is invalid");
}
for (const record of [...manifest.records].sort((left, right) => right.path.length - left.path.length)) {
  if (!fs.existsSync(record.path)) continue;
  const metadata = fs.lstatSync(record.path);
  if (metadata.isSymbolicLink() || metadata.isDirectory() !== record.directory) {
    throw new Error(`Runtime ownership restore refuses changed path: ${record.path}`);
  }
  fs.chownSync(record.path, record.uid, record.gid);
  fs.chmodSync(record.path, record.mode);
}
NODE
}

restore_preview_location() {
  if [[ "$PREVIEW_RELOCATED" -ne 1 ]]; then
    return
  fi
  if [[ -e "$LEGACY_PREVIEW_ROOT" || ! -d "$PREVIEW_ROOT" || -L "$PREVIEW_ROOT" ]]; then
    echo "Preview directory relocation could not be reversed automatically; inspect $BACKUP_DIR." >&2
    return 1
  fi
  mv "$PREVIEW_ROOT" "$LEGACY_PREVIEW_ROOT"
  PREVIEW_RELOCATED=0
}

migrate_runtime_identity_after_backup() {
  if [[ "$LEGACY_PREVIEW_ROOT" != "$PREVIEW_ROOT" && -e "$LEGACY_PREVIEW_ROOT" ]]; then
    if [[ ! -d "$LEGACY_PREVIEW_ROOT" || -L "$LEGACY_PREVIEW_ROOT" ]]; then
      fail_cutover_preflight "Legacy HTML preview root must be a real directory: $LEGACY_PREVIEW_ROOT"
    fi
    if find "$LEGACY_PREVIEW_ROOT" -type l -print -quit | grep -q .; then
      fail_cutover_preflight "Legacy HTML preview root contains a symbolic link."
    fi
    if [[ -e "$PREVIEW_ROOT" ]]; then
      if [[ ! -d "$PREVIEW_ROOT" || -L "$PREVIEW_ROOT" ]]; then
        fail_cutover_preflight "Managed HTML preview root must be a real directory: $PREVIEW_ROOT"
      fi
      if find "$PREVIEW_ROOT" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
        fail_cutover_preflight "Managed HTML preview root is not empty; refusing to merge old preview state."
      fi
      rmdir "$PREVIEW_ROOT"
    fi
    # GNU mv handles a cross-filesystem move by copying completely before it
    # removes the source. The restricted backup above remains available for
    # recovery if this deployment later fails.
    mv "$LEGACY_PREVIEW_ROOT" "$PREVIEW_ROOT"
    PREVIEW_RELOCATED=1
  fi
  install -d -m 0755 "$PREVIEW_ROOT" "$PREVIEW_ROOT_PAGES"
  chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$PERSISTENT_DATA" "$PREVIEW_ROOT"
  chmod 0700 "$PERSISTENT_DATA"
  chmod 0700 "$(dirname "$DB_PATH")"
  chmod 0755 "$PREVIEW_ROOT" "$PREVIEW_ROOT_PAGES"
  chown root:"$RUNTIME_GROUP" "$PERSISTENT_ENV"
  chmod 0640 "$PERSISTENT_ENV"
}

verify_runtime_user_access() {
  local target
  for target in "$PERSISTENT_ENV" "$DB_PATH" "$PREVIEW_ROOT"; do
    if ! sudo -n -u "$RUNTIME_USER" -- test -r "$target"; then
      fail_cutover_preflight "UBot runtime account cannot read required path: $target"
    fi
  done
  for target in "$DB_PATH" "$PREVIEW_ROOT"; do
    if ! sudo -n -u "$RUNTIME_USER" -- test -w "$target"; then
      fail_cutover_preflight "UBot runtime account cannot write required path: $target"
    fi
  done
}

require_sudo_atomically_replaceable_file() {
  local file_path="$1"
  local label="$2"
  local parent probe
  require_readable_file "$file_path" "$label"
  parent="$(dirname "$file_path")"
  require_sudo_mutable_directory "$parent" "$label parent"
  if ! probe="$(sudo -n mktemp "$parent/.ubot-v3-root-write-check.XXXXXX")"; then
    fail_cutover_preflight "$label parent cannot create a sudo atomic-write probe: $parent"
  fi
  if ! sudo -n rm -f -- "$probe"; then
    fail_cutover_preflight "$label parent cannot remove its sudo atomic-write probe: $parent"
  fi
}

preflight_legacy_skills_access() {
  local directory file_path
  if [[ ! -e "$SKILLS_DIR" ]]; then
    return
  fi
  if [[ ! -d "$SKILLS_DIR" ]]; then
    fail_cutover_preflight "Legacy skills path is not a directory: $SKILLS_DIR"
  fi
  require_mutable_directory "$(dirname "$SKILLS_DIR")" "Legacy skills parent"
  if ! find "$SKILLS_DIR" -type d -print0 >/dev/null; then
    fail_cutover_preflight "Legacy skills tree cannot be enumerated: $SKILLS_DIR"
  fi
  if ! find "$SKILLS_DIR" -type f -print0 >/dev/null; then
    fail_cutover_preflight "Legacy skills files cannot be enumerated: $SKILLS_DIR"
  fi
  while IFS= read -r -d '' directory; do
    if [[ ! -r "$directory" ]]; then
      fail_cutover_preflight "Legacy skills directory must be readable before archival: $directory"
    fi
  done < <(find "$SKILLS_DIR" -type d -print0)
  while IFS= read -r -d '' file_path; do
    require_readable_file "$file_path" "Legacy skills file"
  done < <(find "$SKILLS_DIR" -type f -print0)
}

preflight_cutover_write_access() {
  local source_path source_parent

  require_atomically_replaceable_file "$PERSISTENT_ENV" "Persistent .env"
  # Docker installations normally root-own this JSON. The deployer validates
  # and edits a restricted user-owned copy, then atomically swaps the approved
  # field into place through sudo.
  require_sudo_atomically_replaceable_file "$NAPCAT_CONFIG" "NapCat JSON configuration"

  if [[ -L "$PERSISTENT_DATA" || ! -d "$PERSISTENT_DATA" ]]; then
    fail_cutover_preflight "Persistent data directory must be a real directory: $PERSISTENT_DATA"
  fi
  require_mutable_directory "$PERSISTENT_DATA" "Persistent data"
  if [[ -L "$DB_PATH" ]]; then
    fail_cutover_preflight "Shared SQLite database must not be a symbolic link: $DB_PATH"
  fi
  require_readable_file "$DB_PATH" "Shared SQLite database"
  if [[ ! -w "$DB_PATH" ]]; then
    fail_cutover_preflight "Shared SQLite database must be writable by the deployment user: $DB_PATH"
  fi
  require_mutable_directory "$(dirname "$DB_PATH")" "Shared SQLite database parent"

  if [[ -e "$ROLLBACK_DIR" || -L "$ROLLBACK_DIR" ]]; then
    require_root_or_runtime_owned_directory "$ROLLBACK_DIR" "V3 rollback"
    require_mutable_directory "$ROLLBACK_DIR" "V3 rollback"
  fi

  # Once V3 has committed its cutover marker, upgrade releases must not scan
  # retired JSON or skills. Their only state mutation is an additive SQLite
  # migration, which is validated by migrate-v3-state.mjs itself.
  if [[ "$existing_cutover_before_deploy" -eq 0 ]]; then
    for source_path in "${LEGACY_SOURCE_PATHS[@]}"; do
      if [[ -e "$source_path" ]]; then
        require_readable_file "$source_path" "Legacy migration source"
        source_parent="$(dirname "$source_path")"
        require_mutable_directory "$source_parent" "Legacy migration source parent"
      fi
    done
    preflight_legacy_skills_access
  fi

  # `current` is switched after the state marker is written. Prove that the
  # containing release root can create and replace the temporary symlink now.
  require_mutable_directory "$RELEASE_ROOT" "Release root"

  # The remaining post-cutover writes are performed through sudo. Verify the
  # target directories now, rather than discovering a restricted sudo policy
  # after SQLite has become the only state authority.
  require_sudo_mutable_directory "$SYSTEMD_ROOT" "Systemd unit"
  preflight_preview_nginx_targets
  preflight_origin_certificate "$BOT_CERTIFICATE" "$BOT_CERTIFICATE_KEY" "bot.9958.uk" "Bot"
  preflight_origin_certificate "$PREVIEW_CERTIFICATE" "$PREVIEW_CERTIFICATE_KEY" "preview.9958.uk" "Preview"
  preflight_napcat_container
}

preflight_napcat_container() {
  local running
  if ! running="$(sudo -n docker inspect --type container --format '{{.State.Running}}' "$NAPCAT_CONTAINER")"; then
    fail_cutover_preflight "NapCat Docker container is unavailable through sudo: $NAPCAT_CONTAINER"
  fi
  if [[ "$running" != "true" ]]; then
    fail_cutover_preflight "NapCat Docker container must be running before V3 cutover: $NAPCAT_CONTAINER"
  fi
  old_napcat_active=1
}

restart_napcat_container() {
  local elapsed=0 running
  sudo -n docker restart --time 30 "$NAPCAT_CONTAINER" >/dev/null
  while (( elapsed < NAPCAT_RESTART_TIMEOUT_SECONDS )); do
    if running="$(sudo -n docker inspect --type container --format '{{.State.Running}}' "$NAPCAT_CONTAINER" 2>/dev/null)" && [[ "$running" == "true" ]]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "NapCat Docker container did not become running after restart: $NAPCAT_CONTAINER" >&2
  return 1
}

install_napcat_config_atomically() {
  local parent root_staging owner_id group_id file_mode metadata
  parent="$(dirname "$NAPCAT_CONFIG")"
  metadata="$(sudo -n stat -c '%u:%g:%a' "$NAPCAT_CONFIG")"
  if [[ ! "$metadata" =~ ^([0-9]+):([0-9]+):([0-7]{3,4})$ ]]; then
    echo "Could not preserve owner, group, and mode for NapCat JSON configuration." >&2
    return 1
  fi
  owner_id="${BASH_REMATCH[1]}"
  group_id="${BASH_REMATCH[2]}"
  file_mode="${BASH_REMATCH[3]}"
  root_staging="$(sudo -n mktemp "$parent/.ubot-v3-napcat.XXXXXX")"
  # NapCat configurations can carry access tokens. Replacing the file must
  # not silently broaden a root-owned configuration from (for example) 0600.
  if ! sudo -n install -m "$file_mode" -o "$owner_id" -g "$group_id" "$NAPCAT_CONFIG_STAGING" "$root_staging"; then
    sudo -n rm -f -- "$root_staging" || true
    return 1
  fi
  sudo -n mv -f "$root_staging" "$NAPCAT_CONFIG"
}

verify_checksum() {
  local asset_name expected actual manifest_line
  asset_name="$(basename "$BUNDLE")"
  manifest_line="$(tr -d '\r' < "$CHECKSUM_FILE" | awk -v asset="$asset_name" '($2 == asset || $2 == ("*" asset)) { print; exit }')"
  if [[ ! "$manifest_line" =~ ^([a-fA-F0-9]{64})[[:space:]]+\*?([^[:space:]]+)$ ]]; then
    echo "Invalid SHA-256 manifest format." >&2
    exit 2
  fi
  if [[ "${BASH_REMATCH[2]}" != "$asset_name" ]]; then
    echo "SHA-256 manifest does not name the supplied bundle." >&2
    exit 2
  fi
  expected="${BASH_REMATCH[1],,}"
  actual="$(sha256sum "$BUNDLE" | awk '{print tolower($1)}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Release SHA-256 verification failed." >&2
    exit 2
  fi
}

verify_github_release_provenance() {
  local metadata_path assets_path official_manifest_path release_id manifest_url asset_name official_line supplied_line official_hash supplied_hash
  asset_name="$(basename "$BUNDLE")"
  metadata_path="$(mktemp)"
  assets_path="$(mktemp)"
  official_manifest_path="$(mktemp)"
  if ! curl --fail --silent --show-error --location \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_RELEASE_REPOSITORY/releases/tags/v$VERSION" \
    -o "$metadata_path"; then
    rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
    echo "Could not retrieve the matching GitHub Release metadata." >&2
    exit 2
  fi
  # GitHub can briefly serve a release object with an empty embedded `assets`
  # array after Actions uploads files. Resolve the verified release ID first,
  # then read the release-owned asset collection directly instead of accepting
  # a stale or separately supplied download URL.
  if ! release_id="$(node - "$metadata_path" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [metadataPath, version] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (release.tag_name !== `v${version}` || release.draft === true || release.prerelease === true) {
  throw new Error("GitHub Release is not the matching published final release.");
}
if (!Number.isSafeInteger(release.id) || release.id <= 0) {
  throw new Error("GitHub Release has an invalid release ID.");
}
process.stdout.write(String(release.id));
NODE
  )"; then
    rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
    echo "GitHub Release metadata is invalid for the requested version." >&2
    exit 2
  fi
  if ! curl --fail --silent --show-error --location \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_RELEASE_REPOSITORY/releases/$release_id/assets?per_page=100" \
    -o "$assets_path"; then
    rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
    echo "Could not retrieve the matching GitHub Release asset list." >&2
    exit 2
  fi
  if ! manifest_url="$(node - "$metadata_path" "$assets_path" "$VERSION" "$asset_name" "$GITHUB_RELEASE_REPOSITORY" <<'NODE'
const fs = require("node:fs");
const [metadataPath, assetsPath, version, archiveName, repository] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8"));
if (release.tag_name !== `v${version}` || release.draft === true || release.prerelease === true ||
    !Array.isArray(assets)) {
  throw new Error("GitHub Release metadata or asset list is invalid.");
}
const checksumName = `${archiveName}.sha256`;
const asset = assets.find((entry) => entry?.name === checksumName);
const expectedUrl = `https://github.com/${repository}/releases/download/v${version}/${checksumName}`;
if (asset?.state !== "uploaded" || asset?.browser_download_url !== expectedUrl) {
  throw new Error(`GitHub Release is missing ${checksumName}.`);
}
process.stdout.write(expectedUrl);
NODE
  )"; then
    rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
    echo "GitHub Release asset list is invalid for the requested version." >&2
    exit 2
  fi
  if ! curl --fail --silent --show-error --location "$manifest_url" -o "$official_manifest_path"; then
    rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
    echo "Could not download the GitHub Release SHA-256 manifest." >&2
    exit 2
  fi
  official_line="$(tr -d '\r' < "$official_manifest_path" | awk -v asset="$asset_name" '$2 == asset || $2 == ("*" asset) { print; exit }')"
  supplied_line="$(tr -d '\r' < "$CHECKSUM_FILE" | awk -v asset="$asset_name" '$2 == asset || $2 == ("*" asset) { print; exit }')"
  rm -f "$metadata_path" "$assets_path" "$official_manifest_path"
  if [[ ! "$official_line" =~ ^[a-fA-F0-9]{64}[[:space:]]+\*?$asset_name$ ]] ||
     [[ ! "$supplied_line" =~ ^[a-fA-F0-9]{64}[[:space:]]+\*?$asset_name$ ]]; then
    echo "GitHub Release or supplied SHA-256 manifest is invalid." >&2
    exit 2
  fi
  official_hash="$(awk '{print tolower($1)}' <<< "$official_line")"
  supplied_hash="$(awk '{print tolower($1)}' <<< "$supplied_line")"
  if [[ "$official_hash" != "$supplied_hash" ]]; then
    echo "Supplied SHA-256 manifest does not match the published GitHub Release asset." >&2
    exit 2
  fi
}

validate_archive_paths() {
  if [[ -L "$BUNDLE" || ! -f "$BUNDLE" ]]; then
    echo "Release archive must be a regular file, not a symbolic link." >&2
    exit 2
  fi
  "$NODE_BIN" "$DEPLOY_SCRIPT_DIR/validate-release-archive.mjs" "$BUNDLE"
}

# Validate the exact compiled release, including a completed headquarters
# ledger against the persistent public reviewer key, before stopping writers.
# The verifier reads only the two public verification settings; it never
# sources or prints the rest of the production dotenv file.
prepare_release_bundle_preflight() {
  local bundle_version
  if [[ -n "$STAGING_DIR" ]]; then
    fail_cutover_preflight "Release staging directory was already initialized."
  fi
  STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.staging-v${VERSION}.XXXXXX")"
  tar --extract --gzip --file="$BUNDLE" --directory="$STAGING_DIR" \
    --no-same-owner --no-same-permissions --delay-directory-restore
  for required in \
    package.json package-lock.json dist/index.js assets/huixian-profile.json assets/private-enterprises-2026.json \
    assets/private-enterprises-2026-audit.json assets/private-enterprises-2026-review.md \
    assets/private-enterprises-2026-headquarters.json assets/private-enterprises-2026-headquarters-evidence.json \
    assets/private-enterprises-2026-headquarters-review.md \
    scripts/deploy-linux-release.sh scripts/migrate-v3-state.mjs scripts/normalize-dotenv-bom.mjs \
    scripts/configure-v3-network.mjs scripts/verify-release-source.mjs scripts/validate-release-archive.mjs \
    scripts/install-node22-runtime.sh scripts/update-cloudflare-origin-allowlist.sh \
    scripts/install-cloudflare-origin-hardening.sh scripts/verify-nginx-vhost-ownership.mjs \
    deploy/systemd/ubot-ingress.service.template deploy/systemd/ubot-worker.service.template \
    deploy/systemd/ubot-admin.service.template deploy/systemd/ubot.target.template \
    deploy/systemd/ubot-maintenance.service.template deploy/systemd/ubot-maintenance.timer.template \
    deploy/systemd/ubot-cloudflare-allowlist.service.template deploy/systemd/ubot-cloudflare-allowlist.timer.template \
    deploy/nginx/bot.9958.uk.conf deploy/nginx/preview.9958.uk.conf deploy/nginx/ubot-preview-static.conf; do
    if [[ ! -e "$STAGING_DIR/$required" ]]; then
      echo "Release bundle is missing a required V3 path: $required" >&2
      exit 2
    fi
  done

  node "$STAGING_DIR/scripts/verify-release-source.mjs" "$STAGING_DIR" \
    --headquarters-review-env "$PERSISTENT_ENV"

  bundle_version="$(node -p "require(process.argv[1]).version" "$STAGING_DIR/package.json")"
  if [[ "$bundle_version" != "$VERSION" ]]; then
    echo "Bundle version does not match the requested version." >&2
    exit 2
  fi

  (
    cd "$STAGING_DIR"
    npm ci --omit=dev --ignore-scripts
  )
}

harden_release_tree() {
  if [[ -L "$STAGING_DIR" ]]; then
    fail_cutover_preflight "Release staging directory must not be a symbolic link."
  fi
  chown -R root:root "$STAGING_DIR"
  find "$STAGING_DIR" -type d -exec chmod 0755 {} +
  find "$STAGING_DIR" -type f -exec chmod a+r,go-w {} +
  find "$STAGING_DIR" -xdev -exec chmod u-s,g-s {} +
  find "$STAGING_DIR/scripts" -type f -name '*.sh' -exec chmod 0755 {} +
  # `npm ci` creates executable package bins as needed. Strip only writable
  # bits so the activated release remains readable but never runtime-mutable.
  chmod -R go-w "$STAGING_DIR"
  if find "$STAGING_DIR" -xdev -perm /6000 -print -quit | grep -q .; then
    fail_cutover_preflight "Hardened release tree still contains SUID or SGID permissions."
  fi
}

preflight_cloudflare_origin_boundary() {
  local target origin_cidrs realip_cidrs
  for target in "$CLOUDFLARE_ORIGIN_CONFIG" "$CLOUDFLARE_REALIP_CONFIG" "$CLOUDFLARE_ORIGIN_READY_MARKER"; do
    if [[ -L "$target" || ! -f "$target" ]]; then
      fail_cutover_preflight "Cloudflare origin hardening is not installed: $target"
    fi
  done
  if ! grep -q 'geo \$realip_remote_addr \$ubot_cloudflare_origin_allowed' "$CLOUDFLARE_ORIGIN_CONFIG" ||
     ! grep -q 'real_ip_header CF-Connecting-IP' "$CLOUDFLARE_REALIP_CONFIG" ||
     ! grep -qx 'UBOT_CLOUDFLARE_ORIGIN_BOUNDARY=1' "$CLOUDFLARE_ORIGIN_READY_MARKER"; then
    fail_cutover_preflight "Cloudflare origin hardening files are invalid; run the origin hardening installer before deploying."
  fi
  origin_cidrs="$(grep -Ec '^[[:space:]]*[0-9A-Fa-f:.]+/[0-9]+[[:space:]]+1;$' "$CLOUDFLARE_ORIGIN_CONFIG" || true)"
  realip_cidrs="$(grep -Ec '^set_real_ip_from[[:space:]]+[0-9A-Fa-f:.]+/[0-9]+;$' "$CLOUDFLARE_REALIP_CONFIG" || true)"
  if [[ ! "$origin_cidrs" =~ ^[0-9]+$ || ! "$realip_cidrs" =~ ^[0-9]+$ ||
      "$origin_cidrs" -lt 15 || "$origin_cidrs" != "$realip_cidrs" ]]; then
    fail_cutover_preflight "Cloudflare origin hardening CIDR files are incomplete or inconsistent."
  fi
  verify_effective_nginx_vhost_ownership
  preflight_cloudflare_vhost "$BOT_NGINX_CONFIG" "$BOT_NGINX_ENABLED_LINK" "bot.9958.uk" "$BOT_CERTIFICATE" "$BOT_CERTIFICATE_KEY" "Bot"
  preflight_cloudflare_vhost "$PREVIEW_NGINX_CONFIG" "$PREVIEW_NGINX_ENABLED_LINK" "preview.9958.uk" "$PREVIEW_CERTIFICATE" "$PREVIEW_CERTIFICATE_KEY" "Preview"
}

verify_effective_nginx_vhost_ownership() {
  local rendered_config
  rendered_config="$(mktemp "${TMPDIR}/ubot-nginx-rendered.XXXXXX")"
  if ! nginx -T > "$rendered_config" 2>&1; then
    rm -f -- "$rendered_config"
    fail_cutover_preflight "Nginx configuration is invalid before deployment."
  fi
  if ! "$NODE_BIN" "$DEPLOY_SCRIPT_DIR/verify-nginx-vhost-ownership.mjs" \
    "$rendered_config" \
    "$BOT_NGINX_CONFIG" "$BOT_NGINX_ENABLED_LINK" "bot.9958.uk" \
    "$PREVIEW_NGINX_CONFIG" "$PREVIEW_NGINX_ENABLED_LINK" "preview.9958.uk"; then
    rm -f -- "$rendered_config"
    fail_cutover_preflight "Nginx has missing or competing UBot hostname vhosts; install the dedicated origin boundary and remove duplicate legacy vhosts before deploying."
  fi
  rm -f -- "$rendered_config"
}

preflight_cloudflare_vhost() {
  local config="$1"
  local enabled_link="$2"
  local hostname="$3"
  local certificate="$4"
  local certificate_key="$5"
  local label="$6"
  local include_count gate_count denied_count

  if [[ -L "$config" || ! -f "$config" ]]; then
    fail_cutover_preflight "$label Cloudflare vhost is missing or not a regular file: $config"
  fi
  if [[ ! -L "$enabled_link" || "$(readlink "$enabled_link")" != "$config" ]]; then
    fail_cutover_preflight "$label Cloudflare vhost is not enabled through its dedicated symlink: $enabled_link"
  fi
  if ! grep -Fq "server_name $hostname;" "$config" ||
     ! grep -Fq "ssl_certificate $certificate;" "$config" ||
     ! grep -Fq "ssl_certificate_key $certificate_key;" "$config"; then
    fail_cutover_preflight "$label enabled vhost does not match its fixed hostname or Origin certificate paths."
  fi
  include_count="$(grep -Fc 'include /etc/nginx/ubot-cloudflare-realip.conf;' "$config" || true)"
  gate_count="$(grep -Fc 'if ($ubot_cloudflare_origin_allowed = 0) {' "$config" || true)"
  denied_count="$(grep -Fc 'return 403;' "$config" || true)"
  if [[ ! "$include_count" =~ ^[0-9]+$ || ! "$gate_count" =~ ^[0-9]+$ || ! "$denied_count" =~ ^[0-9]+$ ||
      "$include_count" -lt 2 || "$gate_count" -lt 2 || "$denied_count" -lt 2 ]]; then
    fail_cutover_preflight "$label enabled vhost must apply the Cloudflare real-IP include and origin gate on both HTTP and HTTPS listeners."
  fi
}

is_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == "active" ]]
}

wait_for_unit_inactive() {
  local unit="$1" attempt state
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
    if [[ -z "$state" || "$state" == "inactive" || "$state" == "failed" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $unit to stop (last state: $state)." >&2
  return 1
}

quiesce_maintenance_writer() {
  # The timer is independent from ubot.target. Stop scheduling first, then
  # terminate a job that may already hold the SQLite write lock.
  sudo systemctl stop "$MAINTENANCE_TIMER" 2>/dev/null || true
  sudo systemctl stop "$MAINTENANCE_SERVICE" 2>/dev/null || true
  wait_for_unit_inactive "$MAINTENANCE_SERVICE"
  wait_for_unit_inactive "$MAINTENANCE_TIMER"
}

quiesce_cloudflare_allowlist_updater() {
  # This root timer atomically writes the UBot Nginx includes. Pause it while
  # deployment or rollback changes related vhost configuration.
  sudo systemctl stop "$CLOUDFLARE_ALLOWLIST_TIMER" 2>/dev/null || true
  sudo systemctl stop "$CLOUDFLARE_ALLOWLIST_SERVICE" 2>/dev/null || true
  wait_for_unit_inactive "$CLOUDFLARE_ALLOWLIST_SERVICE"
  wait_for_unit_inactive "$CLOUDFLARE_ALLOWLIST_TIMER"
}

contain_cloudflare_allowlist_updater() {
  # A failed stop leaves a root-owned writer racing rollback's Nginx restore.
  # Prevent any later activation and make the containment visible to the
  # operator. A masked unit is deliberately not auto-unmasked by rollback.
  sudo systemctl disable --now "$CLOUDFLARE_ALLOWLIST_TIMER" 2>/dev/null || true
  if ! sudo systemctl mask --now "$CLOUDFLARE_ALLOWLIST_SERVICE" "$CLOUDFLARE_ALLOWLIST_TIMER"; then
    echo "Could not mask the Cloudflare allow-list updater units." >&2
    return 1
  fi
  local unit unit_state
  for unit in "$CLOUDFLARE_ALLOWLIST_SERVICE" "$CLOUDFLARE_ALLOWLIST_TIMER"; do
    unit_state="$(sudo systemctl is-enabled "$unit" 2>/dev/null || true)"
    if [[ "$unit_state" != "masked" ]]; then
      echo "Cloudflare allow-list updater unit was not confirmed masked: $unit" >&2
      return 1
    fi
  done
  cloudflare_updater_masked=1
  wait_for_unit_inactive "$CLOUDFLARE_ALLOWLIST_SERVICE" &&
    wait_for_unit_inactive "$CLOUDFLARE_ALLOWLIST_TIMER"
}

reset_runtime_service_failures() {
  sudo systemctl reset-failed "${RUNTIME_SERVICES[@]}"
}

capture_service_restart_counts() {
  SERVICE_RESTART_COUNTS=()
  local service count
  for service in "${RUNTIME_SERVICES[@]}"; do
    count="$(systemctl show "$service" -p NRestarts --value)"
    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      echo "Could not read restart count for $service." >&2
      return 1
    fi
    if [[ "$count" != "0" ]]; then
      echo "$service restarted while starting the new release." >&2
      return 1
    fi
    SERVICE_RESTART_COUNTS+=("$count")
  done
}

verify_service_restart_counts_stable() {
  local index service current
  for index in "${!RUNTIME_SERVICES[@]}"; do
    service="${RUNTIME_SERVICES[$index]}"
    current="$(systemctl show "$service" -p NRestarts --value)"
    if [[ "$current" != "${SERVICE_RESTART_COUNTS[$index]}" ]]; then
      echo "$service restarted during post-deploy health checks." >&2
      return 1
    fi
  done
}

capture_unit_enablement() {
  UNIT_WAS_ENABLED=()
  local unit
  for unit in "${ENABLEMENT_UNITS[@]}"; do
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      UNIT_WAS_ENABLED+=(1)
    else
      UNIT_WAS_ENABLED+=(0)
    fi
  done
}

restore_unit_enablement() {
  local index unit
  for index in "${!ENABLEMENT_UNITS[@]}"; do
    unit="${ENABLEMENT_UNITS[$index]}"
    if [[ "$unit" == "$CLOUDFLARE_ALLOWLIST_TIMER" && "$cloudflare_updater_resume_blocked" -eq 1 ]]; then
      sudo systemctl disable --now "$unit" >/dev/null 2>&1 || true
      continue
    fi
    if [[ "${UNIT_WAS_ENABLED[$index]:-0}" -eq 1 ]]; then
      sudo systemctl enable "$unit" >/dev/null 2>&1 || true
    else
      sudo systemctl disable "$unit" >/dev/null 2>&1 || true
    fi
  done
}

wait_for_ingress_read_api_status() {
  local expected_status="$1"
  local attempt body curl_config
  if [[ "$expected_status" != "listener" && "$expected_status" != "healthy" ]]; then
    echo "Invalid Ingress Read API status expectation." >&2
    return 2
  fi
  curl_config="$(mktemp "${TMPDIR}/ubot-ingress-read-health.XXXXXX")"
  chmod 0600 "$curl_config"
  # Keep the bearer out of curl's argv and the process table. The file is in
  # a root-only temporary location and removed before this helper returns;
  # curl reads the header from its own configuration input.
  if ! printf 'header = "Authorization: Bearer %s"\n' "$INGRESS_READ_API_TOKEN" > "$curl_config"; then
    rm -f -- "$curl_config"
    return 1
  fi
  for ((attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1)); do
    body="$(curl --silent --show-error --fail --max-time 10 \
      --config "$curl_config" \
      "$INGRESS_READ_API_HEALTH_URL" 2>/dev/null || true)"
    if [[ -n "$body" ]] && printf '%s' "$body" | "$NODE_BIN" -e '
      let text = "";
      const expectedStatus = process.argv[1];
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { text += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(text);
          const isReadApiStatus = Boolean(parsed) &&
            typeof parsed.ok === "boolean" &&
            typeof parsed.detail === "string";
          process.exit(isReadApiStatus && (expectedStatus === "listener" || parsed.ok === true) ? 0 : 1);
        } catch { process.exit(1); }
      });
    ' "$expected_status"; then
      rm -f -- "$curl_config"
      return 0
    fi
    sleep 2
  done
  rm -f -- "$curl_config"
  if [[ "$expected_status" == "listener" ]]; then
    echo "Ingress Read API did not return an authenticated JSON listener response." >&2
  else
    echo "Ingress Read API did not return a healthy JSON response." >&2
  fi
  return 1
}

wait_for_ingress_read_api_listener() {
  # Ingress owns the HTTP listener before NapCat has been restarted with the
  # just-installed reverse URL. Do not require a connected transport here: the
  # post-restart health check below is the authoritative connectivity gate.
  wait_for_ingress_read_api_status listener
}

wait_for_ingress_read_api_health() {
  wait_for_ingress_read_api_status healthy
}

wait_for_admin_auth_boundary() {
  local attempt status
  for ((attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1)); do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$ADMIN_HEALTH_URL" || true)"
    if [[ "$status" == "401" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Admin health endpoint did not preserve its authentication boundary." >&2
  return 1
}

has_existing_v3_cutover() {
  DB_PATH="$DB_PATH" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
try {
  const metaTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v3_state_meta'",
  ).get();
  if (!metaTable) process.exitCode = 1;
  else {
    const row = db.prepare(
      "SELECT meta_value FROM v3_state_meta WHERE meta_key = 'state_cutover'",
    ).get();
    process.exitCode = row?.meta_value === "v3" ? 0 : 1;
  }
} finally {
  db.close();
}
NODE
}

backup_unit_files() {
  local unit
  mkdir -p "$BACKUP_DIR/systemd-before"
  for unit in "${UNIT_FILES[@]}"; do
    if sudo test -f "$SYSTEMD_ROOT/$unit"; then
      sudo cp "$SYSTEMD_ROOT/$unit" "$BACKUP_DIR/systemd-before/$unit"
    else
      : > "$BACKUP_DIR/systemd-before/$unit.absent"
    fi
  done
}

restore_unit_files() {
  local unit
  for unit in "${UNIT_FILES[@]}"; do
    if [[ -f "$BACKUP_DIR/systemd-before/$unit" ]]; then
      sudo cp "$BACKUP_DIR/systemd-before/$unit" "$SYSTEMD_ROOT/$unit" || true
    elif [[ -f "$BACKUP_DIR/systemd-before/$unit.absent" ]]; then
      sudo rm -f "$SYSTEMD_ROOT/$unit" || true
    fi
  done
}

switch_current_link() {
  local target="$1"
  local temporary_link="$RELEASE_ROOT/.current-$VERSION-$$"
  rm -f "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$CURRENT_LINK"
}

restore_napcat_config() {
  if [[ -f "$BACKUP_DIR/napcat-config.before.json" ]]; then
    sudo cp "$BACKUP_DIR/napcat-config.before.json" "$NAPCAT_CONFIG" || true
  fi
}

verify_updated_network_env() {
  INGRESS_READ_API_TOKEN="$(node - "$PERSISTENT_ENV" "$PREVIEW_ROOT" <<'NODE'
const fs = require("node:fs");
const [envPath, expectedPreviewRoot] = process.argv.slice(2);
const values = new Map();
for (const raw of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const match = raw.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!match) continue;
  values.set(match[1], match[2].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? ""));
}
if (values.get("INGRESS_READ_API_PORT") !== "6198") {
  throw new Error("Network configuration must set INGRESS_READ_API_PORT=6198 before V3 starts");
}
const token = values.get("INGRESS_READ_API_TOKEN");
if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
  throw new Error("Network configuration must set a non-empty URL-safe ingress read API token before V3 starts");
}
if (values.get("HTML_PREVIEW_ROOT") !== expectedPreviewRoot) {
  throw new Error("Network configuration must set the managed HTML preview root before V3 starts");
}
process.stdout.write(token);
NODE
  )"
}

restore_persistent_env() {
  if [[ -f "$BACKUP_DIR/env.before" ]]; then
    sudo cp "$BACKUP_DIR/env.before" "$PERSISTENT_ENV" || true
  fi
}

backup_preview_nginx_target() {
  local target="$1"
  local backup_name="$2"
  local backup_path="$BACKUP_DIR/$backup_name"
  if sudo -n test -L "$target"; then
    sudo -n readlink "$target" > "$backup_path.symlink"
  elif sudo -n test -f "$target"; then
    sudo -n cp -p "$target" "$backup_path"
  elif sudo -n test -e "$target"; then
    fail_cutover_preflight "Preview Nginx target became non-regular during backup: $target"
  else
    : > "$backup_path.absent"
  fi
}

backup_preview_nginx_files() {
  backup_preview_nginx_target "$PREVIEW_NGINX_CONFIG" "preview-nginx-vhost.before"
  backup_preview_nginx_target "$PREVIEW_NGINX_INCLUDE" "preview-nginx-include.before"
  backup_preview_nginx_target "$PREVIEW_NGINX_ENABLED_LINK" "preview-nginx-enabled.before"
}

restore_preview_nginx_target() {
  local target="$1"
  local backup_name="$2"
  local backup_path="$BACKUP_DIR/$backup_name"
  if [[ -f "$backup_path" ]]; then
    sudo -n cp -p "$backup_path" "$target" || true
  elif [[ -f "$backup_path.symlink" ]]; then
    sudo -n rm -f "$target" || true
    sudo -n ln -s "$(<"$backup_path.symlink")" "$target" || true
  elif [[ -f "$backup_path.absent" ]]; then
    sudo -n rm -f "$target" || true
  fi
}

restore_preview_nginx_files() {
  restore_preview_nginx_target "$PREVIEW_NGINX_CONFIG" "preview-nginx-vhost.before"
  restore_preview_nginx_target "$PREVIEW_NGINX_INCLUDE" "preview-nginx-include.before"
  restore_preview_nginx_target "$PREVIEW_NGINX_ENABLED_LINK" "preview-nginx-enabled.before"
  sudo nginx -t && sudo systemctl reload nginx || true
}

install_preview_nginx_file_atomically() {
  local source_path="$1"
  local target_path="$2"
  local parent root_staging
  parent="$(dirname "$target_path")"
  root_staging="$(sudo -n mktemp "$parent/.ubot-preview-nginx.XXXXXX")"
  if ! sudo -n install -m 0644 "$source_path" "$root_staging"; then
    sudo -n rm -f "$root_staging" || true
    return 1
  fi
  sudo -n mv -f "$root_staging" "$target_path"
}

install_preview_nginx_enabled_link() {
  local parent temporary_link
  parent="$(dirname "$PREVIEW_NGINX_ENABLED_LINK")"
  temporary_link="$parent/.ubot-preview-enabled-$VERSION-$$"
  sudo -n rm -f "$temporary_link"
  sudo -n ln -s "$PREVIEW_NGINX_CONFIG" "$temporary_link"
  sudo -n mv -Tf "$temporary_link" "$PREVIEW_NGINX_ENABLED_LINK"
}

render_preview_nginx_files() {
  local source_vhost="$STAGING_DIR/deploy/nginx/preview.9958.uk.conf"
  local source_include="$STAGING_DIR/deploy/nginx/ubot-preview-static.conf"
  PREVIEW_NGINX_VHOST_STAGING="$BACKUP_DIR/preview.9958.uk.conf.rendered"
  PREVIEW_NGINX_INCLUDE_STAGING="$BACKUP_DIR/ubot-preview-static.conf.rendered"
  if ! grep -q '__UBOT_PREVIEW_CERT_PATH__' "$source_vhost" ||
     ! grep -q '__UBOT_PREVIEW_KEY_PATH__' "$source_vhost" ||
     ! grep -q '__UBOT_HTML_PREVIEW_ROOT__' "$source_include"; then
    echo "Release preview Nginx templates are missing required substitution markers." >&2
    return 1
  fi
  sed \
    -e "s|__UBOT_PREVIEW_CERT_PATH__|$PREVIEW_CERTIFICATE|g" \
    -e "s|__UBOT_PREVIEW_KEY_PATH__|$PREVIEW_CERTIFICATE_KEY|g" \
    "$source_vhost" > "$PREVIEW_NGINX_VHOST_STAGING"
  sed -e "s|__UBOT_HTML_PREVIEW_ROOT__|$PREVIEW_ROOT|g" \
    "$source_include" > "$PREVIEW_NGINX_INCLUDE_STAGING"
  chmod 600 "$PREVIEW_NGINX_VHOST_STAGING" "$PREVIEW_NGINX_INCLUDE_STAGING"
}

rollback() {
  local exit_code="$?"
  if [[ "$rollback_armed" -ne 1 ]]; then
    exit "$exit_code"
  fi

  echo "Deployment failed; restoring release selection and service configuration." >&2
  maintenance_writer_quiesced=0
  cloudflare_updater_quiesced=0
  if quiesce_maintenance_writer; then
    maintenance_writer_quiesced=1
  else
    echo "Could not confirm the maintenance writer is stopped; SQLite policy restoration and service restart are disabled." >&2
  fi
  if quiesce_cloudflare_allowlist_updater; then
    cloudflare_updater_quiesced=1
  else
    cloudflare_updater_resume_blocked=1
    if contain_cloudflare_allowlist_updater; then
      cloudflare_updater_quiesced=1
      echo "Cloudflare allow-list updater required emergency containment and remains masked; inspect and unmask it manually after rollback." >&2
    else
      if [[ "$cloudflare_updater_masked" -eq 1 ]]; then
        echo "Cloudflare allow-list updater remains masked but did not stop; do not restore Nginx automatically." >&2
      else
        echo "Could not mask or stop the Cloudflare allow-list updater; automatic restart remains blocked and do not restore Nginx automatically." >&2
      fi
    fi
  fi
  sudo systemctl stop ubot.target 2>/dev/null || true
  restore_napcat_config
  if [[ "$napcat_restart_attempted" -eq 1 && "$old_napcat_active" -eq 1 ]]; then
    restart_napcat_container || echo "NapCat restart after configuration restore failed; inspect $NAPCAT_CONTAINER manually." >&2
  fi
  restore_preview_location || true
  restore_persistent_env
  restore_runtime_identity || echo "Runtime ownership restore failed; keep services stopped and inspect $BACKUP_DIR/runtime-identity.before.json." >&2
  if [[ "$cloudflare_updater_quiesced" -eq 1 ]]; then
    restore_preview_nginx_files
  else
    echo "Skipped Nginx rollback because the Cloudflare allow-list updater might still write its include; restore from $BACKUP_DIR manually after containment." >&2
  fi
  restore_unit_files
  local policy_restored=1
  if [[ "$maintenance_writer_quiesced" -ne 1 ]]; then
    policy_restored=0
  elif [[ -f "$BACKUP_DIR/capability-policy.json" ]]; then
    if ! node "$DEPLOY_SCRIPT_DIR/bt-capability-policy.mjs" restore "$DB_PATH" "$BACKUP_DIR/capability-policy.json"; then
      policy_restored=0
      echo "Capability policy restore failed; keep the previous services stopped and restore the saved policy before restarting." >&2
    fi
  fi
  if [[ -n "$old_current_target" ]]; then
    switch_current_link "$old_current_target" || true
  else
    rm -f "$CURRENT_LINK" || true
  fi
  sudo systemctl daemon-reload || true
  restore_unit_enablement

  # V3 makes SQLite the state authority. Starting the legacy service after the
  # cutover would silently resume JSON writes, so only an operator may do that
  # as part of the documented disaster-recovery procedure.
  local runtime_restored=0
  if [[ "$cutover_may_have_started" -eq 0 && "$old_legacy_active" -eq 1 && "$maintenance_writer_quiesced" -eq 1 ]]; then
    if sudo systemctl start "$LEGACY_SERVICE"; then
      runtime_restored=1
    else
      echo "Legacy service did not restart during rollback; leave maintenance disabled." >&2
    fi
  fi
  if [[ "$cutover_may_have_started" -eq 0 && "$old_target_active" -eq 1 && "$policy_restored" -eq 1 && "$maintenance_writer_quiesced" -eq 1 ]]; then
    if sudo systemctl start ubot.target; then
      runtime_restored=1
    else
      echo "Previous V3 target did not restart during rollback; leave maintenance disabled." >&2
    fi
  fi
  # An additive upgrade starts from an already cut-over V3 database. Its
  # migrations are transactional and old V3 code remains compatible with
  # extra tables, so restart the previous target after configuration rollback.
  if [[ "$cutover_may_have_started" -eq 1 && "$existing_cutover_before_deploy" -eq 1 && "$old_target_active" -eq 1 && "$policy_restored" -eq 1 && "$maintenance_writer_quiesced" -eq 1 ]]; then
    if sudo systemctl start ubot.target; then
      runtime_restored=1
    else
      echo "Previous V3 target did not restart during rollback; leave maintenance disabled." >&2
    fi
  elif [[ "$cutover_may_have_started" -eq 1 ]]; then
    echo "V3 state migration may have changed SQLite. Release, unit, Nginx, dotenv, and NapCat configuration were restored. Do not restart the legacy service; use README.md#recovery for manual recovery." >&2
  fi
  if [[ "$runtime_restored" -eq 1 && "$old_maintenance_timer_active" -eq 1 && "$maintenance_writer_quiesced" -eq 1 && "$policy_restored" -eq 1 ]]; then
    sudo systemctl start "$MAINTENANCE_TIMER" || echo "Maintenance timer was not restored; inspect it after rollback." >&2
  fi
  if [[ "$old_maintenance_service_active" -eq 1 ]]; then
    echo "The interrupted maintenance job was not resumed automatically; the restored timer will run the next scheduled maintenance cycle." >&2
  fi
  if [[ "$old_cloudflare_timer_active" -eq 1 && "$cloudflare_updater_quiesced" -eq 1 && "$cloudflare_updater_resume_blocked" -eq 0 ]]; then
    sudo systemctl start "$CLOUDFLARE_ALLOWLIST_TIMER" || echo "Cloudflare allow-list timer was not restored; inspect it after rollback." >&2
  fi
  if [[ "$old_cloudflare_service_active" -eq 1 && "$cloudflare_updater_resume_blocked" -eq 0 ]]; then
    echo "The interrupted Cloudflare allow-list update was not resumed automatically; the restored timer will run the next scheduled cycle." >&2
  elif [[ "$cloudflare_updater_resume_blocked" -eq 1 && "$cloudflare_updater_masked" -eq 1 ]]; then
    echo "Cloudflare allow-list units remain masked after rollback; resolve the failed stop and unmask them manually before resuming updates." >&2
  elif [[ "$cloudflare_updater_resume_blocked" -eq 1 ]]; then
    echo "Cloudflare allow-list automatic restart remains blocked after rollback; contain the updater manually before resuming updates." >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
  echo "Release directory already exists." >&2
  exit 2
fi
if [[ ! -f "$PERSISTENT_ENV" ]]; then
  echo "Persistent .env is missing." >&2
  exit 2
fi
if [[ -z "$NAPCAT_CONFIG" || ! -f "$NAPCAT_CONFIG" ]]; then
  echo "UBOT_NAPCAT_CONFIG must point to the existing NapCat reverse WebSocket JSON configuration." >&2
  exit 2
fi
if [[ "$NAPCAT_REVERSE_URL" != "ws://172.21.0.1:6199/onebot/ws" ]]; then
  echo "UBOT_NAPCAT_REVERSE_URL must be ws://172.21.0.1:6199/onebot/ws." >&2
  exit 2
fi

ensure_runtime_account
ensure_root_controlled_deployment_roots
trap 'cleanup_staged_release_inputs' EXIT
stage_release_inputs
verify_checksum
verify_github_release_provenance
validate_archive_paths
create_secure_backup_directory
# systemd does not accept a UTF-8 BOM before the first EnvironmentFile key.
# Normalize it while every writer is still running: the helper first creates
# an exclusive byte-for-byte backup, preserves ownership and mode, and uses a
# same-directory rename so failure cannot leave a partial dotenv file.
require_atomically_replaceable_file "$PERSISTENT_ENV" "Persistent .env"
node "$DEPLOY_SCRIPT_DIR/normalize-dotenv-bom.mjs" \
  --env "$PERSISTENT_ENV" \
  --backup "$BACKUP_DIR/env.before-bom-normalization"
load_preview_settings
validate_preview_storage_paths

if [[ -f "$DB_PATH" ]] && has_existing_v3_cutover; then
  existing_cutover_before_deploy=1
fi

# Do this before stopping either old service. On a first V3 deployment the
# migration writes its cutover marker before deleting legacy JSON; on a later
# V3 maintenance release it only applies additive SQLite migrations. The
# network configurator then uses atomic replacement for dotenv and NapCat JSON.
preflight_cutover_write_access
prepare_release_bundle_preflight
harden_release_tree
harden_bt_runtime
preflight_cloudflare_origin_boundary

if [[ -L "$CURRENT_LINK" ]]; then
  old_current_target="$(readlink "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK must be a symbolic link before V3 deployment." >&2
  exit 2
fi
if is_active "$LEGACY_SERVICE"; then old_legacy_active=1; fi
if is_active ubot.target; then old_target_active=1; fi
if is_active "$MAINTENANCE_TIMER"; then old_maintenance_timer_active=1; fi
if is_active "$MAINTENANCE_SERVICE"; then old_maintenance_service_active=1; fi
if is_active "$CLOUDFLARE_ALLOWLIST_TIMER"; then old_cloudflare_timer_active=1; fi
if is_active "$CLOUDFLARE_ALLOWLIST_SERVICE"; then old_cloudflare_service_active=1; fi
capture_unit_enablement

# Stop all writers before backing up SQLite or reading legacy JSON files.
# Arm rollback first: failure to stop the second legacy writer must still
# restore a target that was already stopped by the first command.
rollback_armed=1
if ! quiesce_maintenance_writer; then
  echo "Cannot safely stop the independent maintenance writer before SQLite backup." >&2
  exit 1
fi
if ! quiesce_cloudflare_allowlist_updater; then
  echo "Cannot safely stop the Cloudflare allow-list updater before Nginx and release changes." >&2
  exit 1
fi
maintenance_writer_quiesced=1
cloudflare_updater_quiesced=1
if [[ "$old_target_active" -eq 1 ]]; then sudo systemctl stop ubot.target; fi
if [[ "$old_legacy_active" -eq 1 ]]; then sudo systemctl stop "$LEGACY_SERVICE"; fi

backup_unit_files
sudo cp "$NAPCAT_CONFIG" "$BACKUP_DIR/napcat-config.before.json"
backup_preview_nginx_files
sudo cp "$PERSISTENT_ENV" "$BACKUP_DIR/env.before"

# This is an operator recovery backup, never a release asset. The V3 migration
# owns the separate encrypted seven-day rollback archive for retired data.
backup_inputs=(.env)
if [[ "$existing_cutover_before_deploy" -eq 1 ]]; then
  # State is backed up again with VACUUM below. Keep a narrow filesystem
  # snapshot here and deliberately avoid reading retired JSON or skills. The
  # generated-page root remains persistent state and is included separately.
  backup_inputs+=(data/shared)
  if [[ "$LEGACY_PREVIEW_ROOT" == "$PERSISTENT_DATA"/* && -e "$LEGACY_PREVIEW_ROOT" ]]; then
    preview_root_relative="${LEGACY_PREVIEW_ROOT#"$PERSISTENT_DATA/"}"
    if [[ -z "$preview_root_relative" ]]; then
      fail_cutover_preflight "Existing HTML preview root must not be the persistent data root."
    fi
    backup_inputs+=("data/$preview_root_relative")
  fi
else
  for persistent_name in data config skills; do
    if [[ -e "$APP_ROOT/$persistent_name" ]]; then
      backup_inputs+=("$persistent_name")
    fi
  done
fi
tar -C "$APP_ROOT" -czf "$BACKUP_DIR/persistent-files.tar.gz" -- "${backup_inputs[@]}"
chmod 600 "$BACKUP_DIR/persistent-files.tar.gz"
backup_external_preview_root "$LEGACY_PREVIEW_ROOT" "legacy-preview-files.tar.gz"
if [[ "$PREVIEW_ROOT" != "$LEGACY_PREVIEW_ROOT" ]]; then
  backup_external_preview_root "$PREVIEW_ROOT" "managed-preview-files.tar.gz"
fi

if [[ -f "$DB_PATH" ]]; then
  DB_PATH="$DB_PATH" BACKUP_DB_PATH="$BACKUP_DIR/bot-shared.db" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH);
try {
  const result = db.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
  const target = process.env.BACKUP_DB_PATH.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${target}'`);
} finally {
  db.close();
}
NODE
  chmod 600 "$BACKUP_DIR/bot-shared.db"
  node "$DEPLOY_SCRIPT_DIR/bt-capability-policy.mjs" backup "$DB_PATH" "$BACKUP_DIR/capability-policy.json"
fi

# Capture ownership and modes before the runtime user changes. This lets an
# automatic rollback return the previous service identity to its original
# filesystem contract without restoring the migrated SQLite contents.
record_runtime_identity

# Normalize only the independent ingress bearer before migration. This has no
# NapCat or preview side effect; on failure the armed rollback restores the
# dotenv and old runtime while V3 state is still untouched.
"$NODE_BIN" "$STAGING_DIR/scripts/configure-v3-network.mjs" \
  --ingress-token-only \
  --env "$PERSISTENT_ENV"

# Parse, but never source or print, secrets from the persistent dotenv file.
node - "$PERSISTENT_ENV" <<'NODE'
const fs = require("node:fs");
const values = new Map();
for (const raw of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(match[1], value);
}
const stateKey = values.get("UBOT_STATE_ENCRYPTION_KEY");
if (!stateKey) {
  throw new Error("Persistent .env is missing required UBOT_STATE_ENCRYPTION_KEY");
}
const isHex = /^[A-Fa-f0-9]{64}$/.test(stateKey);
const decodedStateKey = Buffer.from(stateKey, isHex ? "hex" : "base64url");
if (decodedStateKey.length !== 32 || (!isHex && !/^[A-Za-z0-9_-]+={0,2}$/.test(stateKey))) {
  throw new Error("UBOT_STATE_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64url");
}
for (const key of ["NAPCAT_ACCESS_TOKEN"]) {
  if (!values.get(key)) throw new Error(`Persistent .env is missing required ${key}`);
}
if (values.get("ADMIN_HTTP_ENABLED") !== "true") {
  throw new Error("Persistent .env must set ADMIN_HTTP_ENABLED=true for V3 production");
}
for (const [key, expected] of [["ADMIN_HTTP_HOST", "127.0.0.1"], ["ADMIN_HTTP_PORT", "6200"], ["INGRESS_READ_API_PORT", "6198"]]) {
  if (values.has(key) && values.get(key) !== expected) {
    throw new Error(`Persistent .env must keep ${key}=${expected} for V3 production`);
  }
}
const ingressReadApiToken = values.get("INGRESS_READ_API_TOKEN");
if (!ingressReadApiToken || !/^[A-Za-z0-9_-]{32,256}$/.test(ingressReadApiToken)) {
  throw new Error("Persistent .env must contain a normalized ingress Read API token before V3 migration");
}
NODE

# Link only state that V3 still owns. Legacy config and skills are read by the
# migration through UBOT_APP_ROOT and are never linked into a V3 release.
ln -s "$PERSISTENT_ENV" "$STAGING_DIR/.env"
ln -s "$PERSISTENT_DATA" "$STAGING_DIR/data"

cutover_may_have_started=1
UBOT_APP_ROOT="$APP_ROOT" \
  UBOT_HUIXIAN_PROFILE_PATH="$STAGING_DIR/assets/huixian-profile.json" \
  "$NODE_BIN" "$STAGING_DIR/scripts/migrate-v3-state.mjs" --execute --allow-existing-cutover

# Keep the real NapCat configuration root-owned. The configurator first
# validates the exact approved field against a restricted staging copy while
# updating the user-owned dotenv file, then the deployer swaps that copy into
# the root-owned path with a same-directory rename.
cp "$NAPCAT_CONFIG" "$NAPCAT_CONFIG_STAGING"
chmod 600 "$NAPCAT_CONFIG_STAGING"
network_args=(
  --env "$PERSISTENT_ENV"
  --napcat-config "$NAPCAT_CONFIG_STAGING"
  --reverse-url "$NAPCAT_REVERSE_URL"
)
if [[ -n "$NAPCAT_URL_PATH" ]]; then
  network_args+=(--napcat-url-path "$NAPCAT_URL_PATH")
fi
network_args+=(--html-preview-root "$PREVIEW_ROOT")
"$NODE_BIN" "$STAGING_DIR/scripts/configure-v3-network.mjs" "${network_args[@]}"
verify_updated_network_env
install_napcat_config_atomically

# The one-time migration runs under the administrative deployer so it can
# read retired root-/legacy-owned sources. Once its SQLite transaction and the
# new dotenv are complete, hand all live state to the constrained service user
# before any UBot unit is started.
prepare_preview_root
migrate_runtime_identity_after_backup
prepare_bt_state_directory
verify_runtime_user_access
verify_bt_runtime_user_access

for unit in "${UNIT_FILES[@]}"; do
  template="$STAGING_DIR/deploy/systemd/$unit.template"
  sudo install -m 0644 "$template" "$SYSTEMD_ROOT/$unit"
done

# The preview vhost is intentionally independent from bot.9958.uk. Render
# only reviewed path markers into the dedicated files and atomically replace
# those files; no existing application vhost is touched by this release.
render_preview_nginx_files
install_preview_nginx_file_atomically "$PREVIEW_NGINX_INCLUDE_STAGING" "$PREVIEW_NGINX_INCLUDE"
install_preview_nginx_file_atomically "$PREVIEW_NGINX_VHOST_STAGING" "$PREVIEW_NGINX_CONFIG"
install_preview_nginx_enabled_link
sudo nginx -t
verify_effective_nginx_vhost_ownership

mv "$STAGING_DIR" "$RELEASE_DIR"
switch_current_link "$RELEASE_DIR"

sudo systemctl daemon-reload
# Disable preserves the old unit file for manual disaster recovery.
sudo systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
sudo systemctl enable ubot.target ubot-maintenance.timer ubot-cloudflare-allowlist.timer
reset_runtime_service_failures
sudo systemctl start ubot.target
sudo systemctl reload nginx

for service in "${RUNTIME_SERVICES[@]}"; do
  if ! is_active "$service"; then
    echo "$service did not become active." >&2
    exit 1
  fi
done
capture_service_restart_counts
wait_for_ingress_read_api_listener
wait_for_admin_auth_boundary
verify_service_restart_counts_stable

# NapCat reads OneBot configuration at process startup (or through its WebUI
# setter); a host-side atomic JSON replacement is not a configuration reload.
# Keep the old reverse connection alive until all V3 processes are healthy,
# then restart the known production container so it loads the approved URL.
napcat_restart_attempted=1
restart_napcat_container
wait_for_ingress_read_api_health
wait_for_admin_auth_boundary
verify_service_restart_counts_stable

# Start the independent SQLite retention scheduler only after every service,
# the authenticated read API, and the post-restart checks are healthy.
sudo systemctl start "$MAINTENANCE_TIMER"
sudo systemctl start "$CLOUDFLARE_ALLOWLIST_TIMER"

rollback_armed=0
trap - ERR
cleanup_staged_release_inputs
trap - EXIT
printf 'UBot %s deployed successfully. Restricted backup: %s\n' "$VERSION" "$BACKUP_DIR"
