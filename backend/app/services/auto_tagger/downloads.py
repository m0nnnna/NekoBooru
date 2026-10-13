"""The model download job: one job with a dynamic queue, driven by huggingface_hub."""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from importlib.util import find_spec

from .. import auto_tagger as _at
from .cache import (
    _expected_download_total,
    _hf_cache_dir,
    _local_file_download_progress,
    _qwen_gguf_dir,
    model_cache_status,
)
from .core import MODEL_REGISTRY
from .options import _semantic_model_id, huggingface_token, load_options
from .runtime import _llama_cpp_importable

logger = logging.getLogger(__package__)


_download_lock = threading.Lock()


_DOWNLOAD_ACTIVE_STATUSES = {"queued", "running", "cancelling"}
_DOWNLOAD_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "skipped"}


class DownloadCancelled(RuntimeError):
    pass


class _ProgressTqdm:
    """Minimal tqdm-compatible progress hook for huggingface_hub downloads."""

    _lock = threading.RLock()

    @classmethod
    def get_lock(cls):
        return cls._lock

    @classmethod
    def set_lock(cls, lock):
        cls._lock = lock

    @classmethod
    def external_write_mode(cls, *args, **kwargs):
        return cls._lock

    def __init__(self, *args, **kwargs):
        self.iterable = args[0] if args else None
        self.total = int(kwargs.get("total") or 0)
        self.n = int(kwargs.get("initial") or 0)
        self.desc = str(kwargs.get("desc") or "")
        self.unit = str(kwargs.get("unit") or "")
        self._job_id = _active_job_id()
        self._model_id = _active_model_id()
        self._closed = False
        self._push(0)

    def __iter__(self):
        if self.iterable is None:
            return iter(())
        for item in self.iterable:
            yield item
            self.update(1)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def update(self, n=1):
        if self._closed:
            return
        self.n += int(n or 0)
        self._push(int(n or 0))

    def close(self):
        self._closed = True

    def reset(self, total=None):
        self.n = 0
        if total is not None:
            self.total = int(total or 0)
        self._push(0)

    def set_description(self, desc=None, refresh=True):
        self.desc = str(desc or "")
        self._push(0)

    def set_postfix(self, *args, **kwargs):
        return None

    def refresh(self):
        self._push(0)

    def _push(self, delta: int):
        if not self._job_id or not self._model_id:
            return
        with _download_lock:
            job = _at._download_job
            if not job or job.get("id") != self._job_id:
                return
            if job.get("cancelRequested") or job.get("status") == "cancelling":
                raise DownloadCancelled("Model download cancelled")
            model = job["models"].get(self._model_id)
            if not model:
                return
            model["current"] = self.desc or model.get("current") or ""
            if self.unit.upper().startswith("B"):
                if self.total > 0:
                    model["bytesTotal"] = max(int(model.get("bytesTotal") or 0), self.total)
                model["bytesDownloaded"] = max(int(model.get("bytesDownloaded") or 0), self.n)
            model["updatedAt"] = time.time()


# Deliberately process-global rather than thread-local: snapshot_download fans
# per-file progress bars out to worker threads, and a thread-local context would
# leave every one of them unable to find the job, so byte progress never moved.
# Only one download job runs at a time (start_model_download enforces it).
_download_context: dict[str, str | None] = {"job_id": None, "model_id": None}


def _active_job_id() -> str | None:
    return _download_context.get("job_id")


def _active_model_id() -> str | None:
    return _download_context.get("model_id")


def current_download_job() -> dict | None:
    with _download_lock:
        _reconcile_download_job_locked()
        return json.loads(json.dumps(_at._download_job)) if _at._download_job else None


def cancel_model_download() -> dict:
    with _download_lock:
        if not _at._download_job or _at._download_job.get("status") not in _DOWNLOAD_ACTIVE_STATUSES:
            raise RuntimeError("No active model download is running")
        _refresh_download_row_progress_locked()
        _at._download_job["status"] = "cancelling"
        _at._download_job["cancelRequested"] = True
        _at._download_job["cancelRequestedAt"] = time.time()
        _at._download_job["updatedAt"] = time.time()
        has_active_download = False
        for row in _at._download_job.get("models", {}).values():
            if row.get("status") == "running":
                row["status"] = "cancelling"
                row["current"] = "Cancelling download"
                row["updatedAt"] = time.time()
                has_active_download = True
            elif row.get("status") in {"queued", "cancelling"}:
                row["status"] = "cancelled"
                row["current"] = "Cancelled before download started"
                row["updatedAt"] = time.time()
        if not has_active_download:
            _mark_download_job_cancelled_locked()
        return json.loads(json.dumps(_at._download_job))


def _refresh_download_row_progress_locked() -> None:
    if not _at._download_job:
        return
    for model_id in list(_at._download_job.get("modelIds") or []):
        row = _at._download_job.get("models", {}).get(model_id)
        if not row or row.get("status") in _DOWNLOAD_TERMINAL_STATUSES:
            continue
        downloaded, total = _local_file_download_progress(model_id)
        if total:
            previous = int(row.get("bytesDownloaded") or 0)
            row["bytesTotal"] = max(int(row.get("bytesTotal") or 0), total)
            row["bytesDownloaded"] = max(previous, downloaded)
            if downloaded > previous:
                row["updatedAt"] = time.time()
                _at._download_job["updatedAt"] = time.time()
            if row.get("status") == "running":
                row["current"] = "Downloading local model files"


def _reconcile_download_job_locked() -> None:
    if not _at._download_job or _at._download_job.get("status") not in _DOWNLOAD_ACTIVE_STATUSES:
        return

    _refresh_download_row_progress_locked()

    if _at._download_job.get("cancelRequested"):
        has_active_download = False
        for row in _at._download_job.get("models", {}).values():
            status = row.get("status")
            if status == "queued":
                row["status"] = "cancelled"
                row["current"] = "Cancelled before download started"
                row["updatedAt"] = time.time()
            elif status in {"running", "cancelling"}:
                has_active_download = True
        if not has_active_download:
            _mark_download_job_cancelled_locked()
        return

    changed = False
    for model_id in list(_at._download_job.get("modelIds") or []):
        row = _at._download_job["models"].get(model_id)
        if not row or row.get("status") in _DOWNLOAD_TERMINAL_STATUSES:
            continue
        try:
            cache = model_cache_status(model_id)
        except Exception:
            continue
        if cache.get("downloaded"):
            row["status"] = "completed"
            row["downloaded"] = True
            row["files"] = cache.get("files") or {}
            row["current"] = "Downloaded"
            row["error"] = None
            row["updatedAt"] = time.time()
            changed = True

    if changed:
        completed = sum(1 for row in _at._download_job["models"].values() if row.get("status") == "completed")
        failed = sum(1 for row in _at._download_job["models"].values() if row.get("status") == "failed")
        _at._download_job["completed"] = completed
        _at._download_job["failed"] = failed
        _at._download_job["updatedAt"] = time.time()
        if completed + failed >= int(_at._download_job.get("total") or 0):
            _at._download_job["status"] = "failed" if failed else "completed"


def start_model_download(model_ids: list[str]) -> dict:
    if find_spec("huggingface_hub") is None:
        raise RuntimeError("huggingface_hub is not installed")
    if not model_ids:
        raise ValueError("No models selected")
    unknown = [model_id for model_id in model_ids if model_id not in MODEL_REGISTRY]
    if unknown:
        raise ValueError(f"Unknown model: {', '.join(unknown)}")
    runtime_job = _ensure_download_runtime(model_ids)

    with _download_lock:
        _reconcile_download_job_locked()
        if _at._download_job and _at._download_job.get("status") in _DOWNLOAD_ACTIVE_STATUSES:
            # Queue onto the running job rather than rejecting: the user should
            # be able to line several models up and walk away.
            if _at._download_job.get("cancelRequested"):
                raise RuntimeError("The current model download is being cancelled")
            added = _enqueue_download_models_locked(model_ids)
            snapshot = json.loads(json.dumps(_at._download_job))
            if runtime_job:
                snapshot["runtimeInstallJob"] = runtime_job
            snapshot["queued"] = added
            return snapshot
        job_id = str(uuid.uuid4())
        _at._download_job = {
            "id": job_id,
            "status": "queued",
            "cancelRequested": False,
            "modelIds": model_ids,
            "total": len(model_ids),
            "completed": 0,
            "failed": 0,
            "error": None,
            "createdAt": time.time(),
            "updatedAt": time.time(),
            "models": {
                model_id: {
                    "id": model_id,
                    "name": MODEL_REGISTRY[model_id]["name"],
                    "repoId": MODEL_REGISTRY[model_id]["repoId"],
                    "status": "queued",
                    "bytesDownloaded": 0,
                    "bytesTotal": _expected_download_total(model_id),
                    "current": "",
                    "error": None,
                    "updatedAt": time.time(),
                }
                for model_id in model_ids
            },
        }
        snapshot = json.loads(json.dumps(_at._download_job))
    if runtime_job:
        snapshot["runtimeInstallJob"] = runtime_job

    thread = threading.Thread(target=_run_model_download_job, args=(job_id,), daemon=True)
    thread.start()
    return snapshot


def _enqueue_download_models_locked(model_ids: list[str]) -> list[str]:
    """Add models to the running download job. Caller holds _download_lock."""
    if not _at._download_job:
        return []
    added: list[str] = []
    for model_id in model_ids:
        row = _at._download_job["models"].get(model_id)
        # Re-queue anything that is not already done or in flight, so retrying a
        # failed model is just another download click.
        if row and row.get("status") in {"queued", "running", "completed"}:
            continue
        if row and row.get("status") == "failed":
            _at._download_job["failed"] = max(0, int(_at._download_job.get("failed") or 0) - 1)
        _at._download_job["models"][model_id] = {
            "id": model_id,
            "name": MODEL_REGISTRY[model_id]["name"],
            "repoId": MODEL_REGISTRY[model_id]["repoId"],
            "status": "queued",
            "bytesDownloaded": 0,
            "bytesTotal": _expected_download_total(model_id),
            "current": "",
            "error": None,
            "updatedAt": time.time(),
        }
        if model_id not in _at._download_job["modelIds"]:
            _at._download_job["modelIds"].append(model_id)
        added.append(model_id)
    if added:
        _at._download_job["total"] = len(_at._download_job["modelIds"])
        _at._download_job["updatedAt"] = time.time()
    return added


def _ensure_download_runtime(model_ids: list[str]) -> dict | None:
    if not any(model_id in {"qwen_gguf_q4", "qwen_gguf_q8"} for model_id in model_ids):
        return None
    if _llama_cpp_importable():
        return None
    try:
        from .. import ai_runtime_installer

        return ai_runtime_installer.start_llama_cpp_install()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unable to start llama.cpp runtime install for GGUF download: %s", exc)
        return {"status": "failed", "error": str(exc), "message": "Unable to start llama.cpp runtime install"}


def download_all_model_ids() -> list[str]:
    opts = load_options()
    selected_semantic = _semantic_model_id(opts)
    ids: list[str] = []
    for model_id, meta in MODEL_REGISTRY.items():
        if meta.get("role") == "semantic":
            if model_id == selected_semantic:
                ids.append(model_id)
            continue
        if meta.get("downloadAll", True):
            ids.append(model_id)
    return ids


def _run_model_download_job(job_id: str) -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    token = huggingface_token()
    with _download_lock:
        if _at._download_job and _at._download_job.get("id") == job_id:
            _at._download_job["status"] = "running"
            _at._download_job["updatedAt"] = time.time()

    # Re-read the pending list every pass: start_model_download() can append
    # more models while this job is already running.
    while True:
        with _download_lock:
            if not _at._download_job or _at._download_job.get("id") != job_id:
                return
            if _at._download_job.get("cancelRequested"):
                _mark_download_job_cancelled_locked()
                return
            model_id = next(
                (
                    candidate
                    for candidate in _at._download_job["modelIds"]
                    if _at._download_job["models"].get(candidate, {}).get("status") == "queued"
                ),
                None,
            )
            if model_id is None:
                # Finish under the same lock the enqueuer uses, so a model added
                # right now either lands in this job (and is picked up above) or
                # sees a finished job and starts a fresh one. Never both.
                _at._download_job["status"] = "failed" if _at._download_job["failed"] else "completed"
                _at._download_job["updatedAt"] = time.time()
                _download_context["job_id"] = None
                _download_context["model_id"] = None
                return
        meta = MODEL_REGISTRY[model_id]
        _download_context["job_id"] = job_id
        _download_context["model_id"] = model_id
        with _download_lock:
            if not _at._download_job or _at._download_job.get("id") != job_id:
                return
            row = _at._download_job["models"][model_id]
            row["status"] = "running"
            row["current"] = "Starting download"
            row["updatedAt"] = time.time()
            _at._download_job["updatedAt"] = time.time()
        try:
            kwargs = {
                "repo_id": str(meta["repoId"]),
                "token": huggingface_token(),
                "allow_patterns": meta.get("allowPatterns"),
                "tqdm_class": _ProgressTqdm,
            }
            if meta.get("storage") == "local_files":
                local_dir = _qwen_gguf_dir(model_id)
                local_dir.mkdir(parents=True, exist_ok=True)
                kwargs["local_dir"] = str(local_dir)
                kwargs["max_workers"] = 1
            else:
                kwargs["cache_dir"] = _hf_cache_dir()
            with _download_lock:
                if _at._download_job and _at._download_job.get("id") == job_id:
                    row = _at._download_job["models"][model_id]
                    downloaded, total = _local_file_download_progress(model_id)
                    row["bytesDownloaded"] = max(int(row.get("bytesDownloaded") or 0), downloaded)
                    row["bytesTotal"] = max(int(row.get("bytesTotal") or 0), total)
                    if total:
                        row["current"] = "Fetching local model files"
                    row["updatedAt"] = time.time()
            snapshot_download(**kwargs)
            cache = model_cache_status(model_id)
            with _download_lock:
                if not _at._download_job or _at._download_job.get("id") != job_id:
                    return
                row = _at._download_job["models"][model_id]
                if _at._download_job.get("cancelRequested"):
                    row["status"] = "cancelled"
                    row["current"] = "Cancelled"
                    row["error"] = None
                    row["updatedAt"] = time.time()
                    _mark_download_job_cancelled_locked()
                    return
                row["status"] = "completed"
                row["downloaded"] = cache["downloaded"]
                row["files"] = cache["files"]
                row["current"] = "Downloaded"
                row["updatedAt"] = time.time()
                _at._download_job["completed"] += 1
                _at._download_job["updatedAt"] = time.time()
        except DownloadCancelled as exc:
            with _download_lock:
                if _at._download_job and _at._download_job.get("id") == job_id:
                    row = _at._download_job["models"].get(model_id)
                    if row:
                        row["status"] = "cancelled"
                        row["current"] = "Cancelled"
                        row["error"] = None
                        row["updatedAt"] = time.time()
                    _mark_download_job_cancelled_locked(str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("model download failed for %s: %s", model_id, exc)
            with _download_lock:
                if not _at._download_job or _at._download_job.get("id") != job_id:
                    return
                row = _at._download_job["models"][model_id]
                row["status"] = "failed"
                row["error"] = str(exc)
                row["updatedAt"] = time.time()
                _at._download_job["failed"] += 1
                _at._download_job["updatedAt"] = time.time()
        finally:
            _download_context["job_id"] = None
            _download_context["model_id"] = None


def _mark_download_job_cancelled_locked(message: str = "Model download cancelled") -> None:
    if not _at._download_job:
        return
    _at._download_job["status"] = "cancelled"
    _at._download_job["error"] = message
    _at._download_job["updatedAt"] = time.time()
    for row in _at._download_job.get("models", {}).values():
        if row.get("status") in {"queued", "running", "cancelling"}:
            row["status"] = "cancelled"
            row["current"] = "Cancelled"
            row["updatedAt"] = time.time()
