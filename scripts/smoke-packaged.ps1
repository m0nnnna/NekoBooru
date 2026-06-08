param(
  [Parameter(Mandatory = $true)]
  [string]$Exe,
  [int]$Port = 8772
)

$ErrorActionPreference = "Stop"
$Resolved = (Resolve-Path -LiteralPath $Exe).Path
$LogDir = Join-Path $env:TEMP "nekobooru-smoke"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog = Join-Path $LogDir "packaged.out.log"
$ErrLog = Join-Path $LogDir "packaged.err.log"

$PreviousPort = $env:NEKO_PORT
$env:NEKO_PORT = "$Port"
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
}
