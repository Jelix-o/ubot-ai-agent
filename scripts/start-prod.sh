#!/usr/bin/env bash
# UBot V2.0.0 生产启动脚本（Linux systemd）
# 并行拉起 ingress / worker / admin 三个进程，日志写入 data/logs/
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data/logs

ROLE="${BOT_ROLE:-ingress,worker,admin}"

if [ "$ROLE" = "legacy" ]; then
  exec node dist/index.js
fi

IFS=',' read -ra ROLES <<< "$ROLE"
PIDS=()
for r in "${ROLES[@]}"; do
  BOT_ROLE="$r" node dist/index.js >> "data/logs/$r.log" 2>&1 &
  PIDS+=($!)
  echo "started $r (pid $!)"
done

# 子进程退出时联动退出（systemd 能感知并重启）
trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT
wait
