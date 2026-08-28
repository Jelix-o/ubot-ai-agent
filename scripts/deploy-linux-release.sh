#!/usr/bin/env bash
# Deploy one verified UBot V3 release on Linux.
#
# This script deliberately performs a one-way state cutover. It backs up the
# old persistent state before migration, but never restores a database or
# replays QQ messages automatically after the V3 migration has completed.
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-linux-release.sh <version> <bundle.tar.gz> [bundle.tar.gz.sha256]

The archive and manifest must be the matching downloaded GitHub Release assets.
The deployer verifies their SHA-256 manifest locally before extracting anything.

Optional environment:
  UBOT_APP_ROOT=/opt/ai-project
  UBOT_RELEASE_ROOT=/opt/ai-project-releases
  UBOT_SYSTEMD_ROOT=/etc/systemd/system
  UBOT_LEGACY_SERVICE=ai-project.service
  UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json
  UBOT_NAPCAT_REVERSE_URL=ws://172.21.0.1:6199/onebot/ws
  UBOT_NAPCAT_CONTAINER=napcat
  UBOT_PREVIEW_CERT_PATH=/etc/ssl/cloudflare/preview.9958.uk.pem
  UBOT_PREVIEW_KEY_PATH=/etc/ssl/cloudflare/preview.9958.uk.key

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

VERSION="$1"
BUNDLE="$2"
CHECKSUM_FILE="${3:-$BUNDLE.sha256}"

case "$VERSION" in
  *[!0-9A-Za-z._-]*|"")
    echo "Invalid release version." >&2
    exit 2
    ;;
esac

if [[ ! -f "$BUNDLE" || ! -f "$CHECKSUM_FILE" ]]; then
  echo "Downloaded GitHub Release bundle or its SHA-256 manifest is missing." >&2
  exit 2
fi
if [[ "$(basename "$BUNDLE")" != "ubot-$VERSION-linux.tar.gz" ]]; then
  echo "Bundle must retain the matching GitHub Release asset name: ubot-$VERSION-linux.tar.gz" >&2
  exit 2
fi

APP_ROOT="${UBOT_APP_ROOT:-/opt/ai-project}"
RELEASE_ROOT="${UBOT_RELEASE_ROOT:-/opt/ai-project-releases}"
SYSTEMD_ROOT="${UBOT_SYSTEMD_ROOT:-/etc/systemd/system}"
LEGACY_SERVICE="${UBOT_LEGACY_SERVICE:-ai-project.service}"
RELEASE_DIR="$RELEASE_ROOT/v$VERSION"
STAGING_DIR="$RELEASE_ROOT/.staging-v$VERSION-$$"
CURRENT_LINK="$RELEASE_ROOT/current"
PERSISTENT_ENV="$APP_ROOT/.env"
PERSISTENT_DATA="$APP_ROOT/data"
DB_PATH="$PERSISTENT_DATA/shared/bot-shared.db"
ROLLBACK_DIR="$PERSISTENT_DATA/v3-rollback"
SKILLS_DIR="$APP_ROOT/skills"
BACKUP_ROOT="$APP_ROOT/release-backups"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP-v$VERSION"
NAPCAT_CONFIG="${UBOT_NAPCAT_CONFIG:-/opt/napcat/config/onebot11_428881701.json}"
NAPCAT_REVERSE_URL="${UBOT_NAPCAT_REVERSE_URL:-ws://172.21.0.1:6199/onebot/ws}"
NAPCAT_URL_PATH="network.websocketClients.0.url"
NAPCAT_CONFIG_STAGING="$BACKUP_DIR/napcat-config.v3.json"
NAPCAT_CONTAINER="${UBOT_NAPCAT_CONTAINER:-napcat}"
NAPCAT_RESTART_TIMEOUT_SECONDS=60
GITHUB_RELEASE_REPOSITORY="Jelix-o/ubot-ai-agent"
# These targets are intentionally not configurable: accepting an arbitrary
# /etc/nginx path would let a deployment environment variable overwrite an
# unrelated production vhost. Only this isolated preview site is release-owned.
PREVIEW_NGINX_CONFIG="/etc/nginx/sites-available/preview-9958"
PREVIEW_NGINX_INCLUDE="/etc/nginx/ubot-preview-static.conf"
PREVIEW_NGINX_ENABLED_LINK="/etc/nginx/sites-enabled/preview-9958"
PREVIEW_CERTIFICATE="${UBOT_PREVIEW_CERT_PATH:-${UBOT_PREVIEW_CERTIFICATE:-/etc/ssl/cloudflare/preview.9958.uk.pem}}"
PREVIEW_CERTIFICATE_KEY="${UBOT_PREVIEW_KEY_PATH:-${UBOT_PREVIEW_CERTIFICATE_KEY:-/etc/ssl/cloudflare/preview.9958.uk.key}}"
PREVIEW_ROOT=""
PREVIEW_ROOT_PAGES=""

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
)

old_current_target=""
old_legacy_active=0
old_target_active=0
old_napcat_active=0
existing_cutover_before_deploy=0
cutover_may_have_started=0
rollback_armed=0
napcat_restart_attempted=0

require_command() {
  command -v "$1" >/dev/null || {
    echo "Required command is missing: $1" >&2
    exit 2
  }
}

for command in node npm tar sha256sum systemctl sudo curl install mv readlink ln nginx mktemp dirname basename find docker sleep stat sed openssl grep; do
  require_command "$command"
done
sudo -n true

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
  require_safe_absolute_path "$PREVIEW_CERTIFICATE" "Preview Origin certificate" "/etc/"
  require_safe_absolute_path "$PREVIEW_CERTIFICATE_KEY" "Preview Origin certificate key" "/etc/"
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

preflight_preview_certificate() {
  local subject_alt_names cert_public_key key_public_key
  require_sudo_readable_regular_file "$PREVIEW_CERTIFICATE" "Preview TLS certificate"
  require_sudo_readable_regular_file "$PREVIEW_CERTIFICATE_KEY" "Preview TLS certificate key"
  if ! subject_alt_names="$(sudo -n openssl x509 -in "$PREVIEW_CERTIFICATE" -noout -ext subjectAltName 2>/dev/null)"; then
    fail_cutover_preflight "Preview TLS certificate could not be parsed: $PREVIEW_CERTIFICATE"
  fi
  if [[ "$subject_alt_names" != *"DNS:preview.9958.uk"* ]]; then
    fail_cutover_preflight "Preview TLS certificate does not cover preview.9958.uk"
  fi
  if ! cert_public_key="$(sudo -n openssl x509 -in "$PREVIEW_CERTIFICATE" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{ print $1 }')"; then
    fail_cutover_preflight "Preview TLS certificate public key could not be read."
  fi
  if ! key_public_key="$(sudo -n openssl pkey -in "$PREVIEW_CERTIFICATE_KEY" -pubout -outform DER 2>/dev/null | sha256sum | awk '{ print $1 }')"; then
    fail_cutover_preflight "Preview TLS certificate key could not be read."
  fi
  if [[ ! "$cert_public_key" =~ ^[a-f0-9]{64}$ ]] || [[ "$cert_public_key" != "$key_public_key" ]]; then
    fail_cutover_preflight "Preview TLS certificate and key do not match."
  fi
}

load_preview_settings() {
  local loaded_root
  if ! loaded_root="$(PERSISTENT_ENV="$PERSISTENT_ENV" PERSISTENT_DATA="$PERSISTENT_DATA" node - <<'NODE'
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
const configuredRoot = values.get("HTML_PREVIEW_ROOT")?.trim();
if (configuredRoot && !path.isAbsolute(configuredRoot)) {
  throw new Error("HTML_PREVIEW_ROOT must be an absolute path in Linux production");
}
const previewRoot = path.resolve(configuredRoot || path.join(dataRoot, "generated-pages"));
const relative = path.relative(dataRoot, previewRoot);
if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("HTML_PREVIEW_ROOT must be a child of the persistent data directory");
}
if (!/^[A-Za-z0-9._/-]+$/.test(previewRoot)) {
  throw new Error("HTML_PREVIEW_ROOT contains unsupported path characters for Nginx deployment");
}
const publicBase = values.get("HTML_PREVIEW_PUBLIC_BASE_URL")?.trim() || "https://preview.9958.uk";
const parsed = new URL(publicBase);
if (parsed.origin !== "https://preview.9958.uk" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
  throw new Error("HTML_PREVIEW_PUBLIC_BASE_URL must be exactly https://preview.9958.uk in production");
}
process.stdout.write(previewRoot);
NODE
  )"; then
    fail_cutover_preflight "Could not validate persistent HTML preview settings."
  fi
  PREVIEW_ROOT="$loaded_root"
  PREVIEW_ROOT_PAGES="$PREVIEW_ROOT/pages"
}

prepare_preview_root() {
  if [[ -e "$PREVIEW_ROOT" && ! -d "$PREVIEW_ROOT" ]]; then
    fail_cutover_preflight "HTML preview root is not a directory: $PREVIEW_ROOT"
  fi
  install -d -m 0755 "$PREVIEW_ROOT" "$PREVIEW_ROOT_PAGES"
  if [[ ! -w "$PREVIEW_ROOT" || ! -w "$PREVIEW_ROOT_PAGES" ]]; then
    fail_cutover_preflight "HTML preview root must be writable by the UBot deployment user."
  fi
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

  if [[ ! -d "$PERSISTENT_DATA" ]]; then
    fail_cutover_preflight "Persistent data directory is missing: $PERSISTENT_DATA"
  fi
  require_mutable_directory "$PERSISTENT_DATA" "Persistent data"
  require_readable_file "$DB_PATH" "Shared SQLite database"
  if [[ ! -w "$DB_PATH" ]]; then
    fail_cutover_preflight "Shared SQLite database must be writable by the deployment user: $DB_PATH"
  fi
  require_mutable_directory "$(dirname "$DB_PATH")" "Shared SQLite database parent"

  if [[ -e "$ROLLBACK_DIR" ]]; then
    if [[ ! -d "$ROLLBACK_DIR" ]]; then
      fail_cutover_preflight "V3 rollback path is not a directory: $ROLLBACK_DIR"
    fi
    if [[ ! -O "$ROLLBACK_DIR" ]]; then
      fail_cutover_preflight "V3 rollback directory must be owned by the deployment user because migration restricts its mode: $ROLLBACK_DIR"
    fi
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
  preflight_preview_certificate
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
  local metadata_path official_manifest_path manifest_url asset_name official_line supplied_line official_hash supplied_hash
  asset_name="$(basename "$BUNDLE")"
  metadata_path="$(mktemp)"
  official_manifest_path="$(mktemp)"
  if ! curl --fail --silent --show-error --location \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_RELEASE_REPOSITORY/releases/tags/v$VERSION" \
    -o "$metadata_path"; then
    rm -f "$metadata_path" "$official_manifest_path"
    echo "Could not retrieve the matching GitHub Release metadata." >&2
    exit 2
  fi
  if ! manifest_url="$(node - "$metadata_path" "$VERSION" "$asset_name" <<'NODE'
const fs = require("node:fs");
const [metadataPath, version, archiveName] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (release.tag_name !== `v${version}` || release.draft === true || release.prerelease === true) {
  throw new Error("GitHub Release is not the matching published final release.");
}
const checksumName = `${archiveName}.sha256`;
const asset = Array.isArray(release.assets) ? release.assets.find((entry) => entry?.name === checksumName) : undefined;
if (!asset?.browser_download_url || typeof asset.browser_download_url !== "string") {
  throw new Error(`GitHub Release is missing ${checksumName}.`);
}
process.stdout.write(asset.browser_download_url);
NODE
  )"; then
    rm -f "$metadata_path" "$official_manifest_path"
    echo "GitHub Release metadata is invalid for the requested version." >&2
    exit 2
  fi
  if ! curl --fail --silent --show-error --location "$manifest_url" -o "$official_manifest_path"; then
    rm -f "$metadata_path" "$official_manifest_path"
    echo "Could not download the GitHub Release SHA-256 manifest." >&2
    exit 2
  fi
  official_line="$(tr -d '\r' < "$official_manifest_path" | awk -v asset="$asset_name" '$2 == asset || $2 == ("*" asset) { print; exit }')"
  supplied_line="$(tr -d '\r' < "$CHECKSUM_FILE" | awk -v asset="$asset_name" '$2 == asset || $2 == ("*" asset) { print; exit }')"
  rm -f "$metadata_path" "$official_manifest_path"
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
  local entry normalized
  while IFS= read -r entry; do
    # `tar -C <dir> -czf archive.tar.gz .` emits this harmless root entry.
    # It is not a filesystem path to extract outside the staging directory.
    if [[ "$entry" == "./" ]]; then
      continue
    fi
    normalized="${entry#./}"
    case "$normalized" in
      ""|/*|../*|*/../*|*/..)
        echo "Release archive contains an unsafe path." >&2
        exit 2
        ;;
    esac
  done < <(tar -tzf "$BUNDLE")
}

is_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == "active" ]]
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
  node - "$PERSISTENT_ENV" <<'NODE'
const fs = require("node:fs");
let value;
for (const raw of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const match = raw.match(/^\s*(?:export\s+)?INGRESS_READ_API_PORT\s*=\s*(.*)$/);
  if (!match) continue;
  value = match[1].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? "");
}
if (value !== "6198") {
  throw new Error("Network configuration must set INGRESS_READ_API_PORT=6198 before V3 starts");
}
NODE
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
  sudo systemctl stop ubot.target 2>/dev/null || true
  restore_napcat_config
  if [[ "$napcat_restart_attempted" -eq 1 && "$old_napcat_active" -eq 1 ]]; then
    restart_napcat_container || echo "NapCat restart after configuration restore failed; inspect $NAPCAT_CONTAINER manually." >&2
  fi
  restore_persistent_env
  restore_preview_nginx_files
  restore_unit_files
  if [[ -n "$old_current_target" ]]; then
    switch_current_link "$old_current_target" || true
  else
    rm -f "$CURRENT_LINK" || true
  fi
  sudo systemctl daemon-reload || true

  # V3 makes SQLite the state authority. Starting the legacy service after the
  # cutover would silently resume JSON writes, so only an operator may do that
  # as part of the documented disaster-recovery procedure.
  if [[ "$cutover_may_have_started" -eq 0 && "$old_legacy_active" -eq 1 ]]; then
    sudo systemctl start "$LEGACY_SERVICE" || true
  fi
  if [[ "$cutover_may_have_started" -eq 0 && "$old_target_active" -eq 1 ]]; then
    sudo systemctl start ubot.target || true
  fi
  # An additive upgrade starts from an already cut-over V3 database. Its
  # migrations are transactional and old V3 code remains compatible with
  # extra tables, so restart the previous target after configuration rollback.
  if [[ "$cutover_may_have_started" -eq 1 && "$existing_cutover_before_deploy" -eq 1 && "$old_target_active" -eq 1 ]]; then
    sudo systemctl start ubot.target || true
  elif [[ "$cutover_may_have_started" -eq 1 ]]; then
    echo "V3 state migration may have changed SQLite. Release, unit, Nginx, dotenv, and NapCat configuration were restored. Do not restart the legacy service; use docs/OPERATIONS-v3.md for manual recovery." >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

verify_checksum
verify_github_release_provenance
validate_archive_paths

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

mkdir -p "$RELEASE_ROOT" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
load_preview_settings
prepare_preview_root

if [[ -f "$DB_PATH" ]] && has_existing_v3_cutover; then
  existing_cutover_before_deploy=1
fi

# Do this before stopping either old service. On a first V3 deployment the
# migration writes its cutover marker before deleting legacy JSON; on a later
# V3 maintenance release it only applies additive SQLite migrations. The
# network configurator then uses atomic replacement for dotenv and NapCat JSON.
preflight_cutover_write_access

if [[ -L "$CURRENT_LINK" ]]; then
  old_current_target="$(readlink "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK must be a symbolic link before V3 deployment." >&2
  exit 2
fi
if is_active "$LEGACY_SERVICE"; then old_legacy_active=1; fi
if is_active ubot.target; then old_target_active=1; fi

# Stop all writers before backing up SQLite or reading legacy JSON files.
# Arm rollback first: failure to stop the second legacy writer must still
# restore a target that was already stopped by the first command.
rollback_armed=1
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
  if [[ -e "$PREVIEW_ROOT" ]]; then
    preview_root_relative="${PREVIEW_ROOT#"$PERSISTENT_DATA/"}"
    if [[ "$preview_root_relative" == "$PREVIEW_ROOT" || -z "$preview_root_relative" ]]; then
      fail_cutover_preflight "HTML preview root must remain under persistent data for backup."
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
tar -C "$APP_ROOT" -czf "$BACKUP_DIR/persistent-files.tar.gz" "${backup_inputs[@]}"
chmod 600 "$BACKUP_DIR/persistent-files.tar.gz"

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
fi

mkdir -p "$STAGING_DIR"
tar -xzf "$BUNDLE" -C "$STAGING_DIR"
for required in \
  package.json package-lock.json dist/index.js assets/huixian-profile.json \
  scripts/deploy-linux-release.sh scripts/migrate-v3-state.mjs \
  scripts/configure-v3-network.mjs \
  deploy/systemd/ubot-ingress.service.template deploy/systemd/ubot-worker.service.template \
  deploy/systemd/ubot-admin.service.template deploy/systemd/ubot.target.template \
  deploy/systemd/ubot-maintenance.service.template deploy/systemd/ubot-maintenance.timer.template \
  deploy/nginx/preview.9958.uk.conf deploy/nginx/ubot-preview-static.conf; do
  if [[ ! -e "$STAGING_DIR/$required" ]]; then
    echo "Release bundle is missing a required V3 path: $required" >&2
    exit 2
  fi
done

node "$STAGING_DIR/scripts/verify-release-source.mjs" "$STAGING_DIR"

bundle_version="$(node -p "require(process.argv[1]).version" "$STAGING_DIR/package.json")"
if [[ "$bundle_version" != "$VERSION" ]]; then
  echo "Bundle version does not match the requested version." >&2
  exit 2
fi

(
  cd "$STAGING_DIR"
  npm ci --omit=dev --ignore-scripts
)

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
NODE

# Link only state that V3 still owns. Legacy config and skills are read by the
# migration through UBOT_APP_ROOT and are never linked into a V3 release.
ln -s "$PERSISTENT_ENV" "$STAGING_DIR/.env"
ln -s "$PERSISTENT_DATA" "$STAGING_DIR/data"

cutover_may_have_started=1
UBOT_APP_ROOT="$APP_ROOT" \
  UBOT_HUIXIAN_PROFILE_PATH="$STAGING_DIR/assets/huixian-profile.json" \
  node "$STAGING_DIR/scripts/migrate-v3-state.mjs" --execute --allow-existing-cutover

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
node "$STAGING_DIR/scripts/configure-v3-network.mjs" "${network_args[@]}"
verify_updated_network_env
install_napcat_config_atomically

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

mv "$STAGING_DIR" "$RELEASE_DIR"
switch_current_link "$RELEASE_DIR"

sudo systemctl daemon-reload
# Disable preserves the old unit file for manual disaster recovery.
sudo systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
sudo systemctl enable ubot.target ubot-maintenance.timer
sudo systemctl start ubot.target
sudo systemctl start ubot-maintenance.timer
sudo systemctl reload nginx

sleep 3
for service in ubot-ingress.service ubot-worker.service ubot-admin.service; do
  if ! is_active "$service"; then
    echo "$service did not become active." >&2
    exit 1
  fi
done

# NapCat reads OneBot configuration at process startup (or through its WebUI
# setter); a host-side atomic JSON replacement is not a configuration reload.
# Keep the old reverse connection alive until all V3 processes are healthy,
# then restart the known production container so it loads the approved URL.
napcat_restart_attempted=1
restart_napcat_container

# Authentication protects this endpoint. A 401 is the expected unauthenticated
# listener proof; do not expose a public health endpoint merely for deployment.
health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 http://127.0.0.1:6200/api/health || true)"
if [[ "$health_status" != "401" ]]; then
  echo "Expected protected admin health endpoint to return 401." >&2
  exit 1
fi

rollback_armed=0
trap - ERR
printf 'UBot %s deployed successfully. Restricted backup: %s\n' "$VERSION" "$BACKUP_DIR"
