param(
  [Parameter(Mandatory = $true)]
  [string]$Exe
)

$ErrorActionPreference = "Stop"
$Resolved = (Resolve-Path -LiteralPath $Exe).Path
$LogDir = Join-Path $env:TEMP "nekobooru-smoke"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir "packaged.log"

$proc = Start-Process -FilePath $Resolved -RedirectStandardOutput $Log -RedirectStandardError $Log -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8772/api/health" -TimeoutSec 2
      if ($health.status -eq "ok") {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "NekoBooru did not become healthy. Log: $Log"
  }
  Invoke-RestMethod -Uri "http://127.0.0.1:8772/api/runtime/status" -TimeoutSec 5 | Out-Null
  Invoke-RestMethod -Uri "http://127.0.0.1:8772/api/settings" -TimeoutSec 5 | Out-Null
  Write-Host "Packaged smoke test passed."
} finally {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
}
