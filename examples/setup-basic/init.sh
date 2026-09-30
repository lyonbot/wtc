#!/usr/bin/env bash
# Idempotent init: clone (copy fixture), install, start dev server; exits once healthy.
set -euo pipefail

if [ "${FAIL_AT:-}" = hang ]; then
  wtc-signal phase start "hanging (test hook)"
  sleep 7777 &
  sleep 7777
fi

wtc-signal phase clone
if [ ! -d /workspace/app ]; then
  mkdir -p /workspace
  cp -r /wtc/setup/fixture-app /workspace/app
  git -C /workspace/app init -q
  git -C /workspace/app add -A
  git -C /workspace/app -c user.name=wtc -c user.email=wtc@localhost commit -qm init
fi

if [ "${FAIL_AT:-}" = install ]; then
  wtc-signal phase install "failing (test hook)"
  echo "FAIL_AT=install: exiting 3" >&2
  exit 3
fi
wtc-install

wtc-signal phase start
exec /wtc/setup/scripts/restart-dev-server.sh
