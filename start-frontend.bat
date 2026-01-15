@echo off
echo ========================================
echo   NekoBooru Frontend Dev Server
echo ========================================
echo.

cd /d "%~dp0\frontend"

echo Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Checking if node_modules exists...
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo.
echo Starting Vue.js dev server...
echo.
echo   Frontend: http://localhost:3000
echo   (API proxied to http://localhost:8000)
echo.
echo   Press Ctrl+C to stop
echo.

npm run dev
