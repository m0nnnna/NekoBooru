@echo off
echo ========================================
echo   NekoBooru Launcher
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found in PATH
    pause
    exit /b 1
)

echo Checking if virtual environment exists...
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate.bat

echo Installing/updating dependencies...
pip install -r backend\requirements.txt --quiet

echo.
echo Checking for ffmpeg...
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo WARNING: ffmpeg not found in PATH
    echo Video thumbnails will not be generated.
    echo To install ffmpeg:
    echo   - winget install ffmpeg
    echo   - or download from https://ffmpeg.org/download.html
    echo.
) else (
    echo ffmpeg is available.
    echo.
)

echo Starting NekoBooru backend server...
echo.
echo   Backend API: http://localhost:8000
echo   API Docs:    http://localhost:8000/docs
echo.
echo   Press Ctrl+C to stop
echo.

cd backend
python run.py
