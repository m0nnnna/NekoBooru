@echo off
echo ========================================
echo   NekoBooru Development Environment
echo ========================================
echo.
echo This will start both backend and frontend servers.
echo.
echo   Backend API: http://localhost:8000
echo   Frontend:    http://localhost:3000
echo.
echo Press Ctrl+C to stop both servers
echo.

cd /d "%~dp0"

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found in PATH
    pause
    exit /b 1
)

REM Check if Node.js is available
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Start backend in a new window
echo Starting backend server...
start "NekoBooru Backend" cmd /k "start.bat"

REM Wait a moment for backend to start
timeout /t 3 /nobreak >nul

REM Start frontend in a new window
echo Starting frontend server...
start "NekoBooru Frontend" cmd /k "start-frontend.bat"

echo.
echo Both servers are starting in separate windows.
echo.
echo   Backend API: http://localhost:8000
echo   Frontend:    http://localhost:3000
echo.
echo Close the windows or press Ctrl+C in each to stop the servers.
echo.
pause
