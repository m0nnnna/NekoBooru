import re
import uuid
import asyncio
import aiofiles
import httpx
import html as html_module
from pathlib import Path
from urllib.parse import urlparse
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

from ..config import settings

# Fixed path for cookies file in config directory (matches settings.py)
COOKIES_FILENAME = "ytdlp_cookies.txt"

MISSKEY_FORKS = {"misskey", "calckey", "firefish", "catodon", "iceshrimp", "sharkey", "foundkey", "magnetar"}
PLEROMA_FORKS = {"pleroma", "akkoma"}


class UrlFetchRequest(BaseModel):
    url: str


class FediverseRequest(BaseModel):
    url: str

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

# In-memory store for upload tokens (maps token -> temp file path)
# In production, you might want to use Redis or a database table
upload_tokens: dict[str, Path] = {}


@router.post("")
async def upload_file(content: UploadFile = File(...)):
    """
    Upload a file and get a token for creating a post.
    Compatible with szurubooru API.
    """
    # Validate file extension
    filename = content.filename or "unknown"
    extension = Path(filename).suffix.lower()

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
    """Get the temporary file path for an upload token."""
    return upload_tokens.get(token)


def remove_upload_token(token: str):
    """Remove an upload token after processing."""
    upload_tokens.pop(token, None)


# Mapping of content-type to extension
MIME_TO_EXT = {
    'image/jpeg': '.jpg',
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
    url = request.url.strip()

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
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,video/*,*/*',
                'Referer': f"{parsed.scheme}://{parsed.netloc}/",
            }

            response = await client.get(url, headers=headers)
            response.raise_for_status()

            # Determine file extension from content-type or URL
            content_type = response.headers.get('content-type', '').split(';')[0].strip()
            extension = MIME_TO_EXT.get(content_type)
            url_path = Path(parsed.path)

            if not extension:
                # Try to get from URL path
                if url_path.suffix.lower() in settings.allowed_extensions:
                    extension = url_path.suffix.lower()
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

            return {
                "token": token,
                "filename": filename,
                "size": len(response.content),
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
        if "Unsupported URL" in error_msg:
            raise HTTPException(status_code=400, detail="This URL is not supported by yt-dlp")
        elif "Private video" in error_msg or "Video unavailable" in error_msg:
            raise HTTPException(status_code=400, detail="Video is private or unavailable")
        elif "Sign in" in error_msg or "login" in error_msg.lower():
            raise HTTPException(status_code=400, detail="This video requires login to access")
        else:
            raise HTTPException(status_code=500, detail=f"Failed to download video: {error_msg}")


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
            ext_from_url = Path(urlparse(media_url).path).suffix.lower()
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
            ext_from_url = Path(urlparse(media_url).path).suffix.lower()
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
