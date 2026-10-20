#!/usr/bin/env bash
# Install the two UBot-only origin vhosts after the 9958.uk zone has passed
# origin-TLS preflight and been switched to Cloudflare Full (strict). This is
# intentionally constrained to bot.9958.uk and preview.9958.uk.
set -euo pipefail
umask 077

# This root installer must not inherit a caller-controlled lookup path or
# startup hooks before it invokes helper binaries and the verified Node runtime.
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
TMPDIR="/tmp"
export PATH TMPDIR
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 2
fi
if [[ "${UBOT_CLOUDFLARE_STRICT_READY:-}" != "1" ]]; then
  echo "Set UBOT_CLOUDFLARE_STRICT_READY=1 only after all proxied 9958.uk origins pass preflight on Full (strict)." >&2
  exit 2
fi

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd -P)"
APP_ROOT="/opt/ai-project"
BOT_TEMPLATE="$ROOT/deploy/nginx/bot.9958.uk.conf"
PREVIEW_TEMPLATE="$ROOT/deploy/nginx/preview.9958.uk.conf"
PREVIEW_STATIC_TEMPLATE="$ROOT/deploy/nginx/ubot-preview-static.conf"
ALLOWLIST_UPDATER="$ROOT/scripts/update-cloudflare-origin-allowlist.sh"
VHOST_OWNERSHIP_VERIFIER="$ROOT/scripts/verify-nginx-vhost-ownership.mjs"
BOT_CONFIG="/etc/nginx/sites-available/bot-9958"
BOT_ENABLED="/etc/nginx/sites-enabled/bot-9958"
PREVIEW_CONFIG="/etc/nginx/sites-available/preview-9958"
PREVIEW_INCLUDE="/etc/nginx/ubot-preview-static.conf"
PREVIEW_ENABLED="/etc/nginx/sites-enabled/preview-9958"
READY_MARKER="/etc/nginx/ubot-cloudflare-origin.ready"
BOT_CERTIFICATE="/etc/ssl/cloudflare/bot.9958.uk.pem"
BOT_CERTIFICATE_KEY="/etc/ssl/cloudflare/bot.9958.uk.key"
PREVIEW_CERTIFICATE="/etc/ssl/cloudflare/preview.9958.uk.pem"
PREVIEW_CERTIFICATE_KEY="/etc/ssl/cloudflare/preview.9958.uk.key"
BACKUP_ROOT="/var/backups/ubot-origin"
NODE_BIN="/opt/ubot-runtime/node22/bin/node"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR=""

for command in bash nginx openssl install mktemp sed cp mv ln readlink mkdir date sha256sum awk rm stat dirname grep find; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 2
  }
done
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Required application-scoped Node 22 runtime is missing or not executable: $NODE_BIN" >&2
  exit 2
fi

fail_source_safety_check() {
  echo "Origin hardening bootstrap safety check failed: $1" >&2
  exit 2
}

assert_root_controlled_source_tree() {
  local source_tree="$1"
  local label="$2"
  local current metadata mode unsafe_entry unsafe_link
  if [[ -L "$source_tree" || ! -d "$source_tree" ]]; then
    fail_source_safety_check "$label must be a real directory: $source_tree"
  fi
  current="$source_tree"
  while :; do
    if [[ -L "$current" || ! -e "$current" ]]; then
      fail_source_safety_check "$label ancestor must be a real existing path: $current"
    fi
    metadata="$(stat -c '%u:%g:%a' "$current")"
    if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
      fail_source_safety_check "$label ancestor must be owned by root:root: $current"
    fi
    mode=$((8#${metadata##*:}))
    if (( (mode & 18) != 0 )); then
      fail_source_safety_check "$label ancestor must not be writable by group or other users: $current"
    fi
    if [[ "$current" == "/" ]]; then
      break
    fi
    current="$(dirname "$current")"
  done
  unsafe_entry="$(find "$source_tree" -xdev \( -type f -o -type d \) \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)"
  if [[ -n "$unsafe_entry" ]]; then
    fail_source_safety_check "$label contains non-root-controlled content: $unsafe_entry"
  fi
  unsafe_link="$(find "$source_tree" -xdev -type l -print -quit)"
  if [[ -n "$unsafe_link" ]]; then
    fail_source_safety_check "$label must not contain symbolic links: $unsafe_link"
  fi
}

# This installer writes root-owned Nginx configuration and installs a root
# timer. It must never bootstrap from an old mutable `current` release.
assert_root_controlled_source_tree "$ROOT/scripts" "Origin hardening helper source"
assert_root_controlled_source_tree "$ROOT/deploy/nginx" "Origin hardening template source"

for source in "$BOT_TEMPLATE" "$PREVIEW_TEMPLATE" "$PREVIEW_STATIC_TEMPLATE" "$ALLOWLIST_UPDATER" "$VHOST_OWNERSHIP_VERIFIER"; do
  if [[ ! -f "$source" || -L "$source" ]]; then
    echo "UBot origin hardening source is missing or unsafe: $source" >&2
    exit 2
  fi
done

validate_regular_target() {
  local target="$1"
  local label="$2"
  if [[ -L "$target" ]] || { [[ -e "$target" ]] && [[ ! -f "$target" ]]; }; then
    echo "$label must be a regular file when present: $target" >&2
    exit 2
  fi
}

validate_enabled_link() {
  local target="$1"
  local expected="$2"
  local label="$3"
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -L "$target" || "$(readlink "$target")" != "$expected" ]]; then
      echo "$label must be a symlink to $expected: $target" >&2
      exit 2
    fi
  fi
}

certificate_covers_hostname() {
  local certificate="$1"
  local hostname="$2"
  local dns_entries
  # Parse whole SAN DNS values rather than matching a presentation substring:
  # a suffix such as bot.9958.uk.evil.example must not pass preflight.
  if ! dns_entries="$(openssl x509 -in "$certificate" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^,[:space:]]+' | sed 's/^DNS://')"; then
    return 1
  fi
  printf '%s\n' "$dns_entries" | grep -Fqx -e "$hostname" -e '*.9958.uk'
}

validate_private_key() {
  local certificate="$1"
  local key="$2"
  local hostname="$3"
  local certificate_metadata key_metadata directory_metadata certificate_public_key key_public_key certificate_mode directory_mode
  local minimum_validity_seconds=604800
  if [[ ! -f "$certificate" || -L "$certificate" || ! -f "$key" || -L "$key" ]]; then
    echo "Cloudflare Origin certificate or private key is missing or unsafe for $hostname." >&2
    exit 2
  fi
  certificate_metadata="$(stat -c '%u:%g:%a' "$certificate")"
  key_metadata="$(stat -c '%u:%g:%a' "$key")"
  directory_metadata="$(stat -c '%u:%g:%a' "$(dirname "$key")")"
  if [[ ! "$certificate_metadata" =~ ^0:0:[0-7]{3,4}$ ]] ||
     [[ ! "$key_metadata" =~ ^0:0:(600|640)$ ]] ||
     [[ ! "$directory_metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
    echo "Cloudflare Origin certificate directory/key must be root-owned; private keys must be 0600 or 0640." >&2
    exit 2
  fi
  certificate_mode=$((8#${certificate_metadata##*:}))
  directory_mode=$((8#${directory_metadata##*:}))
  if (( (certificate_mode & 18) != 0 )); then
    echo "Cloudflare Origin certificate file must not be writable by group or other users." >&2
    exit 2
  fi
  if (( (directory_mode & 18) != 0 )); then
    echo "Cloudflare Origin certificate directory must not be writable by group or other users." >&2
    exit 2
  fi
  if ! openssl x509 -in "$certificate" -noout -checkend "$minimum_validity_seconds" >/dev/null 2>&1; then
    echo "Cloudflare Origin certificate is expired or expires within seven days for $hostname." >&2
    exit 2
  fi
  if ! certificate_covers_hostname "$certificate" "$hostname"; then
    echo "Origin certificate does not cover $hostname." >&2
    exit 2
  fi
  certificate_public_key="$(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{ print $1 }')"
  key_public_key="$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | awk '{ print $1 }')"
  if [[ ! "$certificate_public_key" =~ ^[a-f0-9]{64}$ ]] || [[ "$certificate_public_key" != "$key_public_key" ]]; then
    echo "Origin certificate and private key do not match for $hostname." >&2
    exit 2
  fi
}

resolve_existing_preview_root() {
  "$NODE_BIN" - "$APP_ROOT/.env" "$APP_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [envPath, appRoot] = process.argv.slice(2);
const values = new Map();
for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(match[1], value);
}
const configured = values.get("HTML_PREVIEW_ROOT")?.trim();
if (configured && (!path.isAbsolute(configured) || configured.includes("\0") || configured !== path.resolve(configured) || !/^[A-Za-z0-9._/-]+$/.test(configured))) {
  throw new Error("Existing HTML_PREVIEW_ROOT is not a normalized Linux path");
}
const previewRoot = path.resolve(configured || path.join(appRoot, "data", "generated-pages"));
const dataRoot = path.join(path.resolve(appRoot), "data");
const relative = path.relative(dataRoot, previewRoot);
const inData = Boolean(relative) && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative);
if (previewRoot !== "/var/lib/ubot-preview" && !inData) {
  throw new Error("Existing HTML_PREVIEW_ROOT is outside managed storage");
}
process.stdout.write(previewRoot);
NODE
}

backup_target() {
  local target="$1"
  local backup_name="$2"
  if [[ -L "$target" ]]; then
    readlink "$target" > "$BACKUP_DIR/$backup_name.symlink"
  elif [[ -f "$target" ]]; then
    cp -p "$target" "$BACKUP_DIR/$backup_name"
  elif [[ -e "$target" ]]; then
    echo "Refusing non-regular Nginx target during backup: $target" >&2
    exit 2
  else
    : > "$BACKUP_DIR/$backup_name.absent"
  fi
}

install_file_atomically() {
  local source="$1"
  local target="$2"
  local parent temporary
  parent="$(dirname "$target")"
  temporary="$(mktemp "$parent/.ubot-origin.XXXXXX")"
  if ! install -m 0644 "$source" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  mv -f "$temporary" "$target"
}

install_enabled_link() {
  local target="$1"
  local source="$2"
  local parent temporary
  parent="$(dirname "$target")"
  temporary="$parent/.ubot-origin-link-$TIMESTAMP"
  rm -f "$temporary"
  ln -s "$source" "$temporary"
  mv -Tf "$temporary" "$target"
}

install_or_restore() {
  if ! "$@"; then
    restore_previous_configuration
    echo "Could not atomically install a UBot origin configuration file; both UBot vhosts were restored." >&2
    return 1
  fi
}

restore_target() {
  local target="$1"
  local backup_name="$2"
  if [[ -f "$BACKUP_DIR/$backup_name" ]]; then
    install_file_atomically "$BACKUP_DIR/$backup_name" "$target"
  elif [[ -f "$BACKUP_DIR/$backup_name.symlink" ]]; then
    rm -f "$target"
    ln -s "$(<"$BACKUP_DIR/$backup_name.symlink")" "$target"
  elif [[ -f "$BACKUP_DIR/$backup_name.absent" ]]; then
    rm -f "$target"
  fi
}

restore_previous_configuration() {
  restore_target "$BOT_CONFIG" "bot-9958.before" || true
  restore_target "$BOT_ENABLED" "bot-9958.enabled.before" || true
  restore_target "$PREVIEW_CONFIG" "preview-9958.before" || true
  restore_target "$PREVIEW_INCLUDE" "preview-static.before" || true
  restore_target "$PREVIEW_ENABLED" "preview-9958.enabled.before" || true
  restore_target "$READY_MARKER" "origin-ready.before" || true
  nginx -t && systemctl reload nginx || true
}

verify_generated_allowlist() {
  local origin_cidrs realip_cidrs
  origin_cidrs="$(grep -Ec '^[[:space:]]*[0-9A-Fa-f:.]+/[0-9]+[[:space:]]+1;$' /etc/nginx/conf.d/ubot-cloudflare-origin.conf || true)"
  realip_cidrs="$(grep -Ec '^set_real_ip_from[[:space:]]+[0-9A-Fa-f:.]+/[0-9]+;$' /etc/nginx/ubot-cloudflare-realip.conf || true)"
  if [[ ! "$origin_cidrs" =~ ^[0-9]+$ || ! "$realip_cidrs" =~ ^[0-9]+$ ||
      "$origin_cidrs" -lt 15 || "$origin_cidrs" != "$realip_cidrs" ]]; then
    echo "Generated Cloudflare CIDR includes are incomplete or inconsistent." >&2
    return 1
  fi
}

verify_effective_vhost_ownership() {
  local rendered_config
  rendered_config="$(mktemp "${TMPDIR}/ubot-nginx-rendered.XXXXXX")"
  if ! nginx -T > "$rendered_config" 2>&1; then
    rm -f -- "$rendered_config"
    echo "Nginx rejected UBot origin hardening; both UBot vhosts were restored." >&2
    return 1
  fi
  # A duplicate legacy vhost can make nginx -t succeed while Nginx still
  # selects an un-gated server for the same Host. Verify the effective parsed
  # server blocks and their include source before reloading.
  if ! "$NODE_BIN" "$VHOST_OWNERSHIP_VERIFIER" \
    "$rendered_config" \
    "$BOT_CONFIG" "$BOT_ENABLED" "bot.9958.uk" \
    "$PREVIEW_CONFIG" "$PREVIEW_ENABLED" "preview.9958.uk"; then
    rm -f -- "$rendered_config"
    echo "Nginx has missing or competing UBot hostname vhosts; both UBot vhosts were restored." >&2
    return 1
  fi
  rm -f -- "$rendered_config"
}

for target in "$BOT_CONFIG" "$PREVIEW_CONFIG" "$PREVIEW_INCLUDE" "$READY_MARKER"; do
  validate_regular_target "$target" "Nginx target"
done
validate_enabled_link "$BOT_ENABLED" "$BOT_CONFIG" "Bot enabled target"
validate_enabled_link "$PREVIEW_ENABLED" "$PREVIEW_CONFIG" "Preview enabled target"
validate_private_key "$BOT_CERTIFICATE" "$BOT_CERTIFICATE_KEY" "bot.9958.uk"
validate_private_key "$PREVIEW_CERTIFICATE" "$PREVIEW_CERTIFICATE_KEY" "preview.9958.uk"
if [[ ! -f "$APP_ROOT/.env" || -L "$APP_ROOT/.env" ]]; then
  echo "Persistent UBot dotenv is missing or unsafe: $APP_ROOT/.env" >&2
  exit 2
fi
PREVIEW_ROOT="$(resolve_existing_preview_root)"
if [[ -L "$PREVIEW_ROOT" ]]; then
  echo "Existing HTML preview root must not be a symbolic link: $PREVIEW_ROOT" >&2
  exit 2
fi

if [[ -L "$BACKUP_ROOT" ]] || { [[ -e "$BACKUP_ROOT" ]] && [[ ! -d "$BACKUP_ROOT" ]]; }; then
  echo "UBot origin backup root must be a real directory: $BACKUP_ROOT" >&2
  exit 2
fi
mkdir -p -m 0700 "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/$TIMESTAMP.XXXXXX")"
for entry in \
  "$BOT_CONFIG:bot-9958.before" \
  "$BOT_ENABLED:bot-9958.enabled.before" \
  "$PREVIEW_CONFIG:preview-9958.before" \
  "$PREVIEW_INCLUDE:preview-static.before" \
  "$PREVIEW_ENABLED:preview-9958.enabled.before" \
  "$READY_MARKER:origin-ready.before"; do
  backup_target "${entry%%:*}" "${entry#*:}"
done

# This updater is itself transactional: it validates both full CIDR lists,
# replaces same-directory files atomically, and restores them on Nginx failure.
bash "$ALLOWLIST_UPDATER"
if ! verify_generated_allowlist; then
  echo "Cloudflare allow-list verification failed before UBot vhost installation." >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ubot-origin-hardening.XXXXXX")"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT
sed \
  -e "s|__UBOT_BOT_CERT_PATH__|$BOT_CERTIFICATE|g" \
  -e "s|__UBOT_BOT_KEY_PATH__|$BOT_CERTIFICATE_KEY|g" \
  "$BOT_TEMPLATE" > "$STAGING_DIR/bot-9958"
sed \
  -e "s|__UBOT_PREVIEW_CERT_PATH__|$PREVIEW_CERTIFICATE|g" \
  -e "s|__UBOT_PREVIEW_KEY_PATH__|$PREVIEW_CERTIFICATE_KEY|g" \
  "$PREVIEW_TEMPLATE" > "$STAGING_DIR/preview-9958"
sed -e "s|__UBOT_HTML_PREVIEW_ROOT__|$PREVIEW_ROOT|g" \
  "$PREVIEW_STATIC_TEMPLATE" > "$STAGING_DIR/preview-static"
printf 'UBOT_CLOUDFLARE_ORIGIN_BOUNDARY=1\n' > "$STAGING_DIR/origin-ready"

install_or_restore install_file_atomically "$STAGING_DIR/bot-9958" "$BOT_CONFIG"
install_or_restore install_file_atomically "$STAGING_DIR/preview-9958" "$PREVIEW_CONFIG"
install_or_restore install_file_atomically "$STAGING_DIR/preview-static" "$PREVIEW_INCLUDE"
install_or_restore install_file_atomically "$STAGING_DIR/origin-ready" "$READY_MARKER"
install_or_restore install_enabled_link "$BOT_ENABLED" "$BOT_CONFIG"
install_or_restore install_enabled_link "$PREVIEW_ENABLED" "$PREVIEW_CONFIG"

if ! nginx -t; then
  restore_previous_configuration
  echo "Nginx rejected UBot origin hardening; both UBot vhosts were restored." >&2
  exit 1
fi
if ! verify_effective_vhost_ownership; then
  restore_previous_configuration
  exit 1
fi
if ! systemctl reload nginx; then
  restore_previous_configuration
  echo "Nginx reload failed; both UBot vhosts were restored." >&2
  exit 1
fi

printf 'UBot Cloudflare origin hardening installed. Backup: %s\n' "$BACKUP_DIR"
