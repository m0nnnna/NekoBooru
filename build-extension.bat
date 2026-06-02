@echo off
REM Package the NekoBooru browser extension into a zip for GitHub releases.
REM Usage: build-extension.bat [version]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-extension.ps1" %*
