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
if "%NEKO_FRONTEND_PORT%"=="" set NEKO_FRONTEND_PORT=5173
if "%VITE_BACKEND%"=="" set VITE_BACKEND=http://127.0.0.1:8772
set VITE_FRONTEND_PORT=%NEKO_FRONTEND_PORT%
echo   Frontend: http://localhost:%VITE_FRONTEND_PORT%
echo   (API proxied to %VITE_BACKEND%)
echo.
echo   Press Ctrl+C to stop
echo.

npm run dev -- --port %VITE_FRONTEND_PORT%
