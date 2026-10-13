"""Model status, the single-worker model load queue, unloading, and cache deletion."""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import uuid
from importlib.util import find_spec

from ..media import check_ffmpeg_available
from .. import auto_tagger as _at
from .cache import _model_cache_paths, _qwen_gguf_dir, _repo_cache_path, model_cache_status
from .core import (
    _gpu_work_lock,
    AutoTagOptions,
    MODEL_REGISTRY,
    QWEN_SEMANTIC_MODEL_IDS,
    SUPPORTED_IMAGE_EXTS,
    SUPPORTED_VIDEO_EXTS,
    WD_MODEL_ID,
)
from .downloads import _download_lock, current_download_job, start_model_download
from .media_taggers import (
    _ocr_tagger,
    _qwen_gguf_q4_tagger,
    _qwen_gguf_q8_tagger,
    _qwen_tagger,
    _whisper_tagger,
)
from .onnx_taggers import _camie_tagger, _cl_tagger, _pixai_tagger, _wd_tagger
from .options import _semantic_model_id, huggingface_token, load_options, tagger_worker_token
from .runtime import (
    _llama_cpp_importable,
    _onnx_providers,
    _torch_runtime_info,
    _transformers_pipeline_available,
)

logger = logging.getLogger(__package__)


_load_lock = threading.Lock()


_load_queue: list[str] = []


def _onnx_runtime_info() -> dict:
    info = {
        "available": find_spec("onnxruntime") is not None,
        "availableProviders": [],
        "preferredProviders": [],
        "wdProviders": list(_wd_tagger._providers),
        "pixaiProviders": list(_pixai_tagger._providers),
        "camieProviders": list(_camie_tagger._providers),
        "clProviders": list(_cl_tagger._providers),
    }
    if not info["available"]:
        return info
    try:
        import onnxruntime as ort  # type: ignore

        info["availableProviders"] = list(ort.get_available_providers())
        info["preferredProviders"] = _onnx_providers(ort)
    except Exception as exc:  # noqa: BLE001
        info["available"] = False
        info["error"] = str(exc)
    return info


def _remote_worker_status(opts: AutoTagOptions) -> dict:
    """Report remote-worker config and live reachability (used by the UI)."""
    info = {
        "enabled": bool(opts.remoteEnabled),
        "url": opts.remoteUrl,
        "tokenConfigured": bool(tagger_worker_token()),
        "reachable": False,
        "worker": None,
        "error": None,
    }
    if not (opts.remoteEnabled and opts.remoteUrl):
        return info
    import httpx  # base dependency

    try:
        headers = {}
        token = tagger_worker_token()
        if token:
            headers["X-Tagger-Token"] = token
        response = httpx.get(
            f"{opts.remoteUrl.rstrip('/')}/api/auto-tags/status",
            headers=headers,
            timeout=min(60.0, max(5.0, float(opts.remoteTimeoutSeconds))),
        )
        if response.status_code == 200:
            worker = response.json()
            info["reachable"] = True
            info["worker"] = {
                "torch": worker.get("torch"),
                "onnx": worker.get("onnx"),
                "torchDevice": worker.get("torchDevice"),
                "models": worker.get("models"),
                "ffmpeg": worker.get("ffmpeg"),
            }
        else:
            info["error"] = f"worker_error_{response.status_code}"
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"worker_unreachable: {exc}"
    return info


def status() -> dict:
    model_cache = model_cache_status()
    opts = load_options()
    from ..booru_suggest import gelbooru_credentials

    return {
        "enabled": opts.enabled,
        "model": _wd_tagger.name,
        "modelId": WD_MODEL_ID,
        "modelLoaded": _wd_tagger.is_loaded(),
        "modelDownloaded": model_cache["downloaded"],
        "modelFiles": model_cache["files"],
        "models": model_statuses(),
        "downloadJob": current_download_job(),
        "loadJob": current_model_load_job(),
        "torch": _torch_runtime_info(),
        "onnx": _onnx_runtime_info(),
        "torchDevice": opts.torchDevice,
        "qwenDevice": _semantic_tagger_for_options(opts).device_info(),
        "semanticModelId": opts.semanticModelId,
        "remote": _remote_worker_status(opts),
        "huggingFaceTokenConfigured": bool(huggingface_token()),
        "gelbooruCredentialsConfigured": bool(gelbooru_credentials()),
        "dependencies": {
            "huggingface_hub": find_spec("huggingface_hub") is not None,
            "onnxruntime": find_spec("onnxruntime") is not None,
            "numpy": find_spec("numpy") is not None,
            "pillow": find_spec("PIL") is not None,
            "transformers": find_spec("transformers") is not None,
            "transformers_pipeline": _transformers_pipeline_available(),
            "torch": find_spec("torch") is not None,
            "qwen_vl_utils": find_spec("qwen_vl_utils") is not None,
            "llama_cpp": _llama_cpp_importable(),
        },
        "ffmpeg": check_ffmpeg_available(),
        "supportedImages": sorted(SUPPORTED_IMAGE_EXTS),
        "supportedVideos": sorted(SUPPORTED_VIDEO_EXTS),
        "characterModel": {
            "enabled": opts.characterModelEnabled,
            "model": "Camie Tagger v2",
            "available": model_cache_status("camie")["downloaded"] and find_spec("onnxruntime") is not None,
        },
    }


def current_model_load_job() -> dict | None:
    with _load_lock:
        if not _at._load_job and not _load_queue:
            return None
        return _load_job_snapshot_locked()


def _tagger_for_model(model_id: str):
    if model_id == "wd":
        return _wd_tagger
    if model_id == "pixai":
        return _pixai_tagger
    if model_id == "camie":
        return _camie_tagger
    if model_id == "cl":
        return _cl_tagger
    if model_id == "ocr":
        return _ocr_tagger
    if model_id == "whisper":
        return _whisper_tagger
    if model_id == "qwen":
        return _qwen_tagger
    if model_id == "qwen_gguf_q4":
        return _qwen_gguf_q4_tagger
    if model_id == "qwen_gguf_q8":
        return _qwen_gguf_q8_tagger
    raise ValueError(f"Unknown model: {model_id}")


def _semantic_tagger_for_options(opts: AutoTagOptions):
    return _tagger_for_model(_semantic_model_id(opts))


def start_model_load(model_id: str = "wd") -> dict:
    tagger = _tagger_for_model(model_id)

    with _load_lock:
        if tagger.is_loaded():
            _at._load_job = _new_load_job(model_id, status="completed", progress=100, message="Model weights already loaded")
            return _load_job_snapshot_locked()
        running = _at._load_job if _at._load_job and _at._load_job.get("status") in {"queued", "running"} else None
        if running and running.get("modelId") == model_id:
            return _load_job_snapshot_locked()
        if model_id in _load_queue:
            return _load_job_snapshot_locked()
        if running:
            # A different model is loading. Queue this one instead of handing
            # back the in-flight job, which used to leave the UI polling a load
            # that was never going to happen.
            _load_queue.append(model_id)
            return _load_job_snapshot_locked()
        _load_queue.append(model_id)
        if _at._load_worker is None or not _at._load_worker.is_alive():
            _at._load_worker = threading.Thread(target=_run_model_load_queue, daemon=True)
            _at._load_worker.start()
        return _load_job_snapshot_locked()


def _load_job_snapshot_locked() -> dict:
    """Current load job plus anything waiting behind it. Caller holds _load_lock."""
    snapshot = json.loads(json.dumps(_at._load_job)) if _at._load_job else {}
    snapshot["queued"] = list(_load_queue)
    return snapshot


def _run_model_load_queue() -> None:
    while True:
        with _load_lock:
            if not _load_queue:
                return
            model_id = _load_queue.pop(0)
            _at._load_job = _new_load_job(model_id, status="queued", progress=0, message="Queued model weight load")
            job_id = _at._load_job["id"]
        _run_model_load_job(job_id, model_id)


def unload_model(model_id: str) -> dict:
    tagger = _tagger_for_model(model_id)
    # Freeing weights out from under a running inference crashes the process.
    with _gpu_work_lock:
        was_loaded = bool(tagger.unload())
    return {
        "modelId": model_id,
        "model": MODEL_REGISTRY[model_id]["name"],
        "unloaded": was_loaded,
        "loaded": bool(tagger.is_loaded()),
        "models": model_statuses(),
    }


def delete_model_cache(model_id: str) -> dict:
    if model_id not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {model_id}")
    with _download_lock:
        if _at._download_job and _at._download_job.get("status") in {"queued", "running"}:
            raise RuntimeError("Wait for the active model download to finish before deleting model files")

    tagger = _tagger_for_model(model_id)
    was_loaded = bool(tagger.unload())
    meta = MODEL_REGISTRY[model_id]
    if meta.get("storage") == "local_files":
        cache_path = _qwen_gguf_dir(model_id)
        deleted_paths = []
        if cache_path.exists():
            shutil.rmtree(cache_path)
            deleted_paths.append(str(cache_path))
        return {
            "modelId": model_id,
            "model": meta["name"],
            "deleted": bool(deleted_paths),
            "unloaded": was_loaded,
            "cachePath": str(cache_path),
            "deletedPaths": deleted_paths,
            "models": model_statuses(),
        }

    repo_id = str(meta["repoId"])
    cache_paths = _model_cache_paths(repo_id)

    deleted_paths = []
    for cache_path in cache_paths:
        if not cache_path.exists():
            continue
        if cache_path.is_dir():
            shutil.rmtree(cache_path)
        else:
            cache_path.unlink()
        deleted_paths.append(str(cache_path))

    return {
        "modelId": model_id,
        "model": meta["name"],
        "deleted": bool(deleted_paths),
        "unloaded": was_loaded,
        "cachePath": deleted_paths[0] if deleted_paths else str(_repo_cache_path(repo_id).resolve()),
        "deletedPaths": deleted_paths,
        "models": model_statuses(),
    }


def _new_load_job(model_id: str, *, status: str, progress: int, message: str) -> dict:
    now = time.time()
    estimates = {
        "wd": 20,
        "pixai": 15,
        "camie": 30,
        "cl": 45,
        "ocr": 25,
        "whisper": 25,
        "qwen": 90,
        "qwen_gguf_q4": 45,
        "qwen_gguf_q8": 60,
    }
    return {
        "id": str(uuid.uuid4()),
        "modelId": model_id,
        "model": MODEL_REGISTRY[model_id]["name"],
        "repoId": MODEL_REGISTRY[model_id]["repoId"],
        "status": status,
        "stage": status,
        "progress": progress,
        "message": message,
        "estimatedSeconds": estimates.get(model_id, 30),
        "startedAt": now,
        "updatedAt": now,
        "finishedAt": now if status in {"completed", "failed"} else None,
        "error": None,
    }


def _run_model_load_job(job_id: str, model_id: str) -> None:
    def progress(stage: str, percent: int, message: str) -> None:
        with _load_lock:
            if not _at._load_job or _at._load_job.get("id") != job_id:
                return
            _at._load_job["status"] = "running"
            _at._load_job["stage"] = stage
            _at._load_job["progress"] = max(0, min(100, int(percent)))
            _at._load_job["message"] = message
            _at._load_job["updatedAt"] = time.time()

    try:
        progress("start", 3, "Preparing model runtime")
        # Wait for any in-flight inference: allocating a second model's weights
        # while a tag run is mid-image is how this used to OOM the process.
        if not _gpu_work_lock.acquire(blocking=False):
            progress("waiting", 5, "Waiting for the current tagging run to finish")
            _gpu_work_lock.acquire()
        try:
            if model_id == "wd":
                _wd_tagger.ensure_loaded(progress=progress)
            else:
                progress("load_weights", 15, f"Loading {MODEL_REGISTRY[model_id]['name']} weights into memory")
                if model_id in QWEN_SEMANTIC_MODEL_IDS:
                    _tagger_for_model(model_id).ensure_loaded(load_options().torchDevice)
                else:
                    _tagger_for_model(model_id).ensure_loaded()
                progress("ready", 100, "Model weights loaded")
        finally:
            _gpu_work_lock.release()
        with _load_lock:
            if _at._load_job and _at._load_job.get("id") == job_id:
                _at._load_job["status"] = "completed"
                _at._load_job["stage"] = "ready"
                _at._load_job["progress"] = 100
                _at._load_job["message"] = "Model weights loaded"
                _at._load_job["finishedAt"] = time.time()
                _at._load_job["updatedAt"] = time.time()
    except Exception as exc:  # noqa: BLE001
        logger.warning("model load failed for %s: %s", model_id, exc)
        with _load_lock:
            if _at._load_job and _at._load_job.get("id") == job_id:
                _at._load_job["status"] = "failed"
                _at._load_job["stage"] = "failed"
                _at._load_job["message"] = "Model load failed"
                _at._load_job["error"] = str(exc)
                _at._load_job["finishedAt"] = time.time()
                _at._load_job["updatedAt"] = time.time()


def model_statuses() -> list[dict]:
    rows = []
    for model_id, meta in MODEL_REGISTRY.items():
        cache = model_cache_status(model_id)
        try:
            loaded = bool(_tagger_for_model(model_id).is_loaded())
        except ValueError:
            loaded = False
        rows.append({
            **meta,
            "downloaded": cache["downloaded"],
            "files": cache["files"],
            "runtimeAvailable": runtime_available(model_id),
            "loaded": loaded,
            "providers": _model_runtime_providers(model_id),
        })
    return rows


def _model_runtime_providers(model_id: str) -> list[str]:
    if model_id == "wd":
        return list(_wd_tagger._providers)
    if model_id == "pixai":
        return list(_pixai_tagger._providers)
    if model_id == "camie":
        return list(_camie_tagger._providers)
    if model_id == "cl":
        return list(_cl_tagger._providers)
    if model_id in {"qwen_gguf_q4", "qwen_gguf_q8"} and _llama_cpp_importable():
        return ["llama.cpp"]
    return []


def runtime_available(model_id: str) -> bool:
    if model_id in {"wd", "pixai", "camie", "cl"}:
        return bool(_onnx_runtime_info().get("available")) and find_spec("numpy") is not None
    if model_id in {"ocr", "whisper"}:
        return find_spec("transformers") is not None and find_spec("torch") is not None
    if model_id == "qwen":
        return (
            find_spec("transformers") is not None
            and find_spec("torch") is not None
            and find_spec("qwen_vl_utils") is not None
        )
    if model_id in {"qwen_gguf_q4", "qwen_gguf_q8"}:
        return _llama_cpp_importable()
    return False


def download_model() -> dict:
    job = start_model_download(["wd"])
    return {
        "enabled": opts.enabled,
        "model": _wd_tagger.name,
        "modelId": WD_MODEL_ID,
        "modelLoaded": _wd_tagger.is_loaded(),
        "modelDownloaded": model_cache["downloaded"],
        "modelFiles": model_cache["files"],
        "models": model_statuses(),
        "downloadJob": current_download_job(),
        "loadJob": current_model_load_job(),
        "torch": _torch_runtime_info(),
        "onnx": _onnx_runtime_info(),
        "torchDevice": opts.torchDevice,
        "qwenDevice": _semantic_tagger_for_options(opts).device_info(),
        "semanticModelId": opts.semanticModelId,
        "remote": _remote_worker_status(opts),
        "huggingFaceTokenConfigured": bool(huggingface_token()),
    }
