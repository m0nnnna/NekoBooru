param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$BinaryDir = Join-Path $Root "dist\nekobooru-binary"
$BinaryExe = Join-Path $BinaryDir "nekobooru.exe"
$InnoScript = Join-Path $Root "packaging\windows\nekobooru.iss"

function Find-InnoCompiler {
  $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 5\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 5\ISCC.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  return $null
}

if (-not (Test-Path -LiteralPath $BinaryExe)) {
  Write-Host "Packaged binary not found. Building it first..."
  & (Join-Path $Root "build-binary.bat")
}

if (-not (Test-Path -LiteralPath $BinaryExe)) {
  throw "Expected packaged binary at $BinaryExe"
}

$Iscc = Find-InnoCompiler
if (-not $Iscc) {
  throw "Inno Setup compiler was not found. Install Inno Setup 6, then rerun .\build-installer.ps1. Expected ISCC.exe on PATH or under Program Files."
}

if ($Version) {
  $env:NEKOBOORU_VERSION = $Version
}

Write-Host "Building NekoBooru installer with $Iscc..."
& $Iscc $InnoScript

if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE"
}

Write-Host "Installer output:"
Get-ChildItem -LiteralPath (Join-Path $Root "dist\installer") -Filter "NekoBooruSetup-*.exe" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 FullName, Length, LastWriteTime
