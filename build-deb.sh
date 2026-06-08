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
mkdir -p "$DEB_DIR/usr/lib/systemd/user"
mkdir -p "$DEB_DIR/usr/bin"
mkdir -p "$DEB_DIR/usr/share/doc/$PACKAGE_NAME"

# Build the application first
echo "[1/6] Building application..."
bash build-ubuntu.sh "$VERSION"

# Copy built files
echo "[2/6] Copying application files..."
cp -r dist/nekobooru-ubuntu/* "$INSTALL_DIR/"

echo "[3/6] Creating package metadata..."
sed "s/^Version:.*/Version: $VERSION/" packaging/linux/debian/control > "$DEB_DIR/DEBIAN/control"

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

echo "[5/6] Creating launcher script..."
cp packaging/linux/bin/nekobooru "$DEB_DIR/usr/bin/nekobooru"
cp packaging/linux/bin/nekobooru-configure "$DEB_DIR/usr/bin/nekobooru-configure"
cp packaging/linux/bin/nekobooru-repair "$DEB_DIR/usr/bin/nekobooru-repair"
cp packaging/linux/bin/nekobooru-uninstall-user-data "$DEB_DIR/usr/bin/nekobooru-uninstall-user-data"
chmod +x "$DEB_DIR/usr/bin/nekobooru" \
  "$DEB_DIR/usr/bin/nekobooru-configure" \
  "$DEB_DIR/usr/bin/nekobooru-repair" \
  "$DEB_DIR/usr/bin/nekobooru-uninstall-user-data"

mkdir -p "$DEB_DIR/usr/share/applications"
cp packaging/linux/nekobooru.desktop "$DEB_DIR/usr/share/applications/nekobooru.desktop"
cp packaging/linux/nekobooru.service.user "$DEB_DIR/usr/lib/systemd/user/nekobooru.service"
mkdir -p "$INSTALL_DIR/packaging/linux"
cp packaging/linux/apply-installer-settings.sh "$INSTALL_DIR/packaging/linux/apply-installer-settings.sh"
chmod +x "$INSTALL_DIR/packaging/linux/apply-installer-settings.sh"
cp install-ai.sh "$INSTALL_DIR/install-ai.sh"
chmod +x "$INSTALL_DIR/install-ai.sh"
mkdir -p "$INSTALL_DIR/browser-extension/native-host"
cp browser-extension/native-host/nekobooru_launcher_host.py "$INSTALL_DIR/browser-extension/native-host/nekobooru_launcher_host.py"
cp browser-extension/native-host/install-native-host.sh "$INSTALL_DIR/browser-extension/native-host/install-native-host.sh"
chmod +x "$INSTALL_DIR/browser-extension/native-host/install-native-host.sh"
cp docs/desktop-packaging-stages.md "$DEB_DIR/usr/share/doc/$PACKAGE_NAME/desktop-packaging-stages.md" 2>/dev/null || true

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
