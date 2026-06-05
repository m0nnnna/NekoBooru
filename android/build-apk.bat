@echo off
REM Build the NekoBooru APK from the command line (no Android Studio).
REM Resolves Android Studio's bundled JDK and the Android SDK, then runs Gradle.
REM Builds the optimized, installable RELEASE variant by default.
REM Usage: build-apk.bat                 (release APK)
REM        build-apk.bat debug           (debug APK)
REM        build-apk.bat install         (release APK + install on device/emulator)
REM        build-apk.bat debug install   (debug APK + install)
setlocal

REM %~dp0 ends with a trailing backslash; keep one copy for joining paths and a
REM slash-free copy for -p (a trailing "\" before a quote escapes the quote).
set "PROJECT_DIR=%~dp0"
set "PROJECT_ROOT=%PROJECT_DIR:~0,-1%"

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

REM --- Parse args: variant (release|debug) and optional install. ---
set "VARIANT=Release"
set "DO_INSTALL="
:parseargs
if "%~1"=="" goto afterargs
if /I "%~1"=="debug"   set "VARIANT=Debug"
if /I "%~1"=="release" set "VARIANT=Release"
if /I "%~1"=="install" set "DO_INSTALL=1"
shift
goto parseargs
:afterargs

set "TASKS=assemble%VARIANT%"
if defined DO_INSTALL set "TASKS=%TASKS% install%VARIANT%"

echo Running: gradlew %TASKS%
call "%PROJECT_DIR%gradlew.bat" -p "%PROJECT_ROOT%" %TASKS% --no-daemon
if errorlevel 1 (
    echo Gradle build failed.
    exit /b 1
)

if /I "%VARIANT%"=="Debug" (
    set "APK=%PROJECT_DIR%app\build\outputs\apk\debug\app-debug.apk"
) else (
    set "APK=%PROJECT_DIR%app\build\outputs\apk\release\app-release.apk"
)

echo.
echo Built APK: %APK%
endlocal
