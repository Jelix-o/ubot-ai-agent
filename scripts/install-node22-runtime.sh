#!/usr/bin/env bash
# Install a root-owned, application-scoped Node 22 runtime without replacing
# the operating system's Node installation or runtimes used by other apps.
set -euo pipefail
umask 022

VERSION="${1:-22.22.1}"
RUNTIME_ROOT="${UBOT_NODE_RUNTIME_ROOT:-/opt/ubot-runtime}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run the Node runtime installer as root." >&2
  exit 2
fi

# Do not let a root bootstrap inherit an interactive command search path.
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
TMPDIR="/tmp"
export PATH TMPDIR
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS

if [[ ! "$VERSION" =~ ^22\.[0-9]+\.[0-9]+$ ]]; then
  echo "Node runtime version must be an explicit 22.x.y version." >&2
  exit 2
fi

case "$(uname -m)" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported Node runtime architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

for command in curl tar sha256sum install ln mv mktemp awk rm chmod chown mkdir stat readlink find dirname; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 2
  }
done

fail_source_safety_check() {
  echo "Node runtime installer bootstrap safety check failed: $1" >&2
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

# This installer can run before the release deployer to bootstrap Node for the
# Cloudflare CIDR updater. Resolve an invoked `current` link before checking it.
SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
INSTALLER_SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
assert_root_controlled_source_tree "$INSTALLER_SCRIPT_DIR" "Node runtime installer source"

archive_name="node-v$VERSION-linux-$ARCH.tar.xz"
base_url="https://nodejs.org/dist/v$VERSION"
target_dir="$RUNTIME_ROOT/node-v$VERSION"
node_link="$RUNTIME_ROOT/node22"
runtime_provenance_name=".ubot-node-runtime-provenance"

# The installer must not trust a checksum downloaded from the same network
# location as the archive. These digests are reviewed into the root-controlled
# release bootstrap for the supported Node 22 runtime and architectures.
case "$VERSION:$ARCH" in
  "22.22.1:x64") expected_sha256="9a6bc82f9b491279147219f6a18add1e18424dce90d41d2a5fcd69d4924ba3aa" ;;
  "22.22.1:arm64") expected_sha256="0f3550d58d45e5d3cf7103d9e3f69937f09fe82fb5dd474c66a5d816fa58c9ee" ;;
  *)
    echo "No approved pinned Node runtime digest exists for version $VERSION and architecture $ARCH." >&2
    exit 2
    ;;
esac

if [[ ! "$RUNTIME_ROOT" =~ ^/opt/[A-Za-z0-9._/-]+$ ]] || [[ "$RUNTIME_ROOT" == *"//"* ]] ||
   [[ "$RUNTIME_ROOT" == *"/./"* ]] || [[ "$RUNTIME_ROOT" == *"/../"* ]] || [[ "$RUNTIME_ROOT" == */.. ]]; then
  echo "UBOT_NODE_RUNTIME_ROOT must be a normalized path below /opt." >&2
  exit 2
fi
fail_runtime_safety_check() {
  echo "$1" >&2
  exit 1
}

assert_root_owned_directory() {
  local directory="$1"
  local label="$2"
  local metadata mode
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    fail_runtime_safety_check "$label must be a real directory: $directory"
  fi
  metadata="$(stat -c '%u:%g:%a' "$directory")"
  if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
    fail_runtime_safety_check "$label must be owned by root:root: $directory"
  fi
  mode=$((8#${metadata##*:}))
  if (( (mode & 18) != 0 )); then
    fail_runtime_safety_check "$label must not be writable by group or other users: $directory"
  fi
}

assert_root_owned_regular_file() {
  local file="$1"
  local label="$2"
  local metadata mode
  if [[ -L "$file" || ! -f "$file" ]]; then
    fail_runtime_safety_check "$label must be a regular file: $file"
  fi
  metadata="$(stat -c '%u:%g:%a' "$file")"
  if [[ ! "$metadata" =~ ^0:0:[0-7]{3,4}$ ]]; then
    fail_runtime_safety_check "$label must be owned by root:root: $file"
  fi
  mode=$((8#${metadata##*:}))
  if (( (mode & 18) != 0 )); then
    fail_runtime_safety_check "$label must not be writable by group or other users: $file"
  fi
}

ensure_secure_runtime_root() {
  local component current remainder
  assert_root_owned_directory "/opt" "Runtime ancestor"
  if [[ ! -e "$RUNTIME_ROOT" && ! -L "$RUNTIME_ROOT" ]]; then
    install -d -m 0755 "$RUNTIME_ROOT"
  fi

  # Verify every existing component below /opt. A root-owned final directory
  # is not enough when a non-root-writable ancestor can replace it later.
  current="/opt"
  remainder="${RUNTIME_ROOT#/opt/}"
  IFS='/' read -r -a components <<< "$remainder"
  for component in "${components[@]}"; do
    current="$current/$component"
    assert_root_owned_directory "$current" "Node runtime path component"
  done
  chmod 0755 "$RUNTIME_ROOT"
}

assert_runtime_payload() {
  local unsafe_entry
  assert_root_owned_directory "$target_dir" "Node runtime directory"
  assert_root_owned_directory "$target_dir/bin" "Node runtime bin directory"
  assert_root_owned_regular_file "$target_dir/bin/node" "Node runtime binary"
  if [[ ! -x "$target_dir/bin/node" ]]; then
    fail_runtime_safety_check "Node runtime binary is not executable: $target_dir/bin/node"
  fi
  unsafe_entry="$(find "$target_dir" -xdev \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)"
  if [[ -n "$unsafe_entry" ]]; then
    fail_runtime_safety_check "Node runtime tree contains non-root-controlled content: $unsafe_entry"
  fi
}

expected_runtime_provenance() {
  printf 'version=%s\narchitecture=%s\narchive=%s\nsha256=%s' \
    "$VERSION" "$ARCH" "$archive_name" "$expected_sha256"
}

assert_runtime_provenance() {
  local directory="$1"
  local provenance_file actual_provenance
  provenance_file="$directory/$runtime_provenance_name"
  if [[ ! -f "$provenance_file" || -L "$provenance_file" ]]; then
    fail_runtime_safety_check "Existing Node runtime lacks a verified provenance receipt; remove $directory and reinstall it from the approved archive."
  fi
  assert_root_owned_regular_file "$provenance_file" "Node runtime provenance receipt"
  actual_provenance="$(<"$provenance_file")"
  if [[ "$actual_provenance" != "$(expected_runtime_provenance)" ]]; then
    fail_runtime_safety_check "Node runtime provenance receipt does not match the approved archive digest: $provenance_file"
  fi
}

write_runtime_provenance() {
  local directory="$1"
  local provenance_file="$directory/$runtime_provenance_name"
  expected_runtime_provenance > "$provenance_file"
  chown root:root "$provenance_file"
  chmod 0644 "$provenance_file"
  assert_runtime_provenance "$directory"
}

activate_node22_link() {
  if [[ -e "$node_link" || -L "$node_link" ]]; then
    if [[ ! -L "$node_link" || "$(readlink "$node_link")" != "node-v$VERSION" ]]; then
      fail_runtime_safety_check "Refusing unexpected Node 22 link: $node_link"
    fi
  fi
  local temporary_link="$RUNTIME_ROOT/.node22-$VERSION-$$"
  rm -f "$temporary_link"
  ln -s "node-v$VERSION" "$temporary_link"
  mv -Tf "$temporary_link" "$node_link"
}

ensure_secure_runtime_root
if [[ -e "$target_dir" || -L "$target_dir" ]]; then
  assert_runtime_payload
  # Runtimes installed before digest pinning have no locally verifiable
  # provenance. Refuse to activate them; an operator must replace the entire
  # directory with a freshly verified archive instead of trusting its version.
  assert_runtime_provenance "$target_dir"
  if [[ "$("$target_dir/bin/node" --version)" != "v$VERSION" ]]; then
    fail_runtime_safety_check "Existing Node runtime does not match requested version: $target_dir"
  fi
  activate_node22_link
  exit 0
fi

temporary_root="$(mktemp -d "$TMPDIR/ubot-node22.XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

curl --fail --silent --show-error --location "$base_url/$archive_name" -o "$temporary_root/$archive_name"
actual_sha256="$(sha256sum "$temporary_root/$archive_name" | awk '{ print $1 }')"
if [[ "${actual_sha256,,}" != "${expected_sha256,,}" ]]; then
  echo "Node runtime checksum verification failed." >&2
  exit 1
fi

tar -xJf "$temporary_root/$archive_name" -C "$temporary_root"
extracted_dir="$temporary_root/node-v$VERSION-linux-$ARCH"
if [[ ! -x "$extracted_dir/bin/node" ]] || [[ "$("$extracted_dir/bin/node" --version)" != "v$VERSION" ]]; then
  echo "Downloaded Node runtime did not contain the requested version." >&2
  exit 1
fi

install_target="$RUNTIME_ROOT/.node-v$VERSION-$$"
rm -rf "$install_target"
mv "$extracted_dir" "$install_target"
chmod -R a+rX "$install_target"
chown -R root:root "$install_target"
chmod -R go-w "$install_target"
write_runtime_provenance "$install_target"
if [[ -e "$target_dir" || -L "$target_dir" ]]; then
  echo "Refusing to replace an existing unexpected Node runtime: $target_dir" >&2
  exit 1
fi
mv -T "$install_target" "$target_dir"
assert_runtime_payload
assert_runtime_provenance "$target_dir"
activate_node22_link
