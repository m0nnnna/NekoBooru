#!/usr/bin/env bash
# Package the NekoBooru browser extension into a zip for GitHub releases.
# Usage: ./build-extension.sh [version]   (version defaults to manifest.json)
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
src="$root/browser-extension"
manifest="$src/manifest.json"

version="${1:-}"
if [ -z "$version" ]; then
  version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$manifest" \
    | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')"
fi

dist="$root/dist"
stage="$dist/nekobooru-extension"
zip_name="nekobooru-extension-$version.zip"

echo "Packaging NekoBooru extension v$version..."

mkdir -p "$dist"
rm -rf "$stage"
mkdir -p "$stage"
cp -r "$src/." "$stage/"
find "$stage" \( -name 'Thumbs.db' -o -name '.DS_Store' -o -name '*.zip' -o -name '*.test.js' \) -delete

rm -f "$dist/$zip_name"
( cd "$dist" && zip -rq "$zip_name" "nekobooru-extension" )

echo "Created $dist/$zip_name"
echo "Attach this zip to a GitHub release. Users unzip it and 'Load unpacked'."
