#!/bin/bash
# Installation script for NekoBooru systemd service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/nekobooru"
SERVICE_USER="${1:-$USER}"

echo "========================================"
echo "  NekoBooru Service Installation"
echo "========================================"
echo

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "ERROR: This script must be run as root (use sudo)"
    exit 1
fi

# Check if user exists
if ! id "$SERVICE_USER" &> /dev/null; then
    echo "ERROR: User '$SERVICE_USER' does not exist"
    exit 1
fi

echo "Installing NekoBooru to $INSTALL_DIR"
echo "Service will run as user: $SERVICE_USER"
echo

# Create installation directory
mkdir -p "$INSTALL_DIR"

# Copy files
echo "Copying files..."
cp -r "$SCRIPT_DIR"/backend "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR"/frontend "$INSTALL_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR"/regenerate_video_thumbnails.py "$INSTALL_DIR/"
cp "$SCRIPT_DIR"/start.sh "$INSTALL_DIR/"
cp "$SCRIPT_DIR"/*.py "$INSTALL_DIR/" 2>/dev/null || true

# Set ownership
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Create virtual environment
echo "Creating virtual environment..."
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" python3 -m venv venv
sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/backend/requirements.txt"

# Create data directory
mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data"

# Install systemd service
echo "Installing systemd service..."
sed "s|%i|$SERVICE_USER|g" "$SCRIPT_DIR/nekobooru.service" > /etc/systemd/system/nekobooru.service

# Reload systemd
systemctl daemon-reload

echo
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo
echo "Service installed to: /etc/systemd/system/nekobooru.service"
echo
echo "To start the service:"
echo "  sudo systemctl start nekobooru"
echo
echo "To enable on boot:"
echo "  sudo systemctl enable nekobooru"
echo
echo "To check status:"
echo "  sudo systemctl status nekobooru"
echo
echo "To view logs:"
echo "  sudo journalctl -u nekobooru -f"
echo
echo "Note: Make sure ffmpeg is installed for video thumbnail support:"
echo "  sudo apt-get install ffmpeg"
echo
