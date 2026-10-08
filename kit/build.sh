#!/usr/bin/env bash
# Cross-compile wtc-kit for linux/amd64 + linux/arm64 into kit/dist/, then sync kit into packages/wtc/kit (sync.sh).
set -euo pipefail
kit="$(cd "$(dirname "$0")" && pwd)"
cd "$kit/go"
for a in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$a go build -trimpath -ldflags='-s -w' -o ../dist/linux-$a/wtc-kit .
done
bash "$kit/sync.sh"
