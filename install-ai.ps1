<#
.SYNOPSIS
    Install NekoBooru's optional AI auto-tagging stack into the project venv.

.DESCRIPTION
    Creates (or reuses) the project virtual environment, installs the base
    requirements plus the tagger dependencies, and verifies that torch and
    onnxruntime are importable by that venv's interpreter. Installs the
    CUDA/GPU stack by default; pass -CPU for a CPU-only install.

    The compiled nekobooru.exe deliberately excludes this stack and can never
    use it, so AI features require a source checkout running from this venv
    (start.bat for the main app, start-worker.bat for a remote GPU worker).

.PARAMETER CPU
    Install the CPU-only tagger stack (no NVIDIA GPU required).

.PARAMETER VenvPath
    Virtual environment to install into. Default: .\venv

.EXAMPLE
    ./install-ai.ps1
    ./install-ai.ps1 -CPU
#>
[CmdletBinding()]
param(
    [switch]$CPU,
    [string]$VenvPath = "venv"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

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

$tagReqs = if ($CPU) { "backend\requirements-tagger-cpu.txt" } else { "backend\requirements-tagger.txt" }
$mode = if ($CPU) { "CPU-only" } else { "GPU (CUDA)" }
Write-Host "Installing AI auto-tagging stack [$mode] into $VenvPath ..." -ForegroundColor Cyan

# Always install with the venv's own python so packages land in the right place.
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r "backend\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "Base dependency install failed." }
& $venvPython -m pip install -r $tagReqs
if ($LASTEXITCODE -ne 0) { throw "Tagger dependency install failed (see pip output above)." }

# --- Verify the heavy bits actually import in this venv. ---
Write-Host "`nVerifying install ..." -ForegroundColor Cyan
& $venvPython -c "import torch, onnxruntime as ort; print('torch', torch.__version__, '| cuda', torch.cuda.is_available()); print('onnxruntime', ort.__version__, '| providers', ort.get_available_providers())"
if ($LASTEXITCODE -ne 0) { throw "Verification failed: torch/onnxruntime not importable in $VenvPath." }

Write-Host "`nAI auto-tagging stack installed into $VenvPath." -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. Start NekoBooru from source: start.bat (main app) or start-worker.bat (remote GPU worker)."
Write-Host "  2. Open Settings -> Auto Tagging, enable AI features, and download the models you want."
if (-not $CPU) {
    Write-Host "`nNote: if 'cuda' printed False above, your NVIDIA driver/GPU isn't visible to torch;" -ForegroundColor Yellow
    Write-Host "      tagging will fall back to CPU. Re-run with -CPU to install the lighter CPU stack." -ForegroundColor Yellow
}
