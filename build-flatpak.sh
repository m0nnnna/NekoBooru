#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$ROOT/packaging/linux/flatpak/io.github.nekobooru.NekoBooru.yml"
BUILD_DIR="$ROOT/dist/flatpak-build"
REPO_DIR="$ROOT/dist/flatpak-repo"
BUNDLE="$ROOT/dist/NekoBooru.flatpak"

command -v flatpak-builder >/dev/null 2>&1 || {
  echo "flatpak-builder is required." >&2
  exit 127
}

cd "$ROOT"
npm --prefix frontend install
npm --prefix frontend run build
flatpak-builder --force-clean --repo="$REPO_DIR" "$BUILD_DIR" "$MANIFEST"
flatpak build-bundle "$REPO_DIR" "$BUNDLE" io.github.nekobooru.NekoBooru
echo "Created $BUNDLE"
