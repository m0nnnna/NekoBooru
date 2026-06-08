param(
  [int]$BackendPort = 8772,
  [int]$FrontendPort = 5173,
  [string]$AiProfile = "skip",
  [string]$UpdateOwner = "m0nnnna",
  [string]$UpdateRepo = "NekoBooru",
  [string]$UpdateChannel = "stable"
)

$ErrorActionPreference = "Stop"

$configDir = Join-Path $env:LOCALAPPDATA "NekoBooru\config"
$settingsPath = Join-Path $configDir "settings.json"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

function ConvertTo-SettingsObject {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $result[$key] = ConvertTo-SettingsObject $Value[$key]
    }
    return $result
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $items = @()
    foreach ($item in $Value) {
      $items += ,(ConvertTo-SettingsObject $item)
    }
    return $items
  }
  if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and $Value.GetType().Name -eq "PSCustomObject") {
    $result = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = ConvertTo-SettingsObject $property.Value
    }
    return $result
  }
  return $Value
}

$settings = [ordered]@{}
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $loaded = ConvertTo-SettingsObject (Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json)
    if ($loaded) {
      $settings = [ordered]@{}
      foreach ($key in $loaded.Keys) {
        $settings[$key] = $loaded[$key]
      }
    }
  } catch {
    $backup = "$settingsPath.bak-$((Get-Date).ToString('yyyyMMddHHmmss'))"
    Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
  }
}

$settings["server"] = @{
  host = "127.0.0.1"
  port = $BackendPort
  frontendPort = $FrontendPort
  corsOrigins = "http://localhost:$BackendPort,http://127.0.0.1:$BackendPort,http://localhost:$FrontendPort,http://127.0.0.1:$FrontendPort"
}

$settings["installer"] = @{
  aiProfile = $AiProfile
  aiProfileLabel = switch ($AiProfile) {
    "cpu" { "Local CPU AI" }
    "gpu-cu128" { "Local NVIDIA GPU AI" }
    "gpu-cu126-legacy" { "Local legacy NVIDIA GPU AI" }
    "remote" { "Remote/server AI" }
    default { "Skip AI setup" }
  }
  configuredAt = (Get-Date).ToUniversalTime().ToString("o")
}

$settings["updates"] = @{
  owner = $UpdateOwner
  repo = $UpdateRepo
  channel = $UpdateChannel
  autoCheck = $true
  autoDownload = $false
  includePrereleases = ($UpdateChannel -eq "prerelease")
  releasesApiUrl = "https://api.github.com/repos/$UpdateOwner/$UpdateRepo/releases"
  releasesPageUrl = "https://github.com/$UpdateOwner/$UpdateRepo/releases"
}

if ($AiProfile -eq "remote") {
  $autoTagging = @{}
  if ($settings.Contains("auto_tagging") -and $settings["auto_tagging"]) {
    $autoTagging = ConvertTo-SettingsObject $settings["auto_tagging"]
  }
  $autoTagging["remoteEnabled"] = $true
  $settings["auto_tagging"] = $autoTagging
}

$json = $settings | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($settingsPath, $json, $utf8NoBom)
