#!/usr/bin/env bash
# UBot V3 production process launcher.
# Systemd launches one independent role per unit.  This script intentionally
# does not fork children, so service supervision and restart behaviour remain
# attributable to the owning unit.
set -euo pipefail

cd "$(dirname "$0")/.."
ROLE="${BOT_ROLE:-}"

case "$ROLE" in
  ingress|worker|admin|legacy)
    ;;
  *)
    echo "BOT_ROLE must be one of ingress, worker, admin, or legacy." >&2
    exit 2
    ;;
esac

exec node dist/index.js
