#!/bin/bash
# NekoBooru Development Environment Launcher for Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  NekoBooru Development Environment"
echo "========================================"
echo
echo "This will start both backend and frontend servers."
echo
echo "  Backend API: http://localhost:8000"
echo "  Frontend:    http://localhost:3000"
echo
echo "Press Ctrl+C to stop both servers"
echo

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 not found in PATH"
    exit 1
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Function to cleanup on exit
cleanup() {
    echo
    echo "Stopping servers..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    exit
}

trap cleanup SIGINT SIGTERM

# Start backend in background
echo "Starting backend server..."
cd "$SCRIPT_DIR"
./start.sh &
BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Start frontend in background
echo "Starting frontend server..."
cd "$SCRIPT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

echo
echo "Both servers are running."
echo
echo "  Backend API: http://localhost:8000"
echo "  Frontend:    http://localhost:3000"
echo
echo "Press Ctrl+C to stop both servers"
echo

# Wait for both processes
wait
