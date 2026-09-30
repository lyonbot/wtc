#!/usr/bin/env bash
# Cross-compile wtc-kit for linux/amd64 + linux/arm64 into kit/dist/.
set -euo pipefail
cd "$(dirname "$0")/go"
for a in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$a go build -trimpath -ldflags='-s -w' -o ../dist/linux-$a/wtc-kit .
done
