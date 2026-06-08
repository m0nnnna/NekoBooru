<#
.SYNOPSIS
    Install NekoBooru's optional AI auto-tagging stack into the project venv,
    auto-selecting the right CUDA build for the detected GPU.

.DESCRIPTION
    Creates (or reuses) the project virtual environment, then installs the
    correct tagger stack:

      * standard  - NVIDIA GPU, CUDA 12.8 (compute capability 7.0+: Volta,
                    Turing, Ampere, Ada, Hopper, Blackwell)
      * legacy    - older NVIDIA GPU, CUDA 12.6 (compute capability 6.x:
                    Pascal / GTX 10-series, e.g. 1060) - cu128 dropped these
      * cpu       - no usable NVIDIA GPU (or Maxwell sm_5x and older)

    With no switch it DETECTS the GPU via nvidia-smi and picks the stack. It is
    idempotent: if the correct, working build is already installed it does
    nothing. If a build is installed that can't actually launch a CUDA kernel on
    this GPU (e.g. a cu128 build on a 1060), it is uninstalled and the right one
    is installed instead - and when auto-detecting it will fall back
    standard -> legacy -> cpu until one actually runs.

    Packaged installs place this stack in a managed AI venv and link that venv
    into the app process on startup. Source checkouts can also use this script
    against .\venv or another explicit venv path.

.PARAMETER CPU
    Force the CPU-only stack.

.PARAMETER Legacy
    Force the CUDA 12.6 stack (Pascal / GTX 10-series, sm_61).

.PARAMETER GPU
    Force the standard CUDA 12.8 stack.

.PARAMETER Force
    Reinstall even if the correct stack already appears to be installed.

.PARAMETER VenvPath
    Virtual environment to install into. Default: .\venv

.EXAMPLE
    ./install-ai.ps1            # auto-detect the GPU and install the right stack
    ./install-ai.ps1 -Legacy    # force the Pascal/CUDA 12.6 stack
    ./install-ai.ps1 -CPU       # force the CPU stack
#>
[CmdletBinding()]
param(
    [switch]$CPU,
    [switch]$Legacy,
    [switch]$GPU,
    [switch]$Force,
    [string]$VenvPath = "venv",
    [string]$ReceiptPath = "",
    [string]$LogPath = ""
)

# NOTE: intentionally NOT "Stop". In Windows PowerShell 5.1, EAP=Stop turns any
# native-command stderr (a Python traceback, ordinary pip warnings) into a fatal
# NativeCommandError that even 2>$null won't suppress. We check $LASTEXITCODE
# explicitly and use throw (which stops regardless of EAP) for real failures.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$transcriptStarted = $false
if ($LogPath) {
    try {
        $logDir = Split-Path -Parent $LogPath
        if ($logDir) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        Start-Transcript -Path $LogPath -Append | Out-Null
        $transcriptStarted = $true
        Write-Host "Logging AI runtime install to $LogPath" -ForegroundColor Cyan
    } catch {
        Write-Host "Could not start AI runtime install log at ${LogPath}: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

trap {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
    throw $_
}

if (@($CPU, $Legacy, $GPU | Where-Object { $_ }).Count -gt 1) {
    throw "Pick at most one of -CPU / -Legacy / -GPU."
}

# --- Resolve a Python launcher to bootstrap the venv. ---
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python not found in PATH. Install Python 3.10+ first." }

# --- Create the venv if it doesn't exist yet. ---
$venvPython = Join-Path $VenvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Creating virtual environment at $VenvPath ..." -ForegroundColor Cyan
    & $python -m venv $VenvPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) {
        throw "Failed to create virtual environment at $VenvPath."
    }
}

# --- Detect the right stack ("standard" | "legacy" | "cpu") from the GPU. ---
function Get-AutoTarget {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        Write-Host "No nvidia-smi found -> no NVIDIA GPU; selecting CPU stack." -ForegroundColor Yellow
        return "cpu"
    }
    $lines = @()
    try { $lines = & nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>$null } catch {}
    $majors = @()
    foreach ($l in $lines) {
        $t = "$l".Trim()
        if ($t -match '^(\d+)') { $majors += [int]$Matches[1] }
    }
    if ($majors.Count -eq 0) {
        Write-Host "nvidia-smi present but compute capability unreadable (old driver?)." -ForegroundColor Yellow
        Write-Host "Defaulting to the standard CUDA 12.8 stack; will auto-fall back if it doesn't run." -ForegroundColor Yellow
        return "standard"
    }
    $max = ($majors | Measure-Object -Maximum).Maximum
    $name = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1
    if (-not $name) { $name = "NVIDIA GPU" }
    if ($max -ge 7) { $t = "standard" }
    elseif ($max -eq 6) { $t = "legacy" }
    else { $t = "cpu" }
    Write-Host ("Detected {0} (compute capability major {1}) -> {2} stack" -f $name.Trim(), $max, $t) -ForegroundColor Cyan
    return $t
}

# --- Read the installed torch build variant: cu128 / cu126 / cpu / none / ... ---
function Get-InstalledVariant {
    $out = & $venvPython -c "import torch; v=torch.__version__; print(v.split('+',1)[1] if '+' in v else 'unknown')" 2>$null
    if ($LASTEXITCODE -ne 0) { return "none" }
    return ("$out").Trim()
}

function Get-Class {
    param([string]$variant)
    switch -regex ($variant) {
        '^cu12[89]$' { "standard"; break }
        '^cu126$'    { "legacy";   break }
        '^cpu$'      { "cpu";      break }
        '^none$'     { "none";     break }
        default      { "other" }
    }
}

# --- Does the installed torch actually launch a CUDA kernel on this GPU? ---
function Test-CudaKernel {
    & $venvPython -c "import torch; assert torch.cuda.is_available(); x=torch.randn(64,64,device='cuda'); _=(x@x).sum().item()" 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Get-ReqFile {
    param([string]$class)
    switch ($class) {
        "cpu"    { "backend\requirements-tagger-cpu.txt" }
        "legacy" { "backend\requirements-tagger-legacy.txt" }
        default  { "backend\requirements-tagger.txt" }
    }
}

function Invoke-Install {
    param([string]$class)
    & $venvPython -m pip install --upgrade pip 2>&1 | Out-Null
    & $venvPython -m pip install -r "backend\requirements.txt" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Base dependency install failed." }
    & $venvPython -m pip install -r (Get-ReqFile $class) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Tagger dependency install failed (see pip output above)." }
}

function Uninstall-Torch {
    Write-Host "Removing existing torch/onnxruntime so the correct build can be installed ..." -ForegroundColor Yellow
    & $venvPython -m pip uninstall -y torch torchvision torchaudio onnxruntime onnxruntime-gpu 1>$null 2>$null
}

# --- Decide the target. ---
$explicit = $CPU -or $Legacy -or $GPU
if ($CPU) { $target = "cpu" }
elseif ($Legacy) { $target = "legacy" }
elseif ($GPU) { $target = "standard" }
else { $target = Get-AutoTarget }

$variant = Get-InstalledVariant
$class = Get-Class $variant
Write-Host ("Installed torch: {0} (class: {1}) | target: {2}" -f $variant, $class, $target) -ForegroundColor Cyan

# --- Fast path: already correct and (for GPU) actually works. ---
$need = $Force -or ($class -ne $target)
if (-not $need -and $target -ne "cpu") {
    if (-not (Test-CudaKernel)) {
        Write-Host "Installed $variant torch can't run a CUDA kernel on this GPU; will reinstall." -ForegroundColor Yellow
        $need = $true
    }
}

if (-not $need) {
    Write-Host "AI stack already correct ($variant) for target [$target]; nothing to install." -ForegroundColor Green
} else {
    # (Re)install, with self-heal for auto-detected GPU targets.
    $attempt = $target
    while ($true) {
        Uninstall-Torch
        $modeLabel = switch ($attempt) {
            "cpu"    { "CPU-only" }
            "legacy" { "GPU (CUDA 12.6, Pascal/sm_61)" }
            default  { "GPU (CUDA 12.8)" }
        }
        Write-Host "Installing AI auto-tagging stack [$modeLabel] into $VenvPath ..." -ForegroundColor Cyan
        Invoke-Install $attempt

        if ($attempt -eq "cpu") { break }
        if (Test-CudaKernel) { break }

        Write-Host "Installed the $attempt stack, but no CUDA kernel runs on this GPU." -ForegroundColor Yellow
        if ($explicit) {
            Write-Host "Leaving it as requested. Try -Legacy (older GPU) or -CPU instead." -ForegroundColor Yellow
            break
        }
        if ($attempt -eq "standard") {
            Write-Host "Falling back to the legacy CUDA 12.6 stack ..." -ForegroundColor Yellow
            $attempt = "legacy"; continue
        }
        if ($attempt -eq "legacy") {
            Write-Host "Falling back to the CPU stack ..." -ForegroundColor Yellow
            $attempt = "cpu"; continue
        }
        break
    }
    $target = $attempt
}

# --- Verify. ---
Write-Host "`nVerifying install ..." -ForegroundColor Cyan
& $venvPython -c "import torch, onnxruntime as ort; print('torch', torch.__version__, '| cuda', torch.cuda.is_available()); print('onnxruntime', ort.__version__, '| providers', ort.get_available_providers())"
if ($LASTEXITCODE -ne 0) { throw "Verification failed: torch/onnxruntime not importable in $VenvPath." }

Write-Host "`nAI auto-tagging stack ready in $VenvPath (target: $target)." -ForegroundColor Green
if ($ReceiptPath) {
    $receiptDir = Split-Path -Parent $ReceiptPath
    if ($receiptDir) { New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null }
    $profile = switch ($target) {
        "cpu" { "cpu" }
        "legacy" { "gpu-cu126-legacy" }
        default { "gpu-cu128" }
    }
    $receipt = [ordered]@{
        profile = $profile
        installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        python = (Resolve-Path $venvPython).Path
        verified = $true
        target = $target
        installedBy = "install-ai.ps1"
    }
    $json = $receipt | ConvertTo-Json -Depth 5
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ReceiptPath, $json, $utf8NoBom)
    Write-Host "Wrote AI runtime receipt: $ReceiptPath" -ForegroundColor Green
}
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. Restart NekoBooru if it was already running so the app links the managed AI venv."
Write-Host "  2. Open Settings -> Auto Tagging, enable AI features, and download the models you want."
Write-Host "  3. Optional: benchmark with  $venvPython benchmark-tagger.py"

if ($transcriptStarted) {
    Stop-Transcript | Out-Null
}
