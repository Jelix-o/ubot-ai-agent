#!/usr/bin/env bash
# Reconcile the two UBot-only Nginx Cloudflare allow-list includes. Both files
# are atomically replaced only after the complete current IPv4 and IPv6 lists
# validate. A failed Nginx test or reload restores the last known-good files.
set -euo pipefail
umask 077

if (( EUID != 0 )); then
  echo "Run this updater as root." >&2
  exit 2
fi
# This root timer must not inherit an interactive PATH. The service and this
# script intentionally use the distribution's Nginx binary by absolute path.
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
TMPDIR="/tmp"
export PATH TMPDIR
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS
NGINX_BIN="/usr/sbin/nginx"
NODE_BIN="/opt/ubot-runtime/node22/bin/node"
CONF_D="/etc/nginx/conf.d"
ORIGIN_CONFIG="$CONF_D/ubot-cloudflare-origin.conf"
REALIP_CONFIG="/etc/nginx/ubot-cloudflare-realip.conf"

for command in curl install mktemp awk sort cmp cp rm mkdir systemctl sed grep wc tr cat mv dirname readlink stat find; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 2
  }
done
if [[ ! -x "$NGINX_BIN" ]]; then
  echo "Required Nginx binary is missing or not executable: $NGINX_BIN" >&2
  exit 2
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Required Node 22 runtime is missing or not executable: $NODE_BIN" >&2
  exit 2
fi
fail_source_safety_check() {
  echo "Cloudflare allow-list updater bootstrap safety check failed: $1" >&2
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

# This script is called by a root-owned timer. Resolve an invoked `current`
# symlink first, then reject mutable or linked source trees before it can fetch
# CIDRs or touch the active Nginx configuration.
SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
assert_root_controlled_source_tree "$SCRIPT_DIR" "Cloudflare allow-list updater source"

TEMPORARY_DIR="$(mktemp -d "$TMPDIR/ubot-cloudflare-cidrs.XXXXXX")"

cleanup() {
  rm -rf -- "$TEMPORARY_DIR"
}
trap cleanup EXIT

for target in "$ORIGIN_CONFIG" "$REALIP_CONFIG"; do
  if [[ -L "$target" ]] || { [[ -e "$target" ]] && [[ ! -f "$target" ]]; }; then
    echo "Refusing Nginx target that is not a regular file: $target" >&2
    exit 2
  fi
done
mkdir -p "$CONF_D" "$(dirname "$REALIP_CONFIG")"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://www.cloudflare.com/ips-v4 -o "$TEMPORARY_DIR/ips-v4"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://www.cloudflare.com/ips-v6 -o "$TEMPORARY_DIR/ips-v6"

validate_list() {
  local file="$1"
  local family="$2"
  local minimum="$3"
  sed -i 's/\r$//' "$file"
  if [[ -z "$(tr -d '[:space:]' < "$file")" ]]; then
    echo "Cloudflare $family CIDR response is empty." >&2
    return 1
  fi
  if ! "$NODE_BIN" - "$file" "$family" <<'NODE'
const fs = require("node:fs");
const net = require("node:net");
const [file, family] = process.argv.slice(2);
const expected = family === "v4" ? 4 : family === "v6" ? 6 : 0;
for (const value of fs.readFileSync(file, "utf8").trim().split(/\r?\n/)) {
  const [address, prefix, ...extra] = value.trim().split("/");
  const maxPrefix = expected === 4 ? 32 : 128;
  if (extra.length || net.isIP(address) !== expected || !/^(?:0|[1-9][0-9]{0,2})$/.test(prefix ?? "") || Number(prefix) > maxPrefix) {
    throw new Error(`Invalid ${family} CIDR`);
  }
}
NODE
  then
    echo "Cloudflare $family CIDR response is malformed." >&2
    return 1
  fi
  sort -u "$file" -o "$file"
  local count
  count="$(wc -l < "$file" | tr -d '[:space:]')"
  if (( count < minimum )); then
    echo "Cloudflare $family CIDR response has too few entries." >&2
    return 1
  fi
}

validate_list "$TEMPORARY_DIR/ips-v4" v4 10
validate_list "$TEMPORARY_DIR/ips-v6" v6 5
cat "$TEMPORARY_DIR/ips-v4" "$TEMPORARY_DIR/ips-v6" | sort -u > "$TEMPORARY_DIR/cidrs"

{
  echo "# Managed by update-cloudflare-origin-allowlist.sh. Do not edit."
  echo "geo \$realip_remote_addr \$ubot_cloudflare_origin_allowed {"
  echo "    default 0;"
  while IFS= read -r cidr; do
    printf '    %s 1;\n' "$cidr"
  done < "$TEMPORARY_DIR/cidrs"
  echo "}"
} > "$TEMPORARY_DIR/origin.conf"

{
  echo "# Managed by update-cloudflare-origin-allowlist.sh. Do not edit."
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
  while IFS= read -r cidr; do
    printf 'set_real_ip_from %s;\n' "$cidr"
  done < "$TEMPORARY_DIR/cidrs"
} > "$TEMPORARY_DIR/realip.conf"

if [[ -f "$ORIGIN_CONFIG" ]] && [[ -f "$REALIP_CONFIG" ]] && \
   cmp -s "$TEMPORARY_DIR/origin.conf" "$ORIGIN_CONFIG" && cmp -s "$TEMPORARY_DIR/realip.conf" "$REALIP_CONFIG"; then
  exit 0
fi

backup_file() {
  local source="$1"
  local destination="$2"
  if [[ -f "$source" ]]; then
    cp -p "$source" "$destination"
  else
    : > "$destination.absent"
  fi
}

replace_file_atomically() {
  local source="$1"
  local destination="$2"
  local parent temporary
  parent="$(dirname "$destination")"
  temporary="$(mktemp "$parent/.ubot-cloudflare.XXXXXX")"
  if ! install -m 0644 "$source" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  mv -f "$temporary" "$destination"
}

replace_file_or_restore() {
  local source="$1"
  local destination="$2"
  if ! replace_file_atomically "$source" "$destination"; then
    restore_previous_configuration
    echo "Could not atomically update $destination; previous Cloudflare includes were restored." >&2
    return 1
  fi
}

restore_file() {
  local source="$1"
  local destination="$2"
  local parent temporary
  if [[ -f "$source" ]]; then
    parent="$(dirname "$destination")"
    temporary="$(mktemp "$parent/.ubot-cloudflare-restore.XXXXXX")"
    if ! cp -p "$source" "$temporary"; then
      rm -f "$temporary"
      return 1
    fi
    mv -f "$temporary" "$destination"
  elif [[ -f "$source.absent" ]]; then
    rm -f "$destination"
  fi
}

restore_previous_configuration() {
  restore_file "$TEMPORARY_DIR/origin.before" "$ORIGIN_CONFIG"
  restore_file "$TEMPORARY_DIR/realip.before" "$REALIP_CONFIG"
  "$NGINX_BIN" -t && systemctl reload nginx || true
}

backup_file "$ORIGIN_CONFIG" "$TEMPORARY_DIR/origin.before"
backup_file "$REALIP_CONFIG" "$TEMPORARY_DIR/realip.before"
replace_file_or_restore "$TEMPORARY_DIR/origin.conf" "$ORIGIN_CONFIG"
replace_file_or_restore "$TEMPORARY_DIR/realip.conf" "$REALIP_CONFIG"

if ! "$NGINX_BIN" -t; then
  restore_previous_configuration
  echo "Nginx rejected the refreshed Cloudflare allow-list; previous files were restored." >&2
  exit 1
fi

if ! systemctl reload nginx; then
  restore_previous_configuration
  echo "Nginx reload failed after refreshing Cloudflare allow-lists; previous files were restored." >&2
  exit 1
fi

