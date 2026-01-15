#!/bin/bash
# NekoBooru Ubuntu/Linux Build Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="dist/nekobooru-ubuntu"
BUILD_FRONTEND="$BUILD_DIR/frontend"
BUILD_BACKEND="$BUILD_DIR/backend"
VERSION="${1:-1.0.0}"

echo "========================================"
echo "  NekoBooru Ubuntu Build Script"
echo "========================================"
echo

echo "Cleaning previous build..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo
echo "[1/5] Building frontend..."
cd frontend
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi
npm run build
if [ $? -ne 0 ]; then
    echo "ERROR: Frontend build failed"
    exit 1
fi
cd ..

echo
echo "[2/5] Copying frontend build..."
cp -r frontend/dist/* "$BUILD_FRONTEND/"

echo
echo "[3/5] Copying backend files..."
cp -r backend/app "$BUILD_BACKEND/"
cp backend/run.py "$BUILD_BACKEND/"
cp backend/run_prod.py "$BUILD_BACKEND/"
cp backend/requirements.txt "$BUILD_BACKEND/"

echo
echo "[4/5] Creating startup scripts..."
cat > "$BUILD_DIR/start.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "venv" ]; then
    echo "ERROR: Virtual environment not found. Please run ./install.sh first."
    exit 1
fi
source venv/bin/activate
cd backend
python3 run_prod.py
EOF
chmod +x "$BUILD_DIR/start.sh"

cat > "$BUILD_DIR/start-dev.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")/backend"
source ../venv/bin/activate
python3 run.py
EOF
chmod +x "$BUILD_DIR/start-dev.sh"

cat > "$BUILD_DIR/install.sh" << 'EOF'
#!/bin/bash
echo "Installing NekoBooru..."
echo

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 not found. Please install Python 3.8 or higher."
    exit 1
fi

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Install dependencies
echo "Installing dependencies..."
source venv/bin/activate
pip install -r backend/requirements.txt --quiet

echo
echo "Installation complete!"
echo "Run ./start.sh to start the production server."
echo "Run ./start-dev.sh to start the development server."
EOF
chmod +x "$BUILD_DIR/install.sh"

echo
echo "[5/5] Creating README..."
cat > "$BUILD_DIR/README.md" << EOF
# NekoBooru Ubuntu Distribution

## Installation

1. Run \`./install.sh\` to set up the Python environment
2. Run \`./start.sh\` to start the server

The server will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Docs: http://localhost:8000/docs

## Requirements

- Python 3.8 or higher
- Node.js (only needed for development)
- ffmpeg (optional, for video thumbnails)

## System Service Installation

To install as a systemd service:

\`\`\`bash
sudo bash install-service.sh
sudo systemctl start nekobooru
sudo systemctl enable nekobooru
\`\`\`

See README-SERVICE.md for more details.
EOF

# Copy service files
cp nekobooru.service "$BUILD_DIR/" 2>/dev/null || true
cp install-service.sh "$BUILD_DIR/" 2>/dev/null || true
cp README-SERVICE.md "$BUILD_DIR/" 2>/dev/null || true

echo
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo
echo "Distribution package created at: $BUILD_DIR"
echo
echo "To create a tarball:"
echo "  cd dist && tar -czf nekobooru-ubuntu-$VERSION.tar.gz nekobooru-ubuntu"
echo
