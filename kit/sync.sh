#!/usr/bin/env bash
# Copy kit/bin + kit/dist into packages/wtc/kit/ (gitignored) so the npm package can ship them; embed.ts imports from there.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../packages/wtc/kit"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$here/bin" "$here/dist" "$dest/"
