@echo off
echo ========================================
echo   NekoBooru Binary Build Script
echo ========================================
echo.

cd /d "%~dp0"

set OUTPUT_DIR=dist\nekobooru-binary

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
echo [2/5] Setting up Python build environment...
if not exist "build-venv" (
    echo Creating build virtual environment...
    python -m venv build-venv
)
call build-venv\Scripts\activate.bat
pip install -r backend\requirements.txt --quiet
pip install pyinstaller --quiet

echo.
echo Generating favicon.ico...
python -c "from PIL import Image,ImageDraw;sizes=[16,32,48,64,128,256];imgs=[];[exec('img=Image.new(\"RGBA\",(s,s),(0,0,0,0));d=ImageDraw.Draw(img);f=s/64.0;d.ellipse([int(18*f),int(26*f),int(46*f),int(50*f)],fill=(224,122,95));d.ellipse([int(23*f),int(31*f),int(41*f),int(47*f)],fill=(235,139,114));[(d.ellipse([int((cx-6)*f),int((cy-7)*f),int((cx+6)*f),int((cy+7)*f)],fill=(224,122,95)),d.ellipse([int((cx-3)*f),int((cy-4)*f),int((cx+3)*f),int((cy+4)*f)],fill=(235,139,114))) for cx,cy in [(20,17),(32,13),(44,17)]];imgs.append(img)') for s in sizes];imgs[0].save('frontend/public/favicon.ico',format='ICO',sizes=[(s,s) for s in sizes],append_images=imgs[1:])"

echo.
echo [3/5] Building binary with PyInstaller...
pyinstaller nekobooru.spec --noconfirm --clean
if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    pause
    exit /b 1
)

echo.
echo [4/5] Packaging distribution...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

copy /Y "dist\nekobooru.exe" "%OUTPUT_DIR%\"

echo.
echo [5/5] Creating README...
(
echo NekoBooru - Standalone Binary
echo ==============================
echo.
echo Usage:
echo   Run nekobooru.exe to start the server ^(binds to 127.0.0.1:8772^).
echo   The frontend is served by the backend from the packaged build.
echo.
echo   To change the bind address or port, edit and run start-neko.bat
echo   instead ^(it sets NEKO_HOST / NEKO_PORT before launching^).
echo.
echo   The server will be available at:
echo     - Application: http://localhost:8772
echo     - API Docs:    http://localhost:8772/docs
echo.
echo   Your database and uploaded files are stored under:
echo     %%LOCALAPPDATA%%\NekoBooru\data
echo.
echo   Your settings, logs, models, and optional AI runtimes are stored under:
echo     %%LOCALAPPDATA%%\NekoBooru
echo.
echo Optional:
echo   - Place ffmpeg.exe next to nekobooru.exe for video thumbnails
echo   - Place yt-dlp.exe next to nekobooru.exe for video downloads
echo   - Use Settings -^> Auto Tagging to install optional AI runtimes and models
echo.
echo No Python installation required!
) > "%OUTPUT_DIR%\README.txt"

certutil -hashfile "%OUTPUT_DIR%\nekobooru.exe" SHA256 > "%OUTPUT_DIR%\SHA256SUMS.txt"

echo.
echo Creating start-neko.bat launcher...
(
echo @echo off
echo REM ===== NekoBooru launch settings =====
echo REM NEKO_HOST: 127.0.0.1 = this PC only ^(default^). 0.0.0.0 = all interfaces / LAN.
echo REM WARNING: NekoBooru has NO authentication. Only use 0.0.0.0 on a trusted LAN.
echo set NEKO_HOST=127.0.0.1
echo REM NEKO_PORT: TCP port to listen on. Default 8772.
echo set NEKO_PORT=8772
echo REM If you open the UI from another device's browser, also set the allowed origin, e.g.:
echo REM set NEKO_CORS_ORIGINS=http://192.168.1.50:8772
echo.
echo nekobooru.exe
echo pause
) > "%OUTPUT_DIR%\start-neko.bat"

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Single-file binary created at: %OUTPUT_DIR%\nekobooru.exe
echo.
echo To create a ZIP archive:
echo   powershell Compress-Archive -Path "%OUTPUT_DIR%" -DestinationPath "dist\nekobooru-binary.zip" -Force
echo.
pause
