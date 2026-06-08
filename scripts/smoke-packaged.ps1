param(
  [Parameter(Mandatory = $true)]
  [string]$Exe,
  [int]$Port = 8772,
  [switch]$TestShutdownEvent
)

$ErrorActionPreference = "Stop"
$Resolved = (Resolve-Path -LiteralPath $Exe).Path
$LogDir = Join-Path $env:TEMP "nekobooru-smoke"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog = Join-Path $LogDir "packaged.out.log"
$ErrLog = Join-Path $LogDir "packaged.err.log"
$ConfigDir = Join-Path $LogDir "config"
$DataDir = Join-Path $LogDir "data"
$AppLogDir = Join-Path $LogDir "logs"
$CacheDir = Join-Path $LogDir "cache"
$ModelsDir = Join-Path $LogDir "models"
$RuntimesDir = Join-Path $LogDir "runtimes"
New-Item -ItemType Directory -Force -Path $ConfigDir, $DataDir, $AppLogDir, $CacheDir, $ModelsDir, $RuntimesDir | Out-Null

$PreviousPort = $env:NEKO_PORT
$PreviousConfigDir = $env:NEKO_CONFIG_DIR
$PreviousDataDir = $env:NEKO_DATA_DIR
$PreviousLogsDir = $env:NEKO_LOGS_DIR
$PreviousCacheDir = $env:NEKO_CACHE_DIR
$PreviousModelsDir = $env:NEKO_MODELS_DIR
$PreviousRuntimesDir = $env:NEKO_RUNTIMES_DIR
$env:NEKO_PORT = "$Port"
$env:NEKO_CONFIG_DIR = $ConfigDir
$env:NEKO_DATA_DIR = $DataDir
$env:NEKO_LOGS_DIR = $AppLogDir
$env:NEKO_CACHE_DIR = $CacheDir
$env:NEKO_MODELS_DIR = $ModelsDir
$env:NEKO_RUNTIMES_DIR = $RuntimesDir
$proc = Start-Process -FilePath $Resolved -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
      if ($health.status -eq "ok") {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "NekoBooru did not become healthy. Logs: $OutLog / $ErrLog"
  }
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runtime/status" -TimeoutSec 5 | Out-Null
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/settings" -TimeoutSec 5 | Out-Null
  if ($TestShutdownEvent) {
    $event = [System.Threading.EventWaitHandle]::OpenExisting('Local\NekoBooruShutdown')
    try {
      $event.Set() | Out-Null
    } finally {
      $event.Dispose()
    }
    $proc.WaitForExit(15000) | Out-Null
    if (-not $proc.HasExited) {
      throw "NekoBooru did not exit after Local\NekoBooruShutdown was signaled."
    }
  }
  Write-Host "Packaged smoke test passed."
} finally {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
  if ($null -eq $PreviousPort) {
    Remove-Item Env:\NEKO_PORT -ErrorAction SilentlyContinue
  } else {
    $env:NEKO_PORT = $PreviousPort
  }
  if ($null -eq $PreviousConfigDir) { Remove-Item Env:\NEKO_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_CONFIG_DIR = $PreviousConfigDir }
  if ($null -eq $PreviousDataDir) { Remove-Item Env:\NEKO_DATA_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_DATA_DIR = $PreviousDataDir }
  if ($null -eq $PreviousLogsDir) { Remove-Item Env:\NEKO_LOGS_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_LOGS_DIR = $PreviousLogsDir }
  if ($null -eq $PreviousCacheDir) { Remove-Item Env:\NEKO_CACHE_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_CACHE_DIR = $PreviousCacheDir }
  if ($null -eq $PreviousModelsDir) { Remove-Item Env:\NEKO_MODELS_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_MODELS_DIR = $PreviousModelsDir }
  if ($null -eq $PreviousRuntimesDir) { Remove-Item Env:\NEKO_RUNTIMES_DIR -ErrorAction SilentlyContinue } else { $env:NEKO_RUNTIMES_DIR = $PreviousRuntimesDir }
}
