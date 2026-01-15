@echo off
echo ========================================
echo   NekoBooru Build All Platforms
echo ========================================
echo.

set VERSION=%1
if "%VERSION%"=="" set VERSION=1.0.0

echo Building Windows package...
call build-windows.bat

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Distribution packages:
echo   - Windows: dist\nekobooru-windows\
echo.
echo To create ZIP archive:
echo   powershell Compress-Archive -Path "dist\nekobooru-windows" -DestinationPath "dist\nekobooru-windows-%VERSION%.zip" -Force
echo.
