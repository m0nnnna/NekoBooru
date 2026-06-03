@echo off
REM Build the NekoBooru debug APK from the command line (no Android Studio).
REM Resolves Android Studio's bundled JDK and the Android SDK, then runs Gradle.
REM Usage: build-apk.bat            (debug APK)
REM        build-apk.bat install    (debug APK + install on device/emulator)
setlocal

set "PROJECT_DIR=%~dp0"

REM --- Resolve a JDK (prefer existing JAVA_HOME, else Android Studio JBR). ---
if not defined JAVA_HOME (
    if exist "C:\Program Files\Android\Android Studio\jbr" (
        set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
    ) else if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr" (
        set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
    )
)
if not defined JAVA_HOME (
    echo ERROR: No JDK found. Set JAVA_HOME to a JDK 17+ ^(Android Studio's JBR works^).
    exit /b 1
)
echo JAVA_HOME = %JAVA_HOME%

REM --- Resolve the Android SDK (falls back to local.properties if unset). ---
if not defined ANDROID_HOME (
    if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
)
if defined ANDROID_HOME echo ANDROID_HOME = %ANDROID_HOME%

set "TASKS=assembleDebug"
if /I "%~1"=="install" set "TASKS=assembleDebug installDebug"

call "%PROJECT_DIR%gradlew.bat" -p "%PROJECT_DIR%" %TASKS% --no-daemon
if errorlevel 1 (
    echo Gradle build failed.
    exit /b 1
)

echo.
echo Built APK: %PROJECT_DIR%app\build\outputs\apk\debug\app-debug.apk
endlocal
