#!/bin/bash
# NekoBooru .deb Package Builder

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="${1:-1.0.0}"
PACKAGE_NAME="nekobooru"
DEB_DIR="dist/${PACKAGE_NAME}_${VERSION}"
INSTALL_DIR="$DEB_DIR/opt/nekobooru"

echo "========================================"
echo "  Building .deb Package"
echo "========================================"
echo "Version: $VERSION"
echo

# Clean previous build
rm -rf "$DEB_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$DEB_DIR/DEBIAN"
mkdir -p "$DEB_DIR/etc/systemd/system"
mkdir -p "$DEB_DIR/usr/bin"

# Build the application first
echo "[1/6] Building application..."
bash build-ubuntu.sh "$VERSION"

# Copy built files
echo "[2/6] Copying application files..."
cp -r dist/nekobooru-ubuntu/* "$INSTALL_DIR/"

# Create control file
echo "[3/6] Creating package metadata..."
cat > "$DEB_DIR/DEBIAN/control" << EOF
Package: $PACKAGE_NAME
Version: $VERSION
Section: web
Priority: optional
Architecture: all
Depends: python3 (>= 3.8), python3-pip, python3-venv
Recommends: ffmpeg
Maintainer: NekoBooru Team
Description: A lightweight, local booru-style image/video gallery
 NekoBooru is a self-hosted image and video gallery application
 with tagging, pools, and search capabilities.
EOF

# Create postinst script
echo "[4/6] Creating installation script..."
cp packaging/linux/debian/postinst "$DEB_DIR/DEBIAN/postinst"
chmod +x "$DEB_DIR/DEBIAN/postinst"

# Create prerm script
cp packaging/linux/debian/prerm "$DEB_DIR/DEBIAN/prerm"
chmod +x "$DEB_DIR/DEBIAN/prerm"

# Create postrm script
cp packaging/linux/debian/postrm "$DEB_DIR/DEBIAN/postrm"
chmod +x "$DEB_DIR/DEBIAN/postrm"

# Create launcher script
echo "[5/6] Creating launcher script..."
cat > "$DEB_DIR/usr/bin/nekobooru" << 'EOF'
#!/bin/bash
set -euo pipefail

APP_DIR="/opt/nekobooru"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
VENV="$DATA_HOME/nekobooru/runtimes/python-core"
LOG_DIR="$STATE_HOME/nekobooru/logs"

mkdir -p "$LOG_DIR" "$(dirname "$VENV")"
if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install -r "$APP_DIR/backend/requirements.txt" --quiet

export NEKO_PACKAGED=1
export NEKO_APP_DIR="$APP_DIR"
cd "$APP_DIR/backend"
exec "$VENV/bin/python" run_prod.py "$@"
EOF
chmod +x "$DEB_DIR/usr/bin/nekobooru"

mkdir -p "$DEB_DIR/usr/share/applications"
cp packaging/linux/nekobooru.desktop "$DEB_DIR/usr/share/applications/nekobooru.desktop"

# Build the package
echo "[6/6] Building .deb package..."
dpkg-deb --build "$DEB_DIR" "dist/${PACKAGE_NAME}_${VERSION}_all.deb"

echo
echo "========================================"
echo "  Package Build Complete!"
echo "========================================"
echo
echo "Package created: dist/${PACKAGE_NAME}_${VERSION}_all.deb"
echo
echo "To install:"
echo "  sudo dpkg -i dist/${PACKAGE_NAME}_${VERSION}_all.deb"
echo
echo "To fix dependencies if needed:"
echo "  sudo apt-get install -f"
echo
