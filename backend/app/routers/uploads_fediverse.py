"""Uploads imported from a Fediverse post (Mastodon, Misskey and Pleroma families).

Included into routers.uploads.router. Names it needs from routers.uploads (the
upload-token store) are looked up as ``uploads.<name>`` at call time.
"""

import html as html_module
import re
import uuid
from pathlib import Path
from urllib.parse import urlparse

import aiofiles
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..dependencies import get_current_user
from ..models import User
from .uploads_fetch import MIME_TO_EXT

router = APIRouter()


MISSKEY_FORKS = {"misskey", "calckey", "firefish", "catodon", "iceshrimp", "sharkey", "foundkey", "magnetar"}
PLEROMA_FORKS = {"pleroma", "akkoma"}


class FediverseRequest(BaseModel):
    url: str


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
            ext_from_url = uploads.normalize_upload_extension(Path(urlparse(media_url).path).suffix.lower())
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
            ext_from_url = uploads.normalize_upload_extension(Path(urlparse(media_url).path).suffix.lower())
            ext = ext_from_url if ext_from_url in settings.allowed_extensions else ".jpg"
        attachments.append({"url": media_url, "type": mime, "ext": ext})

    tags = [t.get("name", "") for t in status.get("tags", []) if t.get("name")]

    content = status.get("content", "") or ""
    clean = re.sub(r'<[^>]+>', ' ', content)
    clean = html_module.unescape(clean).strip()
    clean = re.sub(r'\s+', ' ', clean)[:200]

    return attachments, tags, clean


@router.post("/from-fediverse")
async def upload_from_fediverse(request: FediverseRequest, current_user: User = Depends(get_current_user)):
    """
    Fetch media from a Pleroma or Misskey post.
    Auto-detects the platform via NodeInfo, downloads all media attachments,
    and returns a token per attachment along with suggested tags.
    """
    return await _upload_from_fediverse_impl(request)


async def _upload_from_fediverse_impl(request: FediverseRequest) -> dict:
    """Actual implementation, callable without a request context.

    services/upload_job_runners.py's _run_fediverse runs as a background task with
    no current_user available (the job's own creation was already
    authenticated) - it calls this directly rather than the router function,
    since calling a route that Depends(get_current_user) as a plain Python
    function would fail with a missing argument.
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

                uploads.upload_tokens[token] = temp_path
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


# Imported last, not first: routers.uploads imports this module while it is itself
# loading, and the names above are only read through it at call time. Either
# module can then be imported first.
from . import uploads  # noqa: E402
