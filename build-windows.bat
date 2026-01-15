@echo off
echo ========================================
echo   NekoBooru Windows Build Script
echo ========================================
echo.

cd /d "%~dp0"

set BUILD_DIR=dist\nekobooru-windows
set BUILD_FRONTEND=%BUILD_DIR%\frontend
set BUILD_BACKEND=%BUILD_DIR%\backend

echo Cleaning previous build...
if exist "%BUILD_DIR%" rmdir /s /q "%BUILD_DIR%"
mkdir "%BUILD_DIR%"

echo.
echo [1/5] Building frontend...
cd frontend
if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
)
call npm run build
if errorlevel 1 (
    echo ERROR: Frontend build failed
    pause
    exit /b 1
)
cd ..

echo.
echo [2/5] Copying frontend build...
xcopy /E /I /Y "frontend\dist\*" "%BUILD_FRONTEND%"

echo.
echo [3/5] Copying backend files...
xcopy /E /I /Y "backend\app" "%BUILD_BACKEND%\app"
copy /Y "backend\run.py" "%BUILD_BACKEND%\"
copy /Y "backend\run_prod.py" "%BUILD_BACKEND%\"
copy /Y "backend\requirements.txt" "%BUILD_BACKEND%\"

echo.
echo [4/5] Creating startup scripts...
echo @echo off > "%BUILD_DIR%\start.bat"
echo cd /d "%%~dp0" >> "%BUILD_DIR%\start.bat"
echo if not exist "venv" ( >> "%BUILD_DIR%\start.bat"
echo     echo ERROR: Virtual environment not found. Please run install.bat first. >> "%BUILD_DIR%\start.bat"
echo     pause >> "%BUILD_DIR%\start.bat"
echo     exit /b 1 >> "%BUILD_DIR%\start.bat"
echo ) >> "%BUILD_DIR%\start.bat"
echo call venv\Scripts\activate.bat >> "%BUILD_DIR%\start.bat"
echo cd backend >> "%BUILD_DIR%\start.bat"
echo python run_prod.py >> "%BUILD_DIR%\start.bat"

echo @echo off > "%BUILD_DIR%\start-dev.bat"
echo cd /d "%%~dp0backend" >> "%BUILD_DIR%\start-dev.bat"
echo python run.py >> "%BUILD_DIR%\start-dev.bat"

echo @echo off > "%BUILD_DIR%\install.bat"
echo echo Installing NekoBooru... >> "%BUILD_DIR%\install.bat"
echo echo. >> "%BUILD_DIR%\install.bat"
echo if not exist "venv" ( >> "%BUILD_DIR%\install.bat"
echo     echo Creating virtual environment... >> "%BUILD_DIR%\install.bat"
echo     python -m venv venv >> "%BUILD_DIR%\install.bat"
echo ) >> "%BUILD_DIR%\install.bat"
echo echo Installing dependencies... >> "%BUILD_DIR%\install.bat"
echo call venv\Scripts\activate.bat >> "%BUILD_DIR%\install.bat"
echo pip install -r backend\requirements.txt --quiet >> "%BUILD_DIR%\install.bat"
echo echo. >> "%BUILD_DIR%\install.bat"
echo echo Installation complete! >> "%BUILD_DIR%\install.bat"
echo echo Run start.bat to start the server. >> "%BUILD_DIR%\install.bat"
echo pause >> "%BUILD_DIR%\install.bat"

echo.
echo [5/5] Creating README...
(
echo NekoBooru Windows Distribution
echo ===============================
echo.
echo Installation:
echo   1. Run install.bat to set up the Python environment
echo   2. Run start.bat to start the server
echo.
echo The server will be available at:
echo   - Application: http://localhost:8000
echo   - API Docs: http://localhost:8000/docs
echo.
echo Requirements:
echo   - Python 3.8 or higher
echo   - Node.js (only needed for development)
echo   - ffmpeg (optional, for video thumbnails)
) > "%BUILD_DIR%\README.txt"

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Distribution package created at: %BUILD_DIR%
echo.
echo To create a ZIP archive:
echo   powershell Compress-Archive -Path "%BUILD_DIR%" -DestinationPath "dist\nekobooru-windows.zip" -Force
echo.
pause
