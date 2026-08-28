#!/usr/bin/env bash
# Builds a deployable Linux release archive from the current worktree.
#
# Runtime state is deliberately not a release asset.  The deployment script
# links only the persistent .env and data directory after it has backed them up
# and completed the one-way V3 state cutover.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
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
node scripts/build.cjs

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
  COMMANDS.md \
  "RELEASE-v$VERSION.md" \
  .env.example \
  .env.server-2022.example \
  dist \
  scripts/configure-v3-network.mjs \
  scripts/deploy-linux-release.sh \
  scripts/normalize-dotenv-bom.mjs \
  scripts/migrate-v3-state.mjs \
  scripts/verify-release-source.mjs \
  deploy/nginx/bot.9958.uk.conf \
  deploy/nginx/preview.9958.uk.conf \
  deploy/nginx/ubot-preview-static.conf \
  deploy/systemd/ubot-ingress.service.template \
  deploy/systemd/ubot-worker.service.template \
  deploy/systemd/ubot-admin.service.template \
  deploy/systemd/ubot.target.template \
  deploy/systemd/ubot-maintenance.service.template \
  deploy/systemd/ubot-maintenance.timer.template \
  docs/OPERATIONS-v3.md \
  docs/ADMIN-RECOVERY-v3.md \
  docs/MIGRATION-v3.md \
  docs/ROLLBACK-v3.md \
  assets/huixian-profile.json; do
  copy_release_path "$release_path"
done

find "$STAGING_DIR/dist" -type f -name '*.test.js' -delete

node scripts/verify-release-source.mjs "$STAGING_DIR"
tar -C "$STAGING_DIR" -czf "$ARCHIVE" .

archive_name="$(basename "$ARCHIVE")"
sha256sum "$ARCHIVE" | awk -v asset="$archive_name" '{ print $1 " *" asset }' | tee "$ARCHIVE.sha256"

# Verify the exact bytes that will be uploaded, then prove a fresh release can
# install its production dependency graph without relying on this worktree.
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ubot-release-verify-$VERSION-XXXXXX")"
tar -xzf "$ARCHIVE" -C "$VERIFY_DIR"
node "$VERIFY_DIR/scripts/verify-release-source.mjs" "$VERIFY_DIR"
(
  cd "$VERIFY_DIR"
  npm ci --omit=dev --ignore-scripts
)
rm -rf "$VERIFY_DIR"
VERIFY_DIR=""

printf 'Linux release archive created: %s\n' "$ARCHIVE"
