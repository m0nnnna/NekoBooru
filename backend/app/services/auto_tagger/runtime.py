"""Torch, onnxruntime and llama.cpp runtime discovery, CUDA preparation and GPU fallbacks."""
from __future__ import annotations

import ctypes
import importlib
import os
import logging
import sys
import gc
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from .. import auto_tagger as _at
from .core import QWEN_MIN_FREE_VRAM_GB

logger = logging.getLogger(__package__)


_LLAMA_DLL_DIRECTORY_HANDLES: list[Any] = []
_LLAMA_PRELOAD_HANDLES: list[Any] = []
_ONNX_DLL_DIRECTORY_HANDLES: list[Any] = []
_ONNX_PRELOAD_HANDLES: list[Any] = []


def _clear_torch_cache() -> None:
    gc.collect()
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _normalize_torch_device(value: str | None) -> str:
    value = str(value or "auto").lower().strip()
    if value not in {"auto", "gpu", "cpu"}:
        return "auto"
    return value


def _torch_runtime_info() -> dict:
    info = {
        "available": find_spec("torch") is not None,
        "version": None,
        "cudaAvailable": False,
        "cudaVersion": None,
        "deviceCount": 0,
        "devices": [],
    }
    if not info["available"]:
        return info
    try:
        import torch  # type: ignore

        info["version"] = str(getattr(torch, "__version__", "unknown"))
        info["cudaAvailable"] = bool(torch.cuda.is_available())
        info["cudaVersion"] = str(getattr(torch.version, "cuda", None))
        info["deviceCount"] = int(torch.cuda.device_count()) if info["cudaAvailable"] else 0
        devices = []
        for idx in range(int(info["deviceCount"])):
            props = torch.cuda.get_device_properties(idx)
            devices.append({
                "index": idx,
                "name": torch.cuda.get_device_name(idx),
                "totalMemoryGb": round(float(props.total_memory) / 1024**3, 2),
                "allocatedGb": round(float(torch.cuda.memory_allocated(idx)) / 1024**3, 2),
                "reservedGb": round(float(torch.cuda.memory_reserved(idx)) / 1024**3, 2),
            })
        info["devices"] = devices
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


# CUDA/cuDNN libraries onnxruntime_providers_cuda.dll links against, in load
# order. cuDNN 9 is split into sub-libraries that must be resident before
# cudnn64_9.dll itself will initialize.
_ONNX_CUDA_DLLS = (
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "nvJitLink_120_0.dll",
    "cufft64_11.dll",
    "curand64_10.dll",
    "cusparse64_12.dll",
    "cusolver64_11.dll",
    "cudnn_graph64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn64_9.dll",
)


def _prepare_onnx_cuda_runtime() -> None:
    """Preload CUDA/cuDNN so onnxruntime can build its CUDA provider on Windows.

    onnxruntime-gpu ships no CUDA libraries of its own; it dlopens cuDNN 9 and
    the CUDA 12 runtime by bare name. Those DLLs are already on disk inside the
    torch wheel (or the nvidia-* wheels), but they live in a directory Windows
    never searches, so provider creation fails with "Require cuDNN 9.* and
    CUDA 12.*" and every ONNX tagger silently falls back to CPU. Putting the
    directory on the search path is not enough — the libraries have to be
    resident — so preload them here and keep the handles alive for the process.
    """
    if _at._ONNX_CUDA_PREPARED or os.name != "nt":
        return
    _at._ONNX_CUDA_PREPARED = True

    candidates: list[Path] = []
    torch_spec = find_spec("torch")
    if torch_spec and torch_spec.origin:
        torch_root = Path(torch_spec.origin).resolve().parent
        candidates.append(torch_root / "lib")
        nvidia_root = torch_root.parent / "nvidia"
        if nvidia_root.exists():
            candidates.extend(path for path in nvidia_root.rglob("bin") if path.is_dir())
    lib_dirs = [path for path in candidates if path.is_dir()]
    if not lib_dirs:
        return

    for path in lib_dirs:
        if hasattr(os, "add_dll_directory"):
            try:
                _ONNX_DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(path)))
            except OSError as exc:
                logger.debug("Unable to add ONNX CUDA DLL directory %s: %s", path, exc)

    loaded = 0
    for name in _ONNX_CUDA_DLLS:
        path = next((directory / name for directory in lib_dirs if (directory / name).exists()), None)
        if not path:
            continue
        try:
            _ONNX_PRELOAD_HANDLES.append(ctypes.WinDLL(str(path)))
            loaded += 1
        except OSError as exc:
            logger.debug("Unable to preload CUDA DLL %s: %s", path, exc)
    if loaded:
        logger.info("Preloaded %d CUDA/cuDNN libraries for the onnxruntime CUDA provider", loaded)


def _create_onnx_session(ort, model_path: str):
    _prepare_onnx_cuda_runtime()
    providers = _onnx_providers(ort)
    try:
        return ort.InferenceSession(model_path, providers=providers)
    except Exception as exc:  # noqa: BLE001
        if providers != ["CPUExecutionProvider"]:
            logger.warning("ONNX GPU provider failed for %s; retrying CPU provider: %s", model_path, exc)
            return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        raise


def _onnx_providers(ort) -> list[str]:
    available = set(ort.get_available_providers())
    providers = []
    if "CUDAExecutionProvider" in available and not _at._ONNX_CUDA_DISABLED:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


# The taggers that build an onnxruntime session (see _create_onnx_session), and
# so the ones a faulted CUDA context can be recovered for by rebuilding on CPU.
_ONNX_TAGGER_MODEL_IDS = ("wd", "pixai", "camie", "cl")


# A CUDA context that has faulted - a driver reset, an Xid, or Windows TDR
# kicking in on the display GPU - stays broken for the life of the process:
# every later call returns the sticky cudaErrorUnknown (999), and cublasCreate
# then fails with CUBLAS_STATUS_NOT_INITIALIZED. Nothing recovers that
# in-process, so instead of failing every remaining image with a confusing
# CUBLAS message, drop to CPU once and keep tagging.
_CUDA_CONTEXT_FATAL_MARKERS = (
    "cublas failure 1",
    "the library was not initialized",
    "cuda failure 999",
    "cudnn_status_execution_failed_cudart",
    "cudnn_backend_api_failed",
    "cudaerrorunknown",
)


def _is_cuda_context_fatal(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _CUDA_CONTEXT_FATAL_MARKERS)


def _disable_onnx_cuda(reason: str) -> None:
    if _at._ONNX_CUDA_DISABLED:
        return
    _at._ONNX_CUDA_DISABLED = True
    logger.error(
        "CUDA context is unusable (%s). Falling back to CPU for ONNX taggers for the rest of "
        "this process; restart the backend to use the GPU again.",
        reason,
    )


def _qwen_device_map(device_preference: str):
    device_preference = _normalize_torch_device(device_preference)
    torch_info = _torch_runtime_info()
    if device_preference == "gpu":
        if not torch_info.get("cudaAvailable"):
            raise RuntimeError("GPU was selected, but this Python environment has CPU-only torch or CUDA is unavailable.")
        _ensure_qwen_gpu_headroom()
        return {"": 0}
    if device_preference == "cpu":
        return "cpu"
    if torch_info.get("cudaAvailable"):
        _ensure_qwen_gpu_headroom()
        return {"": 0}
    return "cpu"


def _ensure_qwen_gpu_headroom() -> None:
    info = _qwen_gpu_memory_info()
    free_gb = float(info.get("freeGb") or 0.0)
    if free_gb < QWEN_MIN_FREE_VRAM_GB:
        raise RuntimeError(
            f"Qwen needs about {QWEN_MIN_FREE_VRAM_GB:g} GB free VRAM to load safely; "
            f"only {free_gb:.1f} GB is free. Unload other AI models or use Custom without Qwen."
        )


def _qwen_gpu_memory_info() -> dict:
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return {"available": False, "freeGb": 0.0, "totalGb": 0.0}
        free, total = torch.cuda.mem_get_info(0)
        return {
            "available": True,
            "freeGb": round(float(free) / 1024**3, 2),
            "totalGb": round(float(total) / 1024**3, 2),
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "freeGb": 0.0, "totalGb": 0.0, "error": str(exc)}


def _qwen_gguf_use_gpu(device_preference: str) -> bool:
    device_preference = _normalize_torch_device(device_preference)
    if device_preference == "cpu":
        return False
    if device_preference == "gpu":
        _ensure_qwen_gpu_headroom()
        return True
    return bool(_qwen_gpu_memory_info().get("available"))


def _transformers_pipeline():
    try:
        from transformers.pipelines import pipeline as hf_pipeline  # type: ignore

        _at._TRANSFORMERS_PIPELINE_OK = True
        return hf_pipeline
    except Exception as direct_exc:  # noqa: BLE001
        try:
            from transformers import pipeline as hf_pipeline  # type: ignore

            _at._TRANSFORMERS_PIPELINE_OK = True
            return hf_pipeline
        except Exception as lazy_exc:  # noqa: BLE001
            _at._TRANSFORMERS_PIPELINE_OK = False
            raise ImportError(
                "transformers pipeline is unavailable. Reinstall the AI runtime so transformers, torch, "
                f"torchvision, and torchaudio are compatible. direct import: {direct_exc}; lazy import: {lazy_exc}"
            ) from lazy_exc


def _transformers_pipeline_available() -> bool:
    """Whether Whisper's transformers pipeline should work.

    Importing transformers.pipelines takes ~3 s and drags torch in, which made
    the first status call after every start slow. The real answer is recorded
    once a Whisper load imports it; until then, the packages being installed
    is the answer, and a broken install still surfaces as that load's error.
    """
    if _at._TRANSFORMERS_PIPELINE_OK is not None:
        return _at._TRANSFORMERS_PIPELINE_OK
    if "transformers.pipelines" in sys.modules:
        return True
    return find_spec("transformers") is not None and find_spec("torch") is not None


def _prepare_llama_cpp_runtime() -> None:
    # Once per process: this walks site-packages/nvidia and registers DLL
    # directories, and status polls used to repeat it (and leak the handles).
    if _at._LLAMA_CPP_PREPARED:
        return
    _at._LLAMA_CPP_PREPARED = True
    if os.name != "nt":
        return
    candidates: list[Path] = []
    llama_spec = find_spec("llama_cpp")
    if llama_spec and llama_spec.origin:
        site_packages = Path(llama_spec.origin).resolve().parents[1]
        candidates.extend([site_packages / "llama_cpp" / "lib", site_packages / "torch" / "lib"])
        nvidia_root = site_packages / "nvidia"
        if nvidia_root.exists():
            candidates.extend(path for path in nvidia_root.rglob("bin") if path.is_dir())
    torch_spec = find_spec("torch")
    if torch_spec and torch_spec.origin:
        candidates.append(Path(torch_spec.origin).resolve().parent / "lib")

    existing_path = os.environ.get("PATH", "")
    existing_parts = [part for part in existing_path.split(os.pathsep) if part]
    prepend: list[str] = []
    for path in candidates:
        if not path.exists():
            continue
        text = str(path)
        if text not in existing_parts and text not in prepend:
            prepend.append(text)
        if hasattr(os, "add_dll_directory"):
            try:
                _LLAMA_DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(text))
            except OSError:
                pass
    if prepend:
        os.environ["PATH"] = os.pathsep.join([*prepend, *existing_parts])

    llama_lib = next((path for path in candidates if path.name == "lib" and path.parent.name == "llama_cpp"), None)
    if not llama_lib:
        return
    for name in ("ggml-base.dll", "ggml-cpu.dll", "ggml-cuda.dll", "ggml.dll", "llama.dll", "mtmd.dll"):
        path = llama_lib / name
        if not path.exists():
            continue
        try:
            _LLAMA_PRELOAD_HANDLES.append(ctypes.CDLL(str(path)))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Unable to preload llama.cpp DLL %s: %s", path, exc)


def _llama_cpp_importable() -> bool:
    if _at._LLAMA_CPP_IMPORTABLE:
        return True
    if find_spec("llama_cpp") is None:
        return False
    try:
        _prepare_llama_cpp_runtime()
        importlib.import_module("llama_cpp")
        _at._LLAMA_CPP_IMPORTABLE = True
        return True
    except Exception as exc:  # noqa: BLE001
        logger.debug("llama_cpp is installed but not importable yet: %s", exc)
        return False
