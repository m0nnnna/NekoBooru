@echo off
echo Checking if backend server is running...
echo.

curl -s http://localhost:8000/api/health >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Backend server is NOT running on port 8000
    echo.
    echo To start the backend:
    echo   1. Run: start.bat
    echo   2. Wait for the server to start
    echo   3. You should see: "Application startup complete"
    echo.
    echo Then check again by running this script.
    exit /b 1
) else (
    echo [OK] Backend server is running!
    echo.
    echo Backend API: http://localhost:8000
    echo API Docs:    http://localhost:8000/docs
    echo Health:      http://localhost:8000/api/health
    exit /b 0
)
