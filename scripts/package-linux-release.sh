#!/usr/bin/env bash
# Builds a deployable Linux release archive from the current worktree.
#
# Runtime state is deliberately not a release asset.  The deployment script
# links only the persistent .env and data directory after it has backed them up
# and completed the one-way V3 state cutover.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${UBOT_NODE_BIN:-}"
NPM_CLI="${UBOT_NPM_CLI:-}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "A controlled Node.js executable is required. Run this script through scripts/run-node22.cjs and scripts/run-bash.cjs." >&2
  exit 2
fi
if [[ -z "$NPM_CLI" || ! -f "$NPM_CLI" ]]; then
  echo "The npm CLI paired with the controlled Node.js runtime is required." >&2
  exit 2
fi

NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  echo "Linux release packaging requires Node.js 22 or newer; found Node.js $NODE_MAJOR." >&2
  exit 2
fi

run_node() {
  "$NODE_BIN" "$@"
}

run_npm() {
  "$NODE_BIN" "$NPM_CLI" "$@"
}

VERSION="$(run_node -p "require('./package.json').version")"
if [[ -z "$VERSION" ]]; then
  echo "package.json has no version" >&2
  exit 2
fi

OUTPUT_DIR="${OUTPUT_DIR:-release}"
ARCHIVE="$OUTPUT_DIR/ubot-$VERSION-linux.tar.gz"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ubot-release-$VERSION-XXXXXX")"
VERIFY_DIR=""
cleanup() {
  rm -rf "$STAGING_DIR"
  if [[ -n "$VERIFY_DIR" ]]; then
    rm -rf "$VERIFY_DIR"
  fi
}
trap cleanup EXIT

rm -rf dist
run_node scripts/build.cjs

mkdir -p "$OUTPUT_DIR"
rm -f "$ARCHIVE" "$ARCHIVE.sha256"

# Copy an explicit, minimal allow-list.  `git ls-files --cached` is unsafe here:
# it can include a file deleted in the working tree but still present in the
# index, which previously made a dirty release impossible to package correctly.
copy_release_path() {
  local relative_path="$1"
  local source_path="$ROOT/$relative_path"
  local destination_path="$STAGING_DIR/$relative_path"
  if [[ ! -e "$source_path" ]]; then
    echo "Required release path is missing: $relative_path" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$destination_path")"
  cp -a "$source_path" "$destination_path"
}

for release_path in \
  package.json \
  package-lock.json \
  README.md \
  .env.example \
  .env.server-2022.example \
  dist \
  scripts/configure-v3-network.mjs \
  scripts/configure-image-model.mjs \
  scripts/install-node22-runtime.sh \
  scripts/update-cloudflare-origin-allowlist.sh \
  scripts/install-cloudflare-origin-hardening.sh \
  scripts/verify-nginx-vhost-ownership.mjs \
  scripts/upgrade-model-policy.mjs \
  scripts/repair-member-name.mjs \
  scripts/maintain-member-alias.mjs \
  scripts/deploy-linux-release.sh \
  scripts/normalize-dotenv-bom.mjs \
  scripts/migrate-v3-state.mjs \
  scripts/verify-release-source.mjs \
  scripts/validate-release-archive.mjs \
  scripts/public-docs.mjs \
  deploy/nginx/bot.9958.uk.conf \
  deploy/nginx/preview.9958.uk.conf \
  deploy/nginx/ubot-preview-static.conf \
  deploy/systemd/ubot-ingress.service.template \
  deploy/systemd/ubot-worker.service.template \
  deploy/systemd/ubot-admin.service.template \
  deploy/systemd/ubot.target.template \
  deploy/systemd/ubot-maintenance.service.template \
  deploy/systemd/ubot-maintenance.timer.template \
  deploy/systemd/ubot-cloudflare-allowlist.service.template \
  deploy/systemd/ubot-cloudflare-allowlist.timer.template \
  assets/huixian-profile.json \
  assets/private-enterprises-2026.json \
  assets/private-enterprises-2026-audit.json \
  assets/private-enterprises-2026-review.md \
  assets/private-enterprises-2026-headquarters.json \
  assets/private-enterprises-2026-headquarters-evidence.json \
  assets/private-enterprises-2026-headquarters-review.md \
  assets/blacklisted-at-meme.jpg; do
  copy_release_path "$release_path"
done

while IFS= read -r release_path; do
  copy_release_path "$release_path"
done < <(run_node scripts/bt-release-files.cjs)

find "$STAGING_DIR/dist" -type f -name '*.test.js' -delete

run_node scripts/verify-release-source.mjs "$STAGING_DIR"
# The deployment-side validator rejects links and non-USTAR metadata. Package
# the trusted staging tree in the same deliberately narrow format.
tar --format=ustar -C "$STAGING_DIR" -czf "$ARCHIVE" .

archive_name="$(basename "$ARCHIVE")"
sha256sum "$ARCHIVE" | awk -v asset="$archive_name" '{ print $1 " *" asset }' | tee "$ARCHIVE.sha256"

# Verify the exact bytes that will be uploaded, then prove a fresh release can
# install its production dependency graph without relying on this worktree.
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ubot-release-verify-$VERSION-XXXXXX")"
run_node scripts/validate-release-archive.mjs "$ARCHIVE"
tar --extract --gzip --file="$ARCHIVE" --directory="$VERIFY_DIR" \
  --no-same-owner --no-same-permissions --delay-directory-restore
run_node "$VERIFY_DIR/scripts/verify-release-source.mjs" "$VERIFY_DIR"
run_node scripts/secret-scan.mjs --source "$VERIFY_DIR"
(
  cd "$VERIFY_DIR"
  run_npm ci --omit=dev --ignore-scripts
)
rm -rf "$VERIFY_DIR"
VERIFY_DIR=""

printf 'Linux release archive created: %s\n' "$ARCHIVE"
