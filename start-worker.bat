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

REM ----- Ensure the AI stack is installed in the venv (first run only) -----
set NEED_INSTALL=1
if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe -c "import torch, onnxruntime" >nul 2>&1 && set NEED_INSTALL=0
)
if "%NEED_INSTALL%"=="1" (
    echo AI stack not found in venv; installing GPU stack via install-ai.ps1 ...
    echo ^(for a CPU-only worker, run: powershell -File install-ai.ps1 -CPU^)
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ai.ps1"
    if errorlevel 1 (
        echo ERROR: AI install failed. See output above.
        pause
        exit /b 1
    )
)

echo.
echo Starting NekoBooru worker on %NEKO_HOST%:%NEKO_PORT% ...
echo   Model setup UI: http://localhost:%NEKO_PORT%  (Settings -^> Auto Tagging)
echo   Press Ctrl+C to stop
echo.

cd backend
..\venv\Scripts\python.exe run_prod.py
