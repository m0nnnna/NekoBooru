#!/bin/bash
# Check if backend server is running

echo "Checking if backend server is running..."
echo

if curl -s http://localhost:8000/api/health > /dev/null 2>&1; then
    echo "[OK] Backend server is running!"
    echo
    echo "Backend API: http://localhost:8000"
    echo "API Docs:    http://localhost:8000/docs"
    echo "Health:       http://localhost:8000/api/health"
    exit 0
else
    echo "[ERROR] Backend server is NOT running on port 8000"
    echo
    echo "To start the backend:"
    echo "  1. Run: ./start.sh"
    echo "  2. Wait for the server to start"
    echo "  3. You should see: 'Application startup complete'"
    echo
    echo "Then check again by running this script."
    exit 1
fi
