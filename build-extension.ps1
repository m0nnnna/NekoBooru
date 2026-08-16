# Package the NekoBooru browser extension into a zip for GitHub releases.
# Usage: .\build-extension.ps1 [version]   (version defaults to manifest.json)

param([string]$Version)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$srcDir = Join-Path $root 'browser-extension'
$manifestPath = Join-Path $srcDir 'manifest.json'

if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found at $manifestPath"
}

if (-not $Version) {
    $Version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
}

$distDir = Join-Path $root 'dist'
$stageDir = Join-Path $distDir 'nekobooru-extension'
$zipPath = Join-Path $distDir "nekobooru-extension-$Version.zip"

Write-Host "Packaging NekoBooru extension v$Version..."

# Fresh staging copy so the zip only ever contains the shipped files.
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Copy-Item -Path (Join-Path $srcDir '*') -Destination $stageDir -Recurse -Force `
    -Exclude @('*.zip', '*.test.js', 'Thumbs.db', '.DS_Store', 'nekobooru_launcher_host.cmd')

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stageDir -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
Write-Host "Attach this zip to a GitHub release. Users unzip it and 'Load unpacked'."
