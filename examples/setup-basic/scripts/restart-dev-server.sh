#!/usr/bin/env bash
# (Re)start the dev server in tmux session "dev" and wait until /health answers.
set -euo pipefail
cd /workspace/app
tmux kill-session -t dev 2>/dev/null || true
tmux new -d -s dev "node server.mjs"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:5173/health >/dev/null 2>&1 && exit 0
  sleep 0.5
done
echo "dev server did not become healthy within 30s" >&2
exit 1
