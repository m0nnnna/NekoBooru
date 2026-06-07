#!/usr/bin/env bash
#
# Install NekoBooru's optional AI auto-tagging stack into the project venv.
#
# Creates (or reuses) the project virtual environment, installs the base
# requirements plus the tagger dependencies, and verifies that torch and
# onnxruntime are importable by that venv's interpreter. Installs the GPU
# (CUDA 12.8) stack by default; pass --cpu for a CPU-only install, or --legacy
# for the CUDA 12.6 stack that older Pascal GPUs (GTX 10-series, sm_61) need.
#
# Usage:
#   ./install-ai.sh           # GPU (CUDA 12.8) stack
#   ./install-ai.sh --cpu     # CPU-only stack
#   ./install-ai.sh --legacy  # CUDA 12.6 stack for Pascal/sm_61 GPUs
#   ./install-ai.sh --venv=/path/to/venv
#
set -euo pipefail
cd "$(dirname "$0")"

CPU=0
LEGACY=0
VENV="venv"
for arg in "$@"; do
  case "$arg" in
    --cpu)      CPU=1 ;;
    --legacy)   LEGACY=1 ;;
    --venv=*)   VENV="${arg#*=}" ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [ "$CPU" -eq 1 ] && [ "$LEGACY" -eq 1 ]; then
  echo "Use either --cpu or --legacy, not both." >&2; exit 2
fi

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "Python 3 not found in PATH. Install Python 3.10+ first." >&2; exit 1; }

if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating virtual environment at $VENV ..."
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

if [ "$CPU" -eq 1 ]; then
  REQ="backend/requirements-tagger-cpu.txt";    MODE="CPU-only"
elif [ "$LEGACY" -eq 1 ]; then
  REQ="backend/requirements-tagger-legacy.txt"; MODE="GPU (CUDA 12.6, legacy Pascal/sm_61)"
else
  REQ="backend/requirements-tagger.txt";        MODE="GPU (CUDA 12.8)"
fi
echo "Installing AI auto-tagging stack [$MODE] into $VENV ..."

# Always install with the venv's own python so packages land in the right place.
"$VPY" -m pip install --upgrade pip
"$VPY" -m pip install -r backend/requirements.txt
"$VPY" -m pip install -r "$REQ"

echo
echo "Verifying install ..."
"$VPY" -c "import torch, onnxruntime as ort; print('torch', torch.__version__, '| cuda', torch.cuda.is_available()); print('onnxruntime', ort.__version__, '| providers', ort.get_available_providers())"

echo
echo "AI auto-tagging stack installed into $VENV."
echo "Next steps:"
echo "  1. Start NekoBooru from source: ./start.sh"
echo "  2. Open Settings -> Auto Tagging, enable AI features, and download the models you want."
