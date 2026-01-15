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
cat > "$DEB_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

# Create virtual environment and install dependencies
cd /opt/nekobooru/backend
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt --quiet

# Create data directory
mkdir -p /var/lib/nekobooru
chown -R $SUDO_USER:$SUDO_USER /var/lib/nekobooru 2>/dev/null || true

# Create config directory
mkdir -p /etc/nekobooru
chown -R $SUDO_USER:$SUDO_USER /etc/nekobooru 2>/dev/null || true

# Install systemd service if systemd is available
if command -v systemctl &> /dev/null; then
    # Update service file with actual user
    if [ -n "$SUDO_USER" ]; then
        sed "s|%i|$SUDO_USER|g" /opt/nekobooru/nekobooru.service > /etc/systemd/system/nekobooru.service
        systemctl daemon-reload
        echo "Systemd service installed. Start with: sudo systemctl start nekobooru"
    fi
fi

echo "NekoBooru installed successfully!"
echo "Start the service with: sudo systemctl start nekobooru"
echo "Or run manually: cd /opt/nekobooru && ./start.sh"
EOF
chmod +x "$DEB_DIR/DEBIAN/postinst"

# Create prerm script
cat > "$DEB_DIR/DEBIAN/prerm" << 'EOF'
#!/bin/bash
# Stop service before removal
if command -v systemctl &> /dev/null; then
    systemctl stop nekobooru 2>/dev/null || true
    systemctl disable nekobooru 2>/dev/null || true
fi
EOF
chmod +x "$DEB_DIR/DEBIAN/prerm"

# Create postrm script
cat > "$DEB_DIR/DEBIAN/postrm" << 'EOF'
#!/bin/bash
# Clean up after removal
if command -v systemctl &> /dev/null; then
    systemctl daemon-reload
fi
EOF
chmod +x "$DEB_DIR/DEBIAN/postrm"

# Create launcher script
echo "[5/6] Creating launcher script..."
cat > "$DEB_DIR/usr/bin/nekobooru" << 'EOF'
#!/bin/bash
cd /opt/nekobooru/backend
source ../venv/bin/activate
python3 run.py "$@"
EOF
chmod +x "$DEB_DIR/usr/bin/nekobooru"

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
