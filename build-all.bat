@echo off
echo ========================================
echo   NekoBooru Build All Platforms
echo ========================================
echo.

set VERSION=%1
if "%VERSION%"=="" set VERSION=1.0.0

echo Building Windows binary...
call build-binary.bat

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Distribution packages:
echo   - Windows: dist\nekobooru-binary\nekobooru.exe
echo.
echo To create ZIP archive:
echo   powershell Compress-Archive -Path "dist\nekobooru-binary\*" -DestinationPath "dist\nekobooru-windows-%VERSION%.zip" -Force
echo.
