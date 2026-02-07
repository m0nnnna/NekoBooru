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
echo   Simply run nekobooru.exe to start the server.
echo   Everything is packed into the single exe.
echo.
echo   The server will be available at:
echo     - Application: http://localhost:8000
echo     - API Docs:    http://localhost:8000/docs
echo.
echo   A "data" folder will be created next to the executable
echo   for your database and uploaded files.
echo.
echo   A "config" folder will be created for settings.
echo.
echo Optional:
echo   - Place ffmpeg.exe next to nekobooru.exe for video thumbnails
echo   - Place yt-dlp.exe next to nekobooru.exe for video downloads
echo.
echo No Python installation required!
) > "%OUTPUT_DIR%\README.txt"

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
