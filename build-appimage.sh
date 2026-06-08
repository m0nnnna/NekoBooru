#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-4.1.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$ROOT/dist/appimage/NekoBooru.AppDir"

command -v appimagetool >/dev/null 2>&1 || {
  echo "appimagetool is required. Download it from https://github.com/AppImage/AppImageKit/releases" >&2
  exit 127
}

cd "$ROOT"
bash build-ubuntu.sh "$VERSION"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/opt/nekobooru" "$APPDIR/usr/bin" "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/opt/nekobooru/packaging/linux"

cp -r dist/nekobooru-ubuntu/* "$APPDIR/opt/nekobooru/"
cp -r backend "$APPDIR/opt/nekobooru/worker-backend"
cp install-ai.sh "$APPDIR/opt/nekobooru/install-ai.sh"
cp -r browser-extension "$APPDIR/opt/nekobooru/browser-extension"
cp packaging/linux/bin/nekobooru "$APPDIR/usr/bin/nekobooru"
cp packaging/linux/bin/nekobooru-configure "$APPDIR/usr/bin/nekobooru-configure"
cp packaging/linux/bin/nekobooru-repair "$APPDIR/usr/bin/nekobooru-repair"
cp packaging/linux/apply-installer-settings.sh "$APPDIR/opt/nekobooru/packaging/linux/apply-installer-settings.sh"
cp packaging/linux/nekobooru.desktop "$APPDIR/usr/share/applications/nekobooru.desktop"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NEKO_APP_DIR="$HERE/opt/nekobooru"
exec "$HERE/usr/bin/nekobooru" "$@"
EOF
chmod +x "$APPDIR/AppRun" "$APPDIR/usr/bin/"* "$APPDIR/opt/nekobooru/install-ai.sh"
cp packaging/linux/nekobooru.desktop "$APPDIR/nekobooru.desktop"

ARCH="${ARCH:-$(uname -m)}" appimagetool "$APPDIR" "$ROOT/dist/NekoBooru-$VERSION-${ARCH:-$(uname -m)}.AppImage"
