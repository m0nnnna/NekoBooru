param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,
  [string]$AppPath = "",
  [ValidateSet("source", "packaged")]
  [string]$Mode = "source",
  [int]$BackendPort = 8772,
  [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"

$HostName = "com.nekobooru.launcher"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplatePath = Join-Path $Here "$HostName.json"
$HostScript = Join-Path $Here "nekobooru_launcher_host.py"
$Python = Join-Path (Resolve-Path (Join-Path $Here "..\..\venv\Scripts")).Path "python.exe"

if (-not (Test-Path $Python)) {
  $Python = (Get-Command python.exe).Source
}

$ManifestDir = Join-Path $env:LOCALAPPDATA "NekoBooru\native-messaging-hosts"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null

$WrapperPath = Join-Path $ManifestDir "nekobooru_launcher_host.cmd"
@"
@echo off
"$Python" "$HostScript"
"@ | Set-Content -LiteralPath $WrapperPath -Encoding ASCII

$ManifestPath = Join-Path $ManifestDir "$HostName.json"
$ConfigPath = Join-Path $ManifestDir "launcher-config.json"

if ($AppPath) {
  $ResolvedAppPath = (Resolve-Path -LiteralPath $AppPath).Path
  $Mode = "packaged"
} else {
  $ResolvedAppPath = ""
}

@{
  mode = $Mode
  appPath = $ResolvedAppPath
  repoRoot = (Resolve-Path (Join-Path $Here "..\..")).Path
  backendPort = $BackendPort
  frontendPort = $FrontendPort
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

$Manifest = Get-Content -Raw -LiteralPath $TemplatePath
$Manifest = $Manifest.Replace("HOST_PATH_PLACEHOLDER", ($WrapperPath -replace "\\", "\\"))
$Manifest = $Manifest.Replace("EXTENSION_ID_PLACEHOLDER", $ExtensionId.Trim())
Set-Content -LiteralPath $ManifestPath -Value $Manifest -Encoding ASCII

$RegistryRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

foreach ($Key in $RegistryRoots) {
  New-Item -Path $Key -Force | Out-Null
  Set-Item -Path $Key -Value $ManifestPath
}

Write-Host "Installed NekoBooru native launcher for extension $ExtensionId"
Write-Host "Manifest: $ManifestPath"
Write-Host "Launcher mode: $Mode"
if ($AppPath) { Write-Host "Packaged app path: $ResolvedAppPath" }
Write-Host "Backend port: $BackendPort"
Write-Host "Frontend port: $FrontendPort"
Write-Host "Reload the extension in Brave/Chrome after installing."
