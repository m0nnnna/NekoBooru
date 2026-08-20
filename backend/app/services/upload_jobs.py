"""Durable upload jobs and precision remote clip processing."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import aiofiles
import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from ..config import settings
from ..database import async_session
from ..models import UploadArtifact, UploadJob
from .media import check_ffmpeg_available, get_video_info


JOB_TTL = timedelta(hours=24)
ACTIVE_STATES = {"probing", "sampling", "rendering", "publishing", "uploading", "downloading"}
TERMINAL_STATES = {"completed", "failed", "cancelled", "interrupted"}
SUPPORTED_HOSTS = {
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "rumble.com": "rumble",
    "odysee.com": "odysee",
    "lbry.tv": "odysee",
}
PROVIDER_EXTRACTORS = {
    "youtube": {"youtube", "youtube:clip"},
    "rumble": {"rumble", "rumbleembed"},
    "odysee": {"lbry"},
}

_tasks: dict[str, asyncio.Task] = {}
_cancel_events: dict[str, threading.Event] = {}
_subscribers: dict[str, set[asyncio.Queue]] = {}
_task_lock = asyncio.Lock()
_network_slots = asyncio.Semaphore(2)
_transcode_slots = asyncio.Semaphore(1)


class JobError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False, remediation: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.remediation = remediation

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "remediation": self.remediation,
        }


class JobCancelled(Exception):
    pass


def _dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _provider_for_url(raw_url: str) -> str:
    try:
        parsed = urlparse(raw_url.strip())
    except Exception as exc:
        raise JobError("invalid_url", "Enter a valid video URL.") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise JobError("invalid_url", "Only HTTP and HTTPS video URLs are supported.")
    host = parsed.hostname.lower().rstrip(".")
    if parse_qs(parsed.query).get("list"):
        raise JobError("playlist_not_supported", "Choose one video URL without a playlist parameter.")
    for suffix, provider in SUPPORTED_HOSTS.items():
        if host == suffix or host.endswith(f".{suffix}"):
            return provider
    raise JobError("unsupported_provider", "Clip editing supports YouTube, Rumble, and Odysee URLs.")


def validate_selection(start_ms: int, end_ms: int, duration_seconds: float) -> tuple[int, int]:
    try:
        start_ms = int(start_ms)
        end_ms = int(end_ms)
    except (TypeError, ValueError) as exc:
        raise JobError("invalid_selection", "Start and end times must be valid timecodes.") from exc
    duration_ms = round(float(duration_seconds) * 1000)
    if start_ms < 0 or end_ms <= start_ms:
        raise JobError("invalid_selection", "End time must be after start time.")
    if end_ms > duration_ms + 250:
        raise JobError("selection_out_of_bounds", "The selected end time is beyond the source duration.")
    clip_ms = end_ms - start_ms
    if clip_ms < 500:
        raise JobError("clip_too_short", "Clips must be at least 0.5 seconds long.")
    if clip_ms > 140_000:
        raise JobError("clip_too_long", "The X-compatible preset is limited to 140 seconds.")
    return start_ms, min(end_ms, duration_ms)


def _job_dir(job_id: str) -> Path:
    path = settings.cache_dir / "upload-jobs" / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def artifact_path(artifact: UploadArtifact) -> Path:
    root = settings.cache_dir.resolve()
    candidate = (root / artifact.relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise JobError("invalid_artifact", "Artifact path is invalid.") from exc
    return candidate


async def get_job(job_id: str) -> UploadJob | None:
    async with async_session() as session:
        result = await session.execute(
            select(UploadJob).options(selectinload(UploadJob.artifacts)).where(UploadJob.id == job_id)
        )
        return result.scalars().first()


async def snapshot(job_id: str) -> dict | None:
    job = await get_job(job_id)
    return job.to_dict() if job else None


async def _broadcast(job_id: str) -> None:
    payload = await snapshot(job_id)
    if payload is None:
        return
    for queue in list(_subscribers.get(job_id, set())):
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
                queue.put_nowait(payload)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass


async def subscribe(job_id: str):
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)
    _subscribers.setdefault(job_id, set()).add(queue)
    try:
        current = await snapshot(job_id)
        if current is not None:
            yield current
        while True:
            try:
                yield await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield None
    finally:
        listeners = _subscribers.get(job_id)
        if listeners is not None:
            listeners.discard(queue)
            if not listeners:
                _subscribers.pop(job_id, None)


async def update_job(job_id: str, **updates) -> None:
    async with async_session() as session:
        job = await session.get(UploadJob, job_id)
        if not job:
            return
        for key, value in updates.items():
            if key in {"source_metadata", "stages", "metrics", "error"}:
                setattr(job, f"{key}_json", _dumps(value) if value is not None else None)
            else:
                setattr(job, key, value)
        job.updated_at = datetime.utcnow()
        await session.commit()
    await _broadcast(job_id)


def _stages(operation: str) -> list[dict]:
    definitions = {
        "probe": [("validate", "Validate URL"), ("tools", "Check media tools"), ("metadata", "Read source metadata")],
        "sample": [("resolve", "Resolve formats"), ("download", "Download selected range"), ("proxy", "Encode preview"), ("thumbnails", "Build timeline"), ("waveform", "Build waveform"), ("verify", "Verify preview")],
        "render": [("resolve", "Resolve formats"), ("download", "Download selected range"), ("pass1", "Encode pass 1"), ("pass2", "Encode pass 2"), ("verify", "Verify final clip"), ("register", "Register artifact")],
        "upload": [("validate", "Validate local file"), ("transfer", "Upload file"), ("register", "Register upload")],
        "direct": [("resolve", "Resolve direct URL"), ("download", "Download media"), ("register", "Register upload")],
        "fediverse": [("resolve", "Resolve post"), ("attachments", "Discover attachments"), ("download", "Download attachments"), ("register", "Register uploads")],
        "publish": [("validate", "Validate reviewed clip"), ("hash", "Hash and duplicate check"), ("store", "Store media"), ("inspect", "Inspect media"), ("thumbnail", "Generate thumbnail"), ("phash", "Generate similarity hash"), ("ai", "Run optional AI tagging"), ("commit", "Commit post")],
    }
    return [
        {
            "id": key,
            "label": label,
            "state": "pending",
            "progress": 0,
            "detail": "",
            "startedAt": None,
            "completedAt": None,
        }
        for key, label in definitions[operation]
    ]


def completed_stages(operation: str) -> list[dict]:
    timestamp = datetime.utcnow().isoformat()
    return [
        {**stage, "state": "completed", "progress": 100, "startedAt": timestamp, "completedAt": timestamp}
        for stage in _stages(operation)
    ]


def _stage_progress(operation: str, stage_id: str, overall: int) -> int:
    ranges = {
        "probe": {"validate": (0, 10), "tools": (10, 20), "metadata": (20, 100)},
        "sample": {"resolve": (0, 10), "download": (10, 55), "proxy": (55, 75), "thumbnails": (75, 90), "waveform": (90, 95), "verify": (95, 100)},
        "render": {"resolve": (0, 5), "download": (5, 45), "pass1": (45, 65), "pass2": (65, 90), "verify": (90, 95), "register": (95, 100)},
        "publish": {"validate": (0, 15), "hash": (15, 25), "store": (25, 35), "inspect": (35, 45), "thumbnail": (45, 55), "phash": (55, 65), "ai": (65, 90), "commit": (90, 100)},
        "upload": {"validate": (0, 10), "transfer": (10, 90), "register": (90, 100)},
        "direct": {"resolve": (0, 10), "download": (10, 90), "register": (90, 100)},
        "fediverse": {"resolve": (0, 20), "attachments": (20, 30), "download": (30, 90), "register": (90, 100)},
    }
    start, end = ranges.get(operation, {}).get(stage_id, (0, 100))
    if end <= start:
        return 0
    return max(0, min(99, round((overall - start) / (end - start) * 100)))


async def set_progress(
    job_id: str,
    operation: str,
    stage_id: str,
    overall: int,
    detail: str,
    *,
    metrics: dict | None = None,
) -> None:
    job = await get_job(job_id)
    if not job:
        return
    stages = json.loads(job.stages_json or "[]")
    if job.operation != operation or not stages:
        stages = _stages(operation)
    current_index = next((i for i, stage in enumerate(stages) if stage["id"] == stage_id), 0)
    timestamp = datetime.utcnow().isoformat()
    for index, stage in enumerate(stages):
        if index < current_index:
            stage.update(state="completed", progress=100)
            stage["startedAt"] = stage.get("startedAt") or timestamp
            stage["completedAt"] = stage.get("completedAt") or timestamp
        elif index == current_index:
            stage.update(state="running", progress=max(stage.get("progress", 0), _stage_progress(operation, stage_id, overall)))
            stage["detail"] = detail
            stage["startedAt"] = stage.get("startedAt") or timestamp
    await update_job(
        job_id,
        operation=operation,
        stages=stages,
        overall_progress=max(job.overall_progress if job.operation == operation else 0, min(99, int(overall))),
        message=detail,
        metrics=metrics or json.loads(job.metrics_json or "{}"),
    )


def _cookie_file() -> str | None:
    path = settings.config_dir / "ytdlp_cookies.txt"
    return str(path) if path.exists() else None


def _probe_source(url: str, expected_provider: str) -> dict:
    try:
        import yt_dlp
    except ImportError as exc:
        raise JobError("ytdlp_missing", "yt-dlp is not installed.", remediation="Install or update yt-dlp in Settings.") from exc
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 30,
        "retries": 2,
        "extract_flat": False,
    }
    cookiefile = _cookie_file()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise JobError("probe_failed", f"Could not read this video: {exc}", retryable=True, remediation="Update yt-dlp or configure cookies in Settings.") from exc
    if not info or info.get("_type") in {"playlist", "multi_video"} or info.get("entries"):
        raise JobError("playlist_not_supported", "Choose one video, not a playlist or channel.")
    extractor = str(info.get("extractor") or info.get("extractor_key") or "").lower()
    if extractor not in PROVIDER_EXTRACTORS[expected_provider]:
        raise JobError("extractor_mismatch", "The URL did not resolve through the expected video provider.")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise JobError("live_not_supported", "Live and upcoming broadcasts cannot be clipped.")
    duration = info.get("duration")
    if not duration or not math.isfinite(float(duration)):
        raise JobError("duration_unknown", "The source does not expose a finite duration.")
    formats = info.get("formats") or []
    if formats and all(fmt.get("has_drm") for fmt in formats):
        raise JobError("drm_not_supported", "DRM-protected video cannot be processed.")
    requested_formats = info.get("requested_formats") or info.get("requested_downloads") or []
    safe_formats = [
        {
            "formatId": fmt.get("format_id"),
            "extension": fmt.get("ext"),
            "width": fmt.get("width"),
            "height": fmt.get("height"),
            "videoCodec": fmt.get("vcodec"),
            "audioCodec": fmt.get("acodec"),
        }
        for fmt in requested_formats
        if isinstance(fmt, dict)
    ]
    available_dimensions = sorted(
        {
            (int(fmt["width"]), int(fmt["height"]))
            for fmt in formats
            if fmt.get("vcodec") not in {None, "none"} and fmt.get("width") and fmt.get("height")
        },
        key=lambda item: item[0] * item[1],
    )
    canonical_url = info.get("webpage_url") or url
    if _provider_for_url(canonical_url) != expected_provider:
        raise JobError("redirect_host_mismatch", "The video redirected to an unsupported provider.")
    return {
        "provider": expected_provider,
        "extractor": extractor,
        "canonicalUrl": canonical_url,
        "title": info.get("title") or "video",
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": float(duration),
        "durationMs": round(float(duration) * 1000),
        "thumbnail": info.get("thumbnail"),
        "width": info.get("width"),
        "height": info.get("height"),
        "availableDimensions": [{"width": width, "height": height} for width, height in available_dimensions],
        "selectedFormats": safe_formats,
    }


async def create_remote_job(source_url: str, selection: dict | None, profile: str, idempotency_key: str | None) -> dict:
    provider = _provider_for_url(source_url)
    async with async_session() as session:
        if idempotency_key:
            existing = await session.execute(select(UploadJob).where(UploadJob.idempotency_key == idempotency_key))
            job = existing.scalars().first()
            if job:
                await session.refresh(job, ["artifacts"])
                return job.to_dict()
        job = UploadJob(
            kind="remote_clip",
            status="created",
            message="Created remote clip job",
            source_url=source_url.strip(),
            profile=profile,
            selection_start_ms=(selection or {}).get("startMs"),
            selection_end_ms=(selection or {}).get("endMs"),
            idempotency_key=idempotency_key,
            expires_at=datetime.utcnow() + JOB_TTL,
        )
        session.add(job)
        await session.commit()
        job_id = job.id
    await launch(job_id, "probe")
    result = await snapshot(job_id)
    assert result is not None
    return result


async def create_ingest_job(
    kind: str,
    source_url: str | None,
    filename: str | None,
    size: int | None,
    mime_type: str | None,
    idempotency_key: str | None,
) -> dict:
    if kind not in {"local", "direct_url", "fediverse"}:
        raise JobError("unsupported_job_kind", "Unsupported upload job kind.")
    if kind in {"direct_url", "fediverse"}:
        parsed = urlparse((source_url or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise JobError("invalid_url", "Enter a valid HTTP or HTTPS URL.")
    if kind == "local":
        clean_name = Path(filename or "upload.bin").name
        extension = clean_name.lower().endswith(".jfif") and ".jpg" or Path(clean_name).suffix.lower()
        if extension not in settings.allowed_extensions and extension != ".jpg":
            raise JobError("unsupported_file_type", "This local file type is not supported.")
        if size is not None and (size < 0 or size > settings.max_upload_size):
            raise JobError("upload_too_large", "The local file exceeds the configured upload limit.")
    else:
        clean_name = None

    async with async_session() as session:
        if idempotency_key:
            existing = await session.execute(select(UploadJob).where(UploadJob.idempotency_key == idempotency_key))
            job = existing.scalars().first()
            if job:
                await session.refresh(job, ["artifacts"])
                return job.to_dict()
        operation = "upload" if kind == "local" else "direct" if kind == "direct_url" else "fediverse"
        metadata = {"filename": clean_name, "size": size, "mimeType": mime_type} if kind == "local" else {}
        job = UploadJob(
            kind=kind,
            status="created",
            operation=operation,
            ready_for="content" if kind == "local" else None,
            message="Ready for file content" if kind == "local" else "Queued for import",
            source_url=(source_url or "").strip() or None,
            source_metadata_json=_dumps(metadata),
            stages_json=_dumps(_stages(operation)),
            idempotency_key=idempotency_key,
            expires_at=datetime.utcnow() + JOB_TTL,
        )
        session.add(job)
        await session.commit()
        job_id = job.id
    if kind == "direct_url":
        await launch(job_id, "direct")
    elif kind == "fediverse":
        await launch(job_id, "fediverse")
    result = await snapshot(job_id)
    assert result is not None
    return result


async def launch(job_id: str, operation: str) -> None:
    async with _task_lock:
        current = _tasks.get(job_id)
        if current and not current.done():
            raise JobError("job_busy", "This upload job is already running.")
        event = threading.Event()
        _cancel_events[job_id] = event
        runners = {
            "probe": _run_probe,
            "sample": _run_sample,
            "render": _run_render,
            "direct": _run_direct,
            "fediverse": _run_fediverse,
        }
        task = asyncio.create_task(runners[operation](job_id, event))
        _tasks[job_id] = task
        task.add_done_callback(lambda _task, jid=job_id: _task_finished(jid))


async def launch_custom(job_id: str, runner) -> None:
    async with _task_lock:
        current = _tasks.get(job_id)
        if current and not current.done():
            raise JobError("job_busy", "This upload job is already running.")
        event = threading.Event()
        _cancel_events[job_id] = event
        task = asyncio.create_task(runner(event))
        _tasks[job_id] = task
        task.add_done_callback(lambda _task, jid=job_id: _task_finished(jid))


def _task_finished(job_id: str) -> None:
    _tasks.pop(job_id, None)
    _cancel_events.pop(job_id, None)


async def _fail(job_id: str, exc: Exception) -> None:
    directory = settings.cache_dir / "upload-jobs" / job_id
    if directory.exists():
        for pattern in ("*.part*", "*.ytdl", "sample-source*", "render-source*", "x-pass*"):
            for partial in directory.glob(pattern):
                if partial.is_file():
                    partial.unlink(missing_ok=True)
    if isinstance(exc, JobCancelled):
        await update_job(job_id, status="cancelled", ready_for=None, overall_progress=100, message="Cancelled", error=None)
        return
    error = exc if isinstance(exc, JobError) else JobError("processing_failed", str(exc), retryable=True)
    await update_job(job_id, status="failed", ready_for=None, overall_progress=100, message=error.message, error=error.to_dict())


async def _run_probe(job_id: str, cancel: threading.Event) -> None:
    try:
        job = await get_job(job_id)
        if not job:
            return
        await update_job(job_id, status="probing", operation="probe", ready_for=None, overall_progress=0, stages=_stages("probe"), metrics={}, error=None, cancel_requested=False)
        await set_progress(job_id, "probe", "validate", 5, "Validating video URL")
        provider = _provider_for_url(job.source_url or "")
        if cancel.is_set():
            raise JobCancelled()
        await set_progress(job_id, "probe", "tools", 15, "Checking yt-dlp, FFmpeg, and FFprobe")
        if importlib.util.find_spec("yt_dlp") is None:
            raise JobError("ytdlp_missing", "yt-dlp is required.", remediation="Install or update yt-dlp in Settings.")
        if not check_ffmpeg_available() or shutil.which("ffprobe") is None:
            raise JobError("media_tools_missing", "FFmpeg and FFprobe are required.", remediation="Install FFmpeg and restart NekoBooru.")
        await set_progress(job_id, "probe", "metadata", 25, "Reading source metadata")
        async with _network_slots:
            metadata = await asyncio.to_thread(_probe_source, job.source_url or "", provider)
        if cancel.is_set():
            raise JobCancelled()
        next_status = "awaiting_selection"
        ready_for = "selection"
        updates = {
            "status": next_status,
            "ready_for": ready_for,
            "overall_progress": 100,
            "message": "Source ready — choose a clip range",
            "source_metadata": metadata,
            "stages": completed_stages("probe"),
        }
        await update_job(job_id, **updates)
        if job.selection_start_ms is not None and job.selection_end_ms is not None:
            validate_selection(job.selection_start_ms, job.selection_end_ms, metadata["duration"])
            await _run_sample(job_id, cancel)
    except Exception as exc:
        await _fail(job_id, exc)


def _media_extension(filename: str | None, content_type: str | None) -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    mime_extensions = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
    }
    extension = mime_extensions.get(mime) or Path(filename or "").suffix.lower()
    if extension == ".jpeg" or extension == ".jfif":
        extension = ".jpg"
    if extension not in settings.allowed_extensions:
        raise JobError("unsupported_file_type", "The imported media type is not supported.")
    return extension


async def store_local_content(job_id: str, stream, content_length: int | None) -> dict:
    job = await get_job(job_id)
    if not job:
        raise JobError("job_not_found", "Upload job not found.")
    if job.kind != "local" or job.status != "created":
        raise JobError("content_not_allowed", "This job is not waiting for local file content.")
    metadata = json.loads(job.source_metadata_json or "{}")
    expected_size = int(metadata.get("size") or 0)
    if content_length is not None and content_length > settings.max_upload_size:
        raise JobError("upload_too_large", "The local file exceeds the configured upload limit.")
    extension = _media_extension(metadata.get("filename"), metadata.get("mimeType"))
    directory = _job_dir(job_id)
    part = directory / f"source.part{extension}"
    final = directory / f"source{extension}"
    transferred = 0
    last_emit = 0.0
    cancel_event = threading.Event()
    _cancel_events[job_id] = cancel_event
    await update_job(job_id, status="uploading", operation="upload", ready_for=None, stages=_stages("upload"), overall_progress=0, message="Validating local file", error=None)
    await set_progress(job_id, "upload", "validate", 5, "Validating local file")
    try:
        async with aiofiles.open(part, "wb") as handle:
            async for chunk in stream:
                if cancel_event.is_set():
                    raise JobCancelled()
                if not chunk:
                    continue
                transferred += len(chunk)
                if transferred > settings.max_upload_size:
                    raise JobError("upload_too_large", "The local file exceeds the configured upload limit.")
                await handle.write(chunk)
                now = time.monotonic()
                if now - last_emit >= 0.25:
                    last_emit = now
                    total = content_length or expected_size or 0
                    percent = min(99, int(transferred / total * 100)) if total else 1
                    await set_progress(
                        job_id,
                        "upload",
                        "transfer",
                        10 + int(percent * 0.8),
                        "Uploading local file",
                        metrics={"downloadedBytes": transferred, "totalBytes": total or None},
                    )
        if transferred == 0:
            raise JobError("empty_upload", "The uploaded file is empty.")
        if expected_size and transferred != expected_size:
            raise JobError("upload_size_mismatch", "The uploaded byte count does not match the declared file size.", retryable=True)
        await set_progress(job_id, "upload", "register", 95, "Registering local upload")
        part.replace(final)
        await _register_artifact(
            job_id,
            "source",
            final,
            Path(metadata.get("filename") or f"upload{extension}").name,
            {"mimeType": metadata.get("mimeType") or mimetypes.guess_type(final.name)[0]},
        )
        await update_job(job_id, status="content_ready", ready_for="publish", overall_progress=100, message="Local file ready", stages=completed_stages("upload"), metrics={"downloadedBytes": transferred, "totalBytes": transferred})
    except Exception as exc:
        part.unlink(missing_ok=True)
        await _fail(job_id, exc)
        if isinstance(exc, JobError):
            raise
        if isinstance(exc, JobCancelled):
            raise JobError("cancelled", "Upload was cancelled.") from exc
        raise JobError("upload_failed", str(exc), retryable=True) from exc
    finally:
        _cancel_events.pop(job_id, None)
    result = await snapshot(job_id)
    assert result is not None
    return result


async def _run_direct(job_id: str, cancel: threading.Event) -> None:
    part: Path | None = None
    try:
        job = await get_job(job_id)
        if not job:
            return
        await update_job(job_id, status="downloading", operation="direct", ready_for=None, stages=_stages("direct"), overall_progress=0, message="Resolving direct media URL", error=None, cancel_requested=False)
        await set_progress(job_id, "direct", "resolve", 5, "Resolving direct media URL")
        directory = _job_dir(job_id)
        async with _network_slots:
            async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
                async with client.stream("GET", job.source_url or "", headers={"User-Agent": "NekoBooru/4 remote-ingest", "Accept": "image/*,video/*,*/*"}) as response:
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0]
                    extension = _media_extension(urlparse(str(response.url)).path, content_type)
                    total = int(response.headers.get("content-length") or 0)
                    if total > settings.max_upload_size:
                        raise JobError("upload_too_large", "The remote file exceeds the configured upload limit.")
                    part = directory / f"source.part{extension}"
                    final = directory / f"source{extension}"
                    transferred = 0
                    await set_progress(job_id, "direct", "download", 10, "Downloading remote media")
                    async with aiofiles.open(part, "wb") as handle:
                        async for chunk in response.aiter_bytes(256 * 1024):
                            if cancel.is_set():
                                raise JobCancelled()
                            transferred += len(chunk)
                            if transferred > settings.max_upload_size:
                                raise JobError("upload_too_large", "The remote file exceeds the configured upload limit.")
                            await handle.write(chunk)
                            percent = min(99, int(transferred / total * 100)) if total else 1
                            await set_progress(job_id, "direct", "download", 10 + int(percent * 0.8), "Downloading remote media", metrics={"downloadedBytes": transferred, "totalBytes": total or None})
        if transferred == 0:
            raise JobError("empty_download", "The remote server returned an empty file.")
        await set_progress(job_id, "direct", "register", 95, "Registering remote upload")
        part.replace(final)
        filename = Path(urlparse(job.source_url or "").path).name or f"download{extension}"
        await _register_artifact(job_id, "source", final, filename, {"mimeType": content_type, "sourceUrl": str(response.url)})
        await update_job(job_id, status="content_ready", ready_for="publish", overall_progress=100, message="Remote media ready", source_metadata={"canonicalUrl": str(response.url), "filename": filename, "mimeType": content_type}, stages=completed_stages("direct"), metrics={"downloadedBytes": transferred, "totalBytes": total or transferred})
    except Exception as exc:
        if part:
            part.unlink(missing_ok=True)
        await _fail(job_id, exc)


async def _run_fediverse(job_id: str, cancel: threading.Event) -> None:
    pending_tokens: set[str] = set()
    try:
        job = await get_job(job_id)
        if not job:
            return
        await update_job(job_id, status="downloading", operation="fediverse", ready_for=None, stages=_stages("fediverse"), overall_progress=0, message="Resolving Fediverse post", error=None, cancel_requested=False)
        await set_progress(job_id, "fediverse", "resolve", 5, "Resolving Fediverse post")
        from ..routers import uploads

        async with _network_slots:
            result = await uploads.upload_from_fediverse(uploads.FediverseRequest(url=job.source_url or ""))
        if cancel.is_set():
            raise JobCancelled()
        imported = result.get("uploads") or []
        pending_tokens = {item.get("token") for item in imported if item.get("token")}
        await set_progress(job_id, "fediverse", "attachments", 30, f"Found {len(imported)} attachment(s)")
        directory = _job_dir(job_id)
        for index, item in enumerate(imported, start=1):
            token = item.get("token")
            source_path = uploads.get_upload_path(token)
            if not source_path or not source_path.exists():
                raise JobError("attachment_missing", "A resolved Fediverse attachment was unavailable.", retryable=True)
            extension = _media_extension(item.get("filename"), mimetypes.guess_type(source_path.name)[0])
            final = directory / f"source-{index}{extension}"
            source_path.replace(final)
            uploads.remove_upload_token(token)
            pending_tokens.discard(token)
            await set_progress(job_id, "fediverse", "download", 30 + int(index / len(imported) * 55), f"Downloaded attachment {index} of {len(imported)}")
            await _register_artifact(job_id, "source", final, Path(item.get("filename") or final.name).name, {"mimeType": mimetypes.guess_type(final.name)[0], "attachmentIndex": index})
        await set_progress(job_id, "fediverse", "register", 95, "Registering Fediverse media")
        await update_job(job_id, status="content_ready", ready_for="publish", overall_progress=100, message=f"{len(imported)} attachment(s) ready", source_metadata={"canonicalUrl": result.get("source") or job.source_url, "tags": result.get("tags") or [], "title": result.get("title"), "platform": result.get("platform")}, stages=completed_stages("fediverse"), metrics={"attachmentCount": len(imported)})
    except Exception as exc:
        await _fail(job_id, exc)
    finally:
        if pending_tokens:
            from ..routers import uploads

            for token in pending_tokens:
                source_path = uploads.get_upload_path(token)
                if source_path:
                    source_path.unlink(missing_ok=True)
                uploads.remove_upload_token(token)


def _safe_title(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _-]+", "", value or "video").strip()
    return re.sub(r"\s+", "_", cleaned)[:80] or "video"


def x_video_filter(landscape: bool) -> str:
    max_width, max_height = (1280, 720) if landscape else (720, 1280)
    return (
        f"scale=w='min(iw,{max_width})':h='min(ih,{max_height})':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2,"
        "pad=w='max(iw,ceil(ih/3/2)*2)':h='max(ih,ceil(iw/3/2)*2)':"
        "x='(ow-iw)/2':y='(oh-ih)/2':color=black,fps=30,setsar=1,format=yuv420p"
    )


def _download_section(
    url: str,
    dest_dir: Path,
    prefix: str,
    start_seconds: float,
    end_seconds: float,
    max_height: int,
    cancel: threading.Event,
    progress,
) -> Path:
    try:
        import yt_dlp
    except ImportError as exc:
        raise JobError("ytdlp_missing", "yt-dlp is not installed.") from exc
    for old in dest_dir.glob(f"{prefix}*"):
        if old.is_file():
            old.unlink(missing_ok=True)

    last_emit = 0.0

    def hook(data):
        nonlocal last_emit
        if cancel.is_set():
            raise JobCancelled()
        now = time.monotonic()
        if data.get("status") == "downloading" and now - last_emit >= 0.2:
            last_emit = now
            downloaded = int(data.get("downloaded_bytes") or 0)
            total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
            percent = int(downloaded / total * 100) if total else 1
            progress(percent, {
                "downloadedBytes": downloaded,
                "totalBytes": total or None,
                "speedBytesPerSec": data.get("speed"),
                "etaSeconds": data.get("eta"),
            })

    opts = {
        "format": f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best",
        "outtmpl": str(dest_dir / f"{prefix}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "force_keyframes_at_cuts": True,
        "download_ranges": lambda _info, _ydl: [{"start_time": start_seconds, "end_time": end_seconds}],
        "progress_hooks": [hook],
        "socket_timeout": 30,
        "retries": 2,
    }
    cookiefile = _cookie_file()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except JobCancelled:
        raise
    except Exception as exc:
        raise JobError("range_download_failed", f"Could not download the selected range: {exc}", retryable=True, remediation="Update yt-dlp or configure cookies in Settings.") from exc
    candidates = [path for path in dest_dir.glob(f"{prefix}.*") if path.is_file() and path.suffix not in {".part", ".ytdl"}]
    if not candidates:
        raise JobError("range_download_missing", "The range download finished without a media file.", retryable=True)
    result = max(candidates, key=lambda item: item.stat().st_size)
    downloaded_info = get_video_info(result)
    downloaded_duration = float(downloaded_info.get("duration") or 0)
    requested_duration = end_seconds - start_seconds
    if downloaded_duration <= 0 or downloaded_duration > requested_duration + 2:
        result.unlink(missing_ok=True)
        raise JobError(
            "range_sampling_unsupported",
            "This source does not support bounded range sampling.",
            remediation="Download a short source manually and upload it as a local file.",
        )
    if result.stat().st_size > 1024 * 1024 * 1024:
        result.unlink(missing_ok=True)
        raise JobError("range_too_large", "The selected range exceeded the 1 GB processing limit.")
    return result


def _run_ffmpeg(cmd: list[str], duration: float, cancel: threading.Event, progress) -> None:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    output: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            output.append(line)
            if len(output) > 200:
                output.pop(0)
            if cancel.is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                raise JobCancelled()
            key, _, value = line.strip().partition("=")
            if key in {"out_time_ms", "out_time_us"} and duration > 0:
                try:
                    seconds = int(value) / 1_000_000
                    progress(min(99, int(seconds / duration * 100)), {"processedMs": round(seconds * 1000), "totalMs": round(duration * 1000)})
                except ValueError:
                    pass
        code = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    if code != 0:
        raise JobError("ffmpeg_failed", "FFmpeg could not process the selected clip.", retryable=True, remediation="Review the backend log and media-tool diagnostics.")


def _ffmpeg_progress_bridge(loop, job_id, operation, stage, base, span):
    last = {"value": -1}

    def emit(percent: int, metrics: dict):
        overall = base + int(max(0, min(100, percent)) / 100 * span)
        if overall <= last["value"]:
            return
        last["value"] = overall
        if stage in {"pass1", "pass2"}:
            metrics = {**metrics, "encodingPass": 1 if stage == "pass1" else 2}
        asyncio.run_coroutine_threadsafe(set_progress(job_id, operation, stage, overall, f"{stage.replace('_', ' ').title()} {percent}%", metrics=metrics), loop)

    return emit


async def _remove_artifacts(job_id: str, roles: set[str]) -> None:
    async with async_session() as session:
        result = await session.execute(select(UploadArtifact).where(UploadArtifact.job_id == job_id, UploadArtifact.role.in_(roles)))
        for artifact in result.scalars().all():
            artifact_path(artifact).unlink(missing_ok=True)
            await session.delete(artifact)
        await session.commit()


async def _register_artifact(job_id: str, role: str, path: Path, filename: str, metadata: dict) -> UploadArtifact:
    root = settings.cache_dir.resolve()
    relative = str(path.resolve().relative_to(root)).replace("\\", "/")
    expires = datetime.utcnow() + JOB_TTL
    digest = sha256_file(path)

    async with async_session() as session:
        artifact = UploadArtifact(
            job_id=job_id,
            role=role,
            relative_path=relative,
            filename=filename,
            mime_type=metadata.get("mimeType") or ("image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
            file_size=path.stat().st_size,
            sha256=digest,
            width=metadata.get("width"),
            height=metadata.get("height"),
            duration=metadata.get("duration"),
            metadata_json=_dumps(metadata),
            expires_at=expires,
        )
        session.add(artifact)
        await session.commit()
        await session.refresh(artifact)
        return artifact


def sha256_file(path: Path) -> str:
    digest_hash = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest_hash.update(chunk)
    return digest_hash.hexdigest()


def _verify_video(path: Path, expected_duration: float, *, strict_x: bool = False) -> dict:
    info = get_video_info(path)
    duration = float(info.get("duration") or 0)
    if not info.get("width") or not info.get("height") or duration <= 0:
        raise JobError("verification_failed", "Rendered clip has invalid video metadata.")
    if abs(duration - expected_duration) > max(0.05, 1 / max(float(info.get("frameRate") or 30), 1)):
        raise JobError("duration_mismatch", "Rendered duration does not match the reviewed selection.")
    if strict_x:
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
        frame_rate = float(info.get("frameRate") or 0)
        profile = str(info.get("profile") or "").lower()
        if info.get("codec") != "h264" or "high" not in profile:
            raise JobError("x_codec_mismatch", "Final video is not H.264 High Profile.")
        if info.get("pixelFormat") != "yuv420p" or info.get("fieldOrder") not in {"progressive", "unknown", None}:
            raise JobError("x_scan_mismatch", "Final video is not progressive YUV 4:2:0.")
        if width <= 0 or height <= 0 or width % 2 or height % 2 or abs(frame_rate - 30) > 0.01:
            raise JobError("x_dimensions_mismatch", "Final dimensions or frame rate are incompatible with X.")
        if (width >= height and (width > 1280 or height > 720)) or (height > width and (width > 720 or height > 1280)):
            raise JobError("x_dimensions_mismatch", "Final dimensions exceed the X standard preset.")
        ratio = width / height
        if ratio < 1 / 3 or ratio > 3:
            raise JobError("x_aspect_mismatch", "Final aspect ratio is outside X limits.")
        if info.get("audioCodec") not in {None, "aac"} or int(info.get("audioChannels") or 0) > 2:
            raise JobError("x_audio_mismatch", "Final audio is not AAC-LC mono/stereo.")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=format_name:stream=codec_type,sample_aspect_ratio", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        try:
            details = json.loads(probe.stdout) if probe.returncode == 0 else {}
        except json.JSONDecodeError:
            details = {}
        format_names = str(details.get("format", {}).get("format_name") or "").split(",")
        video_stream = next((stream for stream in details.get("streams", []) if stream.get("codec_type") == "video"), {})
        if "mp4" not in format_names or video_stream.get("sample_aspect_ratio") not in {"1:1", None}:
            raise JobError("x_container_mismatch", "Final media is not square-pixel MP4.")
    decode = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", os.devnull], capture_output=True, timeout=max(60, int(duration * 3)))
    if decode.returncode != 0:
        raise JobError("decode_failed", "Rendered clip failed the complete decode check.")
    if path.stat().st_size > min(settings.max_upload_size, 512 * 1024 * 1024):
        raise JobError("output_too_large", "Rendered clip exceeds the configured upload limit.")
    return info


async def request_sample(job_id: str, start_ms: int, end_ms: int, revision: int) -> dict:
    job = await get_job(job_id)
    if not job:
        raise JobError("job_not_found", "Upload job not found.")
    if revision != job.revision:
        raise JobError("stale_revision", "The editor changed; refresh before sampling again.")
    source = json.loads(job.source_metadata_json or "{}")
    start_ms, end_ms = validate_selection(start_ms, end_ms, source.get("duration") or 0)
    await _remove_artifacts(job_id, {"sample", "timeline", "waveform", "render"})
    await update_job(job_id, selection_start_ms=start_ms, selection_end_ms=end_ms, revision=job.revision + 1, status="awaiting_selection", ready_for=None)
    await launch(job_id, "sample")
    result = await snapshot(job_id)
    assert result is not None
    return result


async def _run_sample(job_id: str, cancel: threading.Event) -> None:
    try:
        job = await get_job(job_id)
        if not job:
            return
        source = json.loads(job.source_metadata_json or "{}")
        start_ms, end_ms = validate_selection(job.selection_start_ms, job.selection_end_ms, source.get("duration") or 0)
        context_start = max(0, start_ms - 5000)
        context_end = min(source["durationMs"], end_ms + 5000)
        duration = (context_end - context_start) / 1000
        loop = asyncio.get_running_loop()
        directory = _job_dir(job_id)
        await update_job(job_id, status="sampling", operation="sample", ready_for=None, overall_progress=0, stages=_stages("sample"), metrics={}, error=None, cancel_requested=False)
        await set_progress(job_id, "sample", "resolve", 5, "Resolving preview formats")
        await set_progress(job_id, "sample", "download", 10, "Downloading bounded preview range")
        async with _network_slots:
            downloaded = await asyncio.to_thread(
                _download_section,
                job.source_url or "",
                directory,
                "sample-source",
                context_start / 1000,
                context_end / 1000,
                480,
                cancel,
                _ffmpeg_progress_bridge(loop, job_id, "sample", "download", 10, 45),
            )
        preview_part = directory / "sample.part.mp4"
        preview_path = directory / "sample.mp4"
        preview_part.unlink(missing_ok=True)
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(downloaded),
            "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", str(preview_part),
        ]
        async with _transcode_slots:
            await asyncio.to_thread(_run_ffmpeg, cmd, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "sample", "proxy", 55, 20))
            timeline = directory / "timeline.jpg"
            await set_progress(job_id, "sample", "thumbnails", 75, "Generating timeline thumbnails")
            fps = max(0.01, 12 / max(duration, 0.5))
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(preview_part), "-vf", f"fps={fps},scale=160:-2,tile=12x1", "-frames:v", "1", str(timeline)], check=True, timeout=120)
            waveform = directory / "waveform.jpg"
            await set_progress(job_id, "sample", "waveform", 90, "Generating audio waveform")
            wave = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(preview_part), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x160:colors=#6aadde", "-frames:v", "1", str(waveform)], capture_output=True, timeout=120)
            await set_progress(job_id, "sample", "verify", 95, "Verifying preview")
            info = _verify_video(preview_part, duration)
            preview_part.replace(preview_path)
        info.update({"contextStartMs": context_start, "contextEndMs": context_end, "selectionStartMs": start_ms, "selectionEndMs": end_ms})
        await _register_artifact(job_id, "sample", preview_path, "clip-preview.mp4", info)
        await _register_artifact(job_id, "timeline", timeline, "timeline.jpg", {})
        if wave.returncode == 0 and waveform.exists():
            await _register_artifact(job_id, "waveform", waveform, "waveform.jpg", {})
        downloaded.unlink(missing_ok=True)
        await update_job(job_id, status="sample_ready", ready_for="render", overall_progress=100, message="Preview ready", stages=completed_stages("sample"), metrics={})
    except Exception as exc:
        await _fail(job_id, exc)


async def request_render(job_id: str, revision: int, profile: str) -> dict:
    job = await get_job(job_id)
    if not job:
        raise JobError("job_not_found", "Upload job not found.")
    if revision != job.revision:
        raise JobError("stale_revision", "The sampled selection changed; render the latest revision.")
    if job.status != "sample_ready":
        raise JobError("preview_required", "Review a sampled preview before rendering.")
    if profile != "x-standard":
        raise JobError("unsupported_profile", "Only the x-standard profile is available.")
    await _remove_artifacts(job_id, {"render"})
    await launch(job_id, "render")
    result = await snapshot(job_id)
    assert result is not None
    return result


async def _run_render(job_id: str, cancel: threading.Event) -> None:
    try:
        job = await get_job(job_id)
        if not job:
            return
        source = json.loads(job.source_metadata_json or "{}")
        start_ms, end_ms = validate_selection(job.selection_start_ms, job.selection_end_ms, source.get("duration") or 0)
        pad_start = max(0, start_ms - 3000)
        pad_end = min(source["durationMs"], end_ms + 3000)
        offset = (start_ms - pad_start) / 1000
        duration = (end_ms - start_ms) / 1000
        loop = asyncio.get_running_loop()
        directory = _job_dir(job_id)
        await update_job(job_id, status="rendering", operation="render", ready_for=None, overall_progress=0, stages=_stages("render"), metrics={}, error=None, cancel_requested=False)
        await set_progress(job_id, "render", "resolve", 3, "Resolving fresh source formats")
        await set_progress(job_id, "render", "download", 5, "Downloading bounded render range")
        async with _network_slots:
            downloaded = await asyncio.to_thread(
                _download_section,
                job.source_url or "",
                directory,
                "render-source",
                pad_start / 1000,
                pad_end / 1000,
                1080,
                cancel,
                _ffmpeg_progress_bridge(loop, job_id, "render", "download", 5, 40),
            )
        landscape = int(source.get("width") or 16) >= int(source.get("height") or 9)
        vf = x_video_filter(landscape)
        passlog = directory / "x-pass"
        common = ["-ss", f"{offset:.3f}", "-t", f"{duration:.3f}", "-i", str(downloaded), "-map", "0:v:0", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", "5000k", "-maxrate", "8000k", "-bufsize", "10000k", "-g", "90", "-keyint_min", "45", "-x264-params", "open-gop=0:scenecut=40", "-flags", "+cgop", "-passlogfile", str(passlog)]
        pass1 = ["ffmpeg", "-y", "-hide_banner", "-nostats", *common, "-an", "-pass", "1", "-f", "mp4", "-progress", "pipe:1", os.devnull]
        async with _transcode_slots:
            await asyncio.to_thread(_run_ffmpeg, pass1, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "render", "pass1", 45, 20))
            final_part = directory / "final.part.mp4"
            final_path = directory / "final.mp4"
            final_part.unlink(missing_ok=True)
            pass2 = ["ffmpeg", "-y", "-hide_banner", "-nostats", *common, "-map", "0:a:0?", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2", "-pass", "2", "-movflags", "+faststart", "-progress", "pipe:1", str(final_part)]
            await asyncio.to_thread(_run_ffmpeg, pass2, duration, cancel, _ffmpeg_progress_bridge(loop, job_id, "render", "pass2", 65, 25))
            await set_progress(job_id, "render", "verify", 92, "Verifying final clip")
            info = _verify_video(final_part, duration, strict_x=True)
            final_part.replace(final_path)
        await set_progress(job_id, "render", "register", 98, "Registering reviewed artifact")
        title = _safe_title(source.get("title") or "video")
        def filename_time(milliseconds: int) -> str:
            seconds = milliseconds // 1000
            hours, seconds = divmod(seconds, 3600)
            minutes, seconds = divmod(seconds, 60)
            prefix = f"{hours}h" if hours else ""
            return f"{prefix}{minutes}m{seconds:02d}s"

        filename = f"{title}_{filename_time(start_ms)}-{filename_time(end_ms)}.mp4"
        info.update({"profile": "x-standard", "selectionStartMs": start_ms, "selectionEndMs": end_ms, "xCompatible": True})
        await _register_artifact(job_id, "render", final_path, filename, info)
        downloaded.unlink(missing_ok=True)
        for log in directory.glob("x-pass*"):
            log.unlink(missing_ok=True)
        await update_job(job_id, status="render_ready", ready_for="publish", overall_progress=100, message="Final clip ready for review", stages=completed_stages("render"), metrics={})
    except Exception as exc:
        await _fail(job_id, exc)


async def cancel(job_id: str) -> dict:
    job = await get_job(job_id)
    if not job:
        raise JobError("job_not_found", "Upload job not found.")
    event = _cancel_events.get(job_id)
    if event:
        event.set()
        await update_job(job_id, cancel_requested=True, message="Cancelling…")
    elif job.status in ACTIVE_STATES:
        await _fail(job_id, JobCancelled())
    else:
        raise JobError("cancel_not_allowed", "This upload job is not active.")
    result = await snapshot(job_id)
    assert result is not None
    return result


async def retry(job_id: str) -> dict:
    job = await get_job(job_id)
    if not job:
        raise JobError("job_not_found", "Upload job not found.")
    if job.status not in {"failed", "cancelled", "interrupted"}:
        raise JobError("retry_not_allowed", "Only failed, cancelled, or interrupted jobs can be retried.")
    operation = job.operation or "probe"
    if operation == "publish":
        stable_status = "render_ready" if job.kind == "remote_clip" else "content_ready"
        await update_job(job_id, status=stable_status, operation=None, ready_for="publish", overall_progress=100, message="Ready to retry publication", stages=[], metrics={}, error=None, cancel_requested=False)
        result = await snapshot(job_id)
        assert result is not None
        return result
    if job.kind == "local":
        await update_job(job_id, status="created", operation="upload", ready_for="content", overall_progress=0, message="Ready for file content", stages=_stages("upload"), metrics={}, error=None, cancel_requested=False)
        result = await snapshot(job_id)
        assert result is not None
        return result
    if operation not in {"probe", "sample", "render", "direct", "fediverse"}:
        operation = "probe"
    await launch(job_id, operation)
    result = await snapshot(job_id)
    assert result is not None
    return result


async def delete_job(job_id: str) -> None:
    job = await get_job(job_id)
    if not job:
        return
    if job.status in ACTIVE_STATES:
        raise JobError("job_busy", "Cancel the active job before removing it.")
    directory = settings.cache_dir / "upload-jobs" / job_id
    if directory.exists():
        shutil.rmtree(directory, ignore_errors=True)
    async with async_session() as session:
        await session.execute(delete(UploadJob).where(UploadJob.id == job_id))
        await session.commit()
    await _broadcast(job_id)


async def recover_and_cleanup(*, recover_active: bool = True) -> None:
    now = datetime.utcnow()
    interrupted_ids: list[str] = []
    async with async_session() as session:
        if recover_active:
            active = await session.execute(select(UploadJob).where(UploadJob.status.in_(ACTIVE_STATES)))
            for job in active.scalars().all():
                interrupted_ids.append(job.id)
                job.status = "interrupted"
                job.message = "Interrupted by application restart"
                job.error_json = _dumps(JobError("interrupted", "Processing was interrupted by an application restart.", retryable=True).to_dict())
        expired = await session.execute(select(UploadJob).where(UploadJob.expires_at.is_not(None), UploadJob.expires_at < now))
        expired_ids = [job.id for job in expired.scalars().all()]
        await session.commit()
    for job_id in interrupted_ids:
        directory = settings.cache_dir / "upload-jobs" / job_id
        if directory.exists():
            for pattern in ("*.part*", "*.ytdl", "sample-source*", "render-source*", "x-pass*"):
                for partial in directory.glob(pattern):
                    if partial.is_file():
                        partial.unlink(missing_ok=True)
    for job_id in expired_ids:
        directory = settings.cache_dir / "upload-jobs" / job_id
        if directory.exists():
            shutil.rmtree(directory, ignore_errors=True)
        async with async_session() as session:
            await session.execute(delete(UploadJob).where(UploadJob.id == job_id))
            await session.commit()


async def cleanup_loop() -> None:
    """Run bounded cache cleanup for the lifetime of the backend."""
    while True:
        await asyncio.sleep(60 * 60)
        await recover_and_cleanup(recover_active=False)
