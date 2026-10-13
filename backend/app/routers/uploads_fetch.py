"""Uploads fetched from a URL: direct downloads (/from-url, with progress) and yt-dlp,
plus the per-host user-agent, referer and URL normalisation rules.

Included into routers.uploads.router. Names it
needs from routers.uploads (the upload-token store, its logger) are looked up as
``uploads.<name>`` at call time.
"""

import asyncio
import re
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import aiofiles
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..dependencies import get_current_user
from ..models import User

router = APIRouter()


# Fixed path for cookies file in config directory (matches settings.py)
COOKIES_FILENAME = "ytdlp_cookies.txt"


class UrlFetchRequest(BaseModel):
    url: str
    cookies: str | None = None
    referer: str | None = None
    # Caller-chosen id to poll /from-url/progress/<id> with while it downloads.
    progressId: str | None = None


# Bytes received so far for downloads a caller asked to follow. A slow source
# (Sankaku throttles video) otherwise looks exactly like a hung request.
_PROGRESS_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_PROGRESS_TTL_SECONDS = 600
_fetch_progress: dict[str, dict] = {}


# Files /from-url is downloading right now, so a second request for the same
# one is refused rather than run alongside it.
_active_downloads: set[str] = set()


def _download_key(parsed) -> str:
    host = (parsed.hostname or "").lower()
    # Signed CDN links differ per request only in their query (Sankaku's e,
    # m, and token), so the path alone names the file there.
    if _is_sankaku_media_host(host):
        return f"{host}{parsed.path}"
    return urlunparse(parsed._replace(fragment=""))


def _start_fetch_progress(progress_id: str | None, total: int | None) -> dict | None:
    if not progress_id or not _PROGRESS_ID.match(progress_id):
        return None
    now = time.monotonic()
    for key in [key for key, entry in _fetch_progress.items() if now - entry["started"] > _PROGRESS_TTL_SECONDS]:
        _fetch_progress.pop(key, None)
    entry = {"received": 0, "total": total, "done": False, "started": now}
    _fetch_progress[progress_id] = entry
    return entry


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
async def upload_from_url(request: UrlFetchRequest, current_user: User = Depends(get_current_user)):
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

    # The same file twice at once is a double click, not a wish for two
    # copies; with a throttled source it also halves the speed of both.
    download_key = _download_key(parsed)
    if download_key in _active_downloads:
        raise HTTPException(
            status_code=409,
            detail="This file is already downloading. Wait for that import to finish.",
        )
    _active_downloads.add(download_key)

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
            referer = _media_referer(parsed.hostname, referer)
            headers = {
                'User-Agent': _media_user_agent(parsed.hostname),
                'Accept': 'image/*,video/*,*/*',
                'Referer': referer,
            }

            # Streamed to disk rather than held in memory, so a large video
            # neither doubles the process's footprint nor hides its progress.
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                if _is_sankaku_hotlink_placeholder(response.url):
                    raise HTTPException(
                        status_code=400,
                        detail="Sankaku refused the download and sent its hotlink placeholder instead",
                    )

                # Determine file extension from content-type or URL
                content_type = response.headers.get('content-type', '').split(';')[0].strip()
                extension = MIME_TO_EXT.get(content_type)
                url_path = Path(parsed.path)

                if not extension:
                    # Try to get from URL path
                    url_extension = uploads.normalize_upload_extension(url_path.suffix.lower())
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
                total = int(response.headers.get("content-length") or 0) or None
                progress = _start_fetch_progress(request.progressId, total)
                size = 0
                try:
                    async with aiofiles.open(temp_path, "wb") as f:
                        async for chunk in response.aiter_bytes(256 * 1024):
                            await f.write(chunk)
                            size += len(chunk)
                            if progress is not None:
                                progress["received"] = size
                except BaseException:
                    temp_path.unlink(missing_ok=True)
                    raise
                finally:
                    if progress is not None:
                        progress["done"] = True

            # Store token mapping
            uploads.upload_tokens[token] = temp_path

            # Generate a filename from the URL
            filename = url_path.name if url_path.name else f"image{extension}"
            if Path(filename).suffix.lower() != extension:
                filename = f"{Path(filename).stem}{extension}"

            return {
                "token": token,
                "filename": filename,
                "size": size,
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
    finally:
        _active_downloads.discard(download_key)


# Sankaku's front-ends; every other *.sankakucomplex.com host serves media.
_SANKAKU_FRONTEND_HOSTS = {"chan", "www", "idol", "login", "beta", "legacy", "black", "white"}


def _is_sankaku_media_host(host: str | None) -> bool:
    host = (host or "").lower()
    if not host.endswith(".sankakucomplex.com"):
        return False
    return host.removesuffix(".sankakucomplex.com") not in _SANKAKU_FRONTEND_HOSTS


BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
HONEST_MEDIA_USER_AGENT = "NekoBooru/1.0 (original importer)"
DANBOORU_MEDIA_USER_AGENT = HONEST_MEDIA_USER_AGENT


def _is_danbooru_host(host: str | None) -> bool:
    host = (host or "").lower()
    return host == "donmai.us" or host.endswith(".donmai.us")


def _is_e621_host(host: str | None) -> bool:
    host = (host or "").lower()
    return host in {"e621.net", "e926.net"} or host.endswith((".e621.net", ".e926.net"))


def _media_user_agent(host: str | None) -> str:
    # Danbooru's Cloudflare turns away a browser User-Agent that arrives
    # without a browser's TLS fingerprint (403 challenge page), but serves an
    # honest client name - the one every other Danbooru call here sends too.
    # e621/e926 ask every client to identify itself rather than pose as a
    # browser; that covers their static1.* file hosts too.
    if _is_danbooru_host(host) or _is_e621_host(host):
        return HONEST_MEDIA_USER_AGENT
    return BROWSER_USER_AGENT


def _media_referer(host: str | None, referer: str) -> str:
    # Sankaku's CDN answers a chan.sankakucomplex.com (or its own) referer by
    # redirecting to a hotlink placeholder; the sankaku.app front-end's referer
    # gets the real file, whichever Sankaku page the download started from.
    if _is_sankaku_media_host(host):
        return "https://sankaku.app/"
    return referer


def _is_sankaku_hotlink_placeholder(final_url) -> bool:
    parsed = urlparse(str(final_url))
    host = (parsed.hostname or "").lower()
    return (host == "sankakucomplex.com" or host.endswith(".sankakucomplex.com")) and parsed.path.endswith("/redirect.png")


@router.get("/from-url/progress/{progress_id}")
async def from_url_progress(progress_id: str, current_user: User = Depends(get_current_user)):
    """How far a followed /from-url download has got: bytes received and total."""
    entry = _fetch_progress.get(progress_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown download")
    return {"received": entry["received"], "total": entry["total"], "done": entry["done"]}


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
async def upload_from_ytdlp(request: UrlFetchRequest, current_user: User = Depends(get_current_user)):
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
                return await upload_from_url(UrlFetchRequest(url=url), current_user)
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
        uploads.upload_tokens[token] = downloaded_file

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
        uploads.logger.warning("yt-dlp failed for host=%s path=%s error=%s", urlparse(url).netloc, urlparse(url).path, error_msg)
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


# Imported last, not first: routers.uploads imports this module while it is itself
# loading, and the names above are only read through it at call time. Either
# module can then be imported first.
from . import uploads  # noqa: E402
