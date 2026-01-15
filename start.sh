#!/bin/bash
# NekoBooru Launcher for Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  NekoBooru Launcher"
echo "========================================"
echo

echo "Checking Python..."
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 not found in PATH"
    exit 1
fi
python3 --version

echo "Checking if virtual environment exists..."
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

echo "Activating virtual environment..."
source venv/bin/activate

echo "Installing/updating dependencies..."
pip install -r backend/requirements.txt --quiet

echo
echo "Checking for ffmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "WARNING: ffmpeg not found in PATH"
    echo "Video thumbnails will not be generated."
    echo "To install ffmpeg:"
    echo "  - Ubuntu/Debian: sudo apt-get install ffmpeg"
    echo "  - Fedora: sudo dnf install ffmpeg"
    echo "  - Arch: sudo pacman -S ffmpeg"
    echo
else
    echo "ffmpeg is available."
    echo
fi

echo "Starting NekoBooru backend server..."
echo
echo "  Backend API: http://localhost:8000"
echo "  API Docs:    http://localhost:8000/docs"
echo
echo "  Press Ctrl+C to stop"
echo

cd backend
python run.py
