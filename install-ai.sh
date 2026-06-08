#!/usr/bin/env bash
#
# Install NekoBooru's optional AI auto-tagging stack into the project venv,
# auto-selecting the right CUDA build for the detected GPU.
#
# Stacks:
#   standard  NVIDIA GPU, CUDA 12.8 (compute capability 7.0+: Volta/Turing/
#             Ampere/Ada/Hopper/Blackwell)
#   legacy    older NVIDIA GPU, CUDA 12.6 (compute capability 6.x: Pascal /
#             GTX 10-series, e.g. 1060) - cu128 dropped these
#   cpu       no usable NVIDIA GPU (or Maxwell sm_5x and older)
#
# With no flag it DETECTS the GPU via nvidia-smi and picks the stack. It is
# idempotent (does nothing if the correct working build is present) and will
# uninstall a build that can't launch a CUDA kernel on this GPU and install the
# right one, falling back standard -> legacy -> cpu when auto-detecting.
#
# Usage:
#   ./install-ai.sh            # auto-detect and install the right stack
#   ./install-ai.sh --gpu      # force standard CUDA 12.8
#   ./install-ai.sh --legacy   # force CUDA 12.6 (Pascal/sm_61)
#   ./install-ai.sh --cpu      # force CPU-only
#   ./install-ai.sh --force    # reinstall even if already correct
#   ./install-ai.sh --venv=/path/to/venv
#
set -uo pipefail
cd "$(dirname "$0")"

CPU=0; LEGACY=0; GPU=0; FORCE=0; VENV="venv"
for arg in "$@"; do
  case "$arg" in
    --cpu)     CPU=1 ;;
    --legacy)  LEGACY=1 ;;
    --gpu)     GPU=1 ;;
    --force)   FORCE=1 ;;
    --venv=*)  VENV="${arg#*=}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [ $((CPU + LEGACY + GPU)) -gt 1 ]; then
  echo "Pick at most one of --cpu / --legacy / --gpu." >&2; exit 2
fi

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "Python 3 not found in PATH. Install Python 3.10+ first." >&2; exit 1; }

if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating virtual environment at $VENV ..."
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

detect_target() {
  command -v nvidia-smi >/dev/null 2>&1 || { echo "No nvidia-smi -> CPU stack." >&2; echo cpu; return; }
  local caps; caps="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null || true)"
  if [ -z "$caps" ]; then
    echo "nvidia-smi present but compute capability unreadable; defaulting to standard (will auto-fall back)." >&2
    echo standard; return
  fi
  echo "$caps" | awk -F. '
    { gsub(/[ \t]/,"",$1); m=$1+0; if (m>x) x=m }
    END { if (x>=7) print "standard"; else if (x==6) print "legacy"; else if (x>0) print "cpu"; else print "standard" }'
}

installed_variant() {
  "$VPY" -c "import torch; v=torch.__version__; print(v.split('+',1)[1] if '+' in v else 'unknown')" 2>/dev/null || echo none
}

class_of() {
  case "$1" in
    cu128|cu129) echo standard ;;
    cu126)       echo legacy ;;
    cpu)         echo cpu ;;
    none)        echo none ;;
    *)           echo other ;;
  esac
}

req_file() {
  case "$1" in
    cpu)    echo backend/requirements-tagger-cpu.txt ;;
    legacy) echo backend/requirements-tagger-legacy.txt ;;
    *)      echo backend/requirements-tagger.txt ;;
  esac
}

cuda_kernel_ok() {
  "$VPY" -c "import torch; assert torch.cuda.is_available(); x=torch.randn(64,64,device='cuda'); _=(x@x).sum().item()" >/dev/null 2>&1
}

uninstall_torch() {
  echo "Removing existing torch/onnxruntime so the correct build can be installed ..."
  "$VPY" -m pip uninstall -y torch torchvision torchaudio onnxruntime onnxruntime-gpu >/dev/null 2>&1 || true
}

do_install() {
  "$VPY" -m pip install --upgrade pip >/dev/null
  "$VPY" -m pip install -r backend/requirements.txt || { echo "Base dependency install failed." >&2; exit 1; }
  "$VPY" -m pip install -r "$(req_file "$1")" || { echo "Tagger dependency install failed." >&2; exit 1; }
}

EXPLICIT=0
if   [ "$CPU" -eq 1 ];    then TARGET=cpu;      EXPLICIT=1
elif [ "$LEGACY" -eq 1 ]; then TARGET=legacy;   EXPLICIT=1
elif [ "$GPU" -eq 1 ];    then TARGET=standard; EXPLICIT=1
else TARGET="$(detect_target)"; fi

VARIANT="$(installed_variant)"
CLASS="$(class_of "$VARIANT")"
echo "Installed torch: $VARIANT (class: $CLASS) | target: $TARGET"

NEED=0
[ "$FORCE" -eq 1 ] && NEED=1
[ "$CLASS" != "$TARGET" ] && NEED=1
if [ "$NEED" -eq 0 ] && [ "$TARGET" != "cpu" ]; then
  if ! cuda_kernel_ok; then
    echo "Installed $VARIANT torch can't run a CUDA kernel on this GPU; will reinstall."
    NEED=1
  fi
fi

if [ "$NEED" -eq 0 ]; then
  echo "AI stack already correct ($VARIANT) for target [$TARGET]; nothing to install."
else
  ATTEMPT="$TARGET"
  while true; do
    uninstall_torch
    case "$ATTEMPT" in
      cpu)    LABEL="CPU-only" ;;
      legacy) LABEL="GPU (CUDA 12.6, Pascal/sm_61)" ;;
      *)      LABEL="GPU (CUDA 12.8)" ;;
    esac
    echo "Installing AI auto-tagging stack [$LABEL] into $VENV ..."
    do_install "$ATTEMPT"

    [ "$ATTEMPT" = "cpu" ] && break
    if cuda_kernel_ok; then break; fi

    echo "Installed the $ATTEMPT stack, but no CUDA kernel runs on this GPU."
    if [ "$EXPLICIT" -eq 1 ]; then
      echo "Leaving it as requested. Try --legacy (older GPU) or --cpu instead."
      break
    fi
    if [ "$ATTEMPT" = "standard" ]; then echo "Falling back to legacy CUDA 12.6 ..."; ATTEMPT=legacy; continue; fi
    if [ "$ATTEMPT" = "legacy" ];   then echo "Falling back to the CPU stack ...";   ATTEMPT=cpu;    continue; fi
    break
  done
  TARGET="$ATTEMPT"
fi

echo
echo "Verifying install ..."
"$VPY" -c "import torch, onnxruntime as ort; print('torch', torch.__version__, '| cuda', torch.cuda.is_available()); print('onnxruntime', ort.__version__, '| providers', ort.get_available_providers())" \
  || { echo "Verification failed: torch/onnxruntime not importable in $VENV." >&2; exit 1; }

echo
echo "AI auto-tagging stack ready in $VENV (target: $TARGET)."
echo "Next steps:"
echo "  1. Start NekoBooru from source: ./start.sh"
echo "  2. Open Settings -> Auto Tagging, enable AI features, and download the models you want."
echo "  3. Optional: benchmark with  $VPY benchmark-tagger.py"
