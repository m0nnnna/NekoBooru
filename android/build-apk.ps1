<#
.SYNOPSIS
    Build the NekoBooru Android APK from the command line (no Android Studio).

.DESCRIPTION
    Resolves a JDK (Android Studio's bundled JBR by default) and the Android SDK,
    then runs the committed Gradle wrapper. Produces a debug APK by default; pass
    -Release for an unsigned release build.

.PARAMETER Release
    Build the release variant (app-release-unsigned.apk) instead of debug.

.PARAMETER Install
    After building, install the debug APK on the connected device/emulator.

.PARAMETER Clean
    Run a clean before building.

.EXAMPLE
    ./build-apk.ps1
    ./build-apk.ps1 -Release
    ./build-apk.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$Install,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot

# --- Resolve a JDK (17+). Prefer an existing JAVA_HOME, else Android Studio's JBR. ---
if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) {
    $jbrCandidates = @(
        "C:\Program Files\Android\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "$env:ProgramFiles\Android\Android Studio\jbr"
    )
    $jbr = $jbrCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $jbr) {
        throw "No JDK found. Set JAVA_HOME to a JDK 17+ (Android Studio's bundled JBR works)."
    }
    $env:JAVA_HOME = $jbr
}
Write-Host "JAVA_HOME = $env:JAVA_HOME" -ForegroundColor Cyan

# --- Resolve the Android SDK. ---
if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
    $sdkCandidates = @(
        "$env:LOCALAPPDATA\Android\Sdk",
        "$env:ANDROID_SDK_ROOT"
    )
    $sdk = $sdkCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($sdk) { $env:ANDROID_HOME = $sdk }
}
if ($env:ANDROID_HOME) {
    Write-Host "ANDROID_HOME = $env:ANDROID_HOME" -ForegroundColor Cyan
} else {
    Write-Host "ANDROID_HOME not set; relying on android/local.properties (sdk.dir)." -ForegroundColor Yellow
}

# --- Assemble the Gradle task list. ---
$tasks = @()
if ($Clean) { $tasks += "clean" }
if ($Release) { $tasks += "assembleRelease" } else { $tasks += "assembleDebug" }
if ($Install -and -not $Release) { $tasks += "installDebug" }

$gradlew = Join-Path $projectDir "gradlew.bat"
Write-Host "Running: gradlew $($tasks -join ' ')" -ForegroundColor Cyan
& $gradlew -p $projectDir @tasks --no-daemon
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)." }

# --- Report the APK location. ---
$apk = if ($Release) {
    Join-Path $projectDir "app\build\outputs\apk\release\app-release-unsigned.apk"
} else {
    Join-Path $projectDir "app\build\outputs\apk\debug\app-debug.apk"
}
if (Test-Path $apk) {
    $size = "{0:N1} MB" -f ((Get-Item $apk).Length / 1MB)
    Write-Host "`nBuilt APK: $apk ($size)" -ForegroundColor Green
} else {
    Write-Host "`nBuild finished but expected APK not found at $apk" -ForegroundColor Yellow
}
