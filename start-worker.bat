@echo off
REM ============================================================
REM   NekoBooru - Remote GPU worker launcher
REM ============================================================
REM Run this from a SOURCE checkout of NekoBooru (next to backend\ and
REM frontend\). The compiled nekobooru.exe excludes torch/onnxruntime and
REM can NEVER do AI inference, so the worker must run from source in a venv
REM that has the tagger stack installed.
REM
REM Edit the token below, then run this file.
REM ============================================================

cd /d "%~dp0"

REM ----- Worker network + auth settings (EDIT THESE) -----
set NEKO_HOST=0.0.0.0
set NEKO_PORT=8772
set NEKO_TAGGER_WORKER_TOKEN=change-me-shared-secret

REM ----- Ensure the right AI stack is installed (auto-detects the GPU; only
REM       installs/repairs when needed, so this is fast on subsequent runs) -----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ai.ps1"
if errorlevel 1 (
    echo ERROR: AI install failed. See output above.
    pause
    exit /b 1
)

echo.
echo Starting NekoBooru worker on %NEKO_HOST%:%NEKO_PORT% ...
echo   Model setup UI: http://localhost:%NEKO_PORT%  (Settings -^> Auto Tagging)
echo   Press Ctrl+C to stop
echo.

cd backend
..\venv\Scripts\python.exe run_prod.py
