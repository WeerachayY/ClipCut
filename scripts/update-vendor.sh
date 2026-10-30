#!/usr/bin/env bash
# Refresh vendored ffmpeg.wasm and fonts from npm.
# Usage: scripts/update-vendor.sh [ffmpeg-version] [core-version]
set -euo pipefail
FF=${1:-0.12.15}
CORE=${2:-0.12.10}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
npm init -y >/dev/null
npm install --silent "@ffmpeg/ffmpeg@$FF" "@ffmpeg/core@$CORE" @fontsource/ibm-plex-sans-thai @fontsource/ibm-plex-mono

mkdir -p "$ROOT/vendor/ffmpeg" "$ROOT/vendor/core" "$ROOT/vendor/fonts"
cp node_modules/@ffmpeg/ffmpeg/dist/esm/*.js "$ROOT/vendor/ffmpeg/"
cp node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm "$ROOT/vendor/core/"
for f in thai-400 thai-600 latin-400 latin-600; do
  cp "node_modules/@fontsource/ibm-plex-sans-thai/files/ibm-plex-sans-thai-$f-normal.woff2" "$ROOT/vendor/fonts/"
done
cp node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2 "$ROOT/vendor/fonts/"
cp node_modules/@fontsource/ibm-plex-sans-thai/LICENSE "$ROOT/vendor/fonts/LICENSE-OFL.txt"

echo "Updated vendor/ (ffmpeg $FF, core $CORE). Remember to bump VERSION in sw.js."
