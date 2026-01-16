import uuid
import asyncio
import aiofiles
import httpx
from pathlib import Path
from urllib.parse import urlparse
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..services.settings import SettingsManager


class UrlFetchRequest(BaseModel):
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

            if not extension:
                # Try to get from URL path
                url_path = Path(parsed.path)
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

        # Check for cookies file configuration
        settings_manager = SettingsManager(settings.config_file)
        cookies_path = settings_manager.get_ytdlp_cookies_path()
        if cookies_path and Path(cookies_path).exists():
            ydl_opts['cookiefile'] = cookies_path

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
