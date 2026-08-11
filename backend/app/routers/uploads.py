import re
import time
import uuid
import asyncio
import logging
import aiofiles
import httpx
import html as html_module
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import settings

logger = logging.getLogger(__name__)

# Fixed path for cookies file in config directory (matches settings.py)
COOKIES_FILENAME = "ytdlp_cookies.txt"

MISSKEY_FORKS = {"misskey", "calckey", "firefish", "catodon", "iceshrimp", "sharkey", "foundkey", "magnetar"}
PLEROMA_FORKS = {"pleroma", "akkoma"}


class UrlFetchRequest(BaseModel):
    url: str
    cookies: str | None = None
    referer: str | None = None


class FediverseRequest(BaseModel):
    url: str


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
async def upload_file(content: UploadFile = File(...)):
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


def ytdlp_error_detail(message: str, url: str, raw_error: str = "") -> dict:
    parsed = urlparse(url)
    try:
        import yt_dlp

        version = getattr(yt_dlp.version, "__version__", "unknown")
    except Exception:
        version = "not installed"
    return {
        "message": message,
        "host": parsed.netloc,
        "path": parsed.path or "/",
        "ytDlpVersion": version,
        "hint": "Try updating yt-dlp, uploading cookies for login-gated sites, or right-clicking the actual media element instead of the page.",
        "rawError": raw_error[:1000],
    }


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
async def get_upload_content(token: str):
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
async def auto_tags_for_upload(token: str):
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


async def _compute_auto_tag_preview(temp_path: Path, request: UploadAutoTagPreviewRequest) -> dict:
    from ..services.auto_tag_jobs import _tag_media_async
    from ..services.auto_tagger import load_options, merge_with_existing, promote_safety, validate_options

    opts = validate_options({**load_options().__dict__, **(request.settings or {})})
    result = await _tag_media_async(temp_path, opts)
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
async def preview_auto_tags_for_upload(token: str, request: UploadAutoTagPreviewRequest):
    """Preview AI tag suggestions for a temporary upload token without creating a post.

    Synchronous variant kept for backwards compatibility. Clients behind a
    reverse proxy should prefer the async start/poll endpoints below, since AI
    inference (video frames, Whisper, etc.) can exceed a proxy's gateway
    timeout and surface as an HTTP 504.
    """
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")
    return await _compute_auto_tag_preview(temp_path, request)


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


async def _run_preview_job(job_id: str, temp_path: Path, request: UploadAutoTagPreviewRequest) -> None:
    try:
        result = await _compute_auto_tag_preview(temp_path, request)
        job = preview_jobs.get(job_id)
        if job is not None:
            job.update(status="completed", result=result)
    except Exception as exc:  # noqa: BLE001 - surfaced to the client via the job
        logger.warning("auto-tag preview job %s failed: %s", job_id, exc)
        job = preview_jobs.get(job_id)
        if job is not None:
            job.update(status="failed", error=str(exc))


@router.post("/{token}/auto-tags/preview/start")
async def start_preview_auto_tags_for_upload(token: str, request: UploadAutoTagPreviewRequest):
    """Kick off an AI tag preview in the background and return a job id to poll."""
    temp_path = get_upload_path(token)
    if not temp_path or not temp_path.exists():
        raise HTTPException(status_code=404, detail="Invalid or expired content token")

    _prune_preview_jobs()
    job_id = str(uuid.uuid4())
    job = {"status": "running", "result": None, "error": None, "created": time.time()}
    preview_jobs[job_id] = job
    # Hold a reference so the task is not garbage-collected mid-run.
    job["task"] = asyncio.create_task(_run_preview_job(job_id, temp_path, request))
    return {"jobId": job_id, "status": "running"}


@router.get("/auto-tags/preview-jobs/{job_id}")
async def get_preview_auto_tags_job(job_id: str):
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


# Mapping of content-type to extension
MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/jfif': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/webm': '.webm',
    'video/mp4': '.mp4',
}


@router.post("/from-url")
async def upload_from_url(request: UrlFetchRequest):
    """
    Fetch a file from a URL and get a token for creating a post.
    Useful for pasting images from other websites.
    """
    url = _normalize_fetch_url(request.url.strip())

    # Basic URL validation
    try:
        parsed = urlparse(url)
        if not parsed.scheme in ('http', 'https'):
            raise ValueError("Invalid scheme")
        if not parsed.netloc:
            raise ValueError("Invalid URL")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")

    # Generate unique token
    token = str(uuid.uuid4())

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            # Use common browser headers to avoid blocks
            referer = f"{parsed.scheme}://{parsed.netloc}/"
            if request.referer:
                try:
                    parsed_referer = urlparse(request.referer)
                    if parsed_referer.scheme in {"http", "https"} and parsed_referer.netloc:
                        referer = request.referer
                except ValueError:
                    pass
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,video/*,*/*',
                'Referer': referer,
            }

            response = await client.get(url, headers=headers)
            response.raise_for_status()

            # Determine file extension from content-type or URL
            content_type = response.headers.get('content-type', '').split(';')[0].strip()
            extension = MIME_TO_EXT.get(content_type)
            url_path = Path(parsed.path)

            if not extension:
                # Try to get from URL path
                url_extension = normalize_upload_extension(url_path.suffix.lower())
                if url_extension in settings.allowed_extensions:
                    extension = url_extension
                else:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Could not determine file type. Content-Type: {content_type}"
                    )

            if extension not in settings.allowed_extensions:
                raise HTTPException(
                    status_code=400,
                    detail=f"File type {extension} not allowed. Allowed types: {settings.allowed_extensions}",
                )

            # Save to temporary location
            temp_path = settings.uploads_dir / f"{token}{extension}"

            async with aiofiles.open(temp_path, "wb") as f:
                await f.write(response.content)

            # Store token mapping
            upload_tokens[token] = temp_path

            # Generate a filename from the URL
            filename = url_path.name if url_path.name else f"image{extension}"
            if Path(filename).suffix.lower() != extension:
                filename = f"{Path(filename).stem}{extension}"

            return {
                "token": token,
                "filename": filename,
                "size": len(response.content),
                "url": url,
            }

    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to fetch URL: HTTP {e.response.status_code}"
        )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to fetch URL: {str(e)}"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process URL: {str(e)}")


def _normalize_fetch_url(url: str) -> str:
    """Prefer original CDN media variants when a site exposes size parameters."""
    try:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        if host == "pbs.twimg.com" and "/media/" in parsed.path:
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            inferred_format = parsed.path.rsplit(".", 1)[-1].lower() if "." in parsed.path.rsplit("/", 1)[-1] else ""
            if "format" not in query and inferred_format:
                query["format"] = inferred_format
            if "format" in query:
                query["name"] = "orig"
                return urlunparse(parsed._replace(query=urlencode(query), fragment=""))
    except Exception:
        pass
    return url


@router.post("/from-ytdlp")
async def upload_from_ytdlp(request: UrlFetchRequest):
    """
    Download a video using yt-dlp and get a token for creating a post.
    Supports Twitter/X, YouTube, TikTok, Instagram, Reddit, and 1000+ other sites.
    """
    url = request.url.strip()

    # Basic URL validation
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError("Invalid scheme")
        if not parsed.netloc:
            raise ValueError("Invalid URL")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")

    # If the URL points directly to a media file (e.g. a GIF), skip yt-dlp
    # and download it as-is to preserve the original format.
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as check_client:
            head_resp = await check_client.head(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            })
            ct = head_resp.headers.get('content-type', '').split(';')[0].strip()
            if ct in MIME_TO_EXT:
                return await upload_from_url(UrlFetchRequest(url=url))
    except Exception:
        pass  # HEAD check failed — fall through to yt-dlp

    # Generate unique token
    token = str(uuid.uuid4())
    request_cookie_file: Path | None = None

    try:
        # Import yt-dlp here to avoid startup issues if not installed
        import yt_dlp

        # Configure yt-dlp options
        ydl_opts = {
            'format': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[ext=mp4]/best',
            'outtmpl': str(settings.uploads_dir / f'{token}.%(ext)s'),
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
            'noplaylist': True,  # Only download single video, not playlists
            'merge_output_format': 'mp4',  # Prefer mp4 output
        }

        # Prefer one-shot cookies supplied by the browser extension for locked
        # X/Twitter posts. They live only for this yt-dlp invocation.
        if request.cookies:
            if len(request.cookies) > 1024 * 1024:
                raise HTTPException(status_code=400, detail="Cookie payload is too large")
            request_cookie_file = settings.uploads_dir / f"{token}.cookies.txt"
            request_cookie_file.write_text(request.cookies, encoding="utf-8")
            ydl_opts['cookiefile'] = str(request_cookie_file)
        else:
            # Check for cookies file in config directory
            cookies_file = settings.config_dir / COOKIES_FILENAME
            if cookies_file.exists():
                ydl_opts['cookiefile'] = str(cookies_file)

        # Run yt-dlp in thread pool to avoid blocking
        def download_video():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # First extract info without downloading
                info = ydl.extract_info(url, download=False)
                if info is None:
                    raise ValueError("Could not extract video info")

                # Download the video
                ydl.download([url])

                return {
                    'title': info.get('title', 'video'),
                    'thumbnail': info.get('thumbnail'),
                    'duration': info.get('duration'),
                    'ext': info.get('ext', 'mp4'),
                    'uploader': info.get('uploader'),
                }

        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, download_video)

        # Find the downloaded file (extension may vary)
        downloaded_file = None
        for ext in ['mp4', 'webm', 'mkv', 'mov', 'avi']:
            potential_path = settings.uploads_dir / f"{token}.{ext}"
            if potential_path.exists():
                downloaded_file = potential_path
                break

        if not downloaded_file:
            raise HTTPException(status_code=500, detail="Download completed but file not found")

        # Rename to correct extension if needed
        actual_ext = downloaded_file.suffix.lower()
        if actual_ext not in settings.allowed_extensions:
            # Try to find a compatible extension or convert
            raise HTTPException(
                status_code=400,
                detail=f"Downloaded format {actual_ext} not supported. Allowed: {settings.allowed_extensions}"
            )

        # Store token mapping
        upload_tokens[token] = downloaded_file

        # Generate filename from title
        safe_title = "".join(c for c in info['title'] if c.isalnum() or c in ' -_').strip()[:100]
        filename = f"{safe_title}{actual_ext}" if safe_title else f"video{actual_ext}"

        return {
            "token": token,
            "filename": filename,
            "title": info['title'],
            "thumbnail": info.get('thumbnail'),
            "duration": info.get('duration'),
            "uploader": info.get('uploader'),
        }

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="yt-dlp is not installed. Run: pip install yt-dlp"
        )
    except Exception as e:
        # Clean up any partial download
        for ext in ['mp4', 'webm', 'mkv', 'mov', 'avi', 'part', 'ytdl']:
            potential_path = settings.uploads_dir / f"{token}.{ext}"
            if potential_path.exists():
                potential_path.unlink()

        error_msg = str(e)
        logger.warning("yt-dlp failed for host=%s path=%s error=%s", urlparse(url).netloc, urlparse(url).path, error_msg)
        if "Unsupported URL" in error_msg:
            raise HTTPException(
                status_code=400,
                detail=ytdlp_error_detail("This URL is not supported by yt-dlp", url, error_msg),
            )
        elif "Private video" in error_msg or "Video unavailable" in error_msg:
            raise HTTPException(
                status_code=400,
                detail=ytdlp_error_detail("Video is private or unavailable", url, error_msg),
            )
        elif "Sign in" in error_msg or "login" in error_msg.lower():
            raise HTTPException(
                status_code=400,
                detail=ytdlp_error_detail("This video requires login to access", url, error_msg),
            )
        else:
            raise HTTPException(
                status_code=500,
                detail=ytdlp_error_detail(f"Failed to download video: {error_msg}", url, error_msg),
            )
    finally:
        if request_cookie_file and request_cookie_file.exists():
            request_cookie_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Fediverse (Pleroma / Misskey) helpers
# ---------------------------------------------------------------------------

async def _detect_fediverse_platform(host: str, client: httpx.AsyncClient) -> str:
    """Return 'misskey', 'pleroma', or 'mastodon' based on NodeInfo."""
    try:
        resp = await client.get(f"https://{host}/.well-known/nodeinfo", timeout=10)
        if resp.status_code == 200:
            for link in resp.json().get("links", []):
                href = link.get("href")
                if not href:
                    continue
                ni = await client.get(href, timeout=10)
                if ni.status_code == 200:
                    name = ni.json().get("software", {}).get("name", "").lower()
                    if name in MISSKEY_FORKS:
                        return "misskey"
                    if name in PLEROMA_FORKS:
                        return "pleroma"
    except Exception:
        pass
    return "mastodon"


async def _fetch_misskey_attachments(host: str, path: str, client: httpx.AsyncClient):
    """Return (attachments, tags, title) for a Misskey note."""
    m = re.search(r'/notes/([a-zA-Z0-9]+)', path)
    if not m:
        raise HTTPException(status_code=400, detail="Could not extract note ID from Misskey URL")
    note_id = m.group(1)

    resp = await client.post(
        f"https://{host}/api/notes/show",
        json={"noteId": note_id},
        timeout=15,
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=400, detail=f"Failed to fetch Misskey note: HTTP {resp.status_code}")

    note = resp.json()
    files = note.get("files", [])

    attachments = []
    for f in files:
        media_url = f.get("url")
        if not media_url:
            continue
        mime = f.get("type", "")
        ext = MIME_TO_EXT.get(mime)
        if not ext:
            ext_from_url = normalize_upload_extension(Path(urlparse(media_url).path).suffix.lower())
            ext = ext_from_url if ext_from_url in settings.allowed_extensions else ".jpg"
        attachments.append({"url": media_url, "type": mime, "ext": ext})

    text = note.get("text", "") or ""
    tags = re.findall(r'#(\w+)', text)
    clean_text = re.sub(r'#\w+', '', text).strip()[:200]

    return attachments, tags, clean_text


async def _fetch_pleroma_attachments(host: str, path: str, client: httpx.AsyncClient):
    """Return (attachments, tags, title) for a Pleroma/Mastodon status."""
    status_id = path.rstrip("/").split("/")[-1]

    resp = await client.get(f"https://{host}/api/v1/statuses/{status_id}", timeout=15)
    if resp.status_code != 200:
        raise HTTPException(status_code=400, detail=f"Failed to fetch status: HTTP {resp.status_code}")

    status = resp.json()
    media_attachments = status.get("media_attachments", [])

    attachments = []
    for att in media_attachments:
        media_url = att.get("url")
        if not media_url:
            continue
        pleroma_extra = att.get("pleroma") or {}
        mime = pleroma_extra.get("mime_type", "")
        if not mime:
            ext_from_url = Path(urlparse(media_url).path).suffix.lower()
            mime = {
                ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".png": "image/png", ".gif": "image/gif",
                ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
            }.get(ext_from_url, "")
        ext = MIME_TO_EXT.get(mime)
        if not ext:
            ext_from_url = normalize_upload_extension(Path(urlparse(media_url).path).suffix.lower())
            ext = ext_from_url if ext_from_url in settings.allowed_extensions else ".jpg"
        attachments.append({"url": media_url, "type": mime, "ext": ext})

    tags = [t.get("name", "") for t in status.get("tags", []) if t.get("name")]

    content = status.get("content", "") or ""
    clean = re.sub(r'<[^>]+>', ' ', content)
    clean = html_module.unescape(clean).strip()
    clean = re.sub(r'\s+', ' ', clean)[:200]

    return attachments, tags, clean


@router.post("/from-fediverse")
async def upload_from_fediverse(request: FediverseRequest):
    """
    Fetch media from a Pleroma or Misskey post.
    Auto-detects the platform via NodeInfo, downloads all media attachments,
    and returns a token per attachment along with suggested tags.
    """
    url = request.url.strip()

    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError("Invalid scheme")
        if not parsed.netloc:
            raise ValueError("Invalid URL")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")

    host = parsed.netloc
    path = parsed.path

    browser_headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ),
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        try:
            platform = await _detect_fediverse_platform(host, client)

            if platform == "misskey":
                attachments, tags, title = await _fetch_misskey_attachments(host, path, client)
            else:
                attachments, tags, title = await _fetch_pleroma_attachments(host, path, client)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to fetch post: {str(e)}")

        if not attachments:
            raise HTTPException(status_code=404, detail="No media attachments found in this post")

        # Download every attachment and register a token for each
        uploads_result = []
        for att in attachments:
            media_url = att["url"]
            ext = att["ext"]

            try:
                media_resp = await client.get(media_url, headers=browser_headers, timeout=30)
                media_resp.raise_for_status()

                # Re-check extension from actual content-type (catches GIF-served-as-mp4 etc.)
                actual_ct = media_resp.headers.get('content-type', '').split(';')[0].strip()
                actual_ext = MIME_TO_EXT.get(actual_ct, ext)

                if actual_ext not in settings.allowed_extensions:
                    continue

                token = str(uuid.uuid4())
                temp_path = settings.uploads_dir / f"{token}{actual_ext}"

                async with aiofiles.open(temp_path, "wb") as f:
                    await f.write(media_resp.content)

                upload_tokens[token] = temp_path
                url_path = Path(urlparse(media_url).path)
                filename = url_path.name if url_path.name else f"media{actual_ext}"
                if Path(filename).suffix.lower() != actual_ext:
                    filename = f"{Path(filename).stem}{actual_ext}"

                uploads_result.append({
                    "token": token,
                    "filename": filename,
                    "size": len(media_resp.content),
                })
            except Exception:
                continue  # Skip individual failed attachments

        if not uploads_result:
            raise HTTPException(status_code=500, detail="Failed to download any media attachments")

        return {
            "uploads": uploads_result,
            "tags": tags,
            "source": url,
            "title": title,
            "platform": platform,
        }
