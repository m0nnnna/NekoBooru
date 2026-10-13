import re
import time
import uuid
import asyncio
import logging
import zipfile
import aiofiles
import httpx
import html as html_module
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import settings
from ..dependencies import get_current_user
from ..models import User
from ..services.media import check_ffmpeg_available
from ..services.pixiv_ugoira import convert_ugoira_zip_to_mp4, normalize_frames, validate_pixiv_ugoira_url
from . import uploads_fediverse, uploads_fetch
from .uploads_fediverse import (
    FediverseRequest,
    MISSKEY_FORKS,
    PLEROMA_FORKS,
    _detect_fediverse_platform,
    _fetch_misskey_attachments,
    _fetch_pleroma_attachments,
    _upload_from_fediverse_impl,
    upload_from_fediverse,
)
from .uploads_fetch import (
    BROWSER_USER_AGENT,
    COOKIES_FILENAME,
    DANBOORU_MEDIA_USER_AGENT,
    HONEST_MEDIA_USER_AGENT,
    MIME_TO_EXT,
    UrlFetchRequest,
    _PROGRESS_ID,
    _PROGRESS_TTL_SECONDS,
    _SANKAKU_FRONTEND_HOSTS,
    _active_downloads,
    _download_key,
    _fetch_progress,
    _is_danbooru_host,
    _is_e621_host,
    _is_sankaku_hotlink_placeholder,
    _is_sankaku_media_host,
    _media_referer,
    _media_user_agent,
    _normalize_fetch_url,
    _start_fetch_progress,
    from_url_progress,
    upload_from_url,
    upload_from_ytdlp,
    ytdlp_error_detail,
)

logger = logging.getLogger(__name__)


class PixivUgoiraRequest(BaseModel):
    url: str
    frames: list[dict]


class UploadAutoTagPreviewRequest(BaseModel):
    tags: list[str] = []
    safety: str = "safe"
    settings: dict = {}

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

# In-memory store for upload tokens (maps token -> temp file path)
# In production, you might want to use Redis or a database table
upload_tokens: dict[str, Path] = {}


def normalize_upload_extension(extension: str) -> str:
    """Map browser/OS JPEG variants to the app's canonical stored extension."""
    ext = (extension or "").lower()
    if ext == ".jfif":
        return ".jpg"
    return ext


@router.post("")
async def upload_file(content: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """
    Upload a file and get a token for creating a post.
    Compatible with szurubooru API.
    """
    # Validate file extension
    filename = content.filename or "unknown"
    extension = normalize_upload_extension(Path(filename).suffix.lower())

    if extension not in settings.allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"File type {extension} not allowed. Allowed types: {settings.allowed_extensions}",
        )

    # Generate unique token
    token = str(uuid.uuid4())

    # Save to temporary location
    temp_path = settings.uploads_dir / f"{token}{extension}"

    try:
        async with aiofiles.open(temp_path, "wb") as f:
            while chunk := await content.read(1024 * 1024):  # 1MB chunks
                await f.write(chunk)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")

    # Store token mapping
    upload_tokens[token] = temp_path

    return {"token": token}


def get_upload_path(token: str) -> Path | None:
    """Get the temporary file path for an upload token.

    ``upload_tokens`` is in-process, so a restart — a crash, an update, the dev
    server reloading on a file change — drops every pending token and the user
    sees "Invalid or expired content token" even though their file uploaded
    fine and is still sitting on disk. The temp file is named after the token,
    so recover it from the filesystem when the map has no entry.
    """
    path = upload_tokens.get(token)
    if path:
        return path

    # The token reaches the glob below, so only accept the UUIDs save_upload()
    # issues; anything else could try to escape the uploads directory.
    try:
        uuid.UUID(str(token))
    except (AttributeError, TypeError, ValueError):
        return None

    uploads_dir = Path(settings.uploads_dir)
    if not uploads_dir.is_dir():
        return None
    recovered = next((item for item in uploads_dir.glob(f"{token}.*") if item.is_file()), None)
    if recovered:
        upload_tokens[token] = recovered
    return recovered


def remove_upload_token(token: str):
    """Remove an upload token after processing."""
    upload_tokens.pop(token, None)


UPLOAD_MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}


@router.get("/{token}/content")
async def get_upload_content(token: str, current_user: User = Depends(get_current_user)):
    """Serve a pending upload's file.

    The browser extension cannot preview media it never had a playable URL for
    - anything routed through yt-dlp arrives as a page URL, which is why videos
    never appeared in the popup. Once the server has fetched the file it can
    hand it back, which also gives the popup something to scrub for frame
    selection. FileResponse answers Range requests, so seeking works.
    """
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")
    return FileResponse(
        temp_path,
        media_type=UPLOAD_MEDIA_TYPES.get(temp_path.suffix.lower(), "application/octet-stream"),
    )


@router.get("/{token}/auto-tags")
async def auto_tags_for_upload(token: str, current_user: User = Depends(get_current_user)):
    """Preview optional model tags for an uploaded token."""
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")

    from ..services.auto_tag_jobs import _tag_media_async

    # Off the event loop: inference takes seconds, and several extension popups
    # previewing at once would otherwise freeze the whole server, not just this
    # request.
    result = await _tag_media_async(temp_path, None)
    return {
        "enabled": result.enabled,
        "model": result.model,
        "tags": result.tags,
        "characterTags": result.character_tags,
        "rating": result.rating,
        "safety": result.safety,
        "error": result.error,
    }


async def _compute_auto_tag_preview(temp_path: Path, request: UploadAutoTagPreviewRequest, owner_id: int) -> dict:
    from ..services.auto_tag_jobs import _tag_media_async, merge_similar_post_tags
    from ..services.auto_tagger import load_options, merge_with_existing, promote_safety, validate_options
    from ..services.similarity import compute_dhash

    opts = validate_options({**load_options().__dict__, **(request.settings or {})})
    result = await _tag_media_async(temp_path, opts)

    if opts.enabled and opts.inheritSimilarTags:
        phash = await asyncio.to_thread(compute_dhash, temp_path)
        if phash:
            from ..database import async_session
            async with async_session() as db:
                await merge_similar_post_tags(db, result, phash, None, opts, owner_id=owner_id)

    merged_tags, categories = merge_with_existing(request.tags or [], result, opts)

    return {
        "postId": None,
        "existingTags": request.tags or [],
        "suggestedTags": merged_tags,
        "suggestedSafety": promote_safety(request.safety or "safe", result.safety, opts),
        "categories": categories,
        "evidence": result.evidence,
        "model": result.model,
        "error": result.error,
        "durationMs": result.duration_ms,
    }


@router.post("/{token}/auto-tags/preview")
async def preview_auto_tags_for_upload(
    token: str, request: UploadAutoTagPreviewRequest, current_user: User = Depends(get_current_user)
):
    """Preview AI tag suggestions for a temporary upload token without creating a post.

    Synchronous variant kept for backwards compatibility. Clients behind a
    reverse proxy should prefer the async start/poll endpoints below, since AI
    inference (video frames, Whisper, etc.) can exceed a proxy's gateway
    timeout and surface as an HTTP 504.
    """
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")
    return await _compute_auto_tag_preview(temp_path, request, current_user.id)


# Async AI-preview jobs. Inference runs in a background task so each HTTP
# request returns immediately; the client polls for the result. This avoids
# gateway 504s on long-running model runs (video/Whisper/Qwen) when the
# instance is reached through a reverse proxy or tunnel.
# job_id -> {status, result, error, created, task}
preview_jobs: dict[str, dict] = {}
PREVIEW_JOB_TTL_SECONDS = 900


def _prune_preview_jobs() -> None:
    now = time.time()
    stale = [
        jid for jid, job in preview_jobs.items()
        if now - job.get("created", now) > PREVIEW_JOB_TTL_SECONDS
    ]
    for jid in stale:
        preview_jobs.pop(jid, None)


async def _run_preview_job(job_id: str, temp_path: Path, request: UploadAutoTagPreviewRequest, owner_id: int) -> None:
    try:
        result = await _compute_auto_tag_preview(temp_path, request, owner_id)
        job = preview_jobs.get(job_id)
        if job is not None:
            job.update(status="completed", result=result)
    except Exception as exc:  # noqa: BLE001 - surfaced to the client via the job
        logger.warning("auto-tag preview job %s failed: %s", job_id, exc)
        job = preview_jobs.get(job_id)
        if job is not None:
            job.update(status="failed", error=str(exc))


@router.post("/{token}/auto-tags/preview/start")
async def start_preview_auto_tags_for_upload(
    token: str, request: UploadAutoTagPreviewRequest, current_user: User = Depends(get_current_user)
):
    """Kick off an AI tag preview in the background and return a job id to poll."""
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")

    _prune_preview_jobs()
    job_id = str(uuid.uuid4())
    job = {"status": "running", "result": None, "error": None, "created": time.time()}
    preview_jobs[job_id] = job
    # Hold a reference so the task is not garbage-collected mid-run.
    job["task"] = asyncio.create_task(_run_preview_job(job_id, temp_path, request, current_user.id))
    return {"jobId": job_id, "status": "running"}


@router.get("/auto-tags/preview-jobs/{job_id}")
async def get_preview_auto_tags_job(job_id: str, current_user: User = Depends(get_current_user)):
    """Poll an AI tag preview job started via the start endpoint."""
    job = preview_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Preview job not found or expired")
    return {
        "jobId": job_id,
        "status": job["status"],
        "result": job.get("result"),
        "error": job.get("error"),
    }


# Route order is part of matching; the parts' routes are included where they used to be.
router.include_router(uploads_fetch.router)


@router.post("/from-pixiv-ugoira")
async def upload_from_pixiv_ugoira(request: PixivUgoiraRequest, current_user: User = Depends(get_current_user)):
    """Download a trusted Pixiv ugoira frame ZIP and convert it to MP4."""
    try:
        url = validate_pixiv_ugoira_url(request.url)
        frames = normalize_frames(request.frames)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not check_ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg is required to import Pixiv animations")

    token = str(uuid.uuid4())
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    archive_path = settings.uploads_dir / f"{token}.ugoira.zip"
    output_path = settings.uploads_dir / f"{token}.mp4"
    max_download_bytes = 512 * 1024 * 1024
    try:
        timeout = httpx.Timeout(120.0, connect=20.0)
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            async with client.stream("GET", url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
                "Accept": "application/zip,application/octet-stream,*/*",
                "Referer": "https://www.pixiv.net/",
            }) as response:
                response.raise_for_status()
                validate_pixiv_ugoira_url(str(response.url))
                declared_size = int(response.headers.get("content-length") or 0)
                if declared_size > max_download_bytes:
                    raise HTTPException(status_code=413, detail="Pixiv animation archive is too large")
                downloaded = 0
                async with aiofiles.open(archive_path, "wb") as output:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        downloaded += len(chunk)
                        if downloaded > max_download_bytes:
                            raise HTTPException(status_code=413, detail="Pixiv animation archive is too large")
                        await output.write(chunk)

        await asyncio.to_thread(convert_ugoira_zip_to_mp4, archive_path, frames, output_path)
        upload_tokens[token] = output_path
        return {
            "token": token,
            "filename": f"pixiv-ugoira-{token}.mp4",
            "size": output_path.stat().st_size,
            "frameCount": len(frames),
            "url": url,
        }
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch Pixiv animation: HTTP {exc.response.status_code}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch Pixiv animation: {exc}") from exc
    except (ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        archive_path.unlink(missing_ok=True)
        if token not in upload_tokens:
            output_path.unlink(missing_ok=True)


router.include_router(uploads_fediverse.router)
