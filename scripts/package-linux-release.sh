#!/usr/bin/env bash
# Builds a deployable Linux release archive from the current Git worktree.
# The archive intentionally excludes all runtime state; deploy-linux-release.sh
# links persistent .env, data, skills and config on the target host.
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
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

rm -rf dist
node scripts/build.cjs

mkdir -p "$OUTPUT_DIR"
rm -f "$ARCHIVE"

# Include the version-controlled project plus relevant untracked source files,
# then add fresh production dist. Ignored runtime data never enters staging.
git ls-files -z --cached --others --exclude-standard \
  | tar --null --files-from=- --create --file=- \
  | tar --extract --file=- --directory="$STAGING_DIR"
mkdir -p "$STAGING_DIR/dist"
cp -a dist/. "$STAGING_DIR/dist/"
find "$STAGING_DIR/dist" -type f -name '*.test.js' -delete
# Skills are deliberately persistent owner-managed data. The target deployer
# links its existing skills directory rather than replacing it from the bundle.
# RC.1 carries the one security-reviewed replacement whose legacy source-heavy
# definition must be retired on every target.
rm -rf "$STAGING_DIR/skills"
mkdir -p "$STAGING_DIR/managed-skills"
cp skills/itexpert.json "$STAGING_DIR/managed-skills/itexpert.json"

node scripts/verify-release-source.mjs "$STAGING_DIR"
tar -C "$STAGING_DIR" -czf "$ARCHIVE" .

if command -v sha256sum >/dev/null; then
  sha256sum "$ARCHIVE" | tee "$ARCHIVE.sha256"
fi
printf 'Linux release archive created: %s\n' "$ARCHIVE"
