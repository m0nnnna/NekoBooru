<#
.SYNOPSIS
    Build the NekoBooru Android APK from the command line (no Android Studio).

.DESCRIPTION
    Resolves a JDK (Android Studio's bundled JBR by default) and the Android SDK,
    then runs the committed Gradle wrapper. Builds the optimized, installable
    RELEASE variant by default (signed with the debug keystore); pass -Debug for
    a quick debug build.

.PARAMETER DebugBuild
    Build the debug variant (app-debug.apk) instead of release.
    (Named -DebugBuild because -Debug is a reserved PowerShell common parameter.)

.PARAMETER Install
    After building, install the APK on the connected device/emulator.

.PARAMETER Clean
    Run a clean before building.

.EXAMPLE
    ./build-apk.ps1
    ./build-apk.ps1 -DebugBuild
    ./build-apk.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$DebugBuild,
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

# --- Ensure the Gradle wrapper jar exists. It is intentionally NOT committed
#     (an opaque binary used only by ./gradlew), so regenerate it on demand from
#     any available Gradle before invoking the wrapper. ---
$wrapperJar = Join-Path $projectDir "gradle\wrapper\gradle-wrapper.jar"
if (-not (Test-Path $wrapperJar)) {
    # Pull the pinned version out of gradle-wrapper.properties (fallback 8.10.2).
    $gradleVersion = "8.10.2"
    $propsPath = Join-Path $projectDir "gradle\wrapper\gradle-wrapper.properties"
    if (Test-Path $propsPath) {
        $m = Select-String -Path $propsPath -Pattern 'gradle-([0-9][0-9.]*)-' | Select-Object -First 1
        if ($m) { $gradleVersion = $m.Matches[0].Groups[1].Value }
    }
    Write-Host "Gradle wrapper jar missing; regenerating for Gradle $gradleVersion..." -ForegroundColor Yellow

    # Find a Gradle to bootstrap with: PATH first, then a cached wrapper dist.
    $gradleExe = (Get-Command gradle -ErrorAction SilentlyContinue).Source
    if (-not $gradleExe) {
        $gradleExe = Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists" -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $gradleExe) {
        throw "Gradle wrapper jar is missing and no Gradle was found to regenerate it. Install Gradle or open the project in Android Studio once, then re-run. (The jar is intentionally not committed; regenerate manually with: gradle wrapper --gradle-version $gradleVersion)"
    }
    Write-Host "Bootstrapping wrapper with: $gradleExe" -ForegroundColor Cyan
    & $gradleExe -p $projectDir wrapper --gradle-version $gradleVersion --distribution-type bin
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $wrapperJar)) {
        throw "Failed to regenerate the Gradle wrapper jar."
    }
}

# --- Assemble the Gradle task list. ---
$variant = if ($DebugBuild) { "Debug" } else { "Release" }
$tasks = @()
if ($Clean) { $tasks += "clean" }
$tasks += "assemble$variant"
if ($Install) { $tasks += "install$variant" }

$gradlew = Join-Path $projectDir "gradlew.bat"
Write-Host "Running: gradlew $($tasks -join ' ')" -ForegroundColor Cyan
& $gradlew -p $projectDir @tasks --no-daemon
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)." }

# --- Report the APK location. The release build is signed (debug keystore), so
#     its output is app-release.apk, not app-release-unsigned.apk. ---
$apk = if ($DebugBuild) {
    Join-Path $projectDir "app\build\outputs\apk\debug\app-debug.apk"
} else {
    Join-Path $projectDir "app\build\outputs\apk\release\app-release.apk"
}
if (Test-Path $apk) {
    $size = "{0:N1} MB" -f ((Get-Item $apk).Length / 1MB)
    Write-Host "`nBuilt APK: $apk ($size)" -ForegroundColor Green
} else {
    Write-Host "`nBuild finished but expected APK not found at $apk" -ForegroundColor Yellow
}
