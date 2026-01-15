import uuid
import aiofiles
import httpx
import mimetypes
from pathlib import Path
from urllib.parse import urlparse
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

from ..config import settings


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
